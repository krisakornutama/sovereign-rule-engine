import type { RuleEngine, RuleEvent } from './types.js';
import type { MemoryCRDTStore } from '../crdt/engine.js';
import type { CRDTDelta } from '../crdt/types.js';
import type { LocalSyncEngine } from '../sync/engine.js';
import type { SyncEvent, SyncEventType } from '../sync/types.js';

export interface RuleEngineBridgeConfig {
  readonly ruleEngine: RuleEngine;
  readonly crdtStore?: MemoryCRDTStore;
  readonly syncEngine?: LocalSyncEngine;
  readonly autoSubscribe?: boolean;
  readonly onError?: (error: unknown) => void;
}

/**
 * Connects the offline data plane to the rule plane:
 *   CRDT change  -> DELTA_MERGED event
 *   sync event   -> same-named rule event
 */
export class RuleEngineBridge {
  private readonly ruleEngine: RuleEngine;
  private readonly crdtStore?: MemoryCRDTStore;
  private readonly syncEngine?: LocalSyncEngine;
  private readonly onError: (error: unknown) => void;
  private subscribed = false;

  constructor(config: RuleEngineBridgeConfig) {
    this.ruleEngine = config.ruleEngine;
    this.crdtStore = config.crdtStore;
    this.syncEngine = config.syncEngine;
    this.onError = config.onError ?? ((error) => console.error('[rule-engine]', error));

    if (config.autoSubscribe ?? true) {
      this.subscribe();
    }
  }

  subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;

    this.syncEngine?.on('sync:event', (event: SyncEvent) => {
      this.emit(this.fromSyncEvent(event)).catch(this.onError);
    });

    this.crdtStore?.on('crdt:change', (delta: CRDTDelta) => {
      this.emitDeltaMerged(delta).catch(this.onError);
    });
  }

  emit(event: RuleEvent): Promise<void> {
    return this.ruleEngine.evaluate(event);
  }

  emitSyncEvent(
    type: SyncEventType,
    payload: Record<string, unknown>
  ): Promise<void> {
    return this.ruleEngine.evaluate({
      type,
      payload,
      timestamp: Date.now(),
    });
  }

  emitDeltaMerged(delta: CRDTDelta): Promise<void> {
    return this.ruleEngine.evaluate({
      type: 'DELTA_MERGED',
      payload: {
        keys: delta.entries.map((entry) => entry.key),
        entryCount: delta.entries.length,
        delta,
      },
      timestamp: Date.now(),
    });
  }

  private fromSyncEvent(event: SyncEvent): RuleEvent {
    return {
      type: event.type,
      payload: event.payload,
      timestamp: event.timestamp,
      sourcePeerId: event.sourcePeerId,
    };
  }
}
