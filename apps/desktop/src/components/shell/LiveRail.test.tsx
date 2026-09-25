import type {
  EpicProgress,
  OverseerAction,
  OverseerRecord,
  RunMeta,
} from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { OverseerSession } from '../../hooks/useOverseerSession';
import { LiveRail } from './LiveRail';

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

// The same record/action fixtures overseerThread.test.ts builds — the section reads the
// identical OverseerSession seam OverseerView uses, so a fake session with a canned record
// is the whole test backend.
function overseerRecord(over: Partial<OverseerRecord> = {}): OverseerRecord {
  return {
    id: 'w-1',
    prompt: 'what is going on?',
    backendName: 'fake',
    state: 'ready',
    messages: [],
    pendingActions: [],
    pendingApprovals: [],
    undeliveredDecisions: [],
    createdAt: '2026-08-10T00:00:00Z',
    updatedAt: '2026-08-10T00:00:05Z',
    ...over,
  };
}

function overseerAction(over: Partial<OverseerAction> = {}): OverseerAction {
  return {
    id: 'act-1',
    tool: 'cancel_run',
    input: { runId: 'r-1' },
    summary: 'Cancel run r-1',
    createdAt: '2026-08-10T00:00:02Z',
    status: 'pending',
    ...over,
  };
}

function overseerSession(over: Partial<OverseerSession> = {}): OverseerSession {
  return {
    conversationId: null,
    record: undefined,
    recordError: null,
    submit: () => Promise.resolve(),
    sending: false,
    sendError: null,
    confirmAction: () => Promise.resolve(),
    decidingActionId: null,
    decideApproval: () => Promise.resolve(),
    decidingRequestId: null,
    decideError: null,
    model: 'claude-opus-5',
    setModel: () => {},
    effortId: 'default',
    setEffortId: () => {},
    configuredEffort: undefined,
    reset: () => {},
    draft: '',
    setDraft: () => {},
    ...over,
  };
}

// A milestone mid fan-out: the ids of its children are all the rail reads from it, plus
// the spend block the section row prints.
function session(
  epicId: string,
  childIds: string[],
  over: Partial<EpicProgress['spend']> = {}
): EpicProgress {
  return {
    epicId,
    active: true,
    concurrency: 2,
    session: {
      epicId,
      concurrency: 2,
      executor: 'claude',
      state: 'active',
      maxSpendUsd: 60,
      maxRuns: null,
      startedAt: '2026-08-04T00:00:00.000Z',
      updatedAt: '2026-08-04T00:00:00.000Z',
      active: true,
    },
    spend: {
      settledUsd: 41.2,
      liveCount: childIds.length,
      estimatedLiveUsd: 10 * childIds.length,
      runsStarted: childIds.length,
      maxSpendUsd: 60,
      maxRuns: null,
      ...over,
    },
    children: childIds.map((id) => ({
      id,
      title: id,
      status: 'working',
      phase: 'working',
      wave: 1,
      openFindings: 0,
    })),
    waves: [],
    liveRuns: [],
  };
}

function epicDoc(id: string, title: string): TaskDoc {
  return { meta: { id, title, kind: 'epic', status: 'working' } } as TaskDoc;
}

function railProps(over: Partial<Parameters<typeof LiveRail>[0]> = {}) {
  return {
    runs: [],
    overseer: overseerSession(),
    onOpenTask: () => {},
    onOpenOverseer: () => {},
    ...over,
  };
}

test('renders the idle copy with no runs', () => {
  render(<LiveRail {...railProps()} />);
  expect(screen.getByText('No agents running.')).toBeDefined();
  expect(screen.queryByRole('button')).toBeNull();
});

test('renders a 28px row per live run; clicking opens its task on Chat', () => {
  const calls: unknown[] = [];
  render(
    <LiveRail
      {...railProps({
        runs: [run()],
        onOpenTask: (taskId, tab, runId) => {
          calls.push([taskId, tab, runId]);
        },
      })}
    />
  );
  const row = screen.getByRole('button', { name: 'Do the thing' });
  expect(row.className).toContain('h-7');
  fireEvent.click(row);
  expect(calls).toEqual([['t-1', 'chat', 'r-1']]);
});

test('the section has no tabs and no attention strip any more', () => {
  render(<LiveRail {...railProps({ runs: [run()] })} />);
  expect(screen.queryByRole('tab')).toBeNull();
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(screen.queryByText(/waiting on you/)).toBeNull();
  // No mono meta, no kind word on screen — the kind lives in the accessible name.
  expect(screen.queryByText('agent')).toBeNull();
});

test('a review run carries its kind in the accessible name', () => {
  render(<LiveRail {...railProps({ runs: [run({ kind: 'review' })] })} />);
  expect(
    screen.getByRole('button', { name: 'Do the thing (review)' })
  ).toBeDefined();
});

test('a running overseer turn is a row that opens the Overseer page', () => {
  let opened = 0;
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord({ state: 'running' }),
  });
  render(
    <LiveRail
      {...railProps({
        runs: [run()],
        overseer,
        onOpenOverseer: () => opened++,
      })}
    />
  );
  fireEvent.click(screen.getByText('what is going on?'));
  expect(opened).toBe(1);
});

test('a settled overseer conversation adds no row', () => {
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord({ state: 'ready' }),
  });
  render(<LiveRail {...railProps({ overseer })} />);
  expect(screen.getByText('No agents running.')).toBeDefined();
});

// A failed record fetch (daemon restart → the stale id 404s, and the query has
// retry: false) leaves record undefined forever. That is a broken conversation, not an
// agent at work — no phantom running row.
test('a failed overseer record fetch does not fake a running row', () => {
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: undefined,
    recordError: 'overseer conversation w-1 not found (404)',
  });
  render(<LiveRail {...railProps({ overseer })} />);
  expect(screen.getByText('No agents running.')).toBeDefined();
});

// A settled turn holding a queued mutation is state 'ready' — idle — but the section must
// not go quiet while an approval is stranded on the human.
test('a queued approval keeps a waiting row named by the action', () => {
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord({
      state: 'ready',
      pendingActions: [overseerAction()],
    }),
  });
  render(<LiveRail {...railProps({ overseer })} />);
  expect(screen.queryByText('No agents running.')).toBeNull();
  // The row names the thing that is actually waiting — the queued action — not the
  // conversation's opening question from possibly hours earlier.
  expect(screen.getByText('Cancel run r-1')).toBeDefined();
  expect(screen.queryByText('what is going on?')).toBeNull();
});

test('a transient refetch error mid-turn keeps the running row', () => {
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord({ state: 'running' }),
    recordError: 'network blip',
  });
  render(<LiveRail {...railProps({ overseer })} />);
  expect(screen.getByText('what is going on?')).toBeDefined();
});

test('a parked tool call names the waiting row', () => {
  const overseer = overseerSession({
    conversationId: 'w-1',
    record: overseerRecord({
      state: 'running',
      pendingApprovals: [
        {
          requestId: 'req-1',
          toolName: 'Bash',
          input: { command: 'git status' },
          summary: 'Bash: git status',
          requestedAt: '2026-08-10T00:00:01Z',
        },
      ],
    }),
  });
  render(<LiveRail {...railProps({ overseer })} />);
  expect(screen.getByText('Bash: git status')).toBeDefined();
});

test('a live run that fanned out shows its running/total sub-agent count', () => {
  render(
    <LiveRail
      {...railProps({
        runs: [
          run({
            subagents: {
              total: 12,
              running: 5,
              done: 7,
              failed: 0,
              stopped: 0,
            },
          }),
        ],
      })}
    />
  );
  expect(screen.getByLabelText('5 of 12 sub-agents running').textContent).toBe(
    '5/12'
  );
});

test('the rail keeps its test id in both the idle and the populated state', () => {
  const { rerender } = render(<LiveRail {...railProps()} />);
  expect(screen.getByTestId('live-rail').textContent).toBe(
    'No agents running.'
  );
  rerender(<LiveRail {...railProps({ runs: [run()] })} />);
  expect(screen.getByTestId('live-rail').className).toContain('max-h-56');
});

test('live runs on a milestone with a session group under its section row', () => {
  const opened: string[] = [];
  const runs = [
    run({ id: 'r-1', taskId: 't-1', taskTitle: 'Rotate the tokens' }),
    run({ id: 'r-9', taskId: 't-9', taskTitle: 'Loose run' }),
    run({ id: 'r-2', taskId: 't-2', taskTitle: 'Rewrite the login' }),
  ];
  render(
    <LiveRail
      {...railProps({
        runs,
        sessions: [session('e-1', ['t-1', 't-2'])],
        epics: [epicDoc('e-1', 'Auth rewrite')],
        onOpenMilestone: (id) => {
          opened.push(id);
        },
      })}
    />
  );
  // The count and spend are in the name too — they are what the row exists to show.
  const section = screen.getByRole('button', {
    name: 'Auth rewrite milestone · 2 running · $41.20 / $60',
  });
  expect(section.className).toContain('h-7');
  expect(section.textContent).toContain('Auth rewrite');
  expect(screen.getByText('2 running · $41.20 / $60')).toBeDefined();

  // Section row, its two rows, then the loose row — in that order.
  const names = screen
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label'));
  expect(names).toEqual([
    'Auth rewrite milestone · 2 running · $41.20 / $60',
    'Rotate the tokens',
    'Rewrite the login',
    'Loose run',
  ]);

  // The rows under the section indent; the loose row does not.
  expect(
    screen.getByRole('button', { name: 'Rotate the tokens' }).className
  ).toContain('pl-6');
  expect(
    screen.getByRole('button', { name: 'Loose run' }).className
  ).not.toContain('pl-6');

  fireEvent.click(section);
  expect(opened).toEqual(['e-1']);
});

test('a session with no ceiling prints its settled spend alone', () => {
  render(
    <LiveRail
      {...railProps({
        runs: [run({ taskId: 't-1' })],
        sessions: [session('e-1', ['t-1'], { maxSpendUsd: null })],
        epics: [epicDoc('e-1', 'Auth rewrite')],
      })}
    />
  );
  expect(screen.getByText('1 running · $41.20')).toBeDefined();
});

test('a milestone with no epic doc is named by its id', () => {
  render(
    <LiveRail
      {...railProps({
        runs: [run({ taskId: 't-1' })],
        sessions: [session('e-1', ['t-1'])],
      })}
    />
  );
  expect(
    screen.getByRole('button', {
      name: 'e-1 milestone · 1 running · $41.20 / $60',
    })
  ).toBeDefined();
});

test('a paused session reads as held rather than working', () => {
  const active = session('e-1', ['t-1']);
  const paused: EpicProgress = {
    ...active,
    session:
      active.session === null
        ? null
        : { ...active.session, state: 'paused', active: false },
  };
  const { container } = render(
    <LiveRail
      {...railProps({
        runs: [run({ taskId: 't-1' })],
        sessions: [paused],
        epics: [epicDoc('e-1', 'Auth rewrite')],
      })}
    />
  );
  const section = container.querySelector(
    '[data-slot="live-rail-group"] > button'
  );
  expect(section?.querySelector('svg.lucide-ban')).not.toBeNull();
  expect(section?.querySelector('svg.lucide-loader-circle')).toBeNull();
});

test('a session with nothing live adds no section row', () => {
  render(
    <LiveRail
      {...railProps({
        runs: [run({ taskId: 't-9' })],
        sessions: [session('e-1', ['t-1'])],
        epics: [epicDoc('e-1', 'Auth rewrite')],
      })}
    />
  );
  expect(screen.queryByText(/milestone|running ·/)).toBeNull();
  expect(screen.getAllByRole('button')).toHaveLength(1);
});

test('without sessions the rail renders exactly as before', () => {
  const runs = [
    run({ id: 'r-1', taskId: 't-1' }),
    run({ id: 'r-2', taskId: 't-2' }),
  ];
  const { container: bare } = render(<LiveRail {...railProps({ runs })} />);
  const { container: withEmpty } = render(
    <LiveRail
      {...railProps({
        runs,
        sessions: [],
        epics: [],
        onOpenMilestone: () => {},
      })}
    />
  );
  expect(withEmpty.innerHTML).toBe(bare.innerHTML);
  expect(bare.querySelector('[data-slot="live-rail-group"]')).toBeNull();
});
