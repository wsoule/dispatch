import { type ApiClient, ApiError, type WardenRecord } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';
import type { ReactNode } from 'react';

import {
  useWardenSession,
  wardenKey,
  wardenKeyPrefix,
} from './useWardenSession';

const PORT = 4321;

function wardenRecord(): WardenRecord {
  return {
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
  };
}

// Only the two calls this hook makes on the path under test: `start` seeds the
// cache with a real record, then every refetch fails the way the test wants.
function stubClient(refetchError: unknown): ApiClient {
  return {
    baseUrl: `http://127.0.0.1:${PORT}`,
    startWarden: () => Promise.resolve(wardenRecord()),
    getWarden: () => Promise.reject(refetchError),
  } as unknown as ApiClient;
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// Opens a conversation (which caches the record `startWarden` returned) and
// waits for the follow-up refetch to fail, leaving the hook in the one state
// the two tests below disagree about: cached record + non-null error.
async function sessionAfterFailedRefetch(refetchError: unknown) {
  const { result } = renderHook(
    () => useWardenSession(stubClient(refetchError), PORT, '/repo'),
    { wrapper }
  );
  await act(async () => {
    await result.current.submit('what is going on?');
  });
  await waitFor(() => {
    expect(result.current.recordError).not.toBeNull();
  });
  return result;
}

// The ghost direction: warden records live in an in-memory Map, so a daemon
// restart 404s every id. The cached record and its pendingActions describe a
// conversation that no longer exists anywhere and must not reach any consumer.
test('a 404 on refetch drops the cached record', async () => {
  const result = await sessionAfterFailedRefetch(
    new ApiError('warden conversation w-1 not found', 404)
  );
  expect(result.current.record).toBeUndefined();
  expect(result.current.recordError).toBe('warden conversation w-1 not found');
});

// The opposite direction, and the reason this cannot be a blanket
// `recordError !== null` veto: a transient failure leaves the conversation —
// and any mutation queued on it — very much alive server-side.
test('a 500 on refetch keeps the cached record and its pending actions', async () => {
  const result = await sessionAfterFailedRefetch(
    new ApiError('daemon busy', 500)
  );
  expect(result.current.record?.id).toBe('w-1');
  expect(result.current.record?.pendingActions).toHaveLength(1);
});

// A network failure throws a plain TypeError, not an ApiError — no status to
// read, so it takes the same "assume it's still there" branch as a 5xx.
test('a network failure keeps the cached record', async () => {
  const result = await sessionAfterFailedRefetch(new TypeError('fetch failed'));
  expect(result.current.record?.id).toBe('w-1');
});

// The approval lock belongs to the session for the same reason the draft does.
// Approving runs the real mutation before the call resolves, and every surface
// that renders a confirm card is unmounted by an ordinary tab flip — so the
// flag has to be raised for the whole call, on state that outlives the chat.
test('the deciding action is exposed while a confirm is in flight', async () => {
  let settle: ((rec: WardenRecord) => void) | undefined;
  const client = {
    baseUrl: `http://127.0.0.1:${PORT}`,
    startWarden: () => Promise.resolve(wardenRecord()),
    getWarden: () => Promise.resolve(wardenRecord()),
    confirmWardenAction: () =>
      new Promise<WardenRecord>((resolve) => {
        settle = resolve;
      }),
  } as unknown as ApiClient;

  const { result } = renderHook(() => useWardenSession(client, PORT, '/repo'), {
    wrapper,
  });
  await act(async () => {
    await result.current.submit('what is going on?');
  });
  expect(result.current.decidingActionId).toBeNull();

  let decided: Promise<WardenRecord> | undefined;
  act(() => {
    decided = result.current.confirmAction('act-1', true);
  });
  // Mid-flight: the server is running the effect, so every card must stay
  // locked no matter how many times the chat around it has been remounted.
  expect(result.current.decidingActionId).toBe('act-1');

  await act(async () => {
    settle?.(wardenRecord());
    await decided;
  });
  expect(result.current.decidingActionId).toBeNull();
});

// The draft belongs to the session so it can outlive the components that
// render it, but not the conversation it was typed into: reset() is the "start
// over" control, and carrying a half-typed follow-up into the opening
// composer would put words in the next conversation's mouth.
test('reset clears the composer draft along with the conversation', () => {
  const { result } = renderHook(
    () =>
      useWardenSession(stubClient(new ApiError('gone', 404)), PORT, '/repo'),
    { wrapper }
  );
  act(() => {
    result.current.setDraft('half a thought');
  });
  expect(result.current.draft).toBe('half a thought');

  act(() => {
    result.current.reset();
  });
  expect(result.current.draft).toBe('');
  expect(result.current.conversationId).toBeNull();
});

// A dispatchd restart destroys every warden record (they live in an in-memory
// Map), and nothing in the app notices on its own: `warden.changed` can never
// arrive for a conversation the daemon no longer has, and the record query has
// no refetch interval. The WS reconnect handler is the one trigger, and it
// cannot name a conversation id — it lives in useDispatchProject, which does
// not own this session — so it invalidates by prefix. This is that chain's far
// end: once the prefix invalidation fires, the ghost record and the pending
// action nobody can decide any more have to be gone.
test('a reconnect prefix invalidation clears a record the daemon no longer has', async () => {
  let restarted = false;
  const client = {
    baseUrl: `http://127.0.0.1:${PORT}`,
    startWarden: () => Promise.resolve(wardenRecord()),
    getWarden: () =>
      restarted
        ? Promise.reject(new ApiError('warden conversation w-1 not found', 404))
        : Promise.resolve(wardenRecord()),
  } as unknown as ApiClient;

  // This test's own client, not the shared `wrapper`: it has to invalidate the
  // same cache the hook reads, which the per-render wrapper hides.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { result } = renderHook(() => useWardenSession(client, PORT, '/repo'), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  await act(async () => {
    await result.current.submit('what is going on?');
  });
  await waitFor(() => {
    expect(result.current.record?.pendingActions).toHaveLength(1);
  });

  restarted = true;
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: wardenKeyPrefix(PORT) });
  });

  await waitFor(() => {
    expect(result.current.record).toBeUndefined();
  });
  expect(result.current.recordError).toBe('warden conversation w-1 not found');
});

// The prefix above only reaches the record query if the full key still starts
// with it. Nothing else would catch a reshuffle of wardenKey's elements: the
// invalidation would quietly stop matching and the ghost would come back.
test('the record key starts with the prefix the reconnect handler invalidates', () => {
  expect(wardenKey(PORT, 'w-1').slice(0, 2)).toEqual([
    ...wardenKeyPrefix(PORT),
  ]);
});

// The send's error and in-flight flag belong to the session for the same
// reason the draft and the approval lock do: the rail drops the chat's whole
// panel on a tab flip, so a failure reported into component state lands on an
// unmounted component and is never seen. Flipping to Runs to watch the turn is
// the path the feature encourages, which makes this the likely case, not a
// corner one.
test('a failed submit leaves its error and the typed text on the session', async () => {
  const client = {
    baseUrl: `http://127.0.0.1:${PORT}`,
    startWarden: () => Promise.reject(new Error('dispatchd refused it')),
  } as unknown as ApiClient;

  const { result } = renderHook(() => useWardenSession(client, PORT, '/repo'), {
    wrapper,
  });
  act(() => {
    result.current.setDraft('what is going on?');
  });

  await act(async () => {
    await result.current.submit('what is going on?');
  });

  expect(result.current.sendError).toBe('dispatchd refused it');
  expect(result.current.sending).toBe(false);
  // Cleared before the call so a slow round trip cannot eat it, put back on
  // failure — the human should not have to retype the question.
  expect(result.current.draft).toBe('what is going on?');
  expect(result.current.conversationId).toBeNull();
});

// The flag has to be readable *during* the call, not just settled afterwards:
// it is what disables Send, and a chat remounted mid-flight (tab flip, rail
// collapse) must come back with the button still disabled.
test('the in-flight flag is raised for the whole submit', async () => {
  let settle: ((rec: WardenRecord) => void) | undefined;
  const client = {
    baseUrl: `http://127.0.0.1:${PORT}`,
    startWarden: () =>
      new Promise<WardenRecord>((resolve) => {
        settle = resolve;
      }),
    getWarden: () => Promise.resolve(wardenRecord()),
  } as unknown as ApiClient;

  const { result } = renderHook(() => useWardenSession(client, PORT, '/repo'), {
    wrapper,
  });
  expect(result.current.sending).toBe(false);

  let submitted: Promise<void> | undefined;
  act(() => {
    submitted = result.current.submit('what is going on?');
  });
  expect(result.current.sending).toBe(true);

  await act(async () => {
    settle?.(wardenRecord());
    await submitted;
  });
  expect(result.current.sending).toBe(false);
  expect(result.current.sendError).toBeNull();
});

// reset() is the "start over" control, so it clears the last failure with the
// conversation — a stale error banner over a fresh composer is a lie.
test('reset clears the last send error', async () => {
  const client = {
    baseUrl: `http://127.0.0.1:${PORT}`,
    startWarden: () => Promise.reject(new Error('dispatchd refused it')),
  } as unknown as ApiClient;

  const { result } = renderHook(() => useWardenSession(client, PORT, '/repo'), {
    wrapper,
  });
  await act(async () => {
    await result.current.submit('what is going on?');
  });
  expect(result.current.sendError).toBe('dispatchd refused it');

  act(() => {
    result.current.reset();
  });
  expect(result.current.sendError).toBeNull();
});

// The other half of clearing the draft up front: the restore must not clobber
// what the human typed while the call was in flight. `submit` puts the text
// back only when the composer is still empty.
test('a failed submit leaves a newly typed draft alone', async () => {
  let reject: ((err: Error) => void) | undefined;
  const client = {
    baseUrl: `http://127.0.0.1:${PORT}`,
    startWarden: () =>
      new Promise<WardenRecord>((_resolve, rej) => {
        reject = rej;
      }),
  } as unknown as ApiClient;

  const { result } = renderHook(() => useWardenSession(client, PORT, '/repo'), {
    wrapper,
  });

  let submitted: Promise<void> | undefined;
  act(() => {
    submitted = result.current.submit('what is going on?');
  });
  // The sent text is gone the moment it is handed off, not a round trip later.
  expect(result.current.draft).toBe('');

  act(() => {
    result.current.setDraft('next thought');
  });
  await act(async () => {
    reject?.(new Error('daemon unreachable'));
    await submitted;
  });

  expect(result.current.draft).toBe('next thought');
  expect(result.current.sendError).toBe('daemon unreachable');
});
