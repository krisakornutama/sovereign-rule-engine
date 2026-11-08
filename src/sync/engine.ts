import { bytesToUtf8, utf8ToBytes } from '../types.js';
import type {
  CryptoEnvelope,
  HandshakeInit,
  HandshakeResponse,
  IdentityKeyPair,
} from '../crypto/types.js';
import {
  acceptHandshake,
  createHandshakeInit,
  finalizeHandshake,
  type PendingHandshake,
  type SecureSession,
} from '../crypto/session.js';
import type { TransportFrame, TransportLayer, PeerId } from '../transport/types.js';
import type { CRDTDelta, CRDTEntry } from '../crdt/types.js';
import { MemoryCRDTStore } from '../crdt/engine.js';
import { InMemoryContentAddressStore, merkleRoot } from '../merkle/cas.js';
import type { SyncEvent, SyncEventType } from './types.js';

const HANDSHAKE_TIMEOUT_MS = 5000;

type WireMessage =
  | { readonly kind: 'handshake-init'; readonly init: HandshakeInit }
  | { readonly kind: 'handshake-response'; readonly response: HandshakeResponse }
  | { readonly kind: 'secure'; readonly envelope: CryptoEnvelope };

type InnerMessage =
  | { readonly kind: 'announce'; readonly root: string; readonly entryCount: number }
  | { readonly kind: 'delta'; readonly entries: ReadonlyArray<CRDTEntry> }
  | { readonly kind: 'ack'; readonly root: string; readonly applied: number };

export interface LocalSyncConfig {
  readonly peerId: PeerId;
  readonly identity: IdentityKeyPair;
  readonly transport: TransportLayer;
  readonly crdtStore?: MemoryCRDTStore;
  readonly cas?: InMemoryContentAddressStore;
}

/**
 * Encrypted local-sync engine: Edge -> Edge over any TransportLayer.
 *
 * handshake (Ed25519 mutual auth + X25519 ECDH + HKDF)
 *   -> encrypted MERKLE announce
 *   -> encrypted delta batch
 *   -> CRDT merge + ack
 */
export class LocalSyncEngine {
  readonly peerId: PeerId;
  readonly crdtStore: MemoryCRDTStore;
  readonly cas: InMemoryContentAddressStore;

  private readonly identity: IdentityKeyPair;
  private readonly transport: TransportLayer;
  private readonly sessions = new Map<PeerId, SecureSession>();
  private readonly pending = new Map<PeerId, PendingHandshake>();
  private readonly connectionWaiters = new Map<PeerId, (session: SecureSession) => void>();
  private readonly listeners: Array<(event: SyncEvent) => void> = [];
  private started = false;

  constructor(config: LocalSyncConfig) {
    this.peerId = config.peerId;
    this.identity = config.identity;
    this.transport = config.transport;
    this.crdtStore = config.crdtStore ?? new MemoryCRDTStore();
    this.cas = config.cas ?? new InMemoryContentAddressStore();
  }

  start(): void {
    if (this.started) return;
    this.transport.onFrame((frame) => {
      void this.handleFrame(frame);
    });
    this.started = true;
  }

  on(event: 'sync:event', listener: (event: SyncEvent) => void): void {
    if (event === 'sync:event') {
      this.listeners.push(listener);
    }
  }

  async connect(remotePeerId: PeerId): Promise<SecureSession> {
    this.start();

    const existing = this.sessions.get(remotePeerId);
    if (existing) return existing;

    const pending = createHandshakeInit(this.peerId, this.identity, remotePeerId);
    this.pending.set(remotePeerId, pending);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const waitForSession = new Promise<SecureSession>((resolve, reject) => {
      this.connectionWaiters.set(remotePeerId, resolve);
      timer = setTimeout(() => {
        this.connectionWaiters.delete(remotePeerId);
        this.pending.delete(remotePeerId);
        reject(new Error(`Handshake with ${remotePeerId} timed out`));
      }, HANDSHAKE_TIMEOUT_MS);
    });

    try {
      await this.transport.sendFrame({
        from: this.peerId,
        to: remotePeerId,
        payload: utf8ToBytes(
          JSON.stringify({ kind: 'handshake-init', init: pending.init } satisfies WireMessage)
        ),
      });
      return await waitForSession;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  getSession(remotePeerId: PeerId): SecureSession | undefined {
    return this.sessions.get(remotePeerId);
  }

  localEntries(): CRDTEntry[] {
    return this.crdtStore.list();
  }

  localLeaves(): string[] {
    return this.localEntries().map((entry) => this.cas.put(utf8ToBytes(JSON.stringify(entry))));
  }

  localRoot(): string {
    return merkleRoot(this.localLeaves());
  }

  async announce(remotePeerId: PeerId): Promise<void> {
    await this.sendSecure(remotePeerId, {
      kind: 'announce',
      root: this.localRoot(),
      entryCount: this.crdtStore.size,
    });
  }

  async sendDeltaBatch(
    remotePeerId: PeerId,
    entries: ReadonlyArray<CRDTEntry> = this.localEntries()
  ): Promise<number> {
    if (entries.length === 0) return 0;
    await this.sendSecure(remotePeerId, { kind: 'delta', entries });
    return entries.length;
  }

  close(): Promise<void> {
    this.sessions.clear();
    this.pending.clear();
    this.connectionWaiters.clear();
    return this.transport.close();
  }

  private async handleFrame(frame: TransportFrame): Promise<void> {
    try {
      const message = JSON.parse(bytesToUtf8(frame.payload)) as WireMessage;

      switch (message.kind) {
        case 'handshake-init': {
          const { response, session } = acceptHandshake(message.init, this.peerId, this.identity);
          this.sessions.set(frame.from, session);
          await this.transport.sendFrame({
            from: this.peerId,
            to: frame.from,
            payload: utf8ToBytes(
              JSON.stringify({ kind: 'handshake-response', response } satisfies WireMessage)
            ),
          });
          this.emit(
            'PEER_CONNECTED',
            { remotePeerId: frame.from, sessionId: session.sessionId },
            frame.from
          );
          this.resolveConnection(frame.from, session);
          break;
        }

        case 'handshake-response': {
          const pending = this.pending.get(frame.from);
          if (!pending) {
            this.emit(
              'SYNC_ERROR',
              { message: 'Unexpected handshake response', remotePeerId: frame.from },
              frame.from
            );
            return;
          }
          const session = finalizeHandshake(pending, message.response, this.identity);
          this.sessions.set(frame.from, session);
          this.pending.delete(frame.from);
          this.emit(
            'PEER_CONNECTED',
            { remotePeerId: frame.from, sessionId: session.sessionId },
            frame.from
          );
          this.resolveConnection(frame.from, session);
          break;
        }

        case 'secure': {
          const session = this.sessions.get(frame.from);
          if (!session) {
            throw new Error(`No secure session with ${frame.from}`);
          }
          const plaintext = session.decrypt(message.envelope);
          this.handleInner(frame.from, JSON.parse(bytesToUtf8(plaintext)) as InnerMessage);
          break;
        }
      }
    } catch (error) {
      this.emit(
        'SYNC_ERROR',
        {
          message: error instanceof Error ? error.message : 'Unknown sync error',
          remotePeerId: frame.from,
        },
        frame.from
      );
    }
  }

  private handleInner(remotePeerId: PeerId, message: InnerMessage): void {
    switch (message.kind) {
      case 'announce': {
        const localRoot = this.localRoot();
        this.emit(
          'SYNC_ANNOUNCE',
          {
            remotePeerId,
            remoteRoot: message.root,
            localRoot,
            remoteEntryCount: message.entryCount,
            converged: localRoot === message.root,
          },
          remotePeerId
        );
        break;
      }

      case 'delta': {
        const result = this.crdtStore.applyDelta({ entries: message.entries });
        this.emit(
          'DELTA_BATCH',
          {
            remotePeerId,
            applied: result.applied,
            conflicts: result.conflicts.length,
            keys: message.entries.map((entry) => entry.key),
          },
          remotePeerId
        );
        void this.sendSecure(remotePeerId, {
          kind: 'ack',
          root: this.localRoot(),
          applied: result.applied,
        });
        break;
      }

      case 'ack': {
        this.emit(
          'STATE_CONVERGED',
          {
            remotePeerId,
            remoteRoot: message.root,
            localRoot: this.localRoot(),
            converged: message.root === this.localRoot(),
            applied: message.applied,
          },
          remotePeerId
        );
        break;
      }
    }
  }

  private async sendSecure(remotePeerId: PeerId, message: InnerMessage): Promise<void> {
    const session = this.sessions.get(remotePeerId);
    if (!session) {
      throw new Error(`No secure session with ${remotePeerId}; connect first`);
    }
    const envelope = session.encrypt(utf8ToBytes(JSON.stringify(message)));
    await this.transport.sendFrame({
      from: this.peerId,
      to: remotePeerId,
      payload: utf8ToBytes(JSON.stringify({ kind: 'secure', envelope } satisfies WireMessage)),
    });
  }

  private resolveConnection(peerId: PeerId, session: SecureSession): void {
    const waiter = this.connectionWaiters.get(peerId);
    if (waiter) {
      this.connectionWaiters.delete(peerId);
      waiter(session);
    }
  }

  private emit(type: SyncEventType, payload: Record<string, unknown>, sourcePeerId?: PeerId): void {
    const event: SyncEvent = { type, payload, timestamp: Date.now(), sourcePeerId };
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}

export type { CRDTDelta };
