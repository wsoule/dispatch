import type { RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { buildInbox } from './inboxQueue';

function run(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Do the thing',
    executor: 'claude',
    state: 'finished',
    branch: 'dispatch/t-1',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    ...over,
  } as RunMeta;
}

describe('buildInbox', () => {
  test('a finished, un-reviewed run lands in review', () => {
    const inbox = buildInbox([run()], []);
    expect(inbox.review.map((i) => i.run?.id)).toEqual(['r-1']);
    expect(inbox.waiting).toHaveLength(0);
  });

  // No `MergeQueueEntry` involved — a plain live run stuck on an approval
  // gate must still classify as waiting without one.
  test('a run awaiting approval lands in waiting', () => {
    const inbox = buildInbox([run({ state: 'awaiting-approval' })], []);
    expect(inbox.waiting.map((r) => r.id)).toEqual(['r-1']);
    expect(inbox.review).toHaveLength(0);
  });

  test('a reviewed run appears in neither list', () => {
    const inbox = buildInbox(
      [run({ reviewedAt: '2026-08-04T01:00:00.000Z' })],
      []
    );
    expect(inbox.review).toHaveLength(0);
    expect(inbox.waiting).toHaveLength(0);
  });

  test('review entries preserve buildReviewQueue order — newest first', () => {
    const inbox = buildInbox(
      [
        run({ id: 'r-old', updatedAt: '2026-08-01T00:00:00.000Z' }),
        run({ id: 'r-new', updatedAt: '2026-08-03T00:00:00.000Z' }),
      ],
      []
    );
    expect(inbox.review.map((i) => i.run?.id)).toEqual(['r-new', 'r-old']);
  });

  test('a run that is neither finished nor waiting appears in neither list', () => {
    const inbox = buildInbox([run({ state: 'running' })], []);
    expect(inbox.review).toHaveLength(0);
    expect(inbox.waiting).toHaveLength(0);
  });
});
