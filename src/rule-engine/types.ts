export type RuleOperator =
  'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'exists';

export interface RuleCondition {
  readonly field: string;
  readonly operator: RuleOperator;
  readonly value: unknown;
}

export interface RuleAction {
  readonly type: string;
  readonly payload?: Record<string, unknown>;
}

export interface Rule {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly eventTypes: ReadonlyArray<string>;
  readonly condition: RuleCondition;
  readonly action: RuleAction;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RuleEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly timestamp: number;
  readonly sourcePeerId?: string;
}

/** Alias kept short for call sites. */
export type Event = RuleEvent;

export interface ActionContext {
  readonly event: RuleEvent;
  readonly rule: Rule;
  readonly state: Record<string, unknown>;
}

export interface ActionDispatcher {
  dispatch(context: ActionContext): void | Promise<void>;
}

export interface RuleEngineConfig {
  readonly defaultPriority?: number;
  readonly maxRules?: number;
  readonly actionDispatcher: ActionDispatcher;
  readonly state?: Record<string, unknown>;
}

export interface RuleEngine {
  addRule(rule: Rule): void;
  removeRule(ruleId: string): void;
  updateRule(rule: Rule): void;
  evaluate(event: RuleEvent): Promise<void>;
  getRules(): ReadonlyArray<Rule>;
  getEnabledRules(): ReadonlyArray<Rule>;
  enableRule(ruleId: string): void;
  disableRule(ruleId: string): void;
  clearRules(): void;
  setActionDispatcher(dispatcher: ActionDispatcher): void;
  getState(): Record<string, unknown>;
  setState(state: Record<string, unknown>): void;
}
