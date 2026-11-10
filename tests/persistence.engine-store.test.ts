import { describe, expect, it } from 'vitest';
import { SimpleRuleEngine } from '../src/rule-engine/engine.js';
import type { Rule } from '../src/rule-engine/types.js';
import {
  ENGINE_STATE_KEY,
  applyEngineState,
  captureEngineState,
  loadEngineState,
  saveEngineState,
  type EngineVault,
} from '../src/persistence/engine-store.js';

/**
 * Stand-in for `sovereign-vault`: same has/get/put surface, bytes stored as-is.
 * The real vault encrypts and authenticates them; this test only proves the
 * engine round-trips through that surface.
 */
class FakeVault implements EngineVault {
  readonly bytes = new Map<string, Uint8Array>();

  has(key: string): boolean {
    return this.bytes.has(key);
  }

  async get(key: string): Promise<Uint8Array> {
    const value = this.bytes.get(key);
    if (!value) throw new Error(`missing key: ${key}`);
    return value;
  }

  async put(key: string, value: Uint8Array): Promise<unknown> {
    this.bytes.set(key, value);
    return { key };
  }
}

function makeEngine(): SimpleRuleEngine {
  return new SimpleRuleEngine({ actionDispatcher: { dispatch: () => {} } });
}

function rule(id: string, priority = 0, enabled = true): Rule {
  return {
    id,
    name: `rule ${id}`,
    priority,
    enabled,
    eventTypes: ['sensor.reading'],
    condition: { field: 'value', operator: 'gt', value: 10 },
    action: { type: 'alert', payload: { channel: 'local' } },
    createdAt: 1,
    updatedAt: 2,
  };
}

function seed(engine: SimpleRuleEngine): void {
  engine.addRule(rule('a', 5));
  engine.addRule(rule('b', 9, false));
  engine.setState({ lastEvent: 'sensor.reading', count: 3 });
}

describe('captureEngineState / applyEngineState', () => {
  it('round-trips rules and state into a fresh engine', () => {
    const source = makeEngine();
    seed(source);

    const target = makeEngine();
    applyEngineState(target, captureEngineState(source));

    expect(target.getRules()).toEqual(source.getRules());
    expect(target.getState()).toEqual(source.getState());
    expect(target.getEnabledRules().map((r) => r.id)).toEqual(['a']);
  });

  it('replaces existing rules instead of merging them', () => {
    const engine = makeEngine();
    seed(engine);
    applyEngineState(engine, {
      version: 1,
      rules: [rule('only')],
      state: {},
    });
    expect(engine.getRules().map((r) => r.id)).toEqual(['only']);
    expect(engine.getState()).toEqual({});
  });

  it('leaves the running engine untouched when the snapshot is corrupt', () => {
    const engine = makeEngine();
    seed(engine);
    const before = engine.getRules();

    expect(() => applyEngineState(engine, { version: 1, rules: [{ id: 1 }], state: {} })).toThrow(
      /invalid rules/
    );
    expect(engine.getRules()).toEqual(before);
  });

  it('rejects non-object snapshots', () => {
    expect(() => applyEngineState(makeEngine(), null)).toThrow(/must be an object/);
    expect(() => applyEngineState(makeEngine(), ['rules'])).toThrow(/must be an object/);
  });

  it('rejects an unsupported snapshot version', () => {
    expect(() => applyEngineState(makeEngine(), { version: 2, rules: [], state: {} })).toThrow(
      /version 2 is not supported/
    );
  });

  it('rejects rules that are not an array', () => {
    expect(() => applyEngineState(makeEngine(), { version: 1, rules: {}, state: {} })).toThrow(
      /invalid rules/
    );
  });

  it('rejects a malformed state payload', () => {
    expect(() => applyEngineState(makeEngine(), { version: 1, rules: [], state: [] })).toThrow(
      /invalid state/
    );
  });

  it('rejects rules with the wrong field types', () => {
    const broken = { ...rule('a'), eventTypes: ['ok', 7] };
    expect(() =>
      applyEngineState(makeEngine(), { version: 1, rules: [broken], state: {} })
    ).toThrow(/invalid rules/);
  });
});

describe('saveEngineState / loadEngineState', () => {
  it('returns false on a first boot with no snapshot', async () => {
    const vault = new FakeVault();
    const engine = makeEngine();
    await expect(loadEngineState(vault, engine)).resolves.toBe(false);
    expect(engine.getRules()).toEqual([]);
  });

  it('survives a restart through the same vault', async () => {
    const vault = new FakeVault();

    const before = makeEngine();
    seed(before);
    await saveEngineState(vault, before);

    const after = makeEngine();
    await expect(loadEngineState(vault, after)).resolves.toBe(true);
    expect(after.getRules()).toEqual(before.getRules());
    expect(after.getState()).toEqual(before.getState());
    expect(vault.has(ENGINE_STATE_KEY)).toBe(true);
  });

  it('keeps only the latest snapshot when saved twice', async () => {
    const vault = new FakeVault();
    const engine = makeEngine();
    seed(engine);
    await saveEngineState(vault, engine);

    engine.removeRule('a');
    engine.setState({ count: 99 });
    await saveEngineState(vault, engine);

    const restored = makeEngine();
    await loadEngineState(vault, restored);
    expect(restored.getRules().map((r) => r.id)).toEqual(['b']);
    expect(restored.getState()).toEqual({ count: 99 });
  });

  it('stores snapshots under a custom key', async () => {
    const vault = new FakeVault();
    const engine = makeEngine();
    seed(engine);
    await saveEngineState(vault, engine, 'rule-engine/acme');

    expect(vault.has(ENGINE_STATE_KEY)).toBe(false);
    const other = makeEngine();
    await expect(loadEngineState(vault, other, 'rule-engine/acme')).resolves.toBe(true);
    expect(other.getRules()).toHaveLength(2);
  });

  it('reports unreadable bytes instead of silently starting empty', async () => {
    const vault = new FakeVault();
    await vault.put(ENGINE_STATE_KEY, new TextEncoder().encode('{not json'));
    await expect(loadEngineState(vault, makeEngine())).rejects.toThrow(/not valid JSON/);
  });

  it('rejects a stored snapshot from a newer format', async () => {
    const vault = new FakeVault();
    await vault.put(
      ENGINE_STATE_KEY,
      new TextEncoder().encode(JSON.stringify({ version: 9, rules: [], state: {} }))
    );
    await expect(loadEngineState(vault, makeEngine())).rejects.toThrow(/version 9/);
  });
});
