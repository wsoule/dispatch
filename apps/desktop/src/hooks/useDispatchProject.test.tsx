import type {
  ConnectEventsOptions,
  EpicProgress,
  EpicSessionOptions,
  RunMeta,
  RunScopeRequest,
  ServerEvent,
} from '@dispatch/client';
import * as dispatchClient from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

const PORT = 4321;

// The one connection the hook asks for. Mocked at the module level because
// `ensureDispatchd` shells out to Tauri, which does not exist under bun:test.
// bun hoists this mock across every file in the run, so `isTauri` keeps the
// real function's contract (the window global) rather than a constant — the
// deep-link tests enter Tauri by defining `__TAURI_INTERNALS__`.
void mock.module('../lib/tauri', () => ({
  ensureDispatchd: () =>
    Promise.resolve({ port: PORT, appToken: 'app-token', agentToken: null }),
  restartDispatchd: () => Promise.resolve(),
  isTauri: () => '__TAURI_INTERNALS__' in window,
}));

// Captured from the hook's own `connectEvents` call, so a test can play the
// daemon and push frames at it.
let sink: {
  onChange: () => void;
  onEvent: (event: ServerEvent) => void;
} | null = null;

// What the daemon's run list says right now, and the open scope requests it
// reports per run — set by the restart test below, empty for everyone else.
let runsFixture: RunMeta[] = [];
let openScopeRequests = new Map<string, RunScopeRequest[]>();
const scopeRequestListings: string[] = [];

// The bulk epic-progress listing the daemon returns, how many times it was
// asked for, and every `startEpic` body the hook sent — the fan-out tests
// below read these.
let epicProgressFixture: EpicProgress[] = [];
let epicProgressFetches = 0;
const epicStarts: [string, EpicSessionOptions | undefined][] = [];

// Only `createApiClient` is replaced — the rest of the module (ApiError, which
// useOverseerSession's 404 veto instanceof-checks) has to stay real.
// Lets a test hold the first presence fetch open, so a `hello` can land while
// it is still in flight — the interleaving a real browser hits.
let presenceGate: Promise<void> | null = null;
let presenceFetches = 0;

void mock.module('@dispatch/client', () => ({
  ...dispatchClient,
  createApiClient: () => ({
    baseUrl: `http://127.0.0.1:${PORT}`,
    fetchRuns: () => Promise.resolve(runsFixture),
    fetchExecutors: () =>
      Promise.resolve({
        executors: [
          {
            name: 'claude',
            reportsCost: true,
            reportsTurns: true,
            enforcesCaps: true,
          },
        ],
        default: 'claude',
      }),
    listScopeRequests: (runId: string) => {
      scopeRequestListings.push(runId);
      return Promise.resolve(openScopeRequests.get(runId) ?? []);
    },
    fetchAllEpicProgress: () => {
      epicProgressFetches += 1;
      return Promise.resolve(epicProgressFixture);
    },
    startEpic: (epicId: string, opts?: EpicSessionOptions) => {
      epicStarts.push([epicId, opts]);
      return Promise.resolve({
        epicId,
        concurrency: opts?.concurrency ?? 1,
        executor: 'claude',
        state: 'active',
        maxSpendUsd: opts?.maxSpendUsd ?? null,
        maxRuns: opts?.maxRuns ?? null,
        startedAt: '2026-09-20T00:00:00Z',
        updatedAt: '2026-09-20T00:00:00Z',
        active: true,
      });
    },
    startPlan: () => Promise.resolve({ planId: 'p-1' }),
    fetchPlan: (planId: string) =>
      Promise.resolve({
        id: planId,
        prompt: 'split the auth rewrite',
        plannerName: 'fake',
        role: 'plan',
        state: 'ready',
        messages: [],
        questions: [],
        createdAt: '2026-09-20T00:00:00Z',
        updatedAt: '2026-09-20T00:00:00Z',
      }),
    confirmPlan: () => Promise.resolve({ epicId: 'e-1', taskIds: ['t-1'] }),
    fetchPresence: async () => {
      presenceFetches += 1;
      const gate = presenceGate;
      presenceGate = null;
      if (gate !== null) await gate;
      return [];
    },
    connectEvents: (
      onChange: () => void,
      options: ConnectEventsOptions = {}
    ) => {
      sink = { onChange, onEvent: options.onEvent ?? (() => {}) };
      return () => {
        sink = null;
      };
    },
  }),
}));

// Imported after the mocks above so the hook closes over them.
const { agentRosterKey, useDispatchProject } =
  await import('./useDispatchProject');
const { overseerKey } = await import('./useOverseerSession');

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

// Mounts the hook and waits until it has opened its WS connection, returning
// the query client the test seeds a ghost overseer record into.
async function mountConnected() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  renderHook(() => useDispatchProject('/repo', { selectedRunId: null }), {
    wrapper: wrapper(queryClient),
  });
  await waitFor(() => {
    expect(sink).not.toBeNull();
  });
  return queryClient;
}

// A record the daemon no longer has, cached exactly as a live conversation
// leaves it: one pending action, which is what the rail's waiting row, its
// amber badge and both disabled "New conversation" controls read.
function seedGhostRecord(queryClient: QueryClient) {
  queryClient.setQueryData(overseerKey(PORT, 'w-1'), {
    id: 'w-1',
    prompt: 'what is going on?',
    backendName: 'fake',
    state: 'ready',
    messages: [],
    pendingActions: [
      {
        id: 'act-1',
        tool: 'cancel_run',
        input: { runId: 'r-1' },
        summary: 'Cancel run r-1',
        createdAt: '2026-08-10T00:00:02Z',
        status: 'pending',
      },
    ],
    pendingApprovals: [],
    undeliveredDecisions: [],
    createdAt: '2026-08-10T00:00:00Z',
    updatedAt: '2026-08-10T00:00:05Z',
  });
  return queryClient.getQueryState(overseerKey(PORT, 'w-1'));
}

// The daemon's `hello` is sent from its websocket `open` handler, so it is the
// one frame that marks a *connection* — including the reconnect after a
// restart, which drops every in-memory overseer record at once. Nothing else
// reports that: `overseer.changed` can never arrive for a conversation the
// daemon no longer has. This asserts the wiring, not the response to it —
// useOverseerSession.test.tsx covers the far end.
test('hello invalidates every cached overseer record for this daemon', async () => {
  const queryClient = await mountConnected();
  seedGhostRecord(queryClient);
  expect(
    queryClient.getQueryState(overseerKey(PORT, 'w-1'))?.isInvalidated
  ).toBe(false);

  act(() => {
    sink?.onEvent({ type: 'hello', version: '0.0.1' });
  });

  expect(
    queryClient.getQueryState(overseerKey(PORT, 'w-1'))?.isInvalidated
  ).toBe(true);
});

// The daemon announces a socket's arrival before that socket joins the event
// bus, so the newcomer never hears about itself. If its first presence fetch
// raced ahead of the upgrade, `hello` is the only thing left to correct it —
// without this a teammate could sit looking at a room that did not include
// them, the stack hidden, until someone else came or went.
test('hello refetches presence, since a socket never hears its own arrival', async () => {
  const queryClient = await mountConnected();
  queryClient.setQueryData(['dispatch-presence', PORT], []);
  expect(
    queryClient.getQueryState(['dispatch-presence', PORT])?.isInvalidated
  ).toBe(false);

  act(() => {
    sink?.onEvent({ type: 'hello', version: '0.0.1' });
  });

  expect(
    queryClient.getQueryState(['dispatch-presence', PORT])?.isInvalidated
  ).toBe(true);
});

// The race itself, as a real browser hit it: the first presence fetch leaves
// before the daemon has registered this socket, and `hello` arrives while it is
// still in flight. react-query folds an invalidation during a query's first
// fetch into that fetch rather than restarting it (query.js: it only cancels
// when there is data), so the stale answer would land and stick.
test('a hello during the first presence fetch still gets a fresh one', async () => {
  let open!: () => void;
  presenceGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  presenceFetches = 0;
  await mountConnected();
  await waitFor(() => {
    expect(presenceFetches).toBe(1);
  });

  act(() => {
    sink?.onEvent({ type: 'hello', version: '0.0.1' });
  });
  open();

  await waitFor(() => {
    expect(presenceFetches).toBe(2);
  });
});

// The regression this pairs with: the invalidation used to sit in the first
// positional argument of `connectEvents`, which is `onChange` and fires only
// for `task.changed`. That is a task-file write, not a connection — so a
// dispatchd restart on a project whose tasks are not changing left the ghost
// record in place, while every ordinary task edit refetched the overseer for no
// reason. Pinning both directions keeps the callback from drifting back.
test('a task change does not invalidate overseer records', async () => {
  const queryClient = await mountConnected();
  seedGhostRecord(queryClient);

  act(() => {
    sink?.onChange();
  });

  expect(
    queryClient.getQueryState(overseerKey(PORT, 'w-1'))?.isInvalidated
  ).toBe(false);
});

// A registration is a gate message and approving it anywhere (Needs you, the
// CLI) sends an answer; either may change a row the settings roster shows.
test('a registration or an answer invalidates the agent roster', async () => {
  const queryClient = await mountConnected();
  const message = {
    id: 'm-1',
    thread: 'm-1',
    replyTo: null,
    from: 'system',
    to: ['human:wyat'],
    kind: 'question',
    body: 'New agent agent:wyat/cursor.macbook wants to join this project.',
    refs: [],
    data: {
      type: 'agent-registration',
      agent: 'agent:wyat/cursor.macbook',
      client: 'cursor',
      requestedBy: 'human:wyat',
    },
    urgent: false,
    blocking: true,
    choices: ['approve', 'deny'],
    wake: 'none' as const,
    createdAt: '2026-09-25T10:00:00.000Z',
  };
  const seed = () =>
    queryClient.setQueryData(agentRosterKey(PORT), { agents: [] });
  const invalidated = () =>
    queryClient.getQueryState(agentRosterKey(PORT))?.isInvalidated;

  seed();
  act(() => {
    sink?.onEvent({ type: 'message.new', message });
  });
  expect(invalidated()).toBe(true);

  seed();
  act(() => {
    sink?.onEvent({
      type: 'message.new',
      message: {
        ...message,
        id: 'm-2',
        replyTo: 'm-1',
        from: 'human:wyat',
        to: ['system'],
        kind: 'answer',
        body: '',
        data: undefined,
        blocking: false,
        choices: undefined,
        choice: 'approve',
      },
    });
  });
  expect(invalidated()).toBe(true);

  seed();
  act(() => {
    sink?.onEvent({
      type: 'message.new',
      message: {
        ...message,
        id: 'm-3',
        from: 'run:r-1',
        kind: 'message',
        body: 'done',
        data: undefined,
        blocking: false,
        choices: undefined,
      },
    });
  });
  expect(invalidated()).toBe(false);
});

function runFixture(id: string, state: RunMeta['state']): RunMeta {
  return {
    id,
    taskId: 't-1',
    taskTitle: 'Needs a shared export',
    executor: 'claude',
    state,
    branch: `dispatch/${id}`,
    baseBranch: 'main',
    worktreePath: `/tmp/${id}`,
    createdAt: '2026-08-23T00:00:00Z',
    updatedAt: '2026-08-23T00:00:00Z',
  };
}

function scopeRequestFixture(id: string, runId: string): RunScopeRequest {
  return {
    id,
    runId,
    paths: ['packages/core/src/browser.ts'],
    reason: 'the type my scoped code needs is not re-exported',
    requestedAt: '2026-08-23T00:00:01Z',
    granted: null,
    decisionReason: null,
    decidedAt: null,
    decidedBy: null,
  };
}

// Incident 2026-08-23: the only way this hook learned of a scope request was
// the live `scope.requested` frame. An app relaunched after a dispatchd
// restart never received it, so the card the human had not decided vanished
// for good. The daemon now persists the request and carries it onto the
// resumed run; this pins the app's half — the open requests of every live run
// are read back without any event having arrived.
test("a live run's open scope request is surfaced from the listing, without a scope.requested event", async () => {
  runsFixture = [
    runFixture('r-resumed', 'running'),
    runFixture('r-dead', 'failed'),
  ];
  openScopeRequests = new Map([
    ['r-resumed', [scopeRequestFixture('sr-abc123', 'r-resumed')]],
  ]);
  scopeRequestListings.length = 0;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { result } = renderHook(
    () => useDispatchProject('/repo', { selectedRunId: null }),
    { wrapper: wrapper(queryClient) }
  );

  await waitFor(() => {
    expect(result.current.pendingScopeRequests.get('r-resumed')).toEqual({
      requestId: 'sr-abc123',
    });
  });
  // Only live runs are asked: the force-failed predecessor has no agent
  // listening, and its card (if any) belongs to the decision feed.
  expect(scopeRequestListings).toEqual(['r-resumed']);
  expect(result.current.pendingScopeRequests.has('r-dead')).toBe(false);

  runsFixture = [];
  openScopeRequests = new Map();
});

function epicProgressFixtureFor(epicId: string): EpicProgress {
  return {
    epicId,
    active: false,
    session: null,
    spend: {
      settledUsd: 0,
      liveCount: 0,
      estimatedLiveUsd: 0,
      runsStarted: 0,
      maxSpendUsd: null,
      maxRuns: null,
    },
    children: [],
    waves: [],
    liveRuns: [],
  };
}

// Mounts the hook against `epics` worth of progress and waits for the bulk
// listing to land, returning the query client and the hook's live result.
async function mountWithEpics(epics: string[]) {
  epicProgressFixture = epics.map(epicProgressFixtureFor);
  epicProgressFetches = 0;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rendered = renderHook(
    () => useDispatchProject('/repo', { selectedRunId: null }),
    { wrapper: wrapper(queryClient) }
  );
  await waitFor(() => {
    expect(rendered.result.current.epicProgressById.size).toBe(epics.length);
  });
  return { queryClient, result: rendered.result };
}

const epicProgressAllKey = ['dispatch-epic-progress', PORT, 'all'];

// A fan-out of dozens of milestones used to be a burst of dozens of progress
// GETs on every run change; the hook now asks once for all of them.
test('three epics are filled from a single bulk progress fetch', async () => {
  const { result } = await mountWithEpics(['e-1', 'e-2', 'e-3']);

  expect(epicProgressFetches).toBe(1);
  expect([...result.current.epicProgressById.keys()].sort()).toEqual([
    'e-1',
    'e-2',
    'e-3',
  ]);
  expect(result.current.epicProgressById.get('e-2')?.epicId).toBe('e-2');
  epicProgressFixture = [];
});

test('epic.changed invalidates the bulk progress key', async () => {
  const { queryClient } = await mountWithEpics(['e-1']);
  expect(queryClient.getQueryState(epicProgressAllKey)?.isInvalidated).toBe(
    false
  );

  act(() => {
    sink?.onEvent({ type: 'epic.changed', epicId: 'e-1' });
  });

  expect(queryClient.getQueryState(epicProgressAllKey)?.isInvalidated).toBe(
    true
  );
  epicProgressFixture = [];
});

// The paused row is worded from the event's own numbers and the cached task
// title, so it lands before (and regardless of) the progress refetch the same
// frame triggers.
test('epic.paused records a durable inbox row from the event alone', async () => {
  const { queryClient, result } = await mountWithEpics(['e-1']);
  queryClient.setQueryData(
    ['dispatch-tasks-all', PORT],
    [{ meta: { id: 'e-1', title: 'Auth rewrite', kind: 'epic' } } as TaskDoc]
  );
  expect(result.current.notificationInbox.entries).toEqual([]);

  act(() => {
    sink?.onEvent({
      type: 'epic.paused',
      epicId: 'e-1',
      reason: 'budget',
      settledUsd: 41.2,
      estimatedLiveUsd: 30,
      maxSpendUsd: 60,
      runsStarted: 7,
      maxRuns: 20,
    });
  });

  const [row] = result.current.notificationInbox.entries;
  expect(row?.title).toBe('Auth rewrite paused — spend ceiling');
  expect(row?.body).toBe(
    '$41.20 settled + ~$30.00 in flight of $60.00. Resume or raise the ceiling to continue.'
  );
  expect(row?.target).toEqual({ kind: 'task', taskId: 'e-1' });
  expect(row?.read).toBe(false);
  epicProgressFixture = [];
});

// Both the pre-fan-out number form and the options form reach `startEpic`;
// the number is `{ concurrency }` with no ceilings, the options pass through.
test('handleWorkEpic forwards a bare concurrency and a full options body', async () => {
  const { result } = await mountWithEpics(['e-1']);
  epicStarts.length = 0;

  await act(async () => {
    await result.current.handleWorkEpic('e-1', 3);
  });
  await act(async () => {
    await result.current.handleWorkEpic('e-1', {
      concurrency: 3,
      maxSpendUsd: 60,
    });
  });

  expect(epicStarts).toEqual([
    ['e-1', { concurrency: 3, maxSpendUsd: undefined, maxRuns: undefined }],
    ['e-1', { concurrency: 3, maxSpendUsd: 60, maxRuns: undefined }],
  ]);
  epicProgressFixture = [];
});

test('handleConfirmPlan returns the confirm result, and throws with no plan open', async () => {
  const { result } = await mountWithEpics([]);
  const proposal = { tasks: [] };

  // Settled by hand: bun's `rejects` matcher is not awaitable under the
  // repo's `await-thenable` rule.
  const refused = await result.current.handleConfirmPlan(proposal).then(
    () => 'resolved',
    (err: unknown) => (err instanceof Error ? err.message : 'not an Error')
  );
  expect(refused).toBe('no plan open to confirm');

  await act(async () => {
    await result.current.handleSubmitPrompt('split the auth rewrite');
  });
  await waitFor(() => {
    expect(result.current.planRecord?.id).toBe('p-1');
  });
  const confirmed = await result.current.handleConfirmPlan(proposal);
  expect(confirmed).toEqual({ epicId: 'e-1', taskIds: ['t-1'] });
});
