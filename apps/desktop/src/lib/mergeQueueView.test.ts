import type {
  MergeQueueEntry,
  MergeQueueEntryState,
  VerifyStepResult,
} from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  elapsedInStateMs,
  heldCount,
  isMidFlight,
  isOverdue,
  isRetryable,
  phaseSteps,
  QUEUE_PHASES,
  queueStateLabel,
  toQueueRows,
} from './mergeQueueView';

function entry(
  state: MergeQueueEntryState,
  over: Partial<MergeQueueEntry> = {}
): MergeQueueEntry {
  return {
    runId: 'r-1',
    taskId: 't-1',
    taskTitle: 'Do the thing',
    state,
    enqueuedAt: '2026-07-26T00:00:00.000Z',
    ...over,
  };
}

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

  test('mid-flight covers exactly the three moving phases', () => {
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
    expect(all.filter(isMidFlight)).toEqual([
      'rebasing',
      'verifying',
      'merging',
    ]);
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
});

describe('toQueueRows', () => {
  test('positions are 1-based and follow queue order', () => {
    const rows = toQueueRows([
      entry('merging', { runId: 'r-a' }),
      entry('queued', { runId: 'r-b' }),
    ]);
    expect(rows.map((r) => [r.position, r.entry.runId])).toEqual([
      [1, 'r-a'],
      [2, 'r-b'],
    ]);
  });

  test('a held entry surfaces its reason and offers a retry', () => {
    const rows = toQueueRows([
      entry('blocked-environment', { reason: 'working tree has changes' }),
    ]);
    expect(rows[0]?.reason).toBe('working tree has changes');
    expect(rows[0]?.retryable).toBe(true);
    expect(rows[0]?.stalled).toBe(true);
  });

  test('an entry with no reason reports null rather than an empty string', () => {
    expect(toQueueRows([entry('queued')])[0]?.reason).toBeNull();
  });

  // Unlike blocked-environment, a GitHub hold clears itself as PrManager's poll
  // cache updates — there is nothing for the person to go fix by hand, so this
  // state deliberately does not offer a manual retry.
  test('a waiting-github entry surfaces its reason without offering a retry', () => {
    const rows = toQueueRows([entry('waiting-github', { reason: 'draft' })]);
    expect(rows[0]?.reason).toBe('draft');
    expect(rows[0]?.retryable).toBe(false);
    expect(rows[0]?.stalled).toBe(false);
    expect(rows[0]?.label).toBe('Waiting on GitHub');
  });

  test('heldCount counts what one recheck would retry', () => {
    expect(
      heldCount([
        entry('blocked-environment', { runId: 'r-a' }),
        entry('blocked-environment', { runId: 'r-b' }),
        entry('verifying', { runId: 'r-c' }),
      ])
    ).toBe(2);
  });

  test('an empty queue produces no rows', () => {
    expect(toQueueRows([])).toEqual([]);
  });
});

// The wedge this exists for: an entry sat in `verifying` for 11 minutes with no
// process behind it. `isStalled` cannot see that — it reads the state alone, and
// `verifying` is a legitimately busy state. Elapsed time in the CURRENT state is
// what separates slow from wedged, which is why `enqueuedAt` cannot answer it
// (it never moves, so it only ever says "how long since queued").
describe('elapsedInStateMs', () => {
  const now = new Date('2026-07-26T00:10:00.000Z').getTime();

  test('measures from stateSince, not enqueuedAt', () => {
    const e = entry('verifying', {
      enqueuedAt: '2026-07-26T00:00:00.000Z',
      stateSince: '2026-07-26T00:08:00.000Z',
    });
    // 2 minutes in `verifying`, despite 10 minutes in the queue.
    expect(elapsedInStateMs(e, now)).toBe(120_000);
  });

  // Entries persisted before stateSince existed still have to render something
  // rather than NaN.
  test('falls back to enqueuedAt when stateSince is absent', () => {
    const e = entry('verifying', { enqueuedAt: '2026-07-26T00:00:00.000Z' });
    expect(elapsedInStateMs(e, now)).toBe(600_000);
  });
});

describe('isOverdue', () => {
  const now = new Date('2026-07-26T00:10:00.000Z').getTime();

  test('flags a mid-flight entry stuck well past the expected window', () => {
    const e = entry('verifying', { stateSince: '2026-07-26T00:00:00.000Z' });
    expect(isOverdue(e, now)).toBe(true);
  });

  test('leaves a mid-flight entry alone while it is plausibly working', () => {
    const e = entry('verifying', { stateSince: '2026-07-26T00:09:00.000Z' });
    expect(isOverdue(e, now)).toBe(false);
  });

  // A held entry is waiting on a human by design — it is not overdue however
  // long it sits, and flagging it would cry wolf on the normal case.
  test('never flags a held entry, however long it has waited', () => {
    const e = entry('blocked-environment', {
      stateSince: '2026-07-25T00:00:00.000Z',
    });
    expect(isOverdue(e, now)).toBe(false);
  });

  test('never flags a queued entry waiting its turn', () => {
    const e = entry('queued', { stateSince: '2026-07-25T00:00:00.000Z' });
    expect(isOverdue(e, now)).toBe(false);
  });

  // Same reasoning as blocked-environment: waiting on GitHub, not stuck.
  test('never flags a waiting-github entry, however long it has waited', () => {
    const e = entry('waiting-github', {
      stateSince: '2026-07-25T00:00:00.000Z',
    });
    expect(isOverdue(e, now)).toBe(false);
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
