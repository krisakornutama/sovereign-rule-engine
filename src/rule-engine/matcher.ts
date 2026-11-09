import type { Rule, RuleCondition, RuleEvent } from './types.js';

export function getFieldValue(payload: Record<string, unknown>, field: string): unknown {
  let current: unknown = payload;
  for (const part of field.split('.')) {
    if (current !== null && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

export function evaluateCondition(condition: RuleCondition, event: RuleEvent): boolean {
  const value = getFieldValue(event.payload, condition.field);

  switch (condition.operator) {
    case 'eq':
      return value === condition.value;
    case 'neq':
      return value !== condition.value;
    case 'gt':
      return typeof value !== 'undefined' && Number(value) > Number(condition.value);
    case 'gte':
      return typeof value !== 'undefined' && Number(value) >= Number(condition.value);
    case 'lt':
      return typeof value !== 'undefined' && Number(value) < Number(condition.value);
    case 'lte':
      return typeof value !== 'undefined' && Number(value) <= Number(condition.value);
    case 'in':
      return Array.isArray(condition.value) && condition.value.includes(value);
    case 'contains':
      if (typeof value === 'string') {
        return value.includes(String(condition.value));
      }
      if (Array.isArray(value)) {
        return value.includes(condition.value);
      }
      return false;
    case 'exists':
      return value !== undefined && value !== null;
    default:
      return false;
  }
}

export function matchesEvent(rule: Rule, event: RuleEvent): boolean {
  if (!rule.enabled) return false;
  if (rule.eventTypes.length === 0) return false;
  if (!rule.eventTypes.includes(event.type)) return false;
  return evaluateCondition(rule.condition, event);
}

/** Temporary probe: intentionally untested lines for the required-check test. */
export function describeOperatorProbe(operator: string): string {
  if (operator === 'eq') {
    return 'equals';
  }
  return 'other';
}
