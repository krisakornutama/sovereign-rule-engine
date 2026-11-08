import { randomBytes, toHex } from '../types.js';

export type PeerId = string;

export interface TransportFrame {
  readonly from: PeerId;
  readonly to: PeerId;
  readonly payload: Uint8Array;
}

export interface TransportLayer {
  readonly localPeerId: PeerId;
  sendFrame(frame: TransportFrame): Promise<void>;
  onFrame(handler: (frame: TransportFrame) => void): void;
  close(): Promise<void>;
}

export function createPeerId(label: string): PeerId {
  return `${label}-${toHex(randomBytes(4))}`;
}
