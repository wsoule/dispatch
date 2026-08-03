import type { VerificationResult } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  summarizeVerification,
  verificationCheckDetail,
} from './verificationSummary';

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

describe('verificationCheckDetail', () => {
  test('a failing check carries the diagnostic, which is the whole point of it', () => {
    expect(
      verificationCheckDetail({
        check: 'Reject an expired discount code',
        expected: '410 and no discount applied',
        actual: '200, discount applied anyway',
        pass: false,
      })
    ).toEqual({
      expected: '410 and no discount applied',
      actual: '200, discount applied anyway',
    });
  });

  test('a passing check has nothing to add', () => {
    expect(
      verificationCheckDetail({
        check: 'a',
        expected: '200',
        actual: '200',
        pass: true,
      })
    ).toBeNull();
  });

  test('a failing check with no recorded expectation shows nothing rather than empty lines', () => {
    expect(
      verificationCheckDetail({
        check: 'a',
        expected: '  ',
        actual: '',
        pass: false,
      })
    ).toBeNull();
  });
});
