import type { Rule, RuleAction, RuleCondition, RuleOperator } from './types.js';

export interface RuleDefinition {
  readonly id?: string;
  readonly name: string;
  readonly description?: string;
  readonly priority?: number;
  readonly enabled?: boolean;
  readonly eventTypes: ReadonlyArray<string>;
  readonly condition: {
    readonly field: string;
    readonly operator: string;
    readonly value: unknown;
  };
  readonly action: {
    readonly type: string;
    readonly payload?: Record<string, unknown>;
  };
}

const OPERATOR_MAP: Record<string, RuleOperator | undefined> = {
  eq: 'eq',
  '==': 'eq',
  '===': 'eq',
  neq: 'neq',
  '!=': 'neq',
  '!==': 'neq',
  gt: 'gt',
  '>': 'gt',
  gte: 'gte',
  '>=': 'gte',
  lt: 'lt',
  '<': 'lt',
  lte: 'lte',
  '<=': 'lte',
  in: 'in',
  contains: 'contains',
  exists: 'exists',
};

export function parseCondition(definition: RuleDefinition['condition']): RuleCondition {
  const operator = OPERATOR_MAP[definition.operator];
  if (!operator) {
    throw new Error(`Unknown condition operator: ${definition.operator}`);
  }
  if (!definition.field) {
    throw new Error('Condition field is required');
  }
  return {
    field: definition.field,
    operator,
    value: definition.value,
  };
}

export function parseAction(definition: RuleDefinition['action']): RuleAction {
  if (!definition.type) {
    throw new Error('Action type is required');
  }
  return {
    type: definition.type,
    payload: definition.payload ?? {},
  };
}

export function generateRuleId(name: string, eventType: string): string {
  return `rule_${simpleHash(`${name}:${eventType}`)}`;
}

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function parseRuleDefinition(
  definition: RuleDefinition,
  existingRules: ReadonlyArray<Rule> = []
): Rule {
  const eventType = definition.eventTypes[0];
  if (!eventType) {
    throw new Error('eventTypes must contain at least one event type');
  }

  const id = definition.id ?? generateRuleId(definition.name, eventType);
  const existing = existingRules.find((rule) => rule.id === id);
  const now = Date.now();

  return {
    id,
    name: definition.name,
    description: definition.description,
    priority: definition.priority ?? 0,
    enabled: definition.enabled ?? true,
    eventTypes: definition.eventTypes,
    condition: parseCondition(definition.condition),
    action: parseAction(definition.action),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function parseRuleJSON(json: string): Rule {
  return parseRuleDefinition(JSON.parse(json) as RuleDefinition);
}

export function serializeRule(rule: Rule): string {
  return JSON.stringify(rule);
}
