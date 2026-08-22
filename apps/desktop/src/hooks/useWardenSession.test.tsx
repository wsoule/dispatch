import { type ApiClient, ApiError, type WardenRecord } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';
import type { ReactNode } from 'react';

import { useWardenSession } from './useWardenSession';

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
    await result.current.start('what is going on?');
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
    await result.current.start('what is going on?');
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
