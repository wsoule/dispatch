import type { RunMeta, RunState } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import type { RunDisposition } from './runState';
import { deriveRunDisposition, isTerminalRunState } from './runState';

describe('isTerminalRunState', () => {
  test.each([
    ['provisioning', false],
    ['running', false],
    ['awaiting-approval', false],
    ['finished', true],
    ['failed', true],
    ['cancelled', true],
  ] as [RunState, boolean][])('%s -> %s', (state, expected) => {
    expect(isTerminalRunState(state)).toBe(expected);
  });
});

// Only the fields deriveRunDisposition actually reads — a full RunMeta carries
// a dozen more that are irrelevant to this derivation.
function run(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-abc123',
    taskId: 't-abc123',
    taskTitle: 'Do the thing',
    executor: 'claude',
    state: 'finished',
    branch: 'dispatch/t-abc123',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...over,
  } as RunMeta;
}

describe('deriveRunDisposition', () => {
  test.each([
    ['provisioning', 'live'],
    ['running', 'live'],
    ['awaiting-approval', 'live'],
  ] as [RunState, RunDisposition][])('a %s run is %s', (state, expected) => {
    expect(deriveRunDisposition(run({ state }))).toBe(expected);
  });

  // The state this whole helper exists for: the agent got to the end of its
  // work, nothing downstream is blocked on the human, but a human still owes
  // it a look. Purely a signal — it changes no auto-start or merge behavior.
  test('a finished, unreviewed run needs review', () => {
    expect(deriveRunDisposition(run({ state: 'finished' }))).toBe(
      'needs-review'
    );
  });

  // The complement of the truncated-run fix: a run the usage limit cut off is
  // now correctly recorded `failed`, and it still has its session, so the
  // actionable next step is "continue", not "review".
  test('a failed run with a session stopped short and is resumable', () => {
    expect(
      deriveRunDisposition(run({ state: 'failed', sessionId: 'sess-1' }))
    ).toBe('stopped-short');
  });

  test('a cancelled run with a session stopped short too', () => {
    expect(
      deriveRunDisposition(run({ state: 'cancelled', sessionId: 'sess-1' }))
    ).toBe('stopped-short');
  });

  // No session means nothing to resume into — the run is dead, not paused, so
  // it must not advertise a "continue" affordance that cannot work.
  test('a failed run with no session is dead, not resumable', () => {
    expect(deriveRunDisposition(run({ state: 'failed' }))).toBe('dead');
  });

  // An open PR moves review to GitHub; the desktop review queue must not also
  // claim it as something to review locally.
  test('a finished run with an open PR is under review elsewhere', () => {
    expect(
      deriveRunDisposition(
        run({ state: 'finished', prUrl: 'https://github.com/x/y/pull/1' })
      )
    ).toBe('in-review-elsewhere');
  });

  // reviewedAt is the one-way "a human closed this out" marker and wins over
  // everything else, including a failed terminal state.
  test('a reviewed run is closed regardless of its terminal state', () => {
    expect(
      deriveRunDisposition(
        run({ state: 'finished', reviewedAt: '2026-07-26T01:00:00.000Z' })
      )
    ).toBe('closed');
    expect(
      deriveRunDisposition(
        run({
          state: 'failed',
          sessionId: 'sess-1',
          reviewedAt: '2026-07-26T01:00:00.000Z',
        })
      )
    ).toBe('closed');
  });
});
