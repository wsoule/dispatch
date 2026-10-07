import type { RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  landButtonLabel,
  landedCommitUrl,
  mergeLadderLabel,
  mergeLadderPillLabel,
  mergeLadderState,
  mergeLadderTint,
  releaseLabel,
} from './mergeLadder';

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
    // No remote to reach: landed, honestly, locally.
    expect(
      mergeLadderState(
        run({ reviewAction: 'merge', mergeCommit: 'abc', landsOn: 'local' })
      )
    ).toBe('local-only');
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
  // Every surface names the destination: "landed" alone is what let a merge
  // sit on one laptop while origin shipped two releases without it.
  test('names where the work went', () => {
    expect(mergeLadderLabel(undefined)).toBe('not merged');
    expect(
      mergeLadderLabel(
        run({
          reviewAction: 'merge',
          mergeCommit: 'abc1234567',
          pushedToOrigin: true,
          landsOn: 'origin',
        })
      )
    ).toBe('Landed on origin/main · abc1234');
    expect(
      mergeLadderLabel(
        run({
          reviewAction: 'merge',
          mergeCommit: 'abc1234567',
          pushedToOrigin: false,
          landsOn: 'origin',
        })
      )
    ).toBe('Merged locally — not on GitHub yet');
    expect(
      mergeLadderLabel(
        run({ reviewAction: 'merge', mergeCommit: 'abc', landsOn: 'local' })
      )
    ).toBe('Landed locally (no remote)');
    expect(
      mergeLadderLabel(
        run({
          reviewAction: 'merge',
          mergeCommit: 'abc',
          landsOn: 'local',
          baseBranch: 'epic/e-1',
        })
      )
    ).toBe('Landed on epic/e-1 (local epic branch)');
  });

  test('a PR landing names the PR rather than printing "undefined"', () => {
    expect(
      mergeLadderLabel(
        run({ reviewAction: 'pr', prUrl: 'https://github.com/o/r/pull/123' })
      )
    ).toBe('Landed via PR #123');
    expect(mergeLadderLabel(run({ reviewAction: 'pr' }))).toBe('Landed via PR');
  });
});

describe('landButtonLabel', () => {
  test('says where a click puts the work', () => {
    expect(landButtonLabel(run({ landsOn: 'origin' }))).toBe(
      'Land on origin/main'
    );
    expect(landButtonLabel(run({ landsOn: 'local' }))).toBe(
      'Land on local main'
    );
    // An older daemon that does not say: the plain verb, not a guess.
    expect(landButtonLabel(run({}))).toBe('Land');
  });
});

describe('releaseLabel', () => {
  test('answers "did it ship" against the newest release tag', () => {
    expect(
      releaseLabel(run({ release: { tag: 'v0.39.1', included: true } }))
    ).toBe('in v0.39.1');
    expect(
      releaseLabel(run({ release: { tag: 'v0.39.1', included: false } }))
    ).toBe('not released yet');
    expect(releaseLabel(run({}))).toBeUndefined();
  });
});

describe('landedCommitUrl', () => {
  const landed = run({
    reviewAction: 'merge',
    mergeCommit: 'abc1234567',
    pushedToOrigin: true,
    landsOn: 'origin',
  });

  test('links an origin landing to its commit on GitHub', () => {
    expect(landedCommitUrl(landed, 'https://github.com/o/r')).toBe(
      'https://github.com/o/r/commit/abc1234567'
    );
  });

  test('never links a commit GitHub does not have', () => {
    expect(landedCommitUrl(landed, undefined)).toBeUndefined();
    expect(
      landedCommitUrl(
        { ...landed, pushedToOrigin: false },
        'https://github.com/o/r'
      )
    ).toBeUndefined();
  });
});

describe('mergeLadderTint', () => {
  test('paints each rung with a --state-* role, never a raw hue', () => {
    expect(mergeLadderTint('unmerged')).toBe('var(--state-ready-fg)');
    expect(mergeLadderTint('merged-local')).toBe('var(--state-waiting-fg)');
    expect(mergeLadderTint('local-only')).toBe('var(--state-landing-fg)');
    expect(mergeLadderTint('on-origin')).toBe('var(--state-landing-fg)');
  });
});

describe('mergeLadderPillLabel', () => {
  test('gives each rung a short pill label', () => {
    expect(mergeLadderPillLabel('unmerged')).toBe('Not merged');
    expect(mergeLadderPillLabel('merged-local')).toBe('Not on GitHub');
    expect(mergeLadderPillLabel('local-only')).toBe('Landed locally');
    expect(mergeLadderPillLabel('on-origin')).toBe('On origin');
  });
});
