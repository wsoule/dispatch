import type { VerificationResult } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { summarizeVerification } from './verificationSummary';

function result(overrides: Partial<VerificationResult>): VerificationResult {
  return {
    runId: 'run-1',
    taskId: 't-1',
    pass: true,
    checks: [],
    artifacts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('summarizeVerification', () => {
  test('null means no run yet', () => {
    expect(summarizeVerification(null)).toEqual({
      passCount: 0,
      failCount: 0,
      label: 'No verification run yet',
    });
  });

  test('an empty checks array is not read as a clean pass', () => {
    expect(summarizeVerification(result({ checks: [] }))).toEqual({
      passCount: 0,
      failCount: 0,
      label: 'No checks were exercised',
    });
  });

  test('counts pass/fail and labels the ratio', () => {
    const summary = summarizeVerification(
      result({
        checks: [
          { check: 'a', expected: 'x', actual: 'x', pass: true },
          { check: 'b', expected: 'y', actual: 'z', pass: false },
          { check: 'c', expected: 'x', actual: 'x', pass: true },
        ],
      })
    );
    expect(summary).toEqual({
      passCount: 2,
      failCount: 1,
      label: '2/3 checks passed',
    });
  });
});
