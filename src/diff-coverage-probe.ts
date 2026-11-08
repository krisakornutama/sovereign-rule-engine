/** Temporary probe used to verify the PR diff-coverage gate. */
export function diffCoverageProbe(value: number): number {
  if (value > 0) {
    return value * 2;
  }
  return 0;
}
