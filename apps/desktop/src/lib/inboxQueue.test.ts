import type { RunMeta, RunQuestion } from '@dispatch/client';
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

function question(over: Partial<RunQuestion> = {}): RunQuestion {
  return {
    id: 'q-1',
    runId: 'r-1',
    question: 'Which way?',
    options: [],
    askedAt: '2026-08-04T00:30:00.000Z',
    ...over,
  } as RunQuestion;
}

const NO_QUESTIONS = new Map<string, RunQuestion[]>();

describe('buildInbox', () => {
  test('a finished, un-reviewed run lands in review', () => {
    const inbox = buildInbox([run()], [], NO_QUESTIONS);
    expect(inbox.review.map((i) => i.run?.id)).toEqual(['r-1']);
    expect(inbox.waiting).toHaveLength(0);
  });

  // No `MergeQueueEntry` involved — a plain live run stuck on an approval
  // gate must still classify as waiting without one.
  test('a run awaiting approval lands in waiting', () => {
    const inbox = buildInbox(
      [run({ state: 'awaiting-approval' })],
      [],
      NO_QUESTIONS
    );
    expect(inbox.waiting.map((r) => r.id)).toEqual(['r-1']);
    expect(inbox.review).toHaveLength(0);
  });

  test('a reviewed run appears in neither list', () => {
    const inbox = buildInbox(
      [run({ reviewedAt: '2026-08-04T01:00:00.000Z' })],
      [],
      NO_QUESTIONS
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
      [],
      NO_QUESTIONS
    );
    expect(inbox.review.map((i) => i.run?.id)).toEqual(['r-new', 'r-old']);
  });

  test('a run that is neither finished nor waiting appears in neither list', () => {
    const inbox = buildInbox([run({ state: 'running' })], [], NO_QUESTIONS);
    expect(inbox.review).toHaveLength(0);
    expect(inbox.waiting).toHaveLength(0);
  });

  // `deriveFeedState` alone can't see this: a run blocked on an unanswered
  // question stays 'running' in its own metadata (the agent process is still
  // live, just waiting on stdin). Only the separate openQuestions map — keyed
  // by run id, same as taskAttention.ts and controlRoom.ts read it — knows.
  test('a run blocked on an unanswered question lands in waiting', () => {
    const openQuestions = new Map<string, RunQuestion[]>([
      ['r-1', [question({ runId: 'r-1' })]],
    ]);
    const inbox = buildInbox([run({ state: 'running' })], [], openQuestions);
    expect(inbox.waiting.map((r) => r.id)).toEqual(['r-1']);
    expect(inbox.review).toHaveLength(0);
  });

  // A run with an empty question list for its id (already answered, entry
  // never cleaned up) must not be treated as still blocked.
  test('a run with an empty question list is not waiting on that alone', () => {
    const openQuestions = new Map<string, RunQuestion[]>([['r-1', []]]);
    const inbox = buildInbox([run({ state: 'running' })], [], openQuestions);
    expect(inbox.waiting).toHaveLength(0);
  });

  // buildReviewQueue's exclusions apply to `waiting` too: a review/verify-kind
  // run's own RunMeta is an implementation detail of reviewing something else,
  // not a thing needing a human on its own.
  test('a review-kind run awaiting approval is excluded from waiting', () => {
    const inbox = buildInbox(
      [run({ kind: 'review', state: 'awaiting-approval' })],
      [],
      NO_QUESTIONS
    );
    expect(inbox.waiting).toHaveLength(0);
  });

  test('an archived run awaiting approval is excluded from waiting', () => {
    const inbox = buildInbox(
      [
        run({
          state: 'awaiting-approval',
          archivedAt: '2026-08-04T02:00:00.000Z',
        }),
      ],
      [],
      NO_QUESTIONS
    );
    expect(inbox.waiting).toHaveLength(0);
  });
});
