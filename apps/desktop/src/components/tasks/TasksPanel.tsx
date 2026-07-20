import { createApiClient } from '@dispatch/client';
import type { CreateInput, UpdatePatch } from '@dispatch/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { computeBlockedIds } from '../../lib/taskGraph';
import { ensureDispatchd } from '../../lib/tauri';
import { Button } from '../ui/Button';
import { CreateTaskModal } from './CreateTaskModal';
import { TaskBoard } from './TaskBoard';
import { TaskDetailModal } from './TaskDetailModal';
import './TasksPanel.css';

interface TasksPanelProps {
  /** Absolute project root — the same path `has_dispatch`/`ensure_dispatchd` take. */
  projectPath: string;
}

/** Embedded in `ProjectDetail`'s Tasks tab: ensures a dispatchd sidecar is running for this
 * project (spawning one via the Rust `ensure_dispatchd` command if needed), then renders its
 * task board through `@dispatch/client` pointed at that sidecar's port. Owns every dispatchd
 * query/mutation for the tab — `TaskBoard`/`TaskDetailModal`/`CreateTaskModal` below stay
 * presentational, the same split `ProjectBoard` uses for Relay's own kanban. */
export function TasksPanel({ projectPath }: TasksPanelProps) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // Spawning a fresh dispatchd can take a couple of seconds (see
  // `ensure_dispatchd`'s 5s poll budget) — react-query's own loading state
  // covers that wait. `staleTime: Infinity` + no retries: a resolved port is
  // good for the life of this component; a failure surfaces immediately so
  // the "Retry" button below can re-trigger it deliberately instead of
  // react-query silently retrying spawn attempts in the background.
  const {
    data: port,
    isLoading: portLoading,
    isError: portError,
    error: portErrorDetail,
    refetch: retryEnsureDispatchd,
  } = useQuery({
    queryKey: ['dispatchd-port', projectPath],
    queryFn: () => ensureDispatchd(projectPath),
    staleTime: Infinity,
    retry: false,
  });

  const client = useMemo(
    () =>
      port !== undefined ? createApiClient(`http://127.0.0.1:${port}`) : null,
    [port]
  );

  // Memoized on `port` (not recreated every render) so the WS-invalidate effect below can
  // list them as dependencies without reconnecting on every unrelated re-render (e.g.
  // opening/closing a modal) — only an actual port change should do that.
  const tasksQueryKey = useMemo(() => ['dispatch-tasks', port], [port]);
  const configQueryKey = useMemo(() => ['dispatch-config', port], [port]);
  const readyQueryKey = useMemo(() => ['dispatch-ready-tasks', port], [port]);

  // `enabled: client !== null` keeps react-query from ever calling these while the port
  // isn't resolved yet, but each queryFn still guards defensively (rather than asserting
  // non-null) — react-query's types don't let `enabled` narrow `client` inside `queryFn`.
  const { data: tasks, isLoading: tasksLoading } = useQuery({
    queryKey: tasksQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchTasks();
    },
    enabled: client !== null,
  });
  const { data: config } = useQuery({
    queryKey: configQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchConfig();
    },
    enabled: client !== null,
  });
  const { data: readyTasks } = useQuery({
    queryKey: readyQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchReadyTasks();
    },
    enabled: client !== null,
  });

  // dispatchd's WS protocol is "something changed, go refetch" with no payload (see
  // packages/server/src/events.ts) — invalidating these three query keys on every
  // `task.changed` is the react-query equivalent of @dispatch/web's useTasks calling its own
  // `refresh()`, consistent with how useDataChangedEvents.ts already invalidates on Relay's
  // own `data-changed` Tauri event.
  useEffect(() => {
    if (client === null) return;
    return client.connectEvents(() => {
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      void queryClient.invalidateQueries({ queryKey: configQueryKey });
      void queryClient.invalidateQueries({ queryKey: readyQueryKey });
    });
  }, [client, queryClient, tasksQueryKey, configQueryKey, readyQueryKey]);

  const readyIds = useMemo(
    () => new Set((readyTasks ?? []).map((t) => t.meta.id)),
    [readyTasks]
  );
  const blockedIds = useMemo(() => computeBlockedIds(tasks ?? []), [tasks]);
  const epics = useMemo(
    () => (tasks ?? []).filter((t) => t.meta.kind === 'epic'),
    [tasks]
  );
  const selectedDoc = useMemo(
    () => (tasks ?? []).find((t) => t.meta.id === selectedId) ?? null,
    [tasks, selectedId]
  );

  // Awaited (not fire-and-forget) so TaskDetailModal can catch a PATCH
  // rejection and show it inline instead of the update silently vanishing —
  // without a thrown/rejected promise reaching the modal, the only visible
  // effect of a failed update used to be the WS-driven refetch quietly
  // reverting the optimistic-looking UI change.
  async function handleUpdate(id: string, patch: UpdatePatch): Promise<void> {
    if (client === null) return;
    await client.updateTask(id, patch);
    void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    void queryClient.invalidateQueries({ queryKey: readyQueryKey });
  }

  async function handleCreate(input: CreateInput): Promise<void> {
    if (client === null) return;
    await client.createTask(input);
    void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    void queryClient.invalidateQueries({ queryKey: readyQueryKey });
  }

  if (portLoading) {
    return <p className="tasks-panel-status">Starting the task daemon…</p>;
  }

  if (portError || client === null) {
    return (
      <div className="tasks-panel-status">
        <p>
          Couldn&rsquo;t start dispatchd for this project
          {portErrorDetail instanceof Error
            ? `: ${portErrorDetail.message}`
            : '.'}
        </p>
        <Button variant="secondary" onClick={() => void retryEnsureDispatchd()}>
          Retry
        </Button>
      </div>
    );
  }

  if (tasksLoading || !config || !tasks) {
    return <p className="tasks-panel-status">Loading tasks…</p>;
  }

  return (
    <div className="tasks-panel">
      <div className="tasks-panel-toolbar">
        <Button onClick={() => setShowCreate(true)}>+ New Task</Button>
      </div>

      {tasks.length === 0 ? (
        <p className="tasks-panel-status">
          No tasks yet — create the first one to get started.
        </p>
      ) : (
        <TaskBoard
          tasks={tasks}
          statuses={config.statuses}
          readyIds={readyIds}
          blockedIds={blockedIds}
          onSelect={setSelectedId}
        />
      )}

      {selectedDoc !== null && (
        <TaskDetailModal
          doc={selectedDoc}
          statuses={config.statuses}
          onClose={() => setSelectedId(null)}
          onUpdate={handleUpdate}
        />
      )}

      {showCreate && (
        <CreateTaskModal
          statuses={config.statuses}
          epics={epics}
          onCreate={handleCreate}
          onClose={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}
