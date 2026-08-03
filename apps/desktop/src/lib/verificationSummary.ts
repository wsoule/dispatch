import type { VerificationCheck, VerificationResult } from '@dispatch/client';

export interface VerificationSummary {
  passCount: number;
  failCount: number;
  label: string;
}

/** Check counts and a one-line label for the verification badge — `null`
 *  means no verify run has ever produced a usable result for this task. */
export function summarizeVerification(
  result: VerificationResult | null
): VerificationSummary {
  if (result === null) {
    return { passCount: 0, failCount: 0, label: 'No verification run yet' };
  }
  const passCount = result.checks.filter((c) => c.pass).length;
  const failCount = result.checks.length - passCount;
  const label =
    result.checks.length === 0
      ? 'No checks were exercised'
      : `${passCount}/${result.checks.length} checks passed`;
  return { passCount, failCount, label };
}

export interface VerificationCheckDetail {
  expected: string;
  actual: string;
}

/** The expected-vs-actual pair worth showing under a check, or null — a passing
 *  check matched, and a check's name already says what was tried. */
export function verificationCheckDetail(
  check: VerificationCheck
): VerificationCheckDetail | null {
  if (check.pass) return null;
  const expected = check.expected.trim();
  const actual = check.actual.trim();
  if (expected === '' && actual === '') return null;
  return { expected, actual };
}
