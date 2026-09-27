import type {
  ConnectEventsOptions,
  Delivery,
  EpicProgress,
  EpicSessionOptions,
  Message,
  ReplyInput,
  RunMeta,
  SendInput,
  ServerEvent,
  ThreadDetail,
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
const APP_CONNECTION = { port: PORT, appToken: 'app-token', agentToken: null };
let connectionFixture: {
  port: number;
  appToken: string | null;
  agentToken: string | null;
} = APP_CONNECTION;
void mock.module('../lib/tauri', () => ({
  ensureDispatchd: () => Promise.resolve(connectionFixture),
  restartDispatchd: () => Promise.resolve(),
  isTauri: () => '__TAURI_INTERNALS__' in window,
}));

// Captured from the hook's own `connectEvents` call, so a test can play the
// daemon and push frames at it.
let sink: {
  onChange: () => void;
  onEvent: (event: ServerEvent) => void;
} | null = null;

// Every OS notification the hook asked for. The real `notify` only fires
// inside a focused-away Tauri window, so the tests read the request instead.
const notified: { title: string; body: string; kind?: string }[] = [];
void mock.module('../lib/notifications', () => ({
  notify: (title: string, body: string, kind?: string) => {
    notified.push({ title, body, kind });
    return Promise.resolve();
  },
  setNotificationKinds: () => {},
}));

// What the daemon's run list says right now, the open gates it reports, and
// every messaging call the hook made — set by the gate tests below.
let runsFixture: RunMeta[] = [];
let openGatesFixture: Message[] = [];
let openDecisionsCalls = 0;
// Holds open-gate reads open while set, so a test sees the cache before them.
let decisionsHold: Promise<void> | null = null;
const sentMessages: SendInput[] = [];
const replies: [string, ReplyInput][] = [];
const approvalReads: [string, string][] = [];
// Runs inside a send, the way the daemon wakes a run before the send returns.
let duringSend: (() => void) | null = null;
// The caller's unread mail, where the daemon's notices land.
let mailboxFixture: { delivery: unknown; message: Message }[] = [];
// The deliveries the daemon reports for the next sends.
let sendDeliveriesFixture: Partial<Delivery>[] = [];

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
// Who the daemon says this window is; null fails the read, as a daemon still
// coming up would.
let whoamiFixture: { handle: string; ref: string; tier: string } | null = null;

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
    openDecisions: async () => {
      openDecisionsCalls += 1;
      if (decisionsHold !== null) await decisionsHold;
      return { items: openGatesFixture };
    },
    sendMessage: (input: SendInput) => {
      sentMessages.push(input);
      duringSend?.();
      return Promise.resolve({
        message: { id: 'm-sent' },
        deliveries: sendDeliveriesFixture,
        downgraded: false,
      });
    },
    getMailbox: () => Promise.resolve({ items: mailboxFixture }),
    fetchRunApproval: (runId: string, requestId: string) => {
      approvalReads.push([runId, requestId]);
      return Promise.resolve({ tool: 'Bash', input: { command: 'ls -la' } });
    },
    getOverseer: (id: string) =>
      Promise.resolve({
        id,
        pendingApprovals: [
          {
            requestId: 'req-9',
            toolName: 'Bash',
            input: { command: 'make clean' },
            summary: 'Bash: make clean',
            requestedAt: '2026-09-20T00:00:00Z',
          },
        ],
      }),
    replyToMessage: (id: string, input: ReplyInput) => {
      replies.push([id, input]);
      return Promise.resolve({
        message: {},
        deliveries: [],
        downgraded: false,
      });
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
    fetchWhoami: () =>
      whoamiFixture === null
        ? Promise.reject(new Error('dispatchd is still starting'))
        : Promise.resolve(whoamiFixture),
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
const { useDispatchProject } = await import('./useDispatchProject');
const { ATTACHED_DAEMON_MESSAGING_EXPLANATION } =
  await import('../lib/daemonAuth');
const { agentRosterKey } = await import('../lib/agentRoster');
const { overseerKey } = await import('./useOverseerSession');
const { threadKey } = await import('./useThreads');

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

// A whoami that failed on connect would otherwise stay failed for the whole
// session: its answer never goes stale, and nothing else asks again.
test('hello asks the daemon who this window is again', async () => {
  const queryClient = await mountConnected();
  queryClient.setQueryData(['dispatch-whoami', PORT], {
    handle: 'wyat',
    ref: 'human:wyat',
    tier: 'decide',
  });

  act(() => {
    sink?.onEvent({ type: 'hello', version: '0.0.1' });
  });

  expect(
    queryClient.getQueryState(['dispatch-whoami', PORT])?.isInvalidated
  ).toBe(true);
});

test('a failed whoami is exposed with a retry that asks again', async () => {
  whoamiFixture = null;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { result } = renderHook(
    () => useDispatchProject('/repo', { selectedRunId: null }),
    { wrapper: wrapper(queryClient) }
  );
  await waitFor(() => {
    expect(result.current.whoamiError?.message).toBe(
      'dispatchd is still starting'
    );
  });
  expect(result.current.me).toBeNull();

  whoamiFixture = { handle: 'wyat', ref: 'human:wyat', tier: 'decide' };
  act(() => {
    result.current.retryWhoami();
  });
  await waitFor(() => {
    expect(result.current.me).toBe('human:wyat');
  });
  expect(result.current.whoamiError).toBeNull();
  whoamiFixture = null;
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

// A new message joins the open thread from the event itself, without a refetch.
test('a new message lands in its cached thread through the event handler', async () => {
  const queryClient = await mountConnected();
  const root = gateMessage('m-01', {
    kind: 'message',
    blocking: false,
    from: 'run:r-000001',
  });
  queryClient.setQueryData<ThreadDetail>(threadKey(PORT, 'm-01'), {
    messages: [root],
    deliveries: [],
  });
  act(() => {
    sink?.onEvent({
      type: 'message.new',
      message: { ...root, id: 'm-02', replyTo: 'm-01' },
    });
  });
  expect(
    queryClient
      .getQueryData<ThreadDetail>(threadKey(PORT, 'm-01'))
      ?.messages.map((m) => m.id)
  ).toEqual(['m-01', 'm-02']);
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

// A blocking question as dispatchd lists it under `GET /api/decisions/open`.
function gateMessage(id: string, over: Partial<Message>): Message {
  return {
    id,
    thread: id,
    replyTo: null,
    from: 'agent:dispatch',
    to: ['human:wyat'],
    kind: 'question',
    body: 'q',
    refs: [],
    urgent: false,
    blocking: true,
    wake: 'none',
    createdAt: '2026-09-25T10:00:00.000Z',
    ...over,
  };
}

function toolApprovalGate(id: string, runId: string, requestId: string) {
  return gateMessage(id, {
    choices: ['approve', 'approve-session', 'deny'],
    data: {
      type: 'tool-approval',
      requestId,
      runId,
      tool: 'Bash',
      input: { command: 'ls' },
    },
  });
}

const approvalGate = toolApprovalGate('m-a', 'r-1', 'req-1');
const scopeGate = gateMessage('m-s', {
  from: 'run:r-1',
  choices: ['grant', 'deny'],
  data: { type: 'scope', paths: ['a.ts'], reason: 'needed' },
});
const questionGate = gateMessage('m-q', {
  from: 'run:r-1',
  body: 'Which cart?',
  choices: ['old', 'new'],
});

// The query client the last mountWithGates made, for a test to seed its cache.
let gatesQueryClient: QueryClient | null = null;

// Mounts the hook over `gates` with live run r-1 parked on an approval, and
// waits until the open gates have been read into its three maps.
async function mountWithGates(gates: Message[]) {
  runsFixture = [runFixture('r-1', 'awaiting-approval')];
  openGatesFixture = gates;
  openDecisionsCalls = 0;
  notified.length = 0;
  sentMessages.length = 0;
  replies.length = 0;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  gatesQueryClient = queryClient;
  const rendered = renderHook(
    () => useDispatchProject('/repo', { selectedRunId: null }),
    { wrapper: wrapper(queryClient) }
  );
  await waitFor(() => {
    expect(rendered.result.current.pendingApprovals.has('r-1')).toBe(true);
  });
  return rendered.result;
}

// Also drops the inbox rows a run question recorded, which persist per root
// in localStorage and would leak into later tests.
function resetGateFixtures() {
  runsFixture = [];
  openGatesFixture = [];
  mailboxFixture = [];
  sendDeliveriesFixture = [];
  window.localStorage.clear();
}

// After a reload nothing was seen live: the open gates alone rebuild the
// approval, scope and question cards.
test('open gates fill the approval, scope and question maps', async () => {
  const result = await mountWithGates([approvalGate, scopeGate, questionGate]);

  expect(result.current.pendingApprovals.get('r-1')).toEqual([
    {
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'ls' },
      truncated: false,
    },
  ]);
  expect(result.current.pendingScopeRequests.get('r-1')).toMatchObject({
    id: 'm-s',
    paths: ['a.ts'],
    reason: 'needed',
  });
  expect(result.current.openQuestions.get('r-1')?.[0].id).toBe('m-q');
  resetGateFixtures();
});

test('a new blocking question refetches the open gates', async () => {
  await mountWithGates([approvalGate]);
  const before = openDecisionsCalls;

  act(() => {
    sink?.onEvent({
      type: 'message.new',
      message: gateMessage('m-q2', { from: 'run:r-1', body: 'And now?' }),
    });
  });

  await waitFor(() => {
    expect(openDecisionsCalls).toBeGreaterThan(before);
  });
  resetGateFixtures();
});

// A run that parks several tool calls at once raises one notification, not
// one per gate; another run still gets its own.
test('a deciding window notifies one tool approval per waiting run', async () => {
  await mountWithGates([approvalGate]);

  act(() => {
    sink?.onEvent({
      type: 'message.new',
      message: toolApprovalGate('m-a2', 'r-1', 'req-2'),
    });
    sink?.onEvent({
      type: 'message.new',
      message: toolApprovalGate('m-b', 'r-9', 'req-1'),
    });
  });

  expect(notified).toEqual([
    { title: 'Approval needed', body: 'Bash · r-9', kind: 'approval' },
  ]);
  resetGateFixtures();
});

// Muting an agent promises it never interrupts anyone, so its questions
// raise no OS notification; another agent's still do.
test("a muted agent's question raises no notification", async () => {
  await mountWithGates([approvalGate]);
  gatesQueryClient?.setQueryData(agentRosterKey(PORT), {
    agents: [
      {
        address: 'agent:wyat/quiet',
        displayName: 'quiet',
        client: 'codex',
        status: 'approved',
        muted: true,
        approvedBy: 'human:wyat',
        createdAt: '2026-09-25T10:00:00.000Z',
      },
    ],
  });

  act(() => {
    sink?.onEvent({
      type: 'message.new',
      message: gateMessage('m-quiet', {
        from: 'agent:wyat/quiet',
        body: 'Deploy now?',
      }),
    });
    sink?.onEvent({
      type: 'message.new',
      message: gateMessage('m-loud', {
        from: 'agent:wyat/loud',
        body: 'Ship it?',
      }),
    });
  });

  expect(notified).toEqual([
    { title: 'An agent has a question', body: 'Ship it?', kind: 'question' },
  ]);
  resetGateFixtures();
});

// The fold reads the cached gates, which follow each event at once: an
// approval answered elsewhere no longer folds its run's next one, and two
// approvals that land before any refetch notify once.
test('folding tracks gates answered elsewhere and gates not yet refetched', async () => {
  await mountWithGates([approvalGate]);

  act(() => {
    sink?.onEvent({
      type: 'message.new',
      message: gateMessage('m-ans', {
        from: 'human:ada',
        to: ['agent:dispatch'],
        kind: 'answer',
        blocking: false,
        replyTo: 'm-a',
        choice: 'approve',
      }),
    });
    sink?.onEvent({
      type: 'message.new',
      message: toolApprovalGate('m-a2', 'r-1', 'req-2'),
    });
    sink?.onEvent({
      type: 'message.new',
      message: toolApprovalGate('m-b', 'r-9', 'req-1'),
    });
    sink?.onEvent({
      type: 'message.new',
      message: toolApprovalGate('m-b2', 'r-9', 'req-2'),
    });
  });

  expect(notified.map((n) => n.body)).toEqual([
    'Bash · Needs a shared export',
    'Bash · r-9',
  ]);
  resetGateFixtures();
});

test('the card handlers answer their gates with the matching choice', async () => {
  const result = await mountWithGates([approvalGate, scopeGate, questionGate]);

  await act(async () => {
    await result.current.handleApprove('r-1', 'req-1', true, {
      scope: 'session',
    });
    await result.current.handleDecideScopeRequest('r-1', 'm-s', false, 'no');
    await result.current.handleAnswerQuestion('r-1', 'm-q', 'new');
    await result.current.handleAnswerQuestion('r-1', 'm-q', 'neither');
    await result.current.handleSendMessage('r-1', 'keep going');
  });

  expect(replies).toEqual([
    ['m-a', { body: '', choice: 'approve-session' }],
    ['m-s', { body: 'no', choice: 'deny' }],
    ['m-q', { body: 'new', choice: 'new' }],
    ['m-q', { body: 'neither' }],
  ]);
  expect(sentMessages).toEqual([
    { to: ['run:r-1'], kind: 'message', body: 'keep going' },
  ]);
  const stale = await result.current.handleApprove('r-1', 'req-9', true).then(
    () => 'resolved',
    (err: unknown) => (err instanceof Error ? err.message : 'not an Error')
  );
  expect(stale).toBe('This approval is no longer waiting for you.');
  resetGateFixtures();
});

// An answer closes its gate, and the event that says so refetches the list.
test('an answer on the bus refetches the open gates', async () => {
  await mountWithGates([approvalGate]);
  const before = openDecisionsCalls;

  act(() => {
    sink?.onEvent({
      type: 'message.new',
      message: gateMessage('m-ans', {
        kind: 'answer',
        blocking: false,
        replyTo: 'm-a',
      }),
    });
  });

  await waitFor(() => {
    expect(openDecisionsCalls).toBeGreaterThan(before);
  });
  resetGateFixtures();
});

// The card goes as soon as its answer lands, before the refetch, so a second
// click cannot send a second answer to a closed gate.
test('an answered gate leaves the open list without waiting for the refetch', async () => {
  const result = await mountWithGates([approvalGate, scopeGate, questionGate]);
  let release = () => {};
  decisionsHold = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await act(async () => {
      await result.current.handleAnswerQuestion('r-1', 'm-q', 'new');
      await result.current.handleDecideScopeRequest('r-1', 'm-s', true);
      await result.current.handleApprove('r-1', 'req-1', true);
    });
    // Every refetch is held, so only the answered-gate drop can empty these.
    await waitFor(() => {
      expect(result.current.openQuestions.has('r-1')).toBe(false);
      expect(result.current.pendingScopeRequests.has('r-1')).toBe(false);
      expect(result.current.pendingApprovals.has('r-1')).toBe(false);
    });
  } finally {
    decisionsHold = null;
    release();
    resetGateFixtures();
  }
});

// A card whose gate carries only a preview reads the parked call whole.
test('a parked call is read in full by its run and request id', async () => {
  const result = await mountWithGates([approvalGate]);
  approvalReads.length = 0;

  const input = await result.current.fetchApprovalInput('r-1', 'req-1');

  expect(input).toEqual({ command: 'ls -la' });
  expect(approvalReads).toEqual([['r-1', 'req-1']]);
  resetGateFixtures();
});

// An Assistant call's gate carries a preview too; its conversation holds the call whole.
test('a parked Assistant call is read in full from its conversation', async () => {
  const result = await mountWithGates([approvalGate]);

  const input = await result.current.fetchOverseerApprovalInput('o-1', 'req-9');
  const gone = await result.current
    .fetchOverseerApprovalInput('o-1', 'req-gone')
    .then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : 'not an Error')
    );

  expect(input).toEqual({ command: 'make clean' });
  expect(gone).toBe('The Assistant is no longer waiting on this call.');
  resetGateFixtures();
});

// Feedback on one run continues exactly that run, not the task's newest one.
test('request changes continues the named run and follows its continuation', async () => {
  const followed: [string, string][] = [];
  const r2 = {
    ...runFixture('r-2', 'finished'),
    createdAt: '2026-08-24T00:00:00Z',
  };
  runsFixture = [r2, runFixture('r-1', 'finished')];
  openGatesFixture = [];
  sentMessages.length = 0;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { result } = renderHook(
    () =>
      useDispatchProject('/repo', {
        selectedRunId: null,
        onRunDispatched: (runId, taskId) => followed.push([runId, taskId]),
      }),
    { wrapper: wrapper(queryClient) }
  );
  await waitFor(() => {
    expect(result.current.runs).toHaveLength(2);
  });

  // The daemon continues r-1 inside the send, so its continuation is listed next.
  duringSend = () => {
    runsFixture = [
      { ...runFixture('r-3', 'running'), resumedFrom: 'r-1' },
      r2,
      runFixture('r-1', 'finished'),
    ];
  };
  try {
    await act(async () => {
      await result.current.handleRequestChanges('r-1', 'use the new cart');
    });
  } finally {
    duringSend = null;
  }
  expect(sentMessages).toEqual([
    {
      to: ['run:r-1'],
      kind: 'message',
      body: 'use the new cart',
      wake: 'request',
    },
  ]);
  expect(followed).toEqual([['r-3', 't-1']]);
  resetGateFixtures();
});

// A continuation that already existed is not the one this request started.
test('request changes that continued nothing says why, from the daemon notice', async () => {
  runsFixture = [
    { ...runFixture('r-2', 'running'), resumedFrom: 'r-1' },
    runFixture('r-1', 'finished'),
  ];
  openGatesFixture = [];
  mailboxFixture = [
    {
      delivery: {},
      message: {
        ...gateMessage('m-n', {
          kind: 'notice',
          blocking: false,
          body: 'Could not wake run:r-1: run was already resumed. Your message is waiting for it.',
        }),
        refs: [{ type: 'message', id: 'm-sent' }],
      },
    },
  ];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { result } = renderHook(
    () => useDispatchProject('/repo', { selectedRunId: null }),
    { wrapper: wrapper(queryClient) }
  );
  await waitFor(() => {
    expect(result.current.runs).toHaveLength(2);
  });

  const refused = await result.current
    .handleRequestChanges('r-1', 'again')
    .then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : 'not an Error')
    );
  expect(refused).toBe(
    'Could not wake run:r-1: run was already resumed. Your message is waiting for it.'
  );

  mailboxFixture = [];
  const unexplained = await result.current
    .handleRequestChanges('r-1', 'again')
    .then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : 'not an Error')
    );
  expect(unexplained).toBe(
    'The run did not continue. Your message is waiting for it.'
  );
  resetGateFixtures();
});

// A live run takes the message only when the daemon pushed it in; one that
// cannot take mail (a CLI run, one winding down) leaves it held.
test('request changes on a live run succeeds only when the run took the message', async () => {
  runsFixture = [runFixture('r-1', 'running')];
  openGatesFixture = [];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { result } = renderHook(
    () => useDispatchProject('/repo', { selectedRunId: null }),
    { wrapper: wrapper(queryClient) }
  );
  await waitFor(() => {
    expect(result.current.runs).toHaveLength(1);
  });
  const outcome = () =>
    result.current.handleRequestChanges('r-1', 'again').then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : 'not an Error')
    );

  sendDeliveriesFixture = [
    { recipient: 'run:r-1', runId: 'r-1', state: 'pushed' },
  ];
  expect(await outcome()).toBe('resolved');

  sendDeliveriesFixture = [
    { recipient: 'run:r-1', runId: null, state: 'held' },
  ];
  expect(await outcome()).toBe(
    'The run did not continue. Your message is waiting for it.'
  );
  resetGateFixtures();
});

// The shared agent token can neither read open gates nor send, so an attached
// window shows no cards, notifies no gates and refuses a send locally.
test('a window on the agent token reads no gates, notifies none and sends nothing', async () => {
  connectionFixture = { port: PORT, appToken: null, agentToken: 'agent' };
  runsFixture = [runFixture('r-1', 'awaiting-approval')];
  openGatesFixture = [approvalGate, scopeGate, questionGate];
  openDecisionsCalls = 0;
  notified.length = 0;
  sentMessages.length = 0;
  try {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () => useDispatchProject('/repo', { selectedRunId: null }),
      { wrapper: wrapper(queryClient) }
    );
    await waitFor(() => {
      expect(result.current.runs).toHaveLength(1);
    });
    expect(sink).not.toBeNull();

    act(() => {
      sink?.onEvent({ type: 'message.new', message: approvalGate });
    });

    expect(openDecisionsCalls).toBe(0);
    expect(result.current.pendingApprovals.size).toBe(0);
    expect(result.current.pendingScopeRequests.size).toBe(0);
    expect(result.current.openQuestions.size).toBe(0);
    expect(notified).toEqual([]);
    const refused = await result.current.handleSendMessage('r-1', 'hi').then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : 'not an Error')
    );
    expect(refused).toBe(ATTACHED_DAEMON_MESSAGING_EXPLANATION);
    expect(sentMessages).toEqual([]);
    // Answering a question or deciding a scope gate is refused here too.
    replies.length = 0;
    const settle = (p: Promise<void>) =>
      p.then(
        () => 'resolved',
        (err: unknown) => (err instanceof Error ? err.message : 'not an Error')
      );
    expect(
      await settle(result.current.handleAnswerQuestion('r-1', 'm-q', 'new'))
    ).not.toBe('resolved');
    expect(
      await settle(result.current.handleDecideScopeRequest('r-1', 'm-s', true))
    ).not.toBe('resolved');
    expect(replies).toEqual([]);
  } finally {
    connectionFixture = APP_CONNECTION;
    resetGateFixtures();
  }
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
