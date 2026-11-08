import { describe, expect, it } from 'vitest';
import {
  CompositeTransport,
  InMemoryContentAddressStore,
  InMemoryNetwork,
  InMemoryTransport,
  TransportError,
  createPeerId,
  hashData,
  hashNode,
  merkleDiff,
  merkleRoot,
  utf8ToBytes,
  type PeerId,
  type TransportFrame,
  type TransportLayer,
} from '../src/index.js';

describe('Merkle hashing and CAS', () => {
  it('hashes deterministically and distinguishes data', () => {
    const a = hashData(utf8ToBytes('alpha'));
    expect(a).toBe(hashData(utf8ToBytes('alpha')));
    expect(a).not.toBe(hashData(utf8ToBytes('beta')));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashNode(a, a)).toBe(hashData(fromHexLocal(a + a)));
  });

  it('stores blobs by content hash', () => {
    const cas = new InMemoryContentAddressStore();
    const data = utf8ToBytes('payload');
    const hash = cas.put(data);

    expect(cas.has(hash)).toBe(true);
    expect(cas.size).toBe(1);
    expect(cas.put(data)).toBe(hash);
    expect(cas.size).toBe(1);
    expect(cas.get(hash)).toEqual(data);
    expect(cas.get('missing')).toBeUndefined();

    // Returned buffers are copies, so mutating one cannot corrupt the store.
    const fetched = cas.get(hash)!;
    fetched[0] = 0;
    expect(cas.get(hash)![0]).toBe(utf8ToBytes('payload')[0]);

    cas.clear();
    expect(cas.size).toBe(0);
    expect(cas.get(hash)).toBeUndefined();
  });

  it('builds order-stable roots and diffs leaf sets', () => {
    const leaves = [
      hashData(utf8ToBytes('a')),
      hashData(utf8ToBytes('b')),
      hashData(utf8ToBytes('c')),
    ];

    expect(merkleRoot([])).toBe(hashData(new Uint8Array(0)));
    expect(merkleRoot([leaves[0]!])).toBe(leaves[0]);
    expect(merkleRoot(leaves)).toBe(merkleRoot([...leaves]));
    expect(merkleRoot(leaves)).not.toBe(merkleRoot(leaves.slice(0, 2)));
    // Odd leaf count pairs the last node with itself.
    expect(merkleRoot([leaves[0]!, leaves[1]!, leaves[2]!])).toBe(
      hashNode(hashNode(leaves[0]!, leaves[1]!), hashNode(leaves[2]!, leaves[2]!))
    );

    const diff = merkleDiff(leaves.slice(0, 2), leaves.slice(1));
    expect(diff.missingLocally).toEqual([leaves[2]]);
    expect(diff.missingRemotely).toEqual([leaves[0]]);
    expect(merkleDiff(leaves, leaves)).toEqual({ missingLocally: [], missingRemotely: [] });
  });
});

describe('in-memory transport', () => {
  it('delivers frames and stamps the sender', async () => {
    const network = new InMemoryNetwork();
    const alice = createPeerId('alice');
    const bob = createPeerId('bob');
    const aliceTransport = new InMemoryTransport(network, alice);
    const bobTransport = new InMemoryTransport(network, bob);

    const received: TransportFrame[] = [];
    bobTransport.onFrame((frame) => received.push(frame));

    await aliceTransport.sendFrame({ from: alice, to: bob, payload: utf8ToBytes('hi') });
    expect(received).toHaveLength(1);
    expect(received[0]?.from).toBe(alice);
    expect(received[0]?.to).toBe(bob);
  });

  it('reports unreachable peers and closed transports', async () => {
    const network = new InMemoryNetwork();
    const alice = createPeerId('alice');
    const bob = createPeerId('bob');
    const aliceTransport = new InMemoryTransport(network, alice);
    const bobTransport = new InMemoryTransport(network, bob);

    const unreachable = await aliceTransport
      .sendFrame({ from: alice, to: 'ghost', payload: new Uint8Array() })
      .catch((error: unknown) => error);
    expect(unreachable).toBeInstanceOf(TransportError);
    expect((unreachable as TransportError).code).toBe('peer-unreachable');

    await aliceTransport.close();
    const closed = await aliceTransport
      .sendFrame({ from: alice, to: bob, payload: new Uint8Array() })
      .catch((error: unknown) => error);
    expect((closed as TransportError).code).toBe('peer-closed');

    // A closed peer is unregistered, so the network can no longer reach it.
    expect(() => network.deliver({ from: alice, to: alice, payload: new Uint8Array() })).toThrow(
      /not connected/
    );
    expect(bobTransport.localPeerId).toBe(bob);
  });
});

interface StubTransport extends TransportLayer {
  readonly attempts: number;
  readonly frames: TransportFrame[];
}

function stubTransport(localPeerId: PeerId, failures: number): StubTransport {
  let attempts = 0;
  const handlers: Array<(frame: TransportFrame) => void> = [];
  const frames: TransportFrame[] = [];
  return {
    localPeerId,
    get attempts() {
      return attempts;
    },
    frames,
    async sendFrame(frame: TransportFrame): Promise<void> {
      attempts += 1;
      if (attempts <= failures) {
        throw new TransportError('link-down', 'simulated link failure');
      }
      frames.push(frame);
    },
    onFrame(handler: (frame: TransportFrame) => void): void {
      handlers.push(handler);
    },
    async close(): Promise<void> {
      handlers.length = 0;
    },
  };
}

describe('composite transport', () => {
  const frame: TransportFrame = {
    from: 'peer-a',
    to: 'peer-b',
    payload: new Uint8Array(),
  };

  it('falls back to the secondary link after exhausting retries', async () => {
    const primary = stubTransport('peer-a', Number.POSITIVE_INFINITY);
    const fallback = stubTransport('peer-a', 0);
    const composite = new CompositeTransport({ primary, fallback, maxRetries: 2 });

    await composite.sendFrame(frame);
    expect(primary.attempts).toBe(3);
    expect(fallback.frames).toHaveLength(1);
    expect(composite.localPeerId).toBe('peer-a');
  });

  it('throws all-links-failed when every link fails', async () => {
    const primary = stubTransport('peer-a', Number.POSITIVE_INFINITY);
    const fallback = stubTransport('peer-a', Number.POSITIVE_INFINITY);
    const composite = new CompositeTransport({ primary, fallback, maxRetries: 1 });

    const error = await composite.sendFrame(frame).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).code).toBe('all-links-failed');
  });

  it('forwards inbound frames from both links and closes them', async () => {
    const primaryInbound: Array<(frame: TransportFrame) => void> = [];
    const fallbackInbound: Array<(frame: TransportFrame) => void> = [];
    const primary: TransportLayer = {
      localPeerId: 'peer-a',
      async sendFrame() {},
      onFrame(handler) {
        primaryInbound.push(handler);
      },
      async close() {},
    };
    const fallback: TransportLayer = {
      localPeerId: 'peer-a',
      async sendFrame() {},
      onFrame(handler) {
        fallbackInbound.push(handler);
      },
      async close() {},
    };

    const composite = new CompositeTransport({ primary, fallback });
    const seen: TransportFrame[] = [];
    composite.onFrame((incoming) => seen.push(incoming));

    primaryInbound[0]!(frame);
    fallbackInbound[0]!(frame);
    expect(seen).toHaveLength(2);

    await composite.close();
  });
});

function fromHexLocal(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
