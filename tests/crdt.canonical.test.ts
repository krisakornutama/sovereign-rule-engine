import { describe, expect, it } from 'vitest';
import {
  MemoryCRDTStore,
  canonicalValue,
  compareEntries,
  createMemoryCRDTStore,
  type CRDTDelta,
  type CRDTEntry,
} from '../src/index.js';

function entry(overrides: Partial<CRDTEntry> = {}): CRDTEntry {
  return { key: 'k', value: 1, timestamp: 100, peerId: 'peer-a', ...overrides };
}

describe('canonicalValue', () => {
  it('tags primitives so distinct types never collide', () => {
    expect(canonicalValue(null)).toBe('null');
    expect(canonicalValue(undefined)).toBe('undefined');
    expect(canonicalValue(true)).toBe('boolean:true');
    expect(canonicalValue(false)).toBe('boolean:false');
    expect(canonicalValue(1)).toBe('number:1');
    expect(canonicalValue('1')).toBe('string:1');
    expect(canonicalValue(1n)).toBe('bigint:1');
  });

  it('treats -0 as 0 and keeps special numbers distinguishable', () => {
    expect(canonicalValue(-0)).toBe('number:0');
    expect(canonicalValue(0)).toBe(canonicalValue(-0));
    expect(canonicalValue(Number.NaN)).toBe('number:NaN');
    expect(canonicalValue(Number.POSITIVE_INFINITY)).toBe('number:Infinity');
  });

  it('is stable for arrays, bytes and objects regardless of key order', () => {
    expect(canonicalValue([1, 'a', null])).toBe('array:[number:1,string:a,null]');
    expect(canonicalValue(new Uint8Array([1, 2, 255]))).toBe('bytes:1.2.255');
    expect(canonicalValue({ b: 2, a: 1 })).toBe(canonicalValue({ a: 1, b: 2 }));
    expect(canonicalValue({ nested: { y: [1], x: null } })).toBe(
      'object:{"nested":object:{"x":null,"y":array:[number:1]}}'
    );
    expect(canonicalValue([undefined])).not.toBe(canonicalValue([]));
  });

  it('falls back for symbols, functions and unserializable objects', () => {
    expect(canonicalValue(Symbol('tag'))).toBe('symbol:Symbol(tag)');
    const fn = () => undefined;
    expect(canonicalValue(fn)).toBe(`function:${String(fn)}`);

    const evil: Record<string, unknown> = {};
    Object.defineProperty(evil, 'boom', {
      enumerable: true,
      get() {
        throw new Error('cannot read');
      },
    });
    expect(canonicalValue(evil)).toBe('object:unserializable');
  });
});

describe('compareEntries total order', () => {
  it('orders by timestamp, then peer id, then canonical value', () => {
    expect(compareEntries(entry({ timestamp: 101 }), entry({ timestamp: 100 }))).toBeGreaterThan(0);
    expect(compareEntries(entry({ timestamp: 99 }), entry({ timestamp: 100 }))).toBeLessThan(0);

    expect(
      compareEntries(entry({ peerId: 'peer-b' }), entry({ peerId: 'peer-a' }))
    ).toBeGreaterThan(0);
    expect(compareEntries(entry({ peerId: 'peer-a' }), entry({ peerId: 'peer-b' }))).toBeLessThan(
      0
    );

    expect(compareEntries(entry({ value: 2 }), entry({ value: 1 }))).toBeGreaterThan(0);
    expect(compareEntries(entry({ value: 1 }), entry({ value: 2 }))).toBeLessThan(0);
    expect(compareEntries(entry(), entry())).toBe(0);
    expect(compareEntries(entry({ value: { a: 1 } }), entry({ value: { a: 1 } }))).toBe(0);
  });

  it('is antisymmetric for arbitrary value pairs', () => {
    const values: unknown[] = [
      null,
      undefined,
      0,
      -0,
      1,
      'a',
      'b',
      true,
      [1],
      { a: 1 },
      new Uint8Array([1]),
    ];
    for (const left of values) {
      for (const right of values) {
        const forward = compareEntries(entry({ value: left }), entry({ value: right }));
        const backward = compareEntries(entry({ value: right }), entry({ value: left }));
        expect(Math.sign(forward) + Math.sign(backward)).toBe(0);
      }
    }
  });
});

describe('MemoryCRDTStore writes and notifications', () => {
  it('accepts newer writes and keeps the existing entry otherwise', () => {
    const store = new MemoryCRDTStore();
    const written = store.set('config', { mode: 'eco' }, 'peer-a', 10);
    expect(store.size).toBe(1);
    expect(written.value).toEqual({ mode: 'eco' });

    const stale = store.set('config', { mode: 'turbo' }, 'peer-a', 5);
    expect(stale.value).toEqual({ mode: 'eco' });

    const equal = store.set('config', { mode: 'eco' }, 'peer-a', 10);
    expect(equal.value).toEqual({ mode: 'eco' });
    expect(store.get('config')?.timestamp).toBe(10);
  });

  it('uses the wall clock when no timestamp is supplied', () => {
    const store = new MemoryCRDTStore();
    const before = Date.now();
    const written = store.set('clock', 1, 'peer-a');
    expect(written.timestamp).toBeGreaterThanOrEqual(before);
    expect(written.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it('notifies crdt:change only when state actually changes', () => {
    const store = new MemoryCRDTStore();
    const deltas: CRDTDelta[] = [];
    store.on('crdt:change', (delta) => deltas.push(delta));

    store.set('a', 1, 'peer-a', 10);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.entries.map((item) => item.key)).toEqual(['a']);

    store.set('a', 2, 'peer-a', 5);
    expect(deltas).toHaveLength(1);

    // Unknown event names are ignored rather than registered.
    const ignored: CRDTDelta[] = [];
    (store.on as unknown as (event: string, listener: (delta: CRDTDelta) => void) => void)(
      'crdt:other',
      (delta) => ignored.push(delta)
    );
    store.set('b', 1, 'peer-a', 11);
    expect(ignored).toHaveLength(0);
    expect(deltas).toHaveLength(2);
  });
});

describe('MemoryCRDTStore delta merging', () => {
  it('applies new keys and newer writes, and records stale ones as conflicts', () => {
    const store = new MemoryCRDTStore();
    store.set('a', 'local', 'peer-a', 100);

    const delta: CRDTDelta = {
      entries: [
        { key: 'a', value: 'stale', timestamp: 50, peerId: 'peer-b' },
        { key: 'b', value: 'fresh', timestamp: 200, peerId: 'peer-b' },
        { key: 'c', value: 'new', timestamp: 1, peerId: 'peer-b' },
      ],
    };
    const result = store.applyDelta(delta);

    expect(result.applied).toBe(2);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.key).toBe('a');
    expect(result.conflicts[0]?.kept.value).toBe('local');
    expect(store.get('a')?.value).toBe('local');
    expect(store.get('b')?.value).toBe('fresh');
    expect(store.get('c')?.value).toBe('new');

    const stale = store.applyDelta({
      entries: [
        { key: 'a', value: 'older', timestamp: 10, peerId: 'peer-b' },
        { key: 'b', value: 'same', timestamp: 100, peerId: 'peer-a' },
      ],
    });
    expect(stale.applied).toBe(0);
    expect(stale.conflicts).toHaveLength(2);
    expect(stale.conflicts[0]?.kept.value).toBe('local');
    expect(stale.conflicts[0]?.rejected.value).toBe('older');
  });

  it('treats identical entries as a silent no-op and emits one change per batch', () => {
    const store = new MemoryCRDTStore();
    store.set('a', 1, 'peer-a', 100);
    const deltas: CRDTDelta[] = [];
    store.on('crdt:change', (delta) => deltas.push(delta));

    const identical = store.applyDelta({
      entries: [{ key: 'a', value: 1, timestamp: 100, peerId: 'peer-a' }],
    });
    expect(identical).toEqual({ applied: 0, conflicts: [] });
    expect(deltas).toHaveLength(0);

    store.applyDelta({
      entries: [
        { key: 'b', value: 1, timestamp: 200, peerId: 'peer-b' },
        { key: 'c', value: 1, timestamp: 201, peerId: 'peer-b' },
      ],
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.entries).toHaveLength(2);
  });

  it('aggregates multiple deltas', () => {
    const store = new MemoryCRDTStore();
    store.set('a', 1, 'peer-a', 10);

    const merged = store.mergeDeltas([
      { entries: [{ key: 'a', value: 2, timestamp: 20, peerId: 'peer-b' }] },
      { entries: [{ key: 'b', value: 1, timestamp: 5, peerId: 'peer-b' }] },
      { entries: [{ key: 'a', value: 0, timestamp: 1, peerId: 'peer-b' }] },
    ]);

    expect(merged.applied).toBe(2);
    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0]?.key).toBe('a');
    expect(store.size).toBe(2);
  });
});

describe('MemoryCRDTStore snapshots', () => {
  it('lists entries sorted by key, exposes state and clears', () => {
    const store = createMemoryCRDTStore();
    store.set('z', 1, 'peer-a', 1);
    store.set('a', 2, 'peer-a', 2);
    store.set('m', 3, 'peer-a', 3);

    expect(store.list().map((item) => item.key)).toEqual(['a', 'm', 'z']);
    expect(store.getState()).toEqual({
      a: store.get('a'),
      m: store.get('m'),
      z: store.get('z'),
    });
    expect(store.get('missing')).toBeUndefined();

    store.clear();
    expect(store.size).toBe(0);
    expect(store.list()).toEqual([]);
    expect(store.getState()).toEqual({});
  });
});
