import type { MergeQueueEntry, RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { awayDigest } from './narrator';

const SINCE = '2026-10-06T09:00:00Z';

function run(over: Partial<RunMeta>): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Fix login',
    state: 'finished',
    updatedAt: '2026-10-06T10:00:00Z',
    createdAt: '2026-10-06T08:00:00Z',
    ...over,
  } as RunMeta;
}

function merged(over: Partial<MergeQueueEntry>): MergeQueueEntry {
  return {
    runId: 'r-9',
    taskId: 't-9',
    taskTitle: 'Ship it',
    state: 'merged',
    enqueuedAt: '2026-10-06T08:30:00Z',
    finishedAt: '2026-10-06T09:30:00Z',
    ...over,
  } as MergeQueueEntry;
}

describe('awayDigest', () => {
  test('says nothing when nothing settled and nothing waits', () => {
    expect(awayDigest({ since: SINCE, runs: [], merges: [] })).toEqual([]);
  });

  test('failures, review and landings, most urgent first', () => {
    const lines = awayDigest({
      since: SINCE,
      runs: [
        run({ id: 'r-1', state: 'failed', taskId: 't-1', taskTitle: 'A' }),
        run({ id: 'r-2', state: 'finished', taskId: 't-2', taskTitle: 'B' }),
        run({ id: 'r-3', state: 'finished', taskTitle: 'C' }),
      ],
      merges: [merged({})],
    });
    expect(lines.map((l) => l.text)).toEqual([
      '✕ r-1 failed · A',
      '◇ 2 ready for review: B, C',
      '✓ 1 landed: Ship it',
    ]);
    expect(lines[0].door).toEqual({ taskId: 't-1' });
    expect(lines[1].door).toEqual({ preset: 'review' });
  });

  test('ignores what settled before `since`, reviewed runs and review runs', () => {
    const lines = awayDigest({
      since: SINCE,
      runs: [
        run({ updatedAt: '2026-10-06T08:59:00Z' }),
        run({ reviewedAt: '2026-10-06T10:00:00Z' }),
        run({ kind: 'review' }),
      ],
      merges: [merged({ finishedAt: '2026-10-06T08:00:00Z' })],
    });
    expect(lines).toEqual([]);
  });

  test('names three titles, then counts the rest', () => {
    const [line] = awayDigest({
      since: SINCE,
      runs: ['a', 'b', 'c', 'd', 'e'].map((t, i) =>
        run({ id: `r-${i}`, state: 'failed', taskTitle: t })
      ),
      merges: [],
    });
    expect(line.text).toBe('✕ 5 runs failed: a, b, c and 2 more');
    expect(line.door).toEqual({ preset: 'failed' });
  });
});
