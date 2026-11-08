import { describe, expect, it } from 'vitest';
import { diffCoverageProbe } from '../src/diff-coverage-probe.js';

describe('diff coverage probe', () => {
  it('doubles positive values', () => {
    expect(diffCoverageProbe(2)).toBe(4);
  });

  it('returns zero for non-positive values', () => {
    expect(diffCoverageProbe(0)).toBe(0);
  });
});
