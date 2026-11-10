import type { AgentSessionMeta, ApiClient, RunMeta } from '@dispatch/client';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { expect, jest, test } from 'bun:test';

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
  expect(agentSessionFeedState(session({ state: 'ready' }))).toBe('answer');
  expect(agentSessionFeedState(session({ state: 'failed' }))).toBe('failed');
});

// The point of the whole change: a planner, an enrich agent, a draft and a overseer all
// appear on the page, labelled, alongside the runs.
test('conversation agents render alongside runs with their kind labels', () => {
  mount({
    runs: [run({ id: 'r-1', taskTitle: 'A task run' })],
    sessions: [
      session({ id: 'plan-1', kind: 'plan', title: 'Plan the widget' }),
      session({ id: 'plan-2', kind: 'enrich', title: 'Fix the header' }),
      session({ id: 'draft-1', kind: 'draft', title: 'Draft a task' }),
      session({ id: 'w-1', kind: 'overseer', title: 'What is running?' }),
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
  expect(screen.getByText('overseer')).toBeDefined();
});

// A merged run's raw state is still `finished` and a superseded predecessor's is still
// `failed`; the row must say which work landed (and as what) instead.
test('runs read merged with their commit, and superseded instead of failed', () => {
  mount({
    runs: [
      run({
        id: 'r-new',
        taskTitle: 'Landed run',
        state: 'finished',
        reviewedAt: '2026-08-04T01:00:00.000Z',
        reviewAction: 'merge',
        mergeCommit: '4cdd0c9a1b2c3d4e',
      }),
      run({
        id: 'r-old',
        taskTitle: 'Resumed run',
        state: 'failed',
        reviewedAt: '2026-08-04T01:00:00.000Z',
        reviewAction: 'merge',
        mergeCommit: '4cdd0c9a1b2c3d4e',
        supersededBy: 'r-new',
      }),
    ],
  });
  expect(screen.getByText(/merged 4cdd0c9/)).toBeDefined();
  expect(screen.getByText(/superseded by r-new/)).toBeDefined();
  expect(screen.queryByText(/failed/)).toBeNull();
});

test('the state filter applies to conversation agents too', () => {
  mount({
    runs: [],
    sessions: [
      session({ id: 'plan-1', state: 'running', title: 'Still planning' }),
      session({ id: 'plan-2', state: 'ready', title: 'Proposal ready' }),
    ],
  });

  fireEvent.click(screen.getByRole('radio', { name: /^Live/ }));
  expect(screen.getByText('Still planning')).toBeDefined();
  expect(screen.queryByText('Proposal ready')).toBeNull();

  fireEvent.click(screen.getByRole('radio', { name: /^Needs review/ }));
  expect(screen.getByText('Proposal ready')).toBeDefined();
  expect(screen.queryByText('Still planning')).toBeNull();

  // An in-memory conversation is never closed out — it is dismissed and disappears.
  fireEvent.click(screen.getByRole('radio', { name: /^Closed/ }));
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

// Cost had its own column before the reskin — it now shares the progress cell with the turn
// count, and must survive a run that only has one of the two.
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

  fireEvent.click(screen.getByRole('radio', { name: /^Needs review/ }));
  expect(screen.getByText('Awaiting a look')).toBeDefined();
  expect(screen.queryByText('Still working')).toBeNull();
  expect(screen.queryByText('Already closed')).toBeNull();

  fireEvent.click(screen.getByRole('radio', { name: /^Live/ }));
  expect(screen.getByText('Still working')).toBeDefined();
  expect(screen.queryByText('Awaiting a look')).toBeNull();

  fireEvent.click(screen.getByRole('radio', { name: /^Closed/ }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Show archived (2)' }));
  expect(seen).toEqual([true]);
  unmount();

  // Nothing archived and the toggle off: no control to show.
  const clean = mount({ archivedRunCount: 0, showArchived: false });
  expect(screen.queryByRole('button', { name: /Show archived/ })).toBeNull();
  clean.unmount();

  // ...but it must never vanish while it is ON, or it would delete the only way back.
  mount({ archivedRunCount: 0, showArchived: true });
  expect(screen.getByRole('button', { name: 'Hide archived' })).toBeDefined();
});

// A fleet shares the progress slot with turns and cost, and gets its own chip so the runs
// that fanned out can be found among everything else.
test('a run row shows its fan-out, and the Fan-out chip keeps only runs with sub-agents', () => {
  mount({
    runs: [
      run({
        id: 'r-1',
        taskTitle: 'Fleet',
        turns: 4,
        subagents: { total: 8, running: 3, done: 5, failed: 0, stopped: 0 },
      }),
      run({ id: 'r-2', taskTitle: 'Solo', turns: 2 }),
    ],
    sessions: [session()],
  });
  expect(screen.getByText('4t · 3/8 agents live')).toBeDefined();
  fireEvent.click(screen.getByRole('radio', { name: /^Fan-out/ }));
  expect(screen.getByText('Fleet')).toBeDefined();
  expect(screen.queryByText('Solo')).toBeNull();
  expect(screen.queryByText('plan the widget')).toBeNull();
});

// The Live page has no sidebar row; the Runs page is one of its two doors (the
// palette's Open Live is the other).
test('the toolbar’s Live button opens the Live page when the host offers it', () => {
  const opened: string[] = [];
  mount({ onOpenLive: () => opened.push('live') });
  fireEvent.click(screen.getByRole('button', { name: 'Live' }));
  expect(opened).toEqual(['live']);
  cleanup();
  mount();
  expect(screen.queryByRole('button', { name: 'Live' })).toBeNull();
});

// The toolbar: the state buckets as a segmented control, each with the count its option
// would show, All selected by default. The page crumb belongs to Settings' shell now.
test('the state filter renders as a segmented control with counts, All selected by default', () => {
  mount({
    runs: [
      run({ id: 'r-1', state: 'running' }),
      run({ id: 'r-2', state: 'finished' }),
      run({
        id: 'r-3',
        state: 'finished',
        reviewedAt: '2026-08-04T01:00:00.000Z',
        subagents: { total: 2, running: 0, done: 2, failed: 0, stopped: 0 },
      }),
    ],
    sessions: [
      session({ state: 'running' }),
      session({ id: 'plan-2', state: 'ready' }),
    ],
  });
  const group = screen.getByRole('radiogroup', { name: 'Agent state' });
  const radios = within(group).getAllByRole('radio');
  // Each option is named "label, count", so the number is not read run into the word.
  expect(
    ['All, 5', 'Live, 2', 'Needs review, 2', 'Closed, 1'].map((name) =>
      within(group).getByRole('radio', { name })
    )
  ).toEqual(radios.slice(0, 4));
  // Conversation agents never fan out, so only the fleet run counts.
  expect(radios[4]).toBe(
    within(group).getByRole('radio', { name: 'Fan-out, 1' })
  );
  expect(radios[0]?.getAttribute('aria-checked')).toBe('true');
  expect(radios[1]?.getAttribute('aria-checked')).toBe('false');
});

// A run row is one button that opens the run; the archive button inside it stays its own
// target. A conversation agent has no run page, so its row has no button at all.
test('a run row opens its run, and a session row is not clickable', () => {
  const jumped: string[] = [];
  const archived: string[] = [];
  mount({
    runs: [run({ id: 'r-7', taskTitle: 'Open me' })],
    sessions: [session({ title: 'Just a chat' })],
    onJumpToRun: (runId) => jumped.push(runId),
    onArchiveRun: (runId) => archived.push(runId),
  });
  fireEvent.click(screen.getByRole('button', { name: /^Open me, / }));
  expect(jumped).toEqual(['r-7']);

  fireEvent.click(screen.getByRole('button', { name: 'Archive Open me' }));
  expect(archived).toEqual(['r-7']);
  expect(jumped).toEqual(['r-7']);

  const sessionRow = screen.getByText('Just a chat').closest('li');
  expect(sessionRow).not.toBeNull();
  if (sessionRow === null) return;
  expect(within(sessionRow).queryAllByRole('button')).toHaveLength(0);
});

// The 25-row cap keeps a long history from rendering on every open; Show all lifts it.
test('the list caps at 25 rows until Show all is pressed', () => {
  mount({
    runs: Array.from({ length: 30 }, (_, i) =>
      run({ id: `r-${String(i)}`, taskTitle: `Run ${String(i)}` })
    ),
  });
  const list = screen.getByRole('list', { name: 'Agents' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(25);
  fireEvent.click(screen.getByRole('button', { name: 'Show all 30' }));
  expect(within(list).getAllByRole('listitem')).toHaveLength(30);
});

// Show all on a long history windows the register (the library's `windowed`, above its
// 150-row default): only the rows near the view mount, each telling assistive tech its
// place in the whole list, and the 25-row cap before it stays a plain list.
test('Show all on a long history mounts only the rows near the view', () => {
  mount({
    runs: Array.from({ length: 400 }, (_, i) =>
      run({ id: `r-${String(i)}`, taskTitle: `Run ${String(i)}` })
    ),
  });
  const list = screen.getByRole('list', { name: 'Agents' });
  expect(list.closest('[data-windowed]')).toBeNull();
  expect(within(list).getAllByRole('listitem')).toHaveLength(25);

  fireEvent.click(screen.getByRole('button', { name: 'Show all 400' }));
  expect(list.closest('[data-windowed="true"]')).not.toBeNull();
  const mounted = Array.from(list.querySelectorAll('li[data-row-id]'));
  expect(mounted.length).toBeGreaterThan(0);
  expect(mounted.length).toBeLessThan(400);
  // The first row is the newest run, first in the whole list.
  expect(mounted[0]?.textContent).toContain('Run 0');
  expect(mounted[0]?.getAttribute('aria-posinset')).toBe('1');
  expect(mounted.every((li) => li.getAttribute('aria-setsize') === '400')).toBe(
    true
  );
  // The rest of the list stands as hidden gaps, so its scroll length is kept.
  expect(
    list.querySelector('li[data-row-gap][aria-hidden="true"]')
  ).not.toBeNull();
});

// The empty states keep their words: a filter that matches nothing, and a repo with no
// agents (with the archive hint when every run is archived).
test('the empty states say why the list is empty', () => {
  const { unmount } = mount({ runs: [run({ state: 'running' })] });
  fireEvent.click(screen.getByRole('radio', { name: /^Closed/ }));
  expect(screen.getByText('No agents match this filter')).toBeDefined();
  unmount();

  const none = mount({ runs: [] });
  expect(screen.getByText('No agents have run yet')).toBeDefined();
  expect(
    screen.getByText('Dispatch a task from the board to start one.')
  ).toBeDefined();
  none.unmount();

  mount({ runs: [], archivedRunCount: 2 });
  expect(
    screen.getByText(
      'Every run here is archived — turn on Show archived to see them.'
    )
  ).toBeDefined();
});

// A run row's button is named by everything the row prints, as the old role=button row was,
// so two runs of one task are two different names, not two identical "Do the thing" buttons.
test('a run row is named by its title, agent, outcome, progress and time', () => {
  mount({
    runs: [
      run({
        id: 'r-1',
        taskTitle: 'Same task',
        state: 'failed',
        turns: 3,
        costUsd: 0.1,
      }),
      run({
        id: 'r-2',
        taskTitle: 'Same task',
        kind: 'review',
        state: 'running',
      }),
    ],
  });
  const names = screen
    .getAllByRole('button', { name: /^Same task, / })
    .map((button) => button.getAttribute('aria-label') ?? '');
  expect(names).toHaveLength(2);
  expect(names[0]).not.toBe(names[1]);
  expect(names[0]).toMatch(/^Same task, failed, 3t · \$0\.10, .+ ago$/);
  expect(names[1]).toMatch(/^Same task, review, working, .+ ago$/);
});

// A live run's outcome shimmers like the old row's live detail line; a run that is done
// moving does not.
test('only an in-flight run’s outcome shimmers', () => {
  mount({
    runs: [
      run({ id: 'r-1', state: 'running', taskTitle: 'Moving' }),
      run({ id: 'r-2', state: 'failed', taskTitle: 'Stopped' }),
    ],
    sessions: [session({ state: 'running', title: 'Planning now' })],
  });
  const shimmering = Array.from(
    document.querySelectorAll('[data-shimmer]')
  ).map((node) => node.textContent);
  // The run says "working"; the planner (also in flight) says it too.
  expect(shimmering).toEqual(['working', 'working']);
  expect(screen.getByText('failed').hasAttribute('data-shimmer')).toBe(false);
});

// A conversation agent's state is said in words in the Outcome cell (its mark is
// decorative), and its empty Progress cell carries no label to read over nothing.
test('a session row says its state in words and labels no empty cell', () => {
  mount({
    runs: [],
    sessions: [session({ state: 'ready', title: 'Waiting on me' })],
  });
  const row = screen.getByText('Waiting on me').closest('li');
  if (row === null) throw new Error('no session row');
  expect(within(row).getByText('answer')).toBeDefined();
  expect(within(row).getByText('Outcome')).toBeDefined();
  expect(within(row).queryByText('Progress')).toBeNull();
});

// A closed-out run draws a neutral disc: the check only when its work landed, a bar when it
// was discarded, so a discarded run never reads as completed.
test('a closed run draws done when it landed and closed when it did not', () => {
  const closed = '2026-08-04T01:00:00.000Z';
  mount({
    runs: [
      run({
        id: 'r-1',
        taskTitle: 'Merged one',
        state: 'finished',
        reviewedAt: closed,
        reviewAction: 'merge',
      }),
      run({
        id: 'r-2',
        taskTitle: 'Discarded one',
        state: 'cancelled',
        reviewedAt: closed,
        reviewAction: 'discard',
      }),
    ],
  });
  function markOf(title: string): string | null | undefined {
    return screen
      .getByText(title)
      .closest('li')
      ?.querySelector('[data-slot="state-mark"]')
      ?.getAttribute('data-state');
  }
  expect(markOf('Merged one')).toBe('done');
  expect(markOf('Discarded one')).toBe('closed');
});

// The archive button sits in the row-action hook the stylesheet reveals on the row's hover or
// focus; a pressed (archived) one is marked so it stays shown.
test('the archive button sits in the row-action hook, marked while pressed', () => {
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
  });
  const archive = screen.getByRole('button', { name: 'Archive Live one' });
  const unarchive = screen.getByRole('button', { name: 'Unarchive Put away' });
  const liveHook = archive.closest('[data-slot="row-action"]');
  const awayHook = unarchive.closest('[data-slot="row-action"]');
  expect(liveHook?.hasAttribute('data-pressed')).toBe(false);
  expect(awayHook?.getAttribute('data-pressed')).toBe('true');
});

// The empty state fills the list area (and centres there) instead of sitting at its top.
test('the empty state sits in the list-filling empty slot', () => {
  mount({ runs: [] });
  const empty = screen.getByText('No agents have run yet');
  expect(empty.closest('[data-slot="agents-empty"]')).not.toBeNull();
});

/** A run whose title read is counted: RunRow reads `taskTitle` on every render, so the
 * count says how many times that run's row rendered. */
function countedRun(id: string, renders: Map<string, number>): RunMeta {
  const base = run({ id, taskTitle: `Run ${id}` });
  return Object.defineProperty({ ...base }, 'taskTitle', {
    enumerable: true,
    get() {
      renders.set(id, (renders.get(id) ?? 0) + 1);
      return `Run ${id}`;
    },
  });
}

// The perf contract behind Show all on a 2,000-run project: a poll that changes one run
// (the runs query keeps every other run's object) re-renders that row only, even though the
// host passes fresh inline handlers each render, and the rows still call the newest ones.
test('a poll re-renders only the rows whose run changed', () => {
  const renders = new Map<string, number>();
  const runs = ['a', 'b', 'c'].map((id) => countedRun(id, renders));
  const baseProps = {
    sessions: [] as AgentSessionMeta[],
    archivedRunCount: 0,
    showArchived: false,
    onSetShowArchived: () => {},
    portLoading: false,
    portError: false,
    portErrorDetail: null,
    client: {} as ApiClient,
    onRetry: () => {},
  };
  const { rerender } = render(
    <AllAgentsView
      {...baseProps}
      runs={runs}
      onJumpToRun={() => {}}
      onArchiveRun={() => {}}
    />
  );
  const before = new Map(renders);

  const jumped: string[] = [];
  const archived: string[] = [];
  const [first, , third] = runs;
  if (first === undefined || third === undefined) return;
  rerender(
    <AllAgentsView
      {...baseProps}
      runs={[first, countedRun('b', renders), third]}
      onJumpToRun={(id) => jumped.push(id)}
      onArchiveRun={(id, next) => archived.push(`${id}:${String(next)}`)}
    />
  );
  expect(renders.get('a')).toBe(before.get('a'));
  expect(renders.get('c')).toBe(before.get('c'));
  expect(renders.get('b')).toBeGreaterThan(before.get('b') ?? 0);

  // An unchanged (not re-rendered) row calls the handlers from the latest render.
  fireEvent.click(screen.getByRole('button', { name: /^Run a, / }));
  fireEvent.click(screen.getByRole('button', { name: 'Archive Run c' }));
  expect(jumped).toEqual(['a']);
  expect(archived).toEqual(['c:true']);
});

// The rows are memoized, so nothing but the minute clock redraws an unchanged row: its
// "Updated" time and its button name still move while the page stays open.
test('an unchanged row’s relative time moves with the minute clock', () => {
  jest.useFakeTimers();
  try {
    const now = new Date(Date.now()).toISOString();
    mount({
      runs: [run({ id: 'r-1', taskTitle: 'Quiet run', updatedAt: now })],
      sessions: [session({ title: 'quiet plan', updatedAt: now })],
    });
    const button = screen.getByRole('button', { name: /^Quiet run, / });
    expect(button.getAttribute('aria-label')).toMatch(/, just now$/);
    // Each row's Updated value: the text after the cell's "Updated" label.
    const updated = () =>
      Array.from(document.querySelectorAll('[data-row]'), (row) => {
        const label = Array.from(row.querySelectorAll('span')).find(
          (span) => span.textContent === 'Updated'
        );
        return label?.nextElementSibling?.textContent ?? null;
      });
    const before = updated();
    expect(before).toEqual(['just now', 'just now']);
    act(() => {
      jest.advanceTimersByTime(120_000);
    });
    expect(button.getAttribute('aria-label')).toMatch(/, 2m ago$/);
    expect(updated()).not.toEqual(before);
    expect(updated().every((text) => text === '2m ago')).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});
