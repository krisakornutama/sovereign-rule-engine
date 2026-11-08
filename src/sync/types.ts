export type SyncEventType =
  'PEER_CONNECTED' | 'SYNC_ANNOUNCE' | 'DELTA_BATCH' | 'STATE_CONVERGED' | 'SYNC_ERROR';

export interface SyncEvent {
  readonly type: SyncEventType;
  readonly payload: Record<string, unknown>;
  readonly timestamp: number;
  readonly sourcePeerId?: string;
}
