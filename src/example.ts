import { InMemoryNetwork, InMemoryTransport } from './transport/in-memory.js';
import { createPeerId } from './transport/types.js';
import { createIdentity } from './crypto/session.js';
import { LocalSyncEngine } from './sync/engine.js';
import { MemoryCRDTStore } from './crdt/engine.js';
import { SimpleRuleEngine } from './rule-engine/engine.js';
import { ActionDispatcherImpl } from './rule-engine/dispatcher.js';
import { RuleEngineBridge } from './rule-engine/bridge.js';
import { utf8ToBytes } from './types.js';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function main(): Promise<void> {
  console.log('=== Sovereign Local Sync — E2E Simulation ===\n');

  const network = new InMemoryNetwork();
  const peerA = createPeerId('peer-a');
  const peerB = createPeerId('peer-b');

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

  console.log('[1] Mutual-auth handshake (Ed25519 + X25519 ECDH + HKDF)');
  const session = await syncA.connect(peerB);
  console.log(`    A: ${peerA}`);
  console.log(`    B: ${peerB}`);
  console.log(`    ✓ secure session ${session.sessionId}\n`);

  const sample = utf8ToBytes('{"temp":45,"humidity":62}');
  const envelope = session.encrypt(sample);
  console.log('[2] Envelope encryption (XChaCha20-Poly1305, nonce = salt||counter)');
  console.log(`    plaintext: ${sample.length} bytes`);
  console.log(
    `    ciphertext: ${envelope.ciphertext.length} base64 chars, nonce: ${envelope.nonce.length} base64 chars\n`
  );

  console.log('[3] Encrypted Merkle announce');
  storeA.set('telemetry:greenhouse', { temp: 45, humidity: 62 }, peerA);
  await syncA.announce(peerB);
  await flush();
  console.log('    → roots differ, A sends encrypted delta\n');

  console.log('[4] Encrypted CRDT delta batch');
  const sent = await syncA.sendDeltaBatch(peerB);
  await flush();
  console.log(`    sent entries: ${sent}`);
  console.log(`    B entries: ${storeB.size}\n`);

  console.log('[5] Convergence');
  const rootA = syncA.localRoot();
  const rootB = syncB.localRoot();
  console.log(`    A root: ${rootA}`);
  console.log(`    B root: ${rootB}`);
  console.log(
    rootA === rootB
      ? `    ✓ converged (${storeB.size} entry)\n`
      : '    ✗ divergence detected\n'
  );

  console.log('[6] Offline rule engine (reacts to synced deltas)');
  const dispatcher = new ActionDispatcherImpl();
  dispatcher.registerAction('log', (ctx) => {
    console.log(`    [RULE] ${ctx.rule.name} fired for`, ctx.event.payload.keys);
  });

  const rules = new SimpleRuleEngine({ actionDispatcher: dispatcher });
  rules.addRuleFromDefinition({
    id: 'telemetry-merged',
    name: 'TelemetryMerged',
    eventTypes: ['DELTA_BATCH'],
    condition: { field: 'applied', operator: '>=', value: 1 },
    action: { type: 'log' },
  });
  rules.addRuleFromDefinition({
    id: 'delta-merged',
    name: 'DeltaMerged',
    eventTypes: ['DELTA_MERGED'],
    condition: { field: 'entryCount', operator: '>', value: 0 },
    action: { type: 'log' },
  });

  // Constructing the bridge auto-subscribes to CRDT/sync events.
  const bridge = new RuleEngineBridge({
    ruleEngine: rules,
    crdtStore: storeB,
    syncEngine: syncB,
  });
  void bridge;

  // A second offline write exercises the bridge end to end.
  storeA.set('telemetry:greenhouse', { temp: 47, humidity: 60 }, peerA);
  await syncA.announce(peerB);
  await syncA.sendDeltaBatch(peerB);
  await flush();

  const finalA = syncA.localRoot();
  const finalB = syncB.localRoot();
  console.log(
    `\n=== Simulation complete: ${rules.getRules().length} rules loaded, B holds ${storeB.size} entry, roots match=${finalA === finalB} ===`
  );

  await syncA.close();
  await syncB.close();
}

main().catch((error) => {
  console.error('Simulation failed:', error);
  process.exitCode = 1;
});
