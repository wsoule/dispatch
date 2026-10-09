import type { TaskDoc } from '@dispatch-foo/core/browser';
import type { ApiClient } from '@dispatch/client';
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
