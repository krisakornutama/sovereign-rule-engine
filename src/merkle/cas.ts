import { SHA256 } from '@stablelib/sha256';
import { concatBytes, fromHex, toHex } from '../types.js';
import type { MerkleDiff } from './types.js';

export function sha256Bytes(data: Uint8Array): Uint8Array {
  return new SHA256().update(data).digest();
}

export function hashData(data: Uint8Array): string {
  return toHex(sha256Bytes(data));
}

export function hashNode(left: string, right: string): string {
  return toHex(sha256Bytes(concatBytes(fromHex(left), fromHex(right))));
}

export class InMemoryContentAddressStore {
  private readonly blobs = new Map<string, Uint8Array>();

  put(data: Uint8Array): string {
    const hash = hashData(data);
    if (!this.blobs.has(hash)) {
      this.blobs.set(hash, data.slice());
    }
    return hash;
  }

  get(hash: string): Uint8Array | undefined {
    const found = this.blobs.get(hash);
    return found ? found.slice() : undefined;
  }

  has(hash: string): boolean {
    return this.blobs.has(hash);
  }

  get size(): number {
    return this.blobs.size;
  }

  clear(): void {
    this.blobs.clear();
  }
}

/** Root of a binary Merkle tree; odd nodes are paired with themselves. */
export function merkleRoot(leaves: ReadonlyArray<string>): string {
  if (leaves.length === 0) {
    return hashData(new Uint8Array(0));
  }

  let level: string[] = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as string;
      const right = level[i + 1] ?? left;
      next.push(hashNode(left, right));
    }
    level = next;
  }

  return level[0] as string;
}

/** Which leaves the other side is missing, given both leaf sets. */
export function merkleDiff(
  localLeaves: ReadonlyArray<string>,
  remoteLeaves: ReadonlyArray<string>
): MerkleDiff {
  const local = new Set(localLeaves);
  const remote = new Set(remoteLeaves);

  return {
    missingLocally: [...remote].filter((leaf) => !local.has(leaf)),
    missingRemotely: [...local].filter((leaf) => !remote.has(leaf)),
  };
}
