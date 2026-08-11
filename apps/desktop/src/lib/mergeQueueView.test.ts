import type { MergeQueueEntryState, VerifyStepResult } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  isRetryable,
  phaseSteps,
  QUEUE_PHASES,
  queueStateLabel,
} from './mergeQueueView';

/** Compact view of a strip: 'p' passed, 'a' active, '.' pending. */
function shape(state: MergeQueueEntryState): string | null {
  const steps = phaseSteps(state);
  if (steps === null) return null;
  return steps
    .map((s) =>
      s.status === 'passed' ? 'p' : s.status === 'active' ? 'a' : '.'
    )
    .join('');
}

describe('phaseSteps', () => {
  test('the strip reports the queue’s three real phases', () => {
    expect(QUEUE_PHASES).toEqual(['rebase', 'verify', 'merge']);
    expect(phaseSteps('queued')).toHaveLength(3);
  });

  test.each([
    ['queued', '...'],
    ['waiting-blockers', '...'],
    ['blocked-environment', '...'],
    ['waiting-github', '...'],
    ['rebasing', 'a..'],
    ['verifying', 'pa.'],
    ['merging', 'ppa'],
    ['merged', 'ppp'],
  ] as [MergeQueueEntryState, string][])('%s -> %s', (state, expected) => {
    expect(shape(state)).toBe(expected);
  });

  // The server wraps rebase/verify/merge in one try and records only the message, so a failed
  // entry cannot say which phase broke. Claiming one would be a fabrication either way round.
  test('a failed entry gets no strip, because the phase is unknowable', () => {
    expect(phaseSteps('failed')).toBeNull();
  });

  test('no phase is ever marked passed before one that is still pending', () => {
    for (const state of [
      'queued',
      'rebasing',
      'verifying',
      'merging',
      'merged',
    ] as MergeQueueEntryState[]) {
      const steps = phaseSteps(state) ?? [];
      const firstUnpassed = steps.findIndex((s) => s.status !== 'passed');
      if (firstUnpassed === -1) continue;
      expect(
        steps.slice(firstUnpassed).every((s) => s.status !== 'passed')
      ).toBe(true);
    }
  });
});

describe('retry eligibility', () => {
  test('only a held entry can be retried', () => {
    expect(isRetryable('blocked-environment')).toBe(true);
  });

  // Mid-flight entries have nothing to retry, and a failed one has already left the queue —
  // re-running that means enqueuing the run again, a different action entirely.
  test.each([
    'queued',
    'waiting-blockers',
    'waiting-github',
    'rebasing',
    'verifying',
    'merging',
    'merged',
    'failed',
  ] as MergeQueueEntryState[])('%s is not retryable', (state) => {
    expect(isRetryable(state)).toBe(false);
  });
});

describe('labels', () => {
  test('every state has a label and none leak the raw enum', () => {
    const all: MergeQueueEntryState[] = [
      'queued',
      'waiting-blockers',
      'blocked-environment',
      'waiting-github',
      'rebasing',
      'verifying',
      'merging',
      'merged',
      'failed',
    ];
    for (const state of all) {
      expect(queueStateLabel(state)).toBeTruthy();
    }
    expect(queueStateLabel('blocked-environment')).not.toContain('-');
  });

  // The GitHub hold is this branch's addition to the queue's states; its label
  // is what the Landing table's gate chip reads.
  test('a GitHub hold reads as waiting on GitHub', () => {
    expect(queueStateLabel('waiting-github')).toBe('Waiting on GitHub');
  });
});

describe('named verify steps', () => {
  test('while verifying, the real steps replace the coarse phases', () => {
    const steps = phaseSteps('verifying', [
      { name: 'typecheck', status: 'passed', ms: 2100 },
      { name: 'tests', status: 'running' },
      { name: 'lint', status: 'pending' },
    ]);
    expect(steps?.map((s) => s.name)).toEqual(['typecheck', 'tests', 'lint']);
    expect(steps?.map((s) => s.status)).toEqual([
      'passed',
      'active',
      'pending',
    ]);
  });

  test('a failed step is shown as failed, not merely stopped', () => {
    const steps = phaseSteps('verifying', [
      { name: 'typecheck', status: 'failed' },
    ]);
    expect(steps?.[0]?.status).toBe('failed');
  });

  // Before and after verification the named steps say nothing useful about where the entry is
  // in the queue, so the three-phase view stays the honest summary.
  test('outside verification the phase view is used even when steps exist', () => {
    const withSteps: VerifyStepResult[] = [
      { name: 'typecheck', status: 'passed' },
    ];
    expect(phaseSteps('merging', withSteps)?.map((s) => s.name)).toEqual([
      'rebase',
      'verify',
      'merge',
    ]);
  });

  test('an entry that reports no steps still gets the phase view', () => {
    expect(phaseSteps('verifying', [])?.map((s) => s.name)).toEqual([
      'rebase',
      'verify',
      'merge',
    ]);
  });

  // Still unknowable: a failed entry has left verification, and the server records only the
  // thrown message, so there is no pipeline to draw.
  test('a failed entry gets no strip regardless of recorded steps', () => {
    expect(
      phaseSteps('failed', [{ name: 'tests', status: 'failed' }])
    ).toBeNull();
  });
});
