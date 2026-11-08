export interface CRDTEntry {
  readonly key: string;
  readonly value: unknown;
  readonly timestamp: number;
  readonly peerId: string;
}

export interface CRDTDelta {
  readonly entries: ReadonlyArray<CRDTEntry>;
}

export interface CRDTState {
  readonly [key: string]: CRDTEntry;
}

export interface ConflictRecord {
  readonly key: string;
  readonly kept: CRDTEntry;
  readonly rejected: CRDTEntry;
}

export interface CRDTMergeResult {
  readonly applied: number;
  readonly conflicts: ReadonlyArray<ConflictRecord>;
}
