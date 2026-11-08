# sovereign-rule-engine

Offline-first decision layer for **Sovereign OS**: an if-this-then-that rule engine
running on top of a peer-to-peer, end-to-end-encrypted local sync stack.

Everything is plain `Uint8Array` and pure TypeScript, so the same code runs on
Node.js 18+ and in the browser / PWA.

## Layers

| Layer | Files | Responsibility |
| --- | --- | --- |
| Transport | `src/transport/*` | Abstract `TransportLayer` (`sendFrame` / `onFrame`), in-memory network, composite link with fallback + retry |
| Crypto | `src/crypto/*` | Mutual-auth handshake (Ed25519 + ephemeral X25519 + HKDF), XChaCha20-Poly1305 envelopes, 24-byte nonce, sliding replay window |
| Storage | `src/merkle/*`, `src/crdt/*` | SHA-256 content-addressed store, Merkle roots/diff, LWW CRDT register map |
| Sync | `src/sync/*` | Encrypted announce → delta batch → merge → ack, with a `sync:event` listener |
| Rules | `src/rule-engine/*` | Rule parser, condition matcher, action dispatcher, engine, and the sync/CRDT bridge |

## Crypto model

```
nonce (24 bytes) = 16-byte random salt || 8-byte big-endian counter
AEAD             = XChaCha20-Poly1305, AAD binds session id + both peer ids
session key      = HKDF-SHA256(X25519 shared secret, salt = SHA256(E_A || E_B), 64 bytes)
                   -> 32 bytes A->B, 32 bytes B->A
```

- Handshake: `createHandshakeInit` → `acceptHandshake` → `finalizeHandshake`.
  Both identities sign their ephemeral keys, so authentication is mutual.
- Replay protection: sequences outside the 64-message sliding window and
  duplicate nonces are rejected before decryption.

## Rule engine

```ts
const dispatcher = new ActionDispatcherImpl();
dispatcher.registerAction('alert', (ctx) => {
  console.log(ctx.rule.name, ctx.event.payload);
});

const engine = new SimpleRuleEngine({ actionDispatcher: dispatcher });

engine.addRuleFromDefinition({
  id: 'high-temperature',
  name: 'HighTemperature',
  priority: 10,
  eventTypes: ['telemetry'],
  condition: { field: 'temp', operator: '>', value: 40 },
  action: { type: 'alert', payload: { message: 'Temperature exceeds threshold' } },
});

await engine.evaluate({
  type: 'telemetry',
  payload: { temp: 45 },
  timestamp: Date.now(),
});
```

Supported operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`,
`exists` (symbolic forms such as `>`, `==`, `!=` are accepted by the parser).
Dotted fields (`sensor.temp`) are resolved against the event payload.

### Bridge to the sync layer

`RuleEngineBridge` subscribes automatically:

- `MemoryCRDTStore` change → `DELTA_MERGED` event (`keys`, `entryCount`, `delta`)
- `LocalSyncEngine` event → rule event of the same type
  (`PEER_CONNECTED`, `SYNC_ANNOUNCE`, `DELTA_BATCH`, `STATE_CONVERGED`, `SYNC_ERROR`)

```ts
const bridge = new RuleEngineBridge({ ruleEngine, crdtStore, syncEngine });
```

## Scripts

```bash
npm install
npm run typecheck      # tsc --noEmit
npm run rule-example   # standalone rule engine walkthrough
npm run example        # two-peer encrypted sync + rule reaction
npm run build          # emit dist/
```

## Notes

- Rules are plain data: persist them with any store, replicate them through the
  same CRDT layer, or ship them as JSON.
- The default resolver is last-writer-wins (higher timestamp wins, peer id
  breaks ties), so replicas converge without a coordinator.
- `TransportLayer` is the only integration point needed for real links
  (Bluetooth LE, Wi-Fi Direct, LoRa, localhost sockets).

## License

MIT
