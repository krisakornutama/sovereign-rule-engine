import { describe, expect, it } from 'vitest';
import {
  ActionDispatcherImpl,
  SimpleRuleEngine,
  type ActionContext,
  type ActionDispatcher,
  type Rule,
  type RuleEvent,
} from '../src/index.js';

const event: RuleEvent = {
  type: 'telemetry',
  payload: { temp: 45 },
  timestamp: 1,
};

function definition(id: string): Parameters<SimpleRuleEngine['addRuleFromDefinition']>[0] {
  return {
    id,
    name: id,
    eventTypes: ['telemetry'],
    condition: { field: 'temp', operator: '>', value: 40 },
    action: { type: 'log' },
  };
}

function silentDispatcher(): ActionDispatcher {
  return { dispatch(): void {} };
}

describe('SimpleRuleEngine lifecycle', () => {
  it('adds, updates, removes and clears rules', () => {
    const engine = new SimpleRuleEngine({ actionDispatcher: silentDispatcher() });
    const rule = engine.addRuleFromDefinition(definition('one'));

    expect(engine.getRules()).toHaveLength(1);
    engine.updateRule({ ...rule, name: 'Renamed', priority: 5 });
    expect(engine.getRules()[0]?.name).toBe('Renamed');
    expect(engine.getRules()[0]?.priority).toBe(5);

    expect(() => engine.updateRule({ ...rule, id: 'missing' })).toThrow(/Unknown rule/);

    engine.removeRule('one');
    expect(engine.getRules()).toHaveLength(0);

    engine.addRuleFromDefinition(definition('two'));
    engine.clearRules();
    expect(engine.getRules()).toHaveLength(0);
    expect(engine.getEnabledRules()).toHaveLength(0);
  });

  it('enforces maxRules for new rules but allows replacing an existing one', () => {
    const engine = new SimpleRuleEngine({
      actionDispatcher: silentDispatcher(),
      maxRules: 1,
    });
    engine.addRuleFromDefinition(definition('one'));

    expect(() => engine.addRuleFromDefinition(definition('two'))).toThrow(
      /Max rules \(1\) exceeded/
    );

    const [existing] = engine.getRules();
    engine.addRule({ ...(existing as Rule), name: 'replaced' });
    expect(engine.getRules()[1]).toBeUndefined();
    expect(engine.getRules()[0]?.name).toBe('replaced');
  });

  it('stores engine state and swaps dispatchers at runtime', async () => {
    const calls: string[] = [];
    const first: ActionDispatcher = {
      dispatch(context: ActionContext): void {
        calls.push(`first:${context.rule.id}`);
      },
    };
    const engine = new SimpleRuleEngine({
      actionDispatcher: first,
      state: { mode: 'eco' },
    });
    engine.addRuleFromDefinition(definition('one'));

    expect(engine.getState()).toEqual({ mode: 'eco' });
    engine.setState({ mode: 'turbo' });
    expect(engine.getState()).toEqual({ mode: 'turbo' });

    await engine.evaluate(event);
    expect(calls).toEqual(['first:one']);

    engine.setActionDispatcher({
      dispatch(context: ActionContext): void {
        calls.push(`second:${context.rule.id}`);
      },
    });
    await engine.evaluate(event);
    expect(calls).toEqual(['first:one', 'second:one']);
  });
});

describe('ActionDispatcherImpl', () => {
  it('registers handlers and surfaces unknown action types', async () => {
    const dispatcher = new ActionDispatcherImpl();
    const seen: string[] = [];
    dispatcher.registerAction('log', (context) => {
      seen.push(`${context.rule.name}:${context.event.type}`);
    });

    expect(dispatcher.hasAction('log')).toBe(true);
    expect(dispatcher.hasAction('alert')).toBe(false);

    const engine = new SimpleRuleEngine({ actionDispatcher: dispatcher });
    engine.addRuleFromDefinition(definition('one'));
    await engine.evaluate(event);
    expect(seen).toEqual(['one:telemetry']);

    dispatcher.unregisterAction('log');
    expect(dispatcher.hasAction('log')).toBe(false);
    await expect(engine.evaluate(event)).rejects.toThrow(/No handler registered/);
  });
});
