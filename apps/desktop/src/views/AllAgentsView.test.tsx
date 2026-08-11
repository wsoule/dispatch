import type { ApiClient, RunMeta } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { runKindLabel } from '../lib/liveRail';
import { runStateBucket } from '../lib/runState';
import { AllAgentsView } from './AllAgentsView';

function run(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Do the thing',
    executor: 'claude',
    state: 'running',
    branch: 'dispatch/t-1',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    ...over,
  } as RunMeta;
}

function mount(over: Partial<Parameters<typeof AllAgentsView>[0]> = {}) {
  const props = {
    runs: [run()],
    archivedRunCount: 0,
    showArchived: false,
    onSetShowArchived: () => {},
    onArchiveRun: () => {},
    portLoading: false,
    portError: false,
    portErrorDetail: null,
    client: {} as ApiClient,
    onRetry: () => {},
    onJumpToRun: () => {},
    ...over,
  };
  return render(<AllAgentsView {...props} />);
}

// The kind derivation, at the level a row actually reads it: a run recorded before `kind`
// existed is a plain agent dispatch, not an unknown.
test('runKindLabel names each kind, defaulting a kindless run to agent', () => {
  expect(runKindLabel(run())).toBe('agent');
  expect(runKindLabel(run({ kind: 'execute' }))).toBe('agent');
  expect(runKindLabel(run({ kind: 'review' }))).toBe('review');
  expect(runKindLabel(run({ kind: 'verify' }))).toBe('verify');
});

// The filter's derivation. Every disposition must land in exactly one bucket, or a run
// disappears from every filter except All.
test('runStateBucket sorts every run into live, needs-review, or closed', () => {
  expect(runStateBucket(run({ state: 'running' }))).toBe('live');
  expect(runStateBucket(run({ state: 'awaiting-approval' }))).toBe('live');
  // Finished and unreviewed — the classic review queue entry.
  expect(runStateBucket(run({ state: 'finished' }))).toBe('needs-review');
  // An open PR moved review to GitHub, but a person still owes it a look.
  expect(
    runStateBucket(run({ state: 'finished', prUrl: 'https://x/pull/1' }))
  ).toBe('needs-review');
  // Failed with a session (continue it) and failed without one (discard it) both still owe
  // a person something.
  expect(runStateBucket(run({ state: 'failed', sessionId: 's-1' }))).toBe(
    'needs-review'
  );
  expect(runStateBucket(run({ state: 'failed' }))).toBe('needs-review');
  // Finished business: closed out by a human, or killed.
  expect(
    runStateBucket(
      run({ state: 'finished', reviewedAt: '2026-08-04T01:00:00.000Z' })
    )
  ).toBe('closed');
  expect(runStateBucket(run({ state: 'cancelled' }))).toBe('closed');
});

test('a review run is labelled, a plain agent run is not', () => {
  mount({
    runs: [
      run({ id: 'r-1', taskTitle: 'Plain agent run' }),
      run({ id: 'r-2', kind: 'review', taskTitle: 'Reviewed run' }),
      run({ id: 'r-3', kind: 'verify', taskTitle: 'Verified run' }),
    ],
  });
  expect(screen.getByText('review')).toBeDefined();
  expect(screen.getByText('verify')).toBeDefined();
  // 'agent' would be a whole column of the same word — the label is only for the runs a
  // person did not dispatch by hand.
  expect(screen.queryByText('agent')).toBeNull();
});

test('the state filter narrows the list to one bucket', () => {
  mount({
    runs: [
      run({ id: 'r-1', state: 'running', taskTitle: 'Still working' }),
      run({ id: 'r-2', state: 'finished', taskTitle: 'Awaiting a look' }),
      run({
        id: 'r-3',
        state: 'finished',
        reviewedAt: '2026-08-04T01:00:00.000Z',
        taskTitle: 'Already closed',
      }),
    ],
  });

  expect(screen.getByText('Still working')).toBeDefined();
  expect(screen.getByText('Already closed')).toBeDefined();

  fireEvent.click(screen.getByRole('button', { name: 'Needs review' }));
  expect(screen.getByText('Awaiting a look')).toBeDefined();
  expect(screen.queryByText('Still working')).toBeNull();
  expect(screen.queryByText('Already closed')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Live' }));
  expect(screen.getByText('Still working')).toBeDefined();
  expect(screen.queryByText('Awaiting a look')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Closed' }));
  expect(screen.getByText('Already closed')).toBeDefined();
  expect(screen.queryByText('Still working')).toBeNull();
});

// The whole point of the rehome: archiving lost its only UI when the Runs page was retired,
// so an already-archived run had no way back.
test('each row archives, and an archived row offers to unarchive', () => {
  const calls: [string, boolean][] = [];
  mount({
    showArchived: true,
    archivedRunCount: 1,
    runs: [
      run({ id: 'r-1', taskTitle: 'Live one' }),
      run({
        id: 'r-2',
        taskTitle: 'Put away',
        archivedAt: '2026-08-04T02:00:00.000Z',
      }),
    ],
    onArchiveRun: (runId, archived) => calls.push([runId, archived]),
  });

  fireEvent.click(screen.getByRole('button', { name: 'Archive Live one' }));
  fireEvent.click(screen.getByRole('button', { name: 'Unarchive Put away' }));
  expect(calls).toEqual([
    ['r-1', true],
    ['r-2', false],
  ]);
});

test('the show-archived toggle appears once something is archived, and flips the shared state', () => {
  const seen: boolean[] = [];
  const { unmount } = mount({
    archivedRunCount: 2,
    onSetShowArchived: (next) => seen.push(next),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Show archived' }));
  expect(seen).toEqual([true]);
  unmount();

  // Nothing archived and the toggle off: no control to show.
  const clean = mount({ archivedRunCount: 0, showArchived: false });
  expect(screen.queryByRole('button', { name: 'Show archived' })).toBeNull();
  clean.unmount();

  // ...but it must never vanish while it is ON, or it would delete the only way back.
  mount({ archivedRunCount: 0, showArchived: true });
  expect(screen.getByRole('button', { name: 'Hide archived' })).toBeDefined();
});
