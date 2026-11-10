import type { Rule, RuleEngine } from '../rule-engine/types.js';

/**
 * The part of `sovereign-vault`'s `Vault` this adapter needs.
 * Structural on purpose: the engine stays dependency-free and any vault-like
 * store (real `Vault`, a test double, another encrypted KV) can be passed in.
 * `Vault` satisfies it as-is, so `saveEngineState(vault, engine)` type-checks.
 */
export interface EngineVault {
  has(key: string): boolean;
  get(key: string): Promise<Uint8Array>;
  put(key: string, bytes: Uint8Array): Promise<unknown>;
}

/** Key used inside the vault; the vault encrypts and authenticates the bytes. */
export const ENGINE_STATE_KEY = 'rule-engine/state';

const SNAPSHOT_VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * What survives a restart: the rule table and the working state the dispatcher
 * reads. CRDT/sync data has its own store and is not duplicated here.
 */
export interface EngineStateSnapshot {
  readonly version: number;
  readonly rules: ReadonlyArray<Rule>;
  readonly state: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRule(value: unknown): value is Rule {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.priority === 'number' &&
    typeof value.enabled === 'boolean' &&
    Array.isArray(value.eventTypes) &&
    value.eventTypes.every((type) => typeof type === 'string') &&
    isRecord(value.condition) &&
    isRecord(value.action) &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  );
}

function parseSnapshot(value: unknown): EngineStateSnapshot {
  if (!isRecord(value)) {
    throw new Error('rule-engine snapshot must be an object');
  }
  if (value.version !== SNAPSHOT_VERSION) {
    throw new Error(
      `rule-engine snapshot version ${String(value.version)} is not supported (expected ${SNAPSHOT_VERSION})`
    );
  }
  if (!Array.isArray(value.rules) || !value.rules.every(isRule)) {
    throw new Error('rule-engine snapshot has invalid rules');
  }
  if (!isRecord(value.state)) {
    throw new Error('rule-engine snapshot has invalid state');
  }
  return { version: SNAPSHOT_VERSION, rules: value.rules, state: value.state };
}

/** Reads rule table + state into a plain, JSON-safe snapshot. */
export function captureEngineState(engine: RuleEngine): EngineStateSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    rules: engine.getRules().map((rule) => ({ ...rule })),
    state: engine.getState(),
  };
}

/**
 * Replaces the engine's rules and state with a snapshot.
 * Validation happens before anything is cleared, so a corrupt snapshot leaves
 * the running engine untouched.
 */
export function applyEngineState(engine: RuleEngine, snapshot: unknown): void {
  const parsed = parseSnapshot(snapshot);
  engine.clearRules();
  for (const rule of parsed.rules) engine.addRule(rule);
  engine.setState(parsed.state);
}

/** Encrypts (inside the vault) and stores the current engine state. */
export async function saveEngineState(
  vault: EngineVault,
  engine: RuleEngine,
  key: string = ENGINE_STATE_KEY
): Promise<void> {
  const json = JSON.stringify(captureEngineState(engine));
  await vault.put(key, encoder.encode(json));
}

/**
 * Restores engine state from the vault.
 * Returns `false` when nothing was ever saved under `key`, so a first boot
 * does not look like a failure.
 */
export async function loadEngineState(
  vault: EngineVault,
  engine: RuleEngine,
  key: string = ENGINE_STATE_KEY
): Promise<boolean> {
  if (!vault.has(key)) return false;
  const raw = decoder.decode(await vault.get(key));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`rule-engine snapshot at "${key}" is not valid JSON`, { cause: error });
  }
  applyEngineState(engine, parsed);
  return true;
}
