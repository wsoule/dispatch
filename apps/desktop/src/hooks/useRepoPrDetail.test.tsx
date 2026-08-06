import type { ApiClient, PrDetail } from '@dispatch/client';
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

// Only the four calls this hook makes; anything else is left off, so a hook
// that started fetching something new would fail rather than pass quietly.
function stubClient(): ApiClient {
  return {
    baseUrl: `http://127.0.0.1:${PORT}`,
    fetchRepoPrDetail: () => Promise.resolve(detail('REVIEW_REQUIRED')),
    fetchRepoPrDiff: () => Promise.resolve({ patch: '', files: [] }),
    reviewRepoPr: () => Promise.resolve(detail('APPROVED')),
    commentRepoPr: () => Promise.resolve(detail('REVIEW_REQUIRED')),
  } as unknown as ApiClient;
}

interface Harness {
  client: QueryClient;
  wrapper: (props: { children: ReactNode }) => ReactNode;
  hook: ReturnType<typeof renderHook<ReturnType<typeof useRepoPrDetail>, void>>;
}

// Mounts the hook with a seeded, valid repo-PRs entry — the one the review
// queue and the PR header both render from — so a test can watch it go stale.
async function mounted(): Promise<Harness> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  client.setQueryData(repoPrsKey(PORT), []);
  const hook = renderHook(() => useRepoPrDetail(stubClient(), PORT, 9), {
    wrapper,
  });
  await waitFor(() => {
    expect(hook.result.current.prDetail).toBeDefined();
  });
  expect(client.getQueryState(repoPrsKey(PORT))?.isInvalidated).toBe(false);
  return { client, wrapper, hook };
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

test('the refreshed detail lands in this cache, no refetch', async () => {
  const { hook } = await mounted();
  await hook.result.current.handleReview('approve');
  await waitFor(() => {
    expect(hook.result.current.prDetail?.status.reviewDecision).toBe(
      'APPROVED'
    );
  });
});
