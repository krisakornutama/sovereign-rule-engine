import { describe, expect, it } from 'vitest';
import { describeOperatorProbe } from '../src/rule-engine/matcher.js';

describe('matcher probe (temporary required-check proof)', () => {
  it('returns the matching label for both branches', () => {
    expect(describeOperatorProbe('eq')).toBe('equals');
    expect(describeOperatorProbe('gt')).toBe('other');
  });
});
