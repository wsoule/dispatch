import type {
  ApiClient,
  EpicProgress,
  PlanProposal,
  RunDetail,
  RunMeta,
  RunState,
} from '@dispatch/client';
import { createApiClient } from '@dispatch/client';
import type {
  CreateInput,
  DispatchConfig,
  TaskDoc,
  UpdatePatch,
} from '@dispatch/core';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { isTerminalRunState } from '../lib/runState';
import { computeBlockedIds } from '../lib/taskGraph';
import { ensureDispatchd } from '../lib/tauri';

// One entry per pending approval this window has seen live via the `approval.requested` WS
// event — the REST API has no way to hand back a paused run's requestId on a plain refetch,
// only the live event carries it (see the WS effect below).
type PendingApproval = { requestId: string; toolName: string };

export interface DispatchProjectData {
  /** `null` until the dispatchd sidecar's port resolves; every field below stays in its own
   * loading/empty state while this is `null` — callers should show a project-level "starting
   * the task daemon…" state, matching the previous TasksPanel behavior. */
  client: ApiClient | null;
  portLoading: boolean;
  portError: boolean;
  portErrorDetail: unknown;
  retryEnsureDispatchd: () => void;

  tasks: TaskDoc[];
  tasksLoading: boolean;
  config: DispatchConfig | null;
  runs: RunMeta[];
  health: { pr: boolean } | undefined;
  readyIds: Set<string>;
  blockedIds: Set<string>;
  epics: TaskDoc[];
  epicProgressById: Map<string, EpicProgress>;
  liveRunStateByTaskId: Map<string, RunState>;
  latestRunByTaskId: Map<string, RunMeta>;

  selectedRunId: string | null;
  setSelectedRunId: (runId: string | null) => void;
  runDetail: RunDetail | undefined;
  diff: import('@dispatch/client').DiffResult | undefined;
  diffLoading: boolean;
  diffError: string | null;
  pendingApprovals: Map<string, PendingApproval>;

  planId: string | null;
  setPlanId: (planId: string | null) => void;
  planRecord: import('@dispatch/client').PlanRecord | undefined;

  handleUpdate: (id: string, patch: UpdatePatch) => Promise<void>;
  handleCreate: (input: CreateInput) => Promise<void>;
  handleDispatch: (
    taskId: string,
    executor?: 'fake' | 'claude'
  ) => Promise<void>;
  handleApprove: (
    runId: string,
    requestId: string,
    allow: boolean
  ) => Promise<void>;
  handleSendMessage: (runId: string, text: string) => Promise<void>;
  handleCancelRun: (runId: string) => Promise<void>;
  handleReview: (runId: string, action: 'merge' | 'discard') => Promise<void>;
  handleRequestChanges: (runId: string, text: string) => Promise<void>;
  handleOpenPr: (runId: string) => Promise<void>;
  handleWorkEpic: (epicId: string, concurrency: number) => Promise<void>;
  handleStopEpic: (epicId: string) => Promise<void>;
  handleSubmitPrompt: (prompt: string) => Promise<string>;
  handleConfirmPlan: (proposal: PlanProposal) => Promise<void>;
}

/**
 * Ensures a dispatchd sidecar is running for `projectPath` and owns every query/mutation the
 * dispatch task/run/plan surfaces need — extracted from the old `TasksPanel` god-component so
 * the new Board/Tasks/Runs/Plans views (each its own top-level nav destination now, not tabs
 * inside one panel) can all read from the same live data and WS-invalidation wiring without
 * duplicating it four times. Pass `null` for `projectPath` when no project is active yet (the
 * get-started state) — every query below stays disabled and every field reads as empty/loading
 * rather than throwing.
 */
export function useDispatchProject(
  projectPath: string | null
): DispatchProjectData {
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<
    Map<string, PendingApproval>
  >(new Map());
  const [planId, setPlanId] = useState<string | null>(null);

  const {
    data: port,
    isLoading: portLoading,
    isError: portError,
    error: portErrorDetail,
    refetch: retryEnsureDispatchd,
  } = useQuery({
    queryKey: ['dispatchd-port', projectPath],
    queryFn: () => {
      if (projectPath === null) throw new Error('no active project');
      return ensureDispatchd(projectPath);
    },
    enabled: projectPath !== null,
    staleTime: Infinity,
    retry: false,
  });

  const client = useMemo(
    () =>
      port !== undefined ? createApiClient(`http://127.0.0.1:${port}`) : null,
    [port]
  );

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
  const epicProgressKeyPrefix = useMemo(
    () => ['dispatch-epic-progress', port],
    [port]
  );
  const planQueryKey = useMemo(
    () => ['dispatch-plan', port, planId],
    [port, planId]
  );

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
    // A running plan is worth polling — nothing on the WS event stream tells us when the
    // planner call itself finishes (only `plan.changed`, which fires once it's already
    // done), so a short poll while `state === 'running'` is the simplest way to notice.
    refetchInterval: (query) =>
      query.state.data?.state === 'running' ? 2000 : false,
  });

  const epics = useMemo(
    () => (tasks ?? []).filter((t) => t.meta.kind === 'epic'),
    [tasks]
  );

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

  useEffect(() => {
    if (client === null) return;
    return client.connectEvents(
      () => {
        void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
        void queryClient.invalidateQueries({ queryKey: configQueryKey });
        void queryClient.invalidateQueries({ queryKey: readyQueryKey });
        void queryClient.invalidateQueries({ queryKey: epicProgressKeyPrefix });
      },
      {
        onEvent: (event) => {
          if (event.type === 'run.changed') {
            void queryClient.invalidateQueries({ queryKey: runsQueryKey });
            void queryClient.invalidateQueries({
              queryKey: ['dispatch-run', port],
            });
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

  const liveRunStateByTaskId = useMemo(() => {
    const map = new Map<string, RunState>();
    for (const run of runs ?? []) {
      if (!isTerminalRunState(run.state)) map.set(run.taskId, run.state);
    }
    return map;
  }, [runs]);

  const latestRunByTaskId = useMemo(() => {
    const map = new Map<string, RunMeta>();
    for (const run of runs ?? []) {
      if (!map.has(run.taskId)) map.set(run.taskId, run);
    }
    return map;
  }, [runs]);

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

  // Returns the new plan's id so PlansView can add it to its local session history
  // immediately, without waiting on a refetch.
  async function handleSubmitPrompt(prompt: string): Promise<string> {
    if (client === null) throw new Error('dispatchd client not ready');
    const { planId: newPlanId } = await client.startPlan(prompt);
    setPlanId(newPlanId);
    return newPlanId;
  }

  async function handleConfirmPlan(proposal: PlanProposal): Promise<void> {
    if (client === null || planId === null) return;
    await client.confirmPlan(planId, proposal);
    void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    void queryClient.invalidateQueries({ queryKey: readyQueryKey });
  }

  return {
    client,
    portLoading,
    portError,
    portErrorDetail,
    retryEnsureDispatchd: () => void retryEnsureDispatchd(),

    tasks: tasks ?? [],
    tasksLoading,
    config: config ?? null,
    runs: runs ?? [],
    health,
    readyIds,
    blockedIds,
    epics,
    epicProgressById,
    liveRunStateByTaskId,
    latestRunByTaskId,

    selectedRunId,
    setSelectedRunId,
    runDetail,
    diff,
    diffLoading,
    diffError,
    pendingApprovals,

    planId,
    setPlanId,
    planRecord,

    handleUpdate,
    handleCreate,
    handleDispatch,
    handleApprove,
    handleSendMessage,
    handleCancelRun,
    handleReview,
    handleRequestChanges,
    handleOpenPr,
    handleWorkEpic,
    handleStopEpic,
    handleSubmitPrompt,
    handleConfirmPlan,
  };
}
