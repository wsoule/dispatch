import type { RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { mergeLadderLabel, mergeLadderState } from './mergeLadder';

// Builds a minimal RunMeta for these tests — only the merge-ladder-relevant
// fields need to vary per test, everything else is filler.
function run(overrides: Partial<RunMeta>): RunMeta {
  return {
    id: 'run-1',
    taskId: 't-1',
    taskTitle: 'Task',
    executor: 'claude',
    state: 'finished',
    branch: 'dispatch/t-1',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('mergeLadderState', () => {
  test('ladder state from run meta', () => {
    expect(mergeLadderState(undefined)).toBe('unmerged');
    expect(mergeLadderState(run({}))).toBe('unmerged');
    expect(
      mergeLadderState(run({ reviewAction: 'merge', mergeCommit: 'abc' }))
    ).toBe('merged-local');
    expect(
      mergeLadderState(
        run({ reviewAction: 'merge', mergeCommit: 'abc', pushedToOrigin: true })
      )
    ).toBe('on-origin');
    expect(mergeLadderState(run({ reviewAction: 'discard' }))).toBe('unmerged');
  });

  test('a merge review action without a merge commit stays unmerged', () => {
    // A 'merge' review action that failed before producing a commit — no
    // `mergeCommit`, so this must not read as merged.
    expect(mergeLadderState(run({ reviewAction: 'merge' }))).toBe('unmerged');
  });

  test('a pr review action counts as on-origin — markRunMergedViaPr only fires once GitHub reports the PR merged', () => {
    expect(
      mergeLadderState(
        run({ reviewAction: 'pr', prUrl: 'https://example.com/pr/1' })
      )
    ).toBe('on-origin');
    // No prUrl at all is still on-origin — the state only depends on reviewAction.
    expect(mergeLadderState(run({ reviewAction: 'pr' }))).toBe('on-origin');
  });
});

describe('mergeLadderLabel', () => {
  test('labels each state', () => {
    expect(mergeLadderLabel('unmerged')).toBe('not merged');
    expect(mergeLadderLabel('merged-local', 'dispatch/t-1')).toBe(
      'on dispatch/t-1, not pushed'
    );
    expect(mergeLadderLabel('on-origin', undefined, 'abc1234567')).toBe(
      'in origin (abc1234)'
    );
  });

  test('on-origin without a sha falls back to PR wording rather than printing "undefined"', () => {
    expect(
      mergeLadderLabel(
        'on-origin',
        undefined,
        undefined,
        'https://github.com/o/r/pull/123'
      )
    ).toBe('merged via PR #123');
    expect(
      mergeLadderLabel(
        'on-origin',
        undefined,
        undefined,
        'https://example.com/not-a-pr'
      )
    ).toBe('merged via PR');
    expect(mergeLadderLabel('on-origin')).toBe('merged via PR');
  });
});
