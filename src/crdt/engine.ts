import type {
  ConflictRecord,
  CRDTDelta,
  CRDTEntry,
  CRDTMergeResult,
  CRDTState,
} from './types.js';

/**
 * Last-writer-wins register map with a deterministic tie-breaker:
 * higher timestamp wins, and on equal timestamps the lexicographically
 * greater peer id wins. Every replica therefore converges on the same value.
 */
export class MemoryCRDTStore {
  private readonly entries = new Map<string, CRDTEntry>();
  private readonly changeListeners: Array<(delta: CRDTDelta) => void> = [];

  on(event: 'crdt:change', listener: (delta: CRDTDelta) => void): void {
    if (event === 'crdt:change') {
      this.changeListeners.push(listener);
    }
  }

  private notifyChange(delta: CRDTDelta): void {
    for (const listener of [...this.changeListeners]) {
      listener(delta);
    }
  }

  set(
    key: string,
    value: unknown,
    peerId: string,
    timestamp: number = Date.now()
  ): CRDTEntry {
    const incoming: CRDTEntry = { key, value, timestamp, peerId };
    const existing = this.entries.get(key);

    if (!existing || compareEntries(incoming, existing) > 0) {
      this.entries.set(key, incoming);
      this.notifyChange({ entries: [incoming] });
      return incoming;
    }

    return existing;
  }

  applyDelta(delta: CRDTDelta): CRDTMergeResult {
    const conflicts: ConflictRecord[] = [];
    const accepted: CRDTEntry[] = [];

    for (const incoming of delta.entries) {
      const existing = this.entries.get(incoming.key);
      if (!existing) {
        this.entries.set(incoming.key, incoming);
        accepted.push(incoming);
        continue;
      }

      if (compareEntries(incoming, existing) > 0) {
        this.entries.set(incoming.key, incoming);
        accepted.push(incoming);
      } else if (compareEntries(incoming, existing) < 0) {
        conflicts.push({ key: incoming.key, kept: existing, rejected: incoming });
      }
    }

    if (accepted.length > 0) {
      this.notifyChange({ entries: accepted });
    }

    return { applied: accepted.length, conflicts };
  }

  mergeDeltas(deltas: ReadonlyArray<CRDTDelta>): CRDTMergeResult {
    let applied = 0;
    const conflicts: ConflictRecord[] = [];

    for (const delta of deltas) {
      const result = this.applyDelta(delta);
      applied += result.applied;
      conflicts.push(...result.conflicts);
    }

    return { applied, conflicts };
  }

  get(key: string): CRDTEntry | undefined {
    return this.entries.get(key);
  }

  list(): CRDTEntry[] {
    return [...this.entries.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  getState(): CRDTState {
    const state: Record<string, CRDTEntry> = {};
    for (const entry of this.entries.values()) {
      state[entry.key] = entry;
    }
    return state;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Negative when `a` loses to `b`, positive when `a` wins. */
export function compareEntries(a: CRDTEntry, b: CRDTEntry): number {
  if (a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  if (a.peerId === b.peerId) return 0;
  return a.peerId > b.peerId ? 1 : -1;
}

export function createMemoryCRDTStore(): MemoryCRDTStore {
  return new MemoryCRDTStore();
}
