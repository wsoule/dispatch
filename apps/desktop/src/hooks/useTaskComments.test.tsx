import type { ApiClient } from '@dispatch/client';
import type { TaskComment } from '@dispatch/core/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';
import type { ReactNode } from 'react';

import { useTaskComments } from './useTaskComments';

function comment(
  id: string,
  body: string,
  parentId: string | null = null
): TaskComment {
  return {
    id,
    taskId: 't-1',
    author: 'human:wyat',
    body,
    created: '2026-09-23T10:00:00.000Z',
    updated: '2026-09-23T10:00:00.000Z',
    parentId,
    external: null,
  };
}

function setup(client: Partial<ApiClient>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(
    () => useTaskComments(client as ApiClient, 1, 't-1', 'human:wyat'),
    { wrapper }
  );
}

test('a new comment shows at once, then becomes the daemon’s copy', async () => {
  let resolve: (c: TaskComment) => void = () => {};
  const { result } = setup({
    fetchTaskComments: () => Promise.resolve([comment('c-1', 'first')]),
    addTaskComment: () =>
      new Promise<TaskComment>((r) => {
        resolve = r;
      }),
  });
  await waitFor(() => expect(result.current.comments).toHaveLength(1));
  let done: Promise<void> = Promise.resolve();
  act(() => {
    done = result.current.add('second');
  });
  await waitFor(() => expect(result.current.comments).toHaveLength(2));
  expect(result.current.comments?.[1]?.id.startsWith('pending:')).toBe(true);
  expect(result.current.comments?.[1]?.author).toBe('human:wyat');
  await act(async () => {
    resolve(comment('c-2', 'second'));
    await done;
  });
  await waitFor(() =>
    expect(result.current.comments?.map((c) => c.id)).toEqual(['c-1', 'c-2'])
  );
});

test('a refused comment is taken back and the error reaches the caller', async () => {
  const { result } = setup({
    fetchTaskComments: () => Promise.resolve([]),
    addTaskComment: () => Promise.reject(new Error('task not found')),
  });
  await waitFor(() => expect(result.current.comments).toEqual([]));
  let failure: unknown = null;
  await act(async () => {
    await result.current.add('lost').catch((err: unknown) => {
      failure = err;
    });
  });
  expect((failure as Error | null)?.message).toBe('task not found');
  expect(result.current.comments).toEqual([]);
});

test('deleting drops the thread at once and restores it when refused', async () => {
  let refuse: (err: Error) => void = () => {};
  const { result } = setup({
    fetchTaskComments: () =>
      Promise.resolve([
        comment('c-1', 'root'),
        comment('c-2', 'reply', 'c-1'),
        comment('c-3', 'other'),
      ]),
    deleteTaskComment: () =>
      new Promise((_, r) => {
        refuse = r;
      }),
  });
  await waitFor(() => expect(result.current.comments).toHaveLength(3));
  let done: Promise<void> = Promise.resolve();
  act(() => {
    done = result.current.remove('c-1').catch(() => {});
  });
  await waitFor(() =>
    expect(result.current.comments?.map((c) => c.id)).toEqual(['c-3'])
  );
  await act(async () => {
    refuse(new Error('others replied to this comment'));
    await done;
  });
  await waitFor(() =>
    expect(result.current.comments?.map((c) => c.id)).toEqual([
      'c-1',
      'c-2',
      'c-3',
    ])
  );
});

test('an edit shows at once', async () => {
  const { result } = setup({
    fetchTaskComments: () => Promise.resolve([comment('c-1', 'old')]),
    updateTaskComment: (_id, _cid, patch) =>
      Promise.resolve(comment('c-1', patch.body)),
  });
  await waitFor(() => expect(result.current.comments).toHaveLength(1));
  await act(async () => {
    await result.current.edit('c-1', 'new');
  });
  await waitFor(() => expect(result.current.comments?.[0]?.body).toBe('new'));
});
