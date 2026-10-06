import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { containerRollup, landingRun, rollupOutcome } from './containerRollup';

function task(id: string, status: string): TaskListItem {
  return { meta: { id, title: id, status } } as TaskListItem;
}

function run(overrides: Partial<RunMeta>): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'T',
    executor: 'claude',
    state: 'finished',
    branch: 'dispatch/t-1',
    baseBranch: 'main',
    worktreePath: '/wt',
    createdAt: '2026-09-23T10:00:00.000Z',
    updatedAt: '2026-09-23T10:05:00.000Z',
    ...overrides,
  };
}

test('landingRun prefers the merged run over one with only a PR', () => {
  const pr = run({ id: 'r-pr', prUrl: 'https://x/pr/1' });
  const merged = run({ id: 'r-m', mergeCommit: 'abc' });
  expect(landingRun([pr, merged])).toBe(merged);
  expect(landingRun([pr])).toBe(pr);
  expect(landingRun([run({})])).toBeUndefined();
});

describe('containerRollup', () => {
  const work = [
    task('t-2', 'landed'),
    task('t-3', 'dropped'),
    task('t-4', 'ready'),
  ];
  const merged = run({
    id: 'r-2',
    taskId: 't-2',
    mergeCommit: 'bd7298e',
    costUsd: 0.25,
    turns: 4,
  });
  const failed = run({
    id: 'r-2a',
    taskId: 't-2',
    state: 'failed',
    costUsd: 0.1,
    turns: 2,
    createdAt: '2026-09-22T10:00:00.000Z',
  });
  const review = run({ id: 'r-rev', taskId: 't-2', kind: 'review' });
  const elsewhere = run({ id: 'r-9', taskId: 't-9', costUsd: 5 });
  const rollup = containerRollup(work, [merged, failed, review, elsewhere]);

  test('counts sub-issues by how they ended', () => {
    expect(rollup).toMatchObject({ landed: 1, dropped: 1, open: 1 });
    expect(rollupOutcome(rollup)).toBe(
      '1 of 3 sub-issues landed · 1 dropped · 1 still open'
    );
  });

  test('names the run that landed each, from its own execute runs', () => {
    expect(rollup.subIssues.map((s) => s.landedBy?.id)).toEqual([
      'r-2',
      undefined,
      undefined,
    ]);
    expect(rollup.runs.map((r) => r.id)).toEqual(['r-2', 'r-2a']);
  });

  test('reads an empty container plainly', () => {
    expect(rollupOutcome(containerRollup([], []))).toBe('No sub-issues.');
  });
});
