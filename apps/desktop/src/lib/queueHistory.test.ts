import type { MergeQueueEntry } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { groupQueueHistory, latestAttemptFailedRunIds } from './queueHistory';

/** A terminal history entry with only the fields the grouping reads. */
function entry(
  runId: string,
  state: 'merged' | 'failed',
  overrides: Partial<MergeQueueEntry> = {}
): MergeQueueEntry {
  return {
    runId,
    taskId: `t-${runId}`,
    taskTitle: `Task ${runId}`,
    state,
    enqueuedAt: '2026-08-11T00:00:00.000Z',
    finishedAt: '2026-08-11T00:05:00.000Z',
    ...overrides,
  } as MergeQueueEntry;
}

describe('groupQueueHistory', () => {
  test('merged entries land, live failures fail, nothing is invented', () => {
    const groups = groupQueueHistory(
      [entry('a', 'merged'), entry('b', 'failed', { reason: 'lint failed' })],
      [{ id: 'a', reviewedAt: '2026-08-11T00:06:00.000Z' }, { id: 'b' }]
    );
    expect(groups.landed.map((e) => e.runId)).toEqual(['a']);
    expect(groups.failed.map((e) => e.runId)).toEqual(['b']);
    expect(groups.stale).toEqual([]);
  });

  // The screenshot bug: "run was already reviewed" failures headlining under RECENTLY
  // LANDED. A reviewed run's failed attempt is stale history, not news.
  test('a failed attempt whose run was since reviewed is stale', () => {
    const groups = groupQueueHistory(
      [entry('a', 'failed', { reason: 'run was already reviewed' })],
      [{ id: 'a', reviewedAt: '2026-08-11T00:06:00.000Z' }]
    );
    expect(groups.failed).toEqual([]);
    expect(groups.stale.map((e) => e.runId)).toEqual(['a']);
  });

  // History is newest-first: an older failed attempt for a run whose newer attempt merged
  // (or failed again) is superseded — only the latest attempt is the run's story.
  test('an older attempt superseded by a newer one is stale', () => {
    const groups = groupQueueHistory(
      [
        entry('a', 'merged'),
        entry('a', 'failed', { reason: 'test timed out' }),
        entry('b', 'failed', { reason: 'flake' }),
        entry('b', 'failed', { reason: 'first flake' }),
      ],
      [{ id: 'a' }, { id: 'b' }]
    );
    expect(groups.landed.map((e) => e.runId)).toEqual(['a']);
    expect(groups.failed.map((e) => e.reason)).toEqual(['flake']);
    expect(groups.stale.map((e) => e.reason)).toEqual([
      'test timed out',
      'first flake',
    ]);
  });

  // Clicking a failed row's Retry puts the run back in the live queue. From that moment
  // the pending attempt is the run's story — the old failure demotes to stale instead of
  // headlining next to its own retry.
  test('a failed attempt whose run is back in the queue is stale', () => {
    const groups = groupQueueHistory(
      [entry('a', 'failed', { reason: 'verify failed' })],
      [{ id: 'a' }],
      new Set(['a'])
    );
    expect(groups.failed).toEqual([]);
    expect(groups.stale.map((e) => e.runId)).toEqual(['a']);
  });

  // A still-loading (or pruned) run list must not reclassify every failure as stale —
  // staleness needs positive evidence, not an absent run.
  test('a failure whose run is missing from the run list stays live', () => {
    const groups = groupQueueHistory(
      [entry('gone', 'failed', { reason: 'verify failed' })],
      []
    );
    expect(groups.failed.map((e) => e.runId)).toEqual(['gone']);
    expect(groups.stale).toEqual([]);
  });

  test('order within each group follows history order (newest first)', () => {
    const groups = groupQueueHistory(
      [
        entry('c', 'failed', { reason: 'newest' }),
        entry('d', 'merged'),
        entry('e', 'failed', { reason: 'oldest' }),
        entry('f', 'merged'),
      ],
      [{ id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }]
    );
    expect(groups.failed.map((e) => e.reason)).toEqual(['newest', 'oldest']);
    expect(groups.landed.map((e) => e.runId)).toEqual(['d', 'f']);
  });
});

describe('latestAttemptFailedRunIds', () => {
  test('flags a run only when its newest attempt failed', () => {
    const ids = latestAttemptFailedRunIds([
      entry('a', 'failed'),
      entry('a', 'merged'),
      entry('b', 'merged'),
      entry('b', 'failed'),
      entry('c', 'failed'),
    ]);
    expect(ids).toEqual(new Set(['a', 'c']));
  });

  test('empty history flags nothing', () => {
    expect(latestAttemptFailedRunIds([])).toEqual(new Set());
  });
});
