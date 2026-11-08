import { describe, expect, it } from 'vitest';
import {
  ActionDispatcherImpl,
  InMemoryNetwork,
  InMemoryTransport,
  LocalSyncEngine,
  MemoryCRDTStore,
  RuleEngineBridge,
  SimpleRuleEngine,
  createIdentity,
  type ActionContext,
  type ActionDispatcher,
  type PeerId,
  type SyncEvent,
} from '../src/index.js';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createPair() {
  const network = new InMemoryNetwork();
  const peerA: PeerId = 'peer-a';
  const peerB: PeerId = 'peer-b';

  const storeA = new MemoryCRDTStore();
  const storeB = new MemoryCRDTStore();

  const syncA = new LocalSyncEngine({
    peerId: peerA,
    identity: createIdentity(),
    transport: new InMemoryTransport(network, peerA),
    crdtStore: storeA,
  });
  const syncB = new LocalSyncEngine({
    peerId: peerB,
    identity: createIdentity(),
    transport: new InMemoryTransport(network, peerB),
    crdtStore: storeB,
  });

  syncA.start();
  syncB.start();

  const eventsA: SyncEvent[] = [];
  const eventsB: SyncEvent[] = [];
  syncA.on('sync:event', (event) => eventsA.push(event));
  syncB.on('sync:event', (event) => eventsB.push(event));

  return { network, peerA, peerB, storeA, storeB, syncA, syncB, eventsA, eventsB };
}

function recordingDispatcher(): { dispatcher: ActionDispatcher; fired: string[] } {
  const fired: string[] = [];
  return {
    fired,
    dispatcher: {
      dispatch(context: ActionContext): void {
        fired.push(`${context.rule.name}:${context.event.type}`);
      },
    },
  };
}

describe('encrypted local sync', () => {
  it('completes a mutual-auth handshake and reports PEER_CONNECTED on both sides', async () => {
    const { peerA, peerB, syncA, syncB, eventsA, eventsB } = createPair();

    const session = await syncA.connect(peerB);
    await flush();

    expect(session.sessionId).toMatch(/^[0-9a-f]{16}$/);
    expect(syncA.getSession(peerB)?.sessionId).toBe(session.sessionId);
    expect(syncB.getSession(peerA)?.sessionId).toBe(session.sessionId);
    expect(eventsA.map((event) => event.type)).toContain('PEER_CONNECTED');
    expect(eventsB.map((event) => event.type)).toContain('PEER_CONNECTED');
    expect(eventsB[0]?.sourcePeerId).toBe(peerA);

    // Connecting twice reuses the established session.
    const again = await syncA.connect(peerB);
    expect(again).toBe(session);
  });

  it('refuses to announce before connecting', async () => {
    const { peerB, syncA } = createPair();
    await expect(syncA.announce(peerB)).rejects.toThrow(/connect first/);
    await expect(
      syncA.sendDeltaBatch(peerB, [{ key: 'k', value: 1, timestamp: 1, peerId: 'peer-a' }])
    ).rejects.toThrow(/connect first/);
  });

  it('announces a differing root, syncs the delta and converges', async () => {
    const { peerB, storeA, storeB, syncA, syncB, eventsA, eventsB } = createPair();

    await syncA.connect(peerB);
    storeA.set('telemetry:greenhouse', { temp: 45 }, 'peer-a', 100);

    await syncA.announce(peerB);
    await flush();

    const announce = eventsB.find((event) => event.type === 'SYNC_ANNOUNCE');
    expect(announce?.payload.converged).toBe(false);
    expect(announce?.payload.remoteEntryCount).toBe(1);

    const sent = await syncA.sendDeltaBatch(peerB);
    await flush();

    expect(sent).toBe(1);
    expect(storeB.get('telemetry:greenhouse')?.value).toEqual({ temp: 45 });
    expect(syncB.localRoot()).toBe(syncA.localRoot());

    const converged = eventsA.find((event) => event.type === 'STATE_CONVERGED');
    expect(converged?.payload.converged).toBe(true);
    expect(converged?.payload.applied).toBe(1);
  });

  it('reports SYNC_ERROR for an encrypted frame with no session', async () => {
    const { network, peerB, syncB, eventsB } = createPair();
    const peerC: PeerId = 'peer-c';
    const transportC = new InMemoryTransport(network, peerC);

    await transportC.sendFrame({
      from: peerC,
      to: peerB,
      payload: new TextEncoder().encode(
        JSON.stringify({
          kind: 'secure',
          envelope: { version: 1, sessionId: 'x', senderPeerId: peerC, nonce: '', ciphertext: '' },
        })
      ),
    });
    await flush();

    const error = eventsB.find((event) => event.type === 'SYNC_ERROR');
    expect(error?.payload.message).toMatch(/No secure session/);
    expect(syncB.getSession(peerC)).toBeUndefined();
    await transportC.close();
  });
});

describe('RuleEngineBridge', () => {
  it('maps CRDT and sync events onto rule events', async () => {
    const { peerB, storeA, syncA, syncB } = createPair();

    const dispatcherB = recordingDispatcher();
    const rulesB = new SimpleRuleEngine({ actionDispatcher: dispatcherB.dispatcher });
    rulesB.addRuleFromDefinition({
      id: 'delta-merged',
      name: 'DeltaMerged',
      priority: 10,
      eventTypes: ['DELTA_MERGED'],
      condition: { field: 'entryCount', operator: '>', value: 0 },
      action: { type: 'log' },
    });
    rulesB.addRuleFromDefinition({
      id: 'delta-batch',
      name: 'DeltaBatch',
      eventTypes: ['DELTA_BATCH'],
      condition: { field: 'applied', operator: '>=', value: 1 },
      action: { type: 'log' },
    });
    new RuleEngineBridge({ ruleEngine: rulesB, crdtStore: syncB.crdtStore, syncEngine: syncB });

    const dispatcherA = recordingDispatcher();
    const rulesA = new SimpleRuleEngine({ actionDispatcher: dispatcherA.dispatcher });
    rulesA.addRuleFromDefinition({
      id: 'converged',
      name: 'Converged',
      eventTypes: ['STATE_CONVERGED'],
      condition: { field: 'converged', operator: '==', value: true },
      action: { type: 'log' },
    });
    new RuleEngineBridge({ ruleEngine: rulesA, syncEngine: syncA });

    await syncA.connect(peerB);
    storeA.set('config:mode', 'eco', 'peer-a', 200);
    await syncA.announce(peerB);
    await syncA.sendDeltaBatch(peerB);
    await flush();

    // Higher priority first, then the lower-priority batch event.
    expect(dispatcherB.fired).toEqual(['DeltaMerged:DELTA_MERGED', 'DeltaBatch:DELTA_BATCH']);
    expect(dispatcherA.fired).toContain('Converged:STATE_CONVERGED');
  });

  it('can emit events explicitly and reports dispatcher failures', async () => {
    const { syncB } = createPair();
    const dispatcher = new ActionDispatcherImpl();
    const fired: string[] = [];
    dispatcher.registerAction('log', (context) => {
      fired.push(`${context.rule.name}:${context.event.type}`);
    });

    const rules = new SimpleRuleEngine({ actionDispatcher: dispatcher });
    rules.addRuleFromDefinition({
      id: 'connected',
      name: 'Connected',
      eventTypes: ['PEER_CONNECTED'],
      condition: { field: 'remotePeerId', operator: 'exists', value: null },
      action: { type: 'log' },
    });

    const bridge = new RuleEngineBridge({
      ruleEngine: rules,
      crdtStore: syncB.crdtStore,
      syncEngine: syncB,
    });

    await bridge.emitSyncEvent('PEER_CONNECTED', { remotePeerId: 'peer-z' });
    expect(fired).toEqual(['Connected:PEER_CONNECTED']);

    // No handler registered for the rule's action type -> evaluate rejects.
    rules.addRuleFromDefinition({
      id: 'broken',
      name: 'Broken',
      eventTypes: ['PEER_CONNECTED'],
      condition: { field: 'remotePeerId', operator: 'exists', value: null },
      action: { type: 'unregistered' },
    });
    await expect(
      bridge.emit({ type: 'PEER_CONNECTED', payload: { remotePeerId: 'peer-z' }, timestamp: 1 })
    ).rejects.toThrow(/No handler registered/);
  });
});
