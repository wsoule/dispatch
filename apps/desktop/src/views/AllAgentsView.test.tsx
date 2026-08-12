import type { AgentSessionMeta, ApiClient, RunMeta } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import {
  agentSessionBucket,
  agentSessionFeedState,
} from '../lib/agentSessions';
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

function session(over: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return {
    id: 'plan-1',
    kind: 'plan',
    title: 'plan the widget',
    state: 'running',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    ...over,
  };
}

function mount(over: Partial<Parameters<typeof AllAgentsView>[0]> = {}) {
  const props = {
    runs: [run()],
    sessions: [] as AgentSessionMeta[],
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

// The mapping the session rows filter and color by: a settled turn waits on a human
// (confirm, answer, retry), so it lands in needs-review; nothing ever lands in closed.
test('agentSessionBucket and agentSessionFeedState cover every session state', () => {
  expect(agentSessionBucket(session({ state: 'running' }))).toBe('live');
  expect(agentSessionBucket(session({ state: 'ready' }))).toBe('needs-review');
  expect(agentSessionBucket(session({ state: 'failed' }))).toBe('needs-review');
  expect(agentSessionFeedState(session({ state: 'running' }))).toBe('working');
  expect(agentSessionFeedState(session({ state: 'ready' }))).toBe('waiting');
  expect(agentSessionFeedState(session({ state: 'failed' }))).toBe('failed');
});

// The point of the whole change: a planner, an enrich agent, a draft and a warden all
// appear on the page, labelled, alongside the runs.
test('conversation agents render alongside runs with their kind labels', () => {
  mount({
    runs: [run({ id: 'r-1', taskTitle: 'A task run' })],
    sessions: [
      session({ id: 'plan-1', kind: 'plan', title: 'Plan the widget' }),
      session({ id: 'plan-2', kind: 'enrich', title: 'Fix the header' }),
      session({ id: 'draft-1', kind: 'draft', title: 'Draft a task' }),
      session({ id: 'w-1', kind: 'warden', title: 'What is running?' }),
    ],
  });
  expect(screen.getByText('A task run')).toBeDefined();
  expect(screen.getByText('Plan the widget')).toBeDefined();
  expect(screen.getByText('planner')).toBeDefined();
  expect(screen.getByText('Fix the header')).toBeDefined();
  expect(screen.getByText('detail')).toBeDefined();
  expect(screen.getByText('Draft a task')).toBeDefined();
  expect(screen.getByText('draft')).toBeDefined();
  expect(screen.getByText('What is running?')).toBeDefined();
  expect(screen.getByText('warden')).toBeDefined();
});

test('the state filter applies to conversation agents too', () => {
  mount({
    runs: [],
    sessions: [
      session({ id: 'plan-1', state: 'running', title: 'Still planning' }),
      session({ id: 'plan-2', state: 'ready', title: 'Proposal ready' }),
    ],
  });

  fireEvent.click(screen.getByRole('button', { name: 'Live' }));
  expect(screen.getByText('Still planning')).toBeDefined();
  expect(screen.queryByText('Proposal ready')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Needs review' }));
  expect(screen.getByText('Proposal ready')).toBeDefined();
  expect(screen.queryByText('Still planning')).toBeNull();

  // An in-memory conversation is never closed out — it is dismissed and disappears.
  fireEvent.click(screen.getByRole('button', { name: 'Closed' }));
  expect(screen.queryByText('Still planning')).toBeNull();
  expect(screen.queryByText('Proposal ready')).toBeNull();
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

// Cost had its own column before the reskin — it now shares TaskRow's progress slot with
// the turn count, and must survive a run that only has one of the two.
test('a run row shows turns and cost in the progress slot', () => {
  mount({
    runs: [
      run({ id: 'r-1', taskTitle: 'Both', turns: 12, costUsd: 0.42 }),
      run({ id: 'r-2', taskTitle: 'Cost only', costUsd: 1.5 }),
      run({ id: 'r-3', taskTitle: 'Turns only', turns: 3 }),
    ],
  });
  expect(screen.getByText('12t · $0.42')).toBeDefined();
  expect(screen.getByText('$1.50')).toBeDefined();
  expect(screen.getByText('3t')).toBeDefined();
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
