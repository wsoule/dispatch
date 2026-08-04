import type { RepoPr, RunMeta } from '@dispatch/client';
import { expect, test } from 'bun:test';

import { buildReviewQueue } from './ReviewQueue';

function run(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Local work',
    executor: 'fake',
    state: 'finished',
    branch: 'dispatch/t-1',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    ...overrides,
  } as RunMeta;
}

function repoPr(overrides: Partial<RepoPr> = {}): RepoPr {
  return {
    number: 9,
    title: 'Someone else PR',
    url: 'https://github.com/example/repo/pull/9',
    headRefName: 'feature/x',
    author: 'teammate',
    isDraft: false,
    updatedAt: '2026-08-02T00:00:00Z',
    headRefOid: 'abc123',
    isCrossRepository: false,
    headRepositoryOwner: 'example',
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    checks: { passed: 0, failed: 0, pending: 0, total: 0 },
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    ...overrides,
  };
}

test('a repo PR dispatch never opened still gets a queue row', () => {
  const queue = buildReviewQueue([], [repoPr()]);
  expect(queue).toHaveLength(1);
  expect(queue[0]?.target).toEqual({ kind: 'pr', number: 9 });
  expect(queue[0]?.title).toBe('Someone else PR');
});

test('a dispatch-opened PR appears once, as its run', () => {
  const url = 'https://github.com/example/repo/pull/9';
  const queue = buildReviewQueue(
    [run({ prUrl: url, taskTitle: 'Our work' })],
    [repoPr({ url })]
  );
  expect(queue).toHaveLength(1);
  // The run-backed item wins: it is the one that can reach the agent send-back.
  expect(queue[0]?.target).toEqual({ kind: 'run', runId: 'r-1' });
  expect(queue[0]?.title).toBe('Our work');
});

test('local runs awaiting review still appear alongside PRs', () => {
  const queue = buildReviewQueue([run()], [repoPr()]);
  expect(queue).toHaveLength(2);
  expect(queue.filter((i) => i.isPr)).toHaveLength(1);
});

test('newest first, so the queue reads like an inbox', () => {
  const queue = buildReviewQueue(
    [run({ updatedAt: '2026-08-01T00:00:00Z' })],
    [repoPr({ updatedAt: '2026-08-03T00:00:00Z' })]
  );
  expect(queue[0]?.isPr).toBe(true);
});
