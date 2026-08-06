import type { ApiClient, PrDetail, ReviewComment } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';
import type { ReactNode } from 'react';

import { repoPrsKey } from './useDispatchProject';
import { useRepoPrDetail } from './useRepoPrDetail';

const PORT = 4321;

function detail(decision: PrDetail['status']['reviewDecision']): PrDetail {
  return {
    status: {
      number: 9,
      url: 'https://github.com/example/repo/pull/9',
      title: 'A PR',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: decision,
      mergeable: 'MERGEABLE',
      checks: { passed: 0, failed: 0, pending: 0, total: 0 },
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    },
    conversation: [],
  };
}

function comment(): ReviewComment {
  return {
    id: 'c1',
    file: 'src/a.ts',
    line: 3,
    pending: true,
    anchorText: 'const a = 1;',
    author: 'you',
    body: 'a note',
    resolved: false,
    created: '2026-08-06T00:00:00.000Z',
    replies: [],
  };
}

// What the stub saw. `oneShotReviews` exists to prove the batch push replaced
// reviewRepoPr rather than joining it: firing both would land two separate
// reviews on the same PR.
interface Calls {
  pushed: Array<{ number: number; verdict: string; body: string }>;
  oneShotReviews: number;
  commentFetches: number;
}

// Only the calls this hook makes; anything else is left off, so a hook that
// started fetching something new would fail rather than pass quietly.
function stubClient(calls: Calls): ApiClient {
  return {
    baseUrl: `http://127.0.0.1:${PORT}`,
    fetchRepoPrDetail: () =>
      Promise.resolve(
        detail(calls.pushed.length > 0 ? 'APPROVED' : 'REVIEW_REQUIRED')
      ),
    fetchRepoPrDiff: () => Promise.resolve({ patch: '', files: [] }),
    fetchReviewComments: () => {
      calls.commentFetches += 1;
      return Promise.resolve([comment()]);
    },
    addReviewComment: () => Promise.resolve(comment()),
    resolveReviewComment: () => Promise.resolve(comment()),
    replyReviewComment: () => Promise.resolve(comment()),
    pushPrReview: (number: number, verdict: string, body: string) => {
      calls.pushed.push({ number, verdict, body });
      return Promise.resolve({ pushed: 1 });
    },
    reviewRepoPr: () => {
      calls.oneShotReviews += 1;
      return Promise.resolve(detail('APPROVED'));
    },
    commentRepoPr: () => Promise.resolve(detail('REVIEW_REQUIRED')),
  } as unknown as ApiClient;
}

interface Harness {
  client: QueryClient;
  calls: Calls;
  hook: ReturnType<typeof renderHook<ReturnType<typeof useRepoPrDetail>, void>>;
}

// Mounts the hook with a seeded, valid repo-PRs entry — the one the review
// queue and the PR header both render from — so a test can watch it go stale.
async function mounted(): Promise<Harness> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const calls: Calls = { pushed: [], oneShotReviews: 0, commentFetches: 0 };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  client.setQueryData(repoPrsKey(PORT), []);
  const stub = stubClient(calls);
  const hook = renderHook(() => useRepoPrDetail(stub, PORT, 9), { wrapper });
  await waitFor(() => {
    expect(hook.result.current.prDetail).toBeDefined();
    expect(hook.result.current.reviewComments.length).toBe(1);
  });
  expect(client.getQueryState(repoPrsKey(PORT))?.isInvalidated).toBe(false);
  return { client, calls, hook };
}

test('approving marks the repo-PR list stale for the queue', async () => {
  const { client, hook } = await mounted();
  await hook.result.current.handleReview('approve');
  expect(client.getQueryState(repoPrsKey(PORT))?.isInvalidated).toBe(true);
});

test('commenting marks the repo-PR list stale too', async () => {
  const { client, hook } = await mounted();
  await hook.result.current.handleComment('looks good');
  expect(client.getQueryState(repoPrsKey(PORT))?.isInvalidated).toBe(true);
});

test('a verdict goes through the batch push, not `gh pr review`', async () => {
  const { calls, hook } = await mounted();
  await hook.result.current.handleReview('request-changes', 'needs work');
  expect(calls.pushed).toEqual([
    { number: 9, verdict: 'request-changes', body: 'needs work' },
  ]);
  expect(calls.oneShotReviews).toBe(0);
});

test('approving refetches the detail the push does not return', async () => {
  const { hook } = await mounted();
  await hook.result.current.handleReview('approve');
  await waitFor(() => {
    expect(hook.result.current.prDetail?.status.reviewDecision).toBe(
      'APPROVED'
    );
  });
});

test('writing a line comment re-pulls the thread list', async () => {
  const { calls, hook } = await mounted();
  const before = calls.commentFetches;
  await hook.result.current.handleAddReviewComment({
    file: 'src/a.ts',
    line: 3,
    anchorText: 'const a = 1;',
    body: 'a note',
  });
  await waitFor(() => {
    expect(calls.commentFetches).toBeGreaterThan(before);
  });
});

test('resolving and replying re-pull the thread list too', async () => {
  const { calls, hook } = await mounted();
  const before = calls.commentFetches;
  await hook.result.current.handleResolveReviewComment('c1', true);
  await hook.result.current.handleReplyReviewComment('c1', 'ack');
  await waitFor(() => {
    expect(calls.commentFetches).toBeGreaterThanOrEqual(before + 2);
  });
});
