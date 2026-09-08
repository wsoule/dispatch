import type {
  ConnectEventsOptions,
  RunMeta,
  RunScopeRequest,
  ServerEvent,
} from '@dispatch/client';
import * as dispatchClient from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

const PORT = 4321;

// The one connection the hook asks for. Mocked at the module level because
// `ensureDispatchd` shells out to Tauri, which does not exist under bun:test.
void mock.module('../lib/tauri', () => ({
  ensureDispatchd: () =>
    Promise.resolve({ port: PORT, appToken: 'app-token', agentToken: null }),
  restartDispatchd: () => Promise.resolve(),
  isTauri: () => false,
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

// Only `createApiClient` is replaced — the rest of the module (ApiError, which
// useWardenSession's 404 veto instanceof-checks) has to stay real.
void mock.module('@dispatch/client', () => ({
  ...dispatchClient,
  createApiClient: () => ({
    baseUrl: `http://127.0.0.1:${PORT}`,
    fetchRuns: () => Promise.resolve(runsFixture),
    listScopeRequests: (runId: string) => {
      scopeRequestListings.push(runId);
      return Promise.resolve(openScopeRequests.get(runId) ?? []);
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
const { wardenKey } = await import('./useWardenSession');

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

// Mounts the hook and waits until it has opened its WS connection, returning
// the query client the test seeds a ghost warden record into.
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
  queryClient.setQueryData(wardenKey(PORT, 'w-1'), {
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
    undeliveredDecisions: [],
    createdAt: '2026-08-10T00:00:00Z',
    updatedAt: '2026-08-10T00:00:05Z',
  });
  return queryClient.getQueryState(wardenKey(PORT, 'w-1'));
}

// The daemon's `hello` is sent from its websocket `open` handler, so it is the
// one frame that marks a *connection* — including the reconnect after a
// restart, which drops every in-memory warden record at once. Nothing else
// reports that: `warden.changed` can never arrive for a conversation the
// daemon no longer has. This asserts the wiring, not the response to it —
// useWardenSession.test.tsx covers the far end.
test('hello invalidates every cached warden record for this daemon', async () => {
  const queryClient = await mountConnected();
  seedGhostRecord(queryClient);
  expect(queryClient.getQueryState(wardenKey(PORT, 'w-1'))?.isInvalidated).toBe(
    false
  );

  act(() => {
    sink?.onEvent({ type: 'hello', version: '0.0.1' });
  });

  expect(queryClient.getQueryState(wardenKey(PORT, 'w-1'))?.isInvalidated).toBe(
    true
  );
});

// The regression this pairs with: the invalidation used to sit in the first
// positional argument of `connectEvents`, which is `onChange` and fires only
// for `task.changed`. That is a task-file write, not a connection — so a
// dispatchd restart on a project whose tasks are not changing left the ghost
// record in place, while every ordinary task edit refetched the warden for no
// reason. Pinning both directions keeps the callback from drifting back.
test('a task change does not invalidate warden records', async () => {
  const queryClient = await mountConnected();
  seedGhostRecord(queryClient);

  act(() => {
    sink?.onChange();
  });

  expect(queryClient.getQueryState(wardenKey(PORT, 'w-1'))?.isInvalidated).toBe(
    false
  );
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
