import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MemoryCRDTStore,
  compareEntries,
  type CRDTDelta,
  type CRDTEntry,
} from '../src/index.js';

/**
 * Property-based convergence checks for the LWW register map.
 *
 * The delivery order of deltas is arbitrary in a peer-to-peer mesh, so every
 * replica must land on the same state no matter which permutation it sees.
 */

const entryArbitrary: fc.Arbitrary<CRDTEntry> = fc.record({
  key: fc.constantFrom('alpha', 'beta', 'gamma', 'delta'),
  value: fc.integer({ min: -1000, max: 1000 }),
  // A tiny timestamp range forces a lot of ties, exercising the peer-id
  // tie-breaker instead of the timestamp comparison.
  timestamp: fc.integer({ min: 0, max: 3 }),
  peerId: fc.constantFrom('peer-a', 'peer-b', 'peer-c'),
});

function toDeltas(entries: ReadonlyArray<CRDTEntry>): CRDTDelta[] {
  return entries.map((entry) => ({ entries: [entry] }));
}

/** Ranks are used as sort keys, giving an arbitrary but deterministic order. */
function permutationArbitrary(length: number): fc.Arbitrary<number[]> {
  return fc.array(fc.nat({ max: 10_000 }), {
    minLength: length,
    maxLength: length,
  });
}

function applyInOrder(
  store: MemoryCRDTStore,
  deltas: ReadonlyArray<CRDTDelta>,
  ranks: ReadonlyArray<number>
): void {
  const order = deltas
    .map((_, index) => index)
    .sort((a, b) => ranks[a]! - ranks[b]! || a - b);
  for (const index of order) {
    store.applyDelta(deltas[index]!);
  }
}

/** Reference model: the entry that wins each key by compareEntries. */
function expectedWinners(entries: ReadonlyArray<CRDTEntry>): Map<string, CRDTEntry> {
  const winners = new Map<string, CRDTEntry>();
  for (const entry of entries) {
    const current = winners.get(entry.key);
    if (!current || compareEntries(entry, current) > 0) {
      winners.set(entry.key, entry);
    }
  }
  return winners;
}

describe('CRDT convergence properties', () => {
  it('converges to the same state for any pair of delivery permutations', () => {
    const scenario = fc
      .array(entryArbitrary, { maxLength: 24 })
      .chain((entries) =>
        fc.tuple(
          fc.constant(entries),
          permutationArbitrary(entries.length),
          permutationArbitrary(entries.length)
        )
      );

    fc.assert(
      fc.property(scenario, ([entries, ranksLeft, ranksRight]) => {
        const deltas = toDeltas(entries);
        const left = new MemoryCRDTStore();
        const right = new MemoryCRDTStore();

        applyInOrder(left, deltas, ranksLeft);
        applyInOrder(right, deltas, ranksRight);

        expect(left.getState()).toEqual(right.getState());
        expect(left.list()).toEqual(right.list());
        expect(left.size).toBe(right.size);
      }),
      { numRuns: 300 }
    );
  });

  it('matches the compareEntries reference model after any permutation', () => {
    const scenario = fc
      .array(entryArbitrary, { maxLength: 24 })
      .chain((entries) =>
        fc.tuple(fc.constant(entries), permutationArbitrary(entries.length))
      );

    fc.assert(
      fc.property(scenario, ([entries, ranks]) => {
        const store = new MemoryCRDTStore();
        applyInOrder(store, toDeltas(entries), ranks);

        const expected = expectedWinners(entries);
        expect(store.size).toBe(expected.size);

        for (const [key, winner] of expected) {
          const actual = store.get(key);
          expect(actual).toBeDefined();
          expect(actual!.value).toBe(winner.value);
          expect(actual!.timestamp).toBe(winner.timestamp);
          expect(actual!.peerId).toBe(winner.peerId);
        }
      }),
      { numRuns: 300 }
    );
  });

  it('is idempotent when every delta is delivered twice', () => {
    const scenario = fc
      .array(entryArbitrary, { maxLength: 24 })
      .chain((entries) =>
        fc.tuple(fc.constant(entries), permutationArbitrary(entries.length))
      );

    fc.assert(
      fc.property(scenario, ([entries, ranks]) => {
        const deltas = toDeltas(entries);
        const store = new MemoryCRDTStore();

        applyInOrder(store, deltas, ranks);
        const snapshot = store.getState();

        const replay = store.mergeDeltas(deltas);
        expect(replay.applied).toBe(0);
        expect(store.getState()).toEqual(snapshot);
      }),
      { numRuns: 200 }
    );
  });

  it('keeps replicas convergent when merging multi-entry batches in any order', () => {
    const scenario = fc
      .array(entryArbitrary, { maxLength: 24 })
      .chain((entries) => {
        const batches: CRDTDelta[] = [];
        for (let index = 0; index < entries.length; index += 3) {
          batches.push({ entries: entries.slice(index, index + 3) });
        }
        return fc.tuple(fc.constant(batches), permutationArbitrary(batches.length));
      });

    fc.assert(
      fc.property(scenario, ([batches, ranks]) => {
        const ordered = batches
          .map((_, index) => index)
          .sort((a, b) => ranks[a]! - ranks[b]! || a - b)
          .map((index) => batches[index]!);

        const left = new MemoryCRDTStore();
        left.mergeDeltas(ordered);

        const right = new MemoryCRDTStore();
        right.mergeDeltas([...ordered].reverse());

        expect(left.getState()).toEqual(right.getState());
      }),
      { numRuns: 200 }
    );
  });
});
