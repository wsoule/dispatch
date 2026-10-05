import type { TaskComment } from '@dispatch-foo/core/browser';
import { commentThreadIds } from '@dispatch-foo/core/browser';
import type { ApiClient } from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { pendingCommentId } from '../lib/commentThreads';

/** Every task's comment thread lives under this root, apart from the task list, so a
 * `comment.changed` refetches one thread and a list refetch never touches comments. */
export function commentsRootKey(port: number | undefined) {
  return ['dispatch-comments', port] as const;
}

export function taskCommentsKey(port: number | undefined, taskId: string) {
  return ['dispatch-comments', port, taskId] as const;
}

export interface TaskCommentsApi {
  /** Oldest first; undefined until the first fetch lands. */
  comments: TaskComment[] | undefined;
  error: string | null;
  /** Adds a comment (or a reply) at once, swapped for the daemon's copy when it lands. */
  add: (body: string, parentId?: string | null) => Promise<void>;
  edit: (commentId: string, body: string) => Promise<void>;
  /** Removes the comment and its replies at once; restored if the daemon refuses. */
  remove: (commentId: string) => Promise<void>;
}

// A process-wide counter so two pages adding at once never share a pending id.
let nextPending = 0;

// Swaps a pending comment for the daemon's copy, in place. A refetch that already carried
// the saved comment just drops the pending one; one that dropped both appends it.
function settlePending(
  list: TaskComment[],
  pendingId: string,
  saved: TaskComment
): TaskComment[] {
  if (list.some((c) => c.id === saved.id)) {
    return list.filter((c) => c.id !== pendingId);
  }
  return list.some((c) => c.id === pendingId)
    ? list.map((c) => (c.id === pendingId ? saved : c))
    : [...list, saved];
}

/**
 * One task's comment thread, with optimistic writes: each action paints the cache before
 * its request and rolls back if the request throws (the error is re-thrown for the caller
 * to show). `me` authors optimistic comments until the daemon's copy replaces them.
 */
export function useTaskComments(
  client: ApiClient | null,
  port: number | undefined,
  taskId: string | null,
  me: string | null
): TaskCommentsApi {
  const queryClient = useQueryClient();
  const key = taskCommentsKey(port, taskId ?? '');
  const { data, error } = useQuery({
    queryKey: key,
    queryFn: () => {
      if (client === null || taskId === null) {
        throw new Error('dispatchd client not ready');
      }
      return client.fetchTaskComments(taskId);
    },
    enabled: client !== null && taskId !== null,
  });
  const add = useCallback(
    async (body: string, parentId: string | null = null) => {
      if (client === null || taskId === null) return;
      const now = new Date().toISOString();
      const pending: TaskComment = {
        id: pendingCommentId(++nextPending),
        taskId,
        author: me ?? 'human',
        body,
        created: now,
        updated: now,
        parentId,
        external: null,
      };
      const k = taskCommentsKey(port, taskId);
      // A refetch already in flight would land without the pending comment.
      void queryClient.cancelQueries({ queryKey: k, exact: true });
      queryClient.setQueryData<TaskComment[]>(k, (old) => [
        ...(old ?? []),
        pending,
      ]);
      try {
        const saved = await client.addTaskComment(taskId, { body, parentId });
        queryClient.setQueryData<TaskComment[]>(k, (old) =>
          settlePending(old ?? [], pending.id, saved)
        );
      } catch (err) {
        queryClient.setQueryData<TaskComment[]>(k, (old) =>
          (old ?? []).filter((c) => c.id !== pending.id)
        );
        throw err;
      }
    },
    [client, port, taskId, me, queryClient]
  );

  const edit = useCallback(
    async (commentId: string, body: string) => {
      if (client === null || taskId === null) return;
      const k = taskCommentsKey(port, taskId);
      void queryClient.cancelQueries({ queryKey: k, exact: true });
      const previous = queryClient.getQueryData<TaskComment[]>(k);
      queryClient.setQueryData<TaskComment[]>(k, (old) =>
        old?.map((c) => (c.id === commentId ? { ...c, body } : c))
      );
      try {
        const saved = await client.updateTaskComment(taskId, commentId, {
          body,
        });
        queryClient.setQueryData<TaskComment[]>(k, (old) =>
          old?.map((c) => (c.id === commentId ? saved : c))
        );
      } catch (err) {
        queryClient.setQueryData(k, previous);
        throw err;
      }
    },
    [client, port, taskId, queryClient]
  );

  const remove = useCallback(
    async (commentId: string) => {
      if (client === null || taskId === null) return;
      const k = taskCommentsKey(port, taskId);
      void queryClient.cancelQueries({ queryKey: k, exact: true });
      const previous = queryClient.getQueryData<TaskComment[]>(k);
      if (previous !== undefined) {
        const gone = commentThreadIds(previous, commentId);
        queryClient.setQueryData<TaskComment[]>(
          k,
          previous.filter((c) => !gone.has(c.id))
        );
      }
      try {
        await client.deleteTaskComment(taskId, commentId);
      } catch (err) {
        queryClient.setQueryData(k, previous);
        throw err;
      }
    },
    [client, port, taskId, queryClient]
  );

  return {
    comments: taskId === null ? undefined : data,
    error: error instanceof Error ? error.message : null,
    add,
    edit,
    remove,
  };
}
