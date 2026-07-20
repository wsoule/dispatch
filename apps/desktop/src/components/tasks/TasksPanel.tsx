import type { RunDetail, RunMeta, RunState } from '@dispatch/client';
import { createApiClient } from '@dispatch/client';
import type { CreateInput, UpdatePatch } from '@dispatch/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { isTerminalRunState } from '../../lib/runState';
import { computeBlockedIds } from '../../lib/taskGraph';
import { ensureDispatchd } from '../../lib/tauri';
import { RunModal } from '../runs/RunModal';
import { RunsRail } from '../runs/RunsRail';
import { Button } from '../ui/Button';
import { CreateTaskModal } from './CreateTaskModal';
import { TaskBoard } from './TaskBoard';
import { TaskDetailModal } from './TaskDetailModal';
import './TasksPanel.css';

interface TasksPanelProps {
  /** Absolute project root — the same path `has_dispatch`/`ensure_dispatchd` take. */
  projectPath: string;
}

// One entry per pending approval this window has seen live via the
// `approval.requested` WS event — see RunLogView's doc comment on why the
// API can't hand this back on a plain refetch, only the live event carries
// it.
type PendingApproval = { requestId: string; toolName: string };

/** Embedded in `ProjectDetail`'s Tasks tab: ensures a dispatchd sidecar is running for this
 * project (spawning one via the Rust `ensure_dispatchd` command if needed), then renders its
 * task board through `@dispatch/client` pointed at that sidecar's port. Owns every dispatchd
 * query/mutation for the tab — `TaskBoard`/`TaskDetailModal`/`CreateTaskModal`/`RunModal`/
 * `RunsRail` below stay presentational, the same split `ProjectBoard` uses for Relay's own
 * kanban. Phase 4 Slice O3 adds the orchestrator run surface (dispatch, live log, approvals,
 * review) alongside the existing task board wiring. */
export function TasksPanel({ projectPath }: TasksPanelProps) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<
    Map<string, PendingApproval>
  >(new Map());

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
  const runsQueryKey = useMemo(() => ['dispatch-runs', port], [port]);
  const runDetailQueryKey = useMemo(
    () => ['dispatch-run', port, selectedRunId],
    [port, selectedRunId]
  );
  const runDiffQueryKey = useMemo(
    () => ['dispatch-run-diff', port, selectedRunId],
    [port, selectedRunId]
  );

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
  const { data: runs } = useQuery({
    queryKey: runsQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchRuns();
    },
    enabled: client !== null,
  });
  const { data: runDetail } = useQuery({
    queryKey: runDetailQueryKey,
    queryFn: () => {
      if (client === null || selectedRunId === null) {
        throw new Error('no run selected');
      }
      return client.fetchRun(selectedRunId);
    },
    enabled: client !== null && selectedRunId !== null,
  });
  // The diff only makes sense — and only avoids a wasted request — once the
  // selected run has actually finished/failed/cancelled; RunModal shows
  // RunLogView (no diff) for every other state, matching the plan's "diff
  // unavailable while running" empty state by simply never asking for one.
  const diffEnabled =
    client !== null &&
    selectedRunId !== null &&
    runDetail !== undefined &&
    isTerminalRunState(runDetail.meta.state);
  const {
    data: diff,
    isLoading: diffLoading,
    error: diffErrorDetail,
  } = useQuery({
    queryKey: runDiffQueryKey,
    queryFn: () => {
      if (client === null || selectedRunId === null) {
        throw new Error('no run selected');
      }
      return client.fetchRunDiff(selectedRunId);
    },
    enabled: diffEnabled,
  });
  const diffError =
    diffErrorDetail instanceof Error ? diffErrorDetail.message : null;

  // dispatchd's WS protocol is "something changed, go refetch" with no payload for
  // `task.changed`/`run.changed` (see packages/server/src/events.ts) — invalidating on every
  // event is the react-query equivalent of @dispatch/web's useTasks calling its own
  // `refresh()`. `run.log` is the one exception: it carries the actual entry, so it's applied
  // directly to the cached RunDetail instead of triggering a refetch — appending one entry at
  // a time keeps a fast log stream from re-fetching the whole transcript on every line.
  useEffect(() => {
    if (client === null) return;
    return client.connectEvents(
      () => {
        void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
        void queryClient.invalidateQueries({ queryKey: configQueryKey });
        void queryClient.invalidateQueries({ queryKey: readyQueryKey });
      },
      {
        onEvent: (event) => {
          if (event.type === 'run.changed') {
            void queryClient.invalidateQueries({ queryKey: runsQueryKey });
            void queryClient.invalidateQueries({
              queryKey: ['dispatch-run', port],
            });
          } else if (event.type === 'run.log') {
            queryClient.setQueryData<RunDetail>(
              ['dispatch-run', port, event.runId],
              (prev) =>
                prev !== undefined
                  ? { ...prev, entries: [...prev.entries, event.entry] }
                  : prev
            );
          } else if (event.type === 'approval.requested') {
            setPendingApprovals((prev) => {
              const next = new Map(prev);
              next.set(event.runId, {
                requestId: event.requestId,
                toolName: event.toolName,
              });
              return next;
            });
          }
        },
      }
    );
  }, [
    client,
    queryClient,
    tasksQueryKey,
    configQueryKey,
    readyQueryKey,
    runsQueryKey,
    port,
  ]);

  // Self-corrects `pendingApprovals` whenever the runs list refreshes: a run that's no longer
  // `awaiting-approval` (approved/denied/cancelled/timed out) drops out, since its requestId
  // is no longer valid even if this window never submitted the decision itself (e.g. approved
  // from another window).
  useEffect(() => {
    if (runs === undefined) return;
    setPendingApprovals((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const runId of next.keys()) {
        const meta = runs.find((r) => r.id === runId);
        if (meta === undefined || meta.state !== 'awaiting-approval') {
          next.delete(runId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [runs]);

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

  // Live (non-terminal) run state per task — the Tasks board card indicator.
  const liveRunStateByTaskId = useMemo(() => {
    const map = new Map<string, RunState>();
    for (const run of runs ?? []) {
      if (!isTerminalRunState(run.state)) map.set(run.taskId, run.state);
    }
    return map;
  }, [runs]);

  // The most recent run per task, regardless of state — `runs` is already
  // newest-first (see RunRegistry.list()), so the first match per taskId
  // wins. TaskDetailModal only actually uses this while the task's own
  // status is in-progress/in-review, so a stale entry left over from a
  // merged/discarded run is harmless (never rendered).
  const latestRunByTaskId = useMemo(() => {
    const map = new Map<string, RunMeta>();
    for (const run of runs ?? []) {
      if (!map.has(run.taskId)) map.set(run.taskId, run);
    }
    return map;
  }, [runs]);

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

  // Dispatches a new run and immediately opens it, so the person who just
  // clicked Dispatch lands straight on the live log instead of having to go
  // find their new run in the rail.
  async function handleDispatch(
    taskId: string,
    executor?: 'fake' | 'claude'
  ): Promise<void> {
    if (client === null) return;
    const meta = await client.createRun(taskId, executor);
    void queryClient.invalidateQueries({ queryKey: runsQueryKey });
    void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    void queryClient.invalidateQueries({ queryKey: readyQueryKey });
    setSelectedRunId(meta.id);
  }

  async function handleApprove(
    runId: string,
    requestId: string,
    allow: boolean
  ): Promise<void> {
    if (client === null) return;
    await client.approveRun(runId, requestId, allow);
    setPendingApprovals((prev) => {
      const next = new Map(prev);
      next.delete(runId);
      return next;
    });
    void queryClient.invalidateQueries({ queryKey: runsQueryKey });
    void queryClient.invalidateQueries({ queryKey: ['dispatch-run', port] });
  }

  async function handleSendMessage(runId: string, text: string): Promise<void> {
    if (client === null) return;
    await client.sendRunMessage(runId, text);
    void queryClient.invalidateQueries({ queryKey: ['dispatch-run', port] });
  }

  async function handleCancelRun(runId: string): Promise<void> {
    if (client === null) return;
    await client.cancelRun(runId);
    void queryClient.invalidateQueries({ queryKey: runsQueryKey });
    void queryClient.invalidateQueries({ queryKey: ['dispatch-run', port] });
  }

  async function handleReview(
    runId: string,
    action: 'merge' | 'discard'
  ): Promise<void> {
    if (client === null) return;
    await client.reviewRun(runId, action);
    void queryClient.invalidateQueries({ queryKey: runsQueryKey });
    void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    void queryClient.invalidateQueries({ queryKey: readyQueryKey });
    setSelectedRunId(null);
  }

  async function handleRequestChanges(
    runId: string,
    text: string
  ): Promise<void> {
    if (client === null) return;
    const meta = await client.sendRunMessage(runId, text, { resume: true });
    void queryClient.invalidateQueries({ queryKey: runsQueryKey });
    void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    void queryClient.invalidateQueries({ queryKey: readyQueryKey });
    // request-changes re-dispatches under a fresh run id — follow it so the
    // modal keeps showing the run that's now actually live.
    setSelectedRunId(meta.id);
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

      <RunsRail runs={runs ?? []} onSelect={setSelectedRunId} />

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
          liveRunStateByTaskId={liveRunStateByTaskId}
          onSelect={setSelectedId}
        />
      )}

      {selectedDoc !== null && (
        <TaskDetailModal
          doc={selectedDoc}
          statuses={config.statuses}
          ready={readyIds.has(selectedDoc.meta.id)}
          run={latestRunByTaskId.get(selectedDoc.meta.id)}
          onClose={() => setSelectedId(null)}
          onUpdate={handleUpdate}
          onDispatch={handleDispatch}
          onOpenRun={(runId) => {
            setSelectedId(null);
            setSelectedRunId(runId);
          }}
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

      {selectedRunId !== null && runDetail !== undefined && (
        <RunModal
          meta={runDetail.meta}
          entries={runDetail.entries}
          pendingApproval={pendingApprovals.get(selectedRunId) ?? null}
          diff={diff}
          diffLoading={diffLoading}
          diffError={diffError}
          onApprove={(requestId, allow) =>
            handleApprove(selectedRunId, requestId, allow)
          }
          onSendMessage={(text) => handleSendMessage(selectedRunId, text)}
          onCancel={() => handleCancelRun(selectedRunId)}
          onMerge={() => handleReview(selectedRunId, 'merge')}
          onDiscard={() => handleReview(selectedRunId, 'discard')}
          onRequestChanges={(text) => handleRequestChanges(selectedRunId, text)}
          onClose={() => setSelectedRunId(null)}
        />
      )}
    </div>
  );
}
