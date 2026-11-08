import { describe, expect, it } from 'vitest';
import {
  SimpleRuleEngine,
  type ActionContext,
  type ActionDispatcher,
  type RuleEvent,
} from '../src/index.js';

function createRecordingDispatcher() {
  const order: string[] = [];
  const dispatcher: ActionDispatcher = {
    dispatch(context: ActionContext): void {
      order.push(context.rule.name);
    },
  };
  return { dispatcher, order };
}

const event: RuleEvent = {
  type: 'telemetry',
  payload: { temp: 45 },
  timestamp: 1_000,
};

function addRule(engine: SimpleRuleEngine, name: string, priority: number): void {
  engine.addRuleFromDefinition({
    id: name.toLowerCase(),
    name,
    priority,
    eventTypes: ['telemetry'],
    condition: { field: 'temp', operator: '>', value: 40 },
    action: { type: 'log' },
  });
}

describe('rule priority ordering', () => {
  it('dispatches matching rules from highest to lowest priority', async () => {
    const { dispatcher, order } = createRecordingDispatcher();
    const engine = new SimpleRuleEngine({ actionDispatcher: dispatcher });

    addRule(engine, 'Low', 1);
    addRule(engine, 'High', 10);
    addRule(engine, 'Medium', 5);

    await engine.evaluate(event);
    expect(order).toEqual(['High', 'Medium', 'Low']);
  });

  it('keeps insertion order for equal priorities', async () => {
    const { dispatcher, order } = createRecordingDispatcher();
    const engine = new SimpleRuleEngine({ actionDispatcher: dispatcher });

    addRule(engine, 'First', 3);
    addRule(engine, 'Second', 3);
    addRule(engine, 'Third', 3);

    await engine.evaluate(event);
    expect(order).toEqual(['First', 'Second', 'Third']);
  });

  it('skips non-matching events and disabled rules, then resumes after enable', async () => {
    const { dispatcher, order } = createRecordingDispatcher();
    const engine = new SimpleRuleEngine({ actionDispatcher: dispatcher });

    addRule(engine, 'High', 10);
    addRule(engine, 'Low', 1);

    await engine.evaluate({ ...event, payload: { temp: 10 } });
    expect(order).toEqual([]);

    engine.disableRule('high');
    await engine.evaluate(event);
    expect(order).toEqual(['Low']);

    order.length = 0;
    engine.enableRule('high');
    await engine.evaluate(event);
    expect(order).toEqual(['High', 'Low']);
  });

  it('ignores unknown rule ids and keeps rules sorted deterministically', () => {
    const { dispatcher } = createRecordingDispatcher();
    const engine = new SimpleRuleEngine({ actionDispatcher: dispatcher });

    addRule(engine, 'High', 10);
    addRule(engine, 'Low', 1);

    expect(() => engine.disableRule('missing')).not.toThrow();
    expect(() => engine.enableRule('missing')).not.toThrow();
    expect(engine.getEnabledRules()).toHaveLength(2);
  });

  it('applies the dispatcher default priority when a definition omits one', async () => {
    const { dispatcher, order } = createRecordingDispatcher();
    const engine = new SimpleRuleEngine({ actionDispatcher: dispatcher });

    engine.addRuleFromDefinition({
      id: 'explicit',
      name: 'Explicit',
      priority: 1,
      eventTypes: ['telemetry'],
      condition: { field: 'temp', operator: '>', value: 40 },
      action: { type: 'log' },
    });
    const parsed = engine.addRuleFromDefinition({
      id: 'defaulted',
      name: 'Defaulted',
      eventTypes: ['telemetry'],
      condition: { field: 'temp', operator: '>', value: 40 },
      action: { type: 'log' },
    });

    expect(parsed.priority).toBe(0);
    await engine.evaluate(event);
    expect(order).toEqual(['Explicit', 'Defaulted']);
  });
});
