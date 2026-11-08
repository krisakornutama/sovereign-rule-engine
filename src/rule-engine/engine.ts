import type {
  ActionDispatcher,
  Rule,
  RuleEngine,
  RuleEngineConfig,
  RuleEvent,
} from './types.js';
import { dispatchAction } from './dispatcher.js';
import { matchesEvent } from './matcher.js';
import { parseRuleDefinition, type RuleDefinition } from './parser.js';

interface ResolvedConfig {
  defaultPriority: number;
  maxRules: number;
  actionDispatcher: ActionDispatcher;
}

export class SimpleRuleEngine implements RuleEngine {
  private readonly rules = new Map<string, Rule>();
  private config: ResolvedConfig;
  private state: Record<string, unknown>;

  constructor(config: RuleEngineConfig) {
    this.config = {
      defaultPriority: config.defaultPriority ?? 0,
      maxRules: config.maxRules ?? 1000,
      actionDispatcher: config.actionDispatcher,
    };
    this.state = { ...(config.state ?? {}) };
  }

  addRule(rule: Rule): void {
    if (!this.rules.has(rule.id) && this.rules.size >= this.config.maxRules) {
      throw new Error(`Max rules (${this.config.maxRules}) exceeded`);
    }
    this.rules.set(rule.id, rule);
  }

  addRuleFromDefinition(definition: RuleDefinition): Rule {
    const rule = parseRuleDefinition(definition, this.getRules());
    this.addRule(rule);
    return rule;
  }

  removeRule(ruleId: string): void {
    this.rules.delete(ruleId);
  }

  updateRule(rule: Rule): void {
    if (!this.rules.has(rule.id)) {
      throw new Error(`Unknown rule: ${rule.id}`);
    }
    this.rules.set(rule.id, { ...rule, updatedAt: Date.now() });
  }

  async evaluate(event: RuleEvent): Promise<void> {
    const matched = this.getEnabledRules()
      .filter((rule) => matchesEvent(rule, event))
      .sort((a, b) => b.priority - a.priority);

    for (const rule of matched) {
      await dispatchAction(this.config.actionDispatcher, rule, event, this.state);
    }
  }

  getRules(): ReadonlyArray<Rule> {
    return [...this.rules.values()];
  }

  getEnabledRules(): ReadonlyArray<Rule> {
    return [...this.rules.values()].filter((rule) => rule.enabled);
  }

  enableRule(ruleId: string): void {
    this.toggleRule(ruleId, true);
  }

  disableRule(ruleId: string): void {
    this.toggleRule(ruleId, false);
  }

  clearRules(): void {
    this.rules.clear();
  }

  setActionDispatcher(dispatcher: ActionDispatcher): void {
    this.config = { ...this.config, actionDispatcher: dispatcher };
  }

  getState(): Record<string, unknown> {
    return { ...this.state };
  }

  setState(state: Record<string, unknown>): void {
    this.state = { ...state };
  }

  private toggleRule(ruleId: string, enabled: boolean): void {
    const existing = this.rules.get(ruleId);
    if (!existing) return;
    this.rules.set(ruleId, { ...existing, enabled, updatedAt: Date.now() });
  }
}
