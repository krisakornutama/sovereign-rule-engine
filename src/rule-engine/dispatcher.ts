import type {
  ActionContext,
  ActionDispatcher,
  Rule,
  RuleEvent,
} from './types.js';

type ActionHandler = (context: ActionContext) => void | Promise<void>;

export class ActionDispatcherImpl implements ActionDispatcher {
  private readonly handlers = new Map<string, ActionHandler>();

  registerAction(type: string, handler: ActionHandler): void {
    this.handlers.set(type, handler);
  }

  unregisterAction(type: string): void {
    this.handlers.delete(type);
  }

  hasAction(type: string): boolean {
    return this.handlers.has(type);
  }

  async dispatch(context: ActionContext): Promise<void> {
    const handler = this.handlers.get(context.rule.action.type);
    if (!handler) {
      throw new Error(
        `No handler registered for action type: ${context.rule.action.type}`
      );
    }
    await handler(context);
  }
}

export async function dispatchAction(
  dispatcher: ActionDispatcher,
  rule: Rule,
  event: RuleEvent,
  state: Record<string, unknown>
): Promise<void> {
  const context: ActionContext = { event, rule, state };
  await dispatcher.dispatch(context);
}
