import type { ApiClient } from '@dispatch/client';
import type { TaskDoc, TaskListItem } from '@dispatch/core/browser';
import { useQuery } from '@tanstack/react-query';

/** The task list's query key. `taskDocKey` nests under it, so invalidating
 * the list also refetches any open task's body. */
export function tasksKey(port: number | undefined) {
  return ['dispatch-tasks', port] as const;
}

export function taskDocKey(port: number | undefined, taskId: string) {
  return ['dispatch-tasks', port, 'doc', taskId] as const;
}

/** One task's full doc, body included — the list query carries only metadata,
 * so a surface that renders the body fetches it here. `null` skips the fetch. */
export function useTaskDoc(
  client: ApiClient | null,
  port: number | undefined,
  taskId: string | null
): TaskDoc | undefined {
  const { data } = useQuery({
    queryKey: taskDocKey(port, taskId ?? ''),
    queryFn: () => {
      if (client === null || taskId === null) {
        throw new Error('dispatchd client not ready');
      }
      return client.fetchTask(taskId);
    },
    enabled: client !== null && taskId !== null,
  });
  return taskId === null ? undefined : data;
}

/** The list's entry for `taskId` with `full`'s body — list meta, since the list is
 * what optimistic edits patch. `null` while the body loads or once the task is gone. */
export function withBody(
  tasks: readonly TaskListItem[],
  taskId: string | null,
  full: TaskDoc | undefined
): TaskDoc | null {
  if (taskId === null || full === undefined) return null;
  const item = tasks.find((t) => t.meta.id === taskId);
  return item === undefined ? null : { meta: item.meta, body: full.body };
}
