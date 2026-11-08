import { createTransportError } from './errors.js';
import type { PeerId, TransportFrame, TransportLayer } from './types.js';

/**
 * Deterministic in-process network used by the examples and tests.
 * Delivery is synchronous, which keeps the handshake easy to follow.
 */
export class InMemoryNetwork {
  private readonly nodes = new Map<PeerId, InMemoryTransport>();

  register(transport: InMemoryTransport): void {
    this.nodes.set(transport.localPeerId, transport);
  }

  unregister(peerId: PeerId): void {
    this.nodes.delete(peerId);
  }

  deliver(frame: TransportFrame): void {
    const target = this.nodes.get(frame.to);
    if (!target) {
      throw createTransportError(
        'peer-unreachable',
        `Peer ${frame.to} is not connected to this network`
      );
    }
    target.deliver(frame);
  }
}

export class InMemoryTransport implements TransportLayer {
  readonly localPeerId: PeerId;
  private readonly network: InMemoryNetwork;
  private readonly handlers: Array<(frame: TransportFrame) => void> = [];
  private closed = false;

  constructor(network: InMemoryNetwork, localPeerId: PeerId) {
    this.network = network;
    this.localPeerId = localPeerId;
    network.register(this);
  }

  sendFrame(frame: TransportFrame): Promise<void> {
    if (this.closed) {
      return Promise.reject(
        createTransportError('peer-closed', `Transport ${this.localPeerId} is closed`)
      );
    }
    try {
      this.network.deliver({ ...frame, from: this.localPeerId });
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  onFrame(handler: (frame: TransportFrame) => void): void {
    this.handlers.push(handler);
  }

  close(): Promise<void> {
    this.closed = true;
    this.handlers.length = 0;
    this.network.unregister(this.localPeerId);
    return Promise.resolve();
  }

  /** @internal called by the network */
  deliver(frame: TransportFrame): void {
    if (this.closed) return;
    for (const handler of [...this.handlers]) {
      handler(frame);
    }
  }
}
