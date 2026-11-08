import { describe, expect, it } from 'vitest';
import {
  evaluateCondition,
  matchesEvent,
  parseCondition,
  parseRuleDefinition,
  parseRuleJSON,
  serializeRule,
  type Rule,
  type RuleCondition,
  type RuleEvent,
  type RuleOperator,
} from '../src/index.js';

const event: RuleEvent = {
  type: 'telemetry',
  payload: {
    temp: 45,
    status: 'error',
    message: 'System critical failure detected',
    tags: ['a', 'b'],
    sensor: { temp: 12, unit: 'C' },
    empty: null,
  },
  timestamp: 1,
};

function condition(operator: RuleOperator, field: string, value: unknown): RuleCondition {
  return { field, operator, value };
}

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'rule-1',
    name: 'Rule',
    priority: 0,
    enabled: true,
    eventTypes: ['telemetry'],
    condition: condition('gt', 'temp', 40),
    action: { type: 'log' },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('condition operators', () => {
  const cases: Array<[RuleCondition, boolean]> = [
    [condition('eq', 'status', 'error'), true],
    [condition('eq', 'status', 'ok'), false],
    [condition('neq', 'status', 'ok'), true],
    [condition('gt', 'temp', 40), true],
    [condition('gt', 'temp', 45), false],
    [condition('gte', 'temp', 45), true],
    [condition('lt', 'temp', 50), true],
    [condition('lt', 'temp', 45), false],
    [condition('lte', 'temp', 45), true],
    [condition('in', 'status', ['ok', 'error']), true],
    [condition('in', 'status', ['ok']), false],
    [condition('contains', 'message', 'critical'), true],
    [condition('contains', 'message', 'missing'), false],
    [condition('contains', 'tags', 'b'), true],
    [condition('contains', 'tags', 'z'), false],
    [condition('exists', 'temp', null), true],
    [condition('exists', 'missing', null), false],
    [condition('exists', 'empty', null), false],
  ];

  it.each(cases)('%o on the sample event', (ruleCondition, expected) => {
    expect(evaluateCondition(ruleCondition, event)).toBe(expected);
  });

  it('resolves dotted fields and treats missing paths as undefined', () => {
    expect(evaluateCondition(condition('eq', 'sensor.unit', 'C'), event)).toBe(true);
    expect(evaluateCondition(condition('eq', 'sensor.missing', 'C'), event)).toBe(false);
    expect(evaluateCondition(condition('gt', 'sensor.missing', 1), event)).toBe(false);
  });

  it('handles non-string payload members without throwing', () => {
    expect(evaluateCondition(condition('contains', 'temp', '4'), event)).toBe(false);
    expect(evaluateCondition(condition('eq', 'sensor', 'x'), event)).toBe(false);
  });
});

describe('event matching', () => {
  it('requires an enabled rule, a matching event type and a true condition', () => {
    expect(matchesEvent(rule(), event)).toBe(true);
    expect(matchesEvent(rule({ enabled: false }), event)).toBe(false);
    expect(matchesEvent(rule({ eventTypes: ['status'] }), event)).toBe(false);
    expect(matchesEvent(rule({ eventTypes: [] }), event)).toBe(false);
    expect(matchesEvent(rule({ condition: condition('gt', 'temp', 100) }), event)).toBe(false);
  });
});

describe('rule parsing', () => {
  it('normalizes symbolic operators', () => {
    expect(parseCondition({ field: 'temp', operator: '>', value: 1 }).operator).toBe('gt');
    expect(parseCondition({ field: 'temp', operator: '>=', value: 1 }).operator).toBe('gte');
    expect(parseCondition({ field: 'temp', operator: '==', value: 1 }).operator).toBe('eq');
    expect(parseCondition({ field: 'temp', operator: '!=', value: 1 }).operator).toBe('neq');
  });

  it('rejects unknown operators and missing fields', () => {
    expect(() => parseCondition({ field: 'temp', operator: '~=', value: 1 })).toThrow(
      /Unknown condition operator/
    );
    expect(() => parseCondition({ field: '', operator: 'eq', value: 1 })).toThrow(
      /field is required/
    );
    expect(() => parseCondition({ field: 'temp', operator: 'eq', value: 1 })).not.toThrow();
  });

  it('fills defaults, derives ids and preserves createdAt on re-parse', () => {
    const first = parseRuleDefinition({
      name: 'HighTemperature',
      eventTypes: ['telemetry'],
      condition: { field: 'temp', operator: '>', value: 40 },
      action: { type: 'alert', payload: { message: 'hot' } },
    });

    expect(first.id).toMatch(/^rule_[0-9a-f]{8}$/);
    expect(first.priority).toBe(0);
    expect(first.enabled).toBe(true);
    expect(first.description).toBeUndefined();
    expect(first.action.payload).toEqual({ message: 'hot' });

    const reparsed = parseRuleDefinition(
      {
        id: first.id,
        name: first.name,
        eventTypes: ['telemetry'],
        condition: { field: 'temp', operator: '>', value: 50 },
        action: { type: 'alert' },
      },
      [first]
    );
    expect(reparsed.createdAt).toBe(first.createdAt);
    expect(reparsed.action.payload).toEqual({});
  });

  it('requires at least one event type', () => {
    expect(() =>
      parseRuleDefinition({
        name: 'NoEvents',
        eventTypes: [],
        condition: { field: 'x', operator: 'exists', value: null },
        action: { type: 'log' },
      })
    ).toThrow(/at least one event type/);
  });

  it('round-trips through JSON', () => {
    const parsed = parseRuleJSON(
      JSON.stringify({
        name: 'FromJson',
        priority: 7,
        eventTypes: ['status'],
        condition: { field: 'status', operator: '==', value: 'error' },
        action: { type: 'log' },
      })
    );
    const reparsed = parseRuleJSON(serializeRule(parsed));
    expect(reparsed).toMatchObject({
      id: parsed.id,
      name: parsed.name,
      priority: parsed.priority,
      eventTypes: parsed.eventTypes,
      condition: parsed.condition,
      action: parsed.action,
    });
    // Only updatedAt is refreshed on re-parse.
    expect(reparsed.updatedAt).toBeGreaterThanOrEqual(parsed.updatedAt);
    expect(parsed.priority).toBe(7);
  });
});
