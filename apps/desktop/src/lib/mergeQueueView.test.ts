import type { MergeQueueEntry, MergeQueueEntryState } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  heldCount,
  isMidFlight,
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
