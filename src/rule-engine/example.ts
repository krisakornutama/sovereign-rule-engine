import { SimpleRuleEngine } from './engine.js';
import { ActionDispatcherImpl } from './dispatcher.js';
import type { RuleEvent } from './types.js';

const dispatcher = new ActionDispatcherImpl();

dispatcher.registerAction('log', (ctx) => {
  console.log(`[ACTION] Rule "${ctx.rule.name}" matched:`, ctx.event.payload);
});

dispatcher.registerAction('alert', (ctx) => {
  console.log(`[ALERT] ${ctx.rule.name}:`, ctx.rule.action.payload);
});

const engine = new SimpleRuleEngine({
  defaultPriority: 0,
  maxRules: 1000,
  actionDispatcher: dispatcher,
  state: { tempThreshold: 40 },
});

engine.addRuleFromDefinition({
  id: 'high-temperature',
  name: 'HighTemperature',
  description: 'Alert when temperature exceeds the threshold',
  priority: 10,
  eventTypes: ['telemetry'],
  condition: { field: 'temp', operator: '>', value: 40 },
  action: {
    type: 'alert',
    payload: { message: 'Temperature exceeds threshold' },
  },
});

engine.addRuleFromDefinition({
  id: 'error-status',
  name: 'ErrorStatus',
  description: 'Log when status is error',
  priority: 5,
  eventTypes: ['status'],
  condition: { field: 'status', operator: '==', value: 'error' },
  action: { type: 'log', payload: { message: 'Error status detected' } },
});

engine.addRuleFromDefinition({
  id: 'contains-critical',
  name: 'ContainsCritical',
  description: 'Log when a message mentions critical',
  priority: 8,
  eventTypes: ['log'],
  condition: { field: 'message', operator: 'contains', value: 'critical' },
  action: { type: 'log', payload: { message: 'Critical log entry' } },
});

console.log('=== Rule Engine Example ===\n');

console.log('Test 1: Temperature > 40');
await engine.evaluate({
  type: 'telemetry',
  payload: { temp: 45, humidity: 60 },
  timestamp: Date.now(),
});

console.log('\nTest 2: Temperature <= 40');
await engine.evaluate({
  type: 'telemetry',
  payload: { temp: 35, humidity: 50 },
  timestamp: Date.now(),
});

console.log('\nTest 3: Status equals error');
await engine.evaluate({
  type: 'status',
  payload: { status: 'error', code: 500 },
  timestamp: Date.now(),
});

console.log('\nTest 4: Message contains critical');
await engine.evaluate({
  type: 'log',
  payload: { message: 'System critical failure detected' },
  timestamp: Date.now(),
});

const disabled: RuleEvent = {
  type: 'telemetry',
  payload: { temp: 45, humidity: 60 },
  timestamp: Date.now(),
};

console.log('\nTest 5: Disable HighTemperature rule');
engine.disableRule('high-temperature');
await engine.evaluate(disabled);

console.log('\n=== Example Complete ===');
