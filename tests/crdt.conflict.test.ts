import { describe, expect, it } from 'vitest';
import {
  MemoryCRDTStore,
  compareEntries,
  type CRDTEntry,
} from '../src/index.js';

function entry(
  key: string,
  value: unknown,
  timestamp: number,
  peerId: string
): CRDTEntry {
  return { key, value, timestamp, peerId };
}

describe('CRDT last-writer-wins tie-break', () => {
  it('keeps the higher timestamp regardless of arrival order', () => {
    const oldEntry = entry('sensor', 'old', 1_000, 'peer-z');
    const newEntry = entry('sensor', 'new', 2_000, 'peer-a');

    const forward = new MemoryCRDTStore();
    forward.set(oldEntry.key, oldEntry.value, oldEntry.peerId, oldEntry.timestamp);
    forward.set(newEntry.key, newEntry.value, newEntry.peerId, newEntry.timestamp);

    const backward = new MemoryCRDTStore();
    backward.set(newEntry.key, newEntry.value, newEntry.peerId, newEntry.timestamp);
    backward.set(oldEntry.key, oldEntry.value, oldEntry.peerId, oldEntry.timestamp);

    expect(forward.get('sensor')?.value).toBe('new');
    expect(backward.get('sensor')?.value).toBe('new');
  });

  it('breaks a timestamp tie with the lexicographically greater peer id', () => {
    const fromA = entry('temp', 'from-a', 5_000, 'peer-a');
    const fromB = entry('temp', 'from-b', 5_000, 'peer-b');

    const aFirst = new MemoryCRDTStore();
    aFirst.applyDelta({ entries: [fromA] });
    aFirst.applyDelta({ entries: [fromB] });

    const bFirst = new MemoryCRDTStore();
    bFirst.applyDelta({ entries: [fromB] });
    bFirst.applyDelta({ entries: [fromA] });

    expect(aFirst.get('temp')?.value).toBe('from-b');
    expect(bFirst.get('temp')?.value).toBe('from-b');
    expect(aFirst.get('temp')?.peerId).toBe('peer-b');
    expect(compareEntries(fromB, fromA)).toBeGreaterThan(0);
    expect(compareEntries(fromA, fromB)).toBeLessThan(0);
  });

  it('orders same-timestamp same-peer writes by canonical value (regression)', () => {
    // One peer writing the same key twice within the same millisecond would
    // otherwise be unordered, so replicas could diverge permanently.
    const first = entry('k', 1, 100, 'peer-a');
    const second = entry('k', 2, 100, 'peer-a');

    const forward = new MemoryCRDTStore();
    forward.applyDelta({ entries: [first] });
    forward.applyDelta({ entries: [second] });

    const backward = new MemoryCRDTStore();
    backward.applyDelta({ entries: [second] });
    backward.applyDelta({ entries: [first] });

    expect(forward.get('k')?.value).toBe(2);
    expect(backward.get('k')?.value).toBe(2);
    expect(compareEntries(second, first)).toBeGreaterThan(0);
  });

  it('treats identical timestamp and peer as a no-op', () => {
    const same = entry('key', 'value', 7_000, 'peer-a');
    const store = new MemoryCRDTStore();
    store.applyDelta({ entries: [same] });

    const result = store.applyDelta({ entries: [same] });
    expect(result.applied).toBe(0);
    expect(result.conflicts).toHaveLength(0);
    expect(compareEntries(same, same)).toBe(0);
  });

  it('records a conflict when an older delta is rejected', () => {
    const store = new MemoryCRDTStore();
    store.applyDelta({ entries: [entry('key', 'kept', 9_000, 'peer-a')] });

    const rejected = entry('key', 'stale', 1_000, 'peer-z');
    const result = store.applyDelta({ entries: [rejected] });

    expect(result.applied).toBe(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.kept.value).toBe('kept');
    expect(result.conflicts[0]?.rejected.value).toBe('stale');
    expect(store.get('key')?.value).toBe('kept');
  });

  it('converges two replicas that merge the same deltas in opposite order', () => {
    const deltas = [
      { entries: [entry('a', 1, 100, 'peer-a')] },
      { entries: [entry('b', 2, 200, 'peer-b')] },
      { entries: [entry('a', 3, 100, 'peer-b')] },
      { entries: [entry('c', 4, 50, 'peer-c')] },
    ];

    const left = new MemoryCRDTStore();
    left.mergeDeltas(deltas);

    const right = new MemoryCRDTStore();
    right.mergeDeltas([...deltas].reverse());

    expect(left.getState()).toEqual(right.getState());
    expect(left.list()).toEqual(right.list());
    expect(left.size).toBe(3);
  });
});
