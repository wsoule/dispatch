import type {
  EpicProgress,
  PlanProposal,
  RunDetail,
  RunMeta,
  RunState,
} from '@dispatch/client';
import { createApiClient } from '@dispatch/client';
import type { CreateInput, UpdatePatch } from '@dispatch/core';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { isTerminalRunState } from '../../lib/runState';
import { computeBlockedIds } from '../../lib/taskGraph';
import { ensureDispatchd } from '../../lib/tauri';
import { RunModal } from '../runs/RunModal';
import { RunsRail } from '../runs/RunsRail';
import { Button } from '../ui/Button';
import { CreateTaskModal } from './CreateTaskModal';
import type { PlanStage } from './PlanModal';
import { PlanModal } from './PlanModal';
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

  // Phase 5 P2: the big-prompt plan flow. `planFlowOpen` gates whether
  // PlanModal renders at all; `planId` is null only for the composer stage
  // (before `POST /api/plan` has returned an id) — see `planStage` below for
  // how the two combine into PlanModal's stage prop.
  const [planFlowOpen, setPlanFlowOpen] = useState(false);
  const [planId, setPlanId] = useState<string | null>(null);

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
  const healthQueryKey = useMemo(() => ['dispatch-health', port], [port]);
  // Prefix shared by every epic's own progress query key (see
  // `epicProgressQueries` below) — kept as its own memo so the WS-invalidate
  // effect can invalidate every epic's progress at once without needing to
  // know which epics exist.
  const epicProgressKeyPrefix = useMemo(
    () => ['dispatch-epic-progress', port],
    [port]
  );
  const planQueryKey = useMemo(
    () => ['dispatch-plan', port, planId],
    [port, planId]
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

  // `pr` gates whether RunModal's review surface offers "Open PR" at all —
  // see PrManager.detectPrCapability server-side for what it checks.
  const { data: health } = useQuery({
    queryKey: healthQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchHealth();
    },
    enabled: client !== null,
  });

  const { data: planRecord } = useQuery({
    queryKey: planQueryKey,
    queryFn: () => {
      if (client === null || planId === null) {
        throw new Error('no plan in progress');
      }
      return client.fetchPlan(planId);
    },
    enabled: client !== null && planId !== null,
  });

  const epics = useMemo(
    () => (tasks ?? []).filter((t) => t.meta.kind === 'epic'),
    [tasks]
  );

  // One progress query per epic on the board — `useQueries` (rather than one
  // useQuery per epic, which would violate the rules of hooks the moment the
  // epic count changes across renders) is the react-query-supported way to
  // run a dynamic list of queries. `active`/`concurrency` here are the one
  // thing EpicEngine's own in-memory session state carries that a task's own
  // TaskDoc/RunMeta never would.
  const epicProgressResults = useQueries({
    queries: epics.map((epic) => ({
      queryKey: [...epicProgressKeyPrefix, epic.meta.id],
      queryFn: () => {
        if (client === null) throw new Error('dispatchd client not ready');
        return client.fetchEpicProgress(epic.meta.id);
      },
      enabled: client !== null,
    })),
  });
  const epicProgressById = useMemo(() => {
    const map = new Map<string, EpicProgress>();
    epics.forEach((epic, i) => {
      const data = epicProgressResults[i]?.data;
      if (data !== undefined) map.set(epic.meta.id, data);
    });
    return map;
  }, [epics, epicProgressResults]);

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
        // A task.changed can flip an epic's children (e.g. the plan/confirm
        // flow just wrote new ones, or an epic's dispatch-started Activity
        // line landed) — cheap enough to always refresh alongside the board.
        void queryClient.invalidateQueries({
          queryKey: epicProgressKeyPrefix,
        });
      },
      {
        onEvent: (event) => {
          if (event.type === 'run.changed') {
            void queryClient.invalidateQueries({ queryKey: runsQueryKey });
            void queryClient.invalidateQueries({
              queryKey: ['dispatch-run', port],
            });
            // A run reaching a terminal state or being reviewed is exactly
            // what can free/fill an epic's concurrency slot — see EpicEngine's
            // own onRunTerminal/onRunReviewed hooks server-side.
            void queryClient.invalidateQueries({
              queryKey: epicProgressKeyPrefix,
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
          } else if (event.type === 'plan.changed') {
            void queryClient.invalidateQueries({
              queryKey: ['dispatch-plan', port, event.planId],
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
    epicProgressKeyPrefix,
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

  async function handleOpenPr(runId: string): Promise<void> {
    if (client === null) return;
    await client.reviewRun(runId, 'pr');
    void queryClient.invalidateQueries({ queryKey: runsQueryKey });
    void queryClient.invalidateQueries({ queryKey: ['dispatch-run', port] });
  }

  async function handleWorkEpic(
    epicId: string,
    concurrency: number
  ): Promise<void> {
    if (client === null) return;
    await client.startEpic(epicId, { concurrency });
    void queryClient.invalidateQueries({ queryKey: epicProgressKeyPrefix });
    void queryClient.invalidateQueries({ queryKey: runsQueryKey });
  }

  async function handleStopEpic(epicId: string): Promise<void> {
    if (client === null) return;
    await client.stopEpic(epicId);
    void queryClient.invalidateQueries({ queryKey: epicProgressKeyPrefix });
  }

  // Opens PlanModal fresh at the composer stage — `planId` starts null even
  // if a previous plan flow left one set (that plan is done being shown
  // either way: it was confirmed or explicitly dismissed to get here).
  function openPlanFlow(): void {
    setPlanId(null);
    setPlanFlowOpen(true);
  }

  function closePlanFlow(): void {
    setPlanFlowOpen(false);
    setPlanId(null);
  }

  async function handleSubmitPrompt(prompt: string): Promise<void> {
    if (client === null) return;
    const { planId: newPlanId } = await client.startPlan(prompt);
    setPlanId(newPlanId);
  }

  async function handleConfirmPlan(proposal: PlanProposal): Promise<void> {
    if (client === null || planId === null) return;
    await client.confirmPlan(planId, proposal);
    void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    void queryClient.invalidateQueries({ queryKey: readyQueryKey });
    closePlanFlow();
  }

  // `planId === null` while the composer is up (no plan started yet);
  // once `POST /api/plan` returns an id, the stage tracks the plan record's
  // own state — 'running' by default until the first fetch resolves, since
  // a plan really is running from the instant startPlan() returns.
  const planStage: PlanStage =
    planId === null
      ? 'compose'
      : (planRecord?.state ?? 'running') === 'ready'
        ? 'ready'
        : (planRecord?.state ?? 'running') === 'failed'
          ? 'failed'
          : 'running';

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
        <Button variant="secondary" onClick={openPlanFlow}>
          Plan work…
        </Button>
        <Button onClick={() => setShowCreate(true)}>+ New Task</Button>
      </div>

      <RunsRail runs={runs ?? []} onSelect={setSelectedRunId} />

      {tasks.length === 0 ? (
        <p className="tasks-panel-status">
          No tasks yet — create the first one, or describe the work with
          &ldquo;Plan work…&rdquo; and let the planner draft it.
        </p>
      ) : (
        <TaskBoard
          tasks={tasks}
          statuses={config.statuses}
          readyIds={readyIds}
          blockedIds={blockedIds}
          liveRunStateByTaskId={liveRunStateByTaskId}
          epicProgressById={epicProgressById}
          epicConcurrencyDefault={config.orchestrator.epicConcurrency}
          onSelect={setSelectedId}
          onWorkEpic={handleWorkEpic}
          onStopEpic={handleStopEpic}
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
          prCapability={health?.pr ?? false}
          onApprove={(requestId, allow) =>
            handleApprove(selectedRunId, requestId, allow)
          }
          onSendMessage={(text) => handleSendMessage(selectedRunId, text)}
          onCancel={() => handleCancelRun(selectedRunId)}
          onMerge={() => handleReview(selectedRunId, 'merge')}
          onDiscard={() => handleReview(selectedRunId, 'discard')}
          onRequestChanges={(text) => handleRequestChanges(selectedRunId, text)}
          onOpenPr={() => handleOpenPr(selectedRunId)}
          onClose={() => setSelectedRunId(null)}
        />
      )}

      {planFlowOpen && (
        <PlanModal
          stage={planStage}
          error={planRecord?.error}
          proposal={planRecord?.proposal}
          onSubmitPrompt={handleSubmitPrompt}
          onConfirm={handleConfirmPlan}
          onCancel={closePlanFlow}
        />
      )}
    </div>
  );
}
