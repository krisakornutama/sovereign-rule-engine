export interface ContentAddressedBlob {
  readonly hash: string;
  readonly data: Uint8Array;
}

export interface MerkleDiff {
  readonly missingLocally: ReadonlyArray<string>;
  readonly missingRemotely: ReadonlyArray<string>;
}
