# sovereign-rule-engine

[![CI](https://github.com/krisakornutama/sovereign-rule-engine/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/krisakornutama/sovereign-rule-engine/actions/workflows/ci.yml)

Offline-first decision layer for **Sovereign OS**: an if-this-then-that rule engine
running on top of a peer-to-peer, end-to-end-encrypted local sync stack.

Everything is plain `Uint8Array` and pure TypeScript, so the same code runs on
Node.js 18+ and in the browser / PWA.

## Layers

| Layer     | Files                        | Responsibility                                                                                                                |
| --------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Transport | `src/transport/*`            | Abstract `TransportLayer` (`sendFrame` / `onFrame`), in-memory network, composite link with fallback + retry                  |
| Crypto    | `src/crypto/*`               | Mutual-auth handshake (Ed25519 + ephemeral X25519 + HKDF), XChaCha20-Poly1305 envelopes, 24-byte nonce, sliding replay window |
| Storage   | `src/merkle/*`, `src/crdt/*` | SHA-256 content-addressed store, Merkle roots/diff, LWW CRDT register map                                                     |
| Sync      | `src/sync/*`                 | Encrypted announce → delta batch → merge → ack, with a `sync:event` listener                                                  |
| Rules     | `src/rule-engine/*`          | Rule parser, condition matcher, action dispatcher, engine, and the sync/CRDT bridge                                           |

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
npm run typecheck      # tsc --noEmit over src/ and tests/
npm test               # vitest: replay window, CRDT tie-break, rule priority
npm run rule-example   # standalone rule engine walkthrough
npm run example        # two-peer encrypted sync + rule reaction
npm run build          # emit dist/
```

## Development

Requirements: Node.js 20+ for the toolchain (CI runs the Node 20 and 22 matrix).
The published library itself targets Node 18+ and modern browsers.

```bash
npm install

npm test               # 87 vitest tests (unit, integration, property-based)
npm run test:coverage  # v8 coverage report in coverage/ + threshold gate
npm run lint           # ESLint (flat config, type-aware TS rules)
npm run format:check   # Prettier check (npm run format to rewrite)
npm run typecheck      # tsc over src/ and tests/
npm run rule-example   # rule engine walkthrough
npm run example        # two-peer encrypted sync simulation
npm run build          # emit dist/ with declarations
```

Coverage is reported as `text`, `lcov` and `json-summary` in `coverage/`
(git-ignored). The gate in `vitest.config.ts` is 90% lines/statements/functions
and 80% branches over `src/`; `npm run test:coverage` exits non-zero below that,
so CI fails on a regression.

CI (`.github/workflows/ci.yml`) runs on every push to `main` and every pull
request: `npm ci` → lint → format check → typecheck → tests with coverage →
build, on Node 20 and 22. ESLint runs type-aware rules over `src/` and `tests/`
(`@typescript-eslint/no-floating-promises`, `await-thenable`), so a dropped
promise fails the build instead of surfacing later as a flaky test.
Each leg uploads its report as the `coverage-node-20` / `coverage-node-22`
artifact (14 days).

Pull requests also get a `diff coverage` job. It downloads the
`coverage-node-20` artifact instead of running the suite a third time, then runs
a pinned `diff-cover` (11.0.1) against the merge base and fails when fewer than
90% of the **new or changed** lines are covered, so untouched legacy code cannot
block a PR. The gate value lives once in the workflow `env`, and the report is
uploaded as the `diff-coverage-report` artifact and written to the run summary.

A final `report` job waits for both and posts a single sticky comment with the
coverage table and the changed-lines result, updated in place on every push —
including when the diff gate fails. Fork PRs are skipped because their token is
read-only.

## Notes

- Rules are plain data: persist them with any store, replicate them through the
  same CRDT layer, or ship them as JSON.
- The default resolver is last-writer-wins with a deterministic total order:
  higher timestamp wins, then the lexicographically greater peer id, then the
  canonically greater value (so one peer's two writes in the same millisecond
  still resolve identically on every replica). Replicas converge without a
  coordinator.
- `TransportLayer` is the only integration point needed for real links
  (Bluetooth LE, Wi-Fi Direct, LoRa, localhost sockets).
- Test suite (`tests/`) covers the 64-message replay window including its
  exact boundary, duplicate nonces, tampered envelopes, CRDT tie-breaking by
  peer id and by canonical value, merge-order convergence, and deterministic
  rule priority ordering.
- `tests/*.property.test.ts` uses fast-check to assert CRDT convergence over
  random entries and random delivery permutations, including duplicate-delivery
  idempotence; CI runs it on Node 20 and 22 for every push and pull request.

## License

MIT
