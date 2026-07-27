import type {
  ApiClient,
  EpicProgress,
  MergeQueueSnapshot,
  PlanProposal,
  PlanRecord,
  RepoPr,
  RunDetail,
  RunMeta,
  RunState,
  TaskDraft,
} from '@dispatch/client';
import { createApiClient } from '@dispatch/client';
import type {
  CreateInput,
  DispatchConfig,
  TaskDoc,
  UpdatePatch,
} from '@dispatch/core';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { readDefaultModel } from '../lib/models';
import { notify } from '../lib/notifications';
import { isTerminalRunState } from '../lib/runState';
import { computeBlockedIds } from '../lib/taskGraph';
import { ensureDispatchd } from '../lib/tauri';
import { useTransitionNotifications } from './useTransitionNotifications';

// One entry per pending approval this window has seen live via the `approval.requested` WS
// event — the REST API has no way to hand back a paused run's requestId on a plain refetch,
// only the live event carries it (see the WS effect below).
type PendingApproval = { requestId: string; toolName: string };

/**
 * `GET /api/plan/:id` as a reusable query, because this hook exposes two independent plan
 * slots: the Plans view's own plan, and the AI task draft the Notes hub starts off a note.
 * They must not share one `planId` — starting a note draft would otherwise replace whatever
 * proposal the Plans view had open — but they poll identically, so the query itself is
 * written once here and instantiated per slot.
 *
 * `retry: false`: a stale `planId` mid project-switch (cleared by an effect below, but not
 * instantly re-rendered) should never retry against the wrong daemon — see I5.
 */
function usePlanRecord(
  client: ApiClient | null,
  port: number | undefined,
  planId: string | null
): PlanRecord | undefined {
  const { data } = useQuery({
    queryKey: ['dispatch-plan', port, planId],
    queryFn: () => {
      if (client === null || planId === null) {
        throw new Error('no plan in progress');
      }
      return client.fetchPlan(planId);
    },
    enabled: client !== null && planId !== null,
    retry: false,
    // A running plan is worth polling — nothing on the WS event stream tells us when the
    // planner call itself finishes (only `plan.changed`, which fires once it's already
    // done), so a short poll while `state === 'running'` is the simplest way to notice.
    refetchInterval: (query) =>
      query.state.data?.state === 'running' ? 2000 : false,
  });
  return data;
}

export interface UseDispatchProjectOptions {
  /** Which run's detail/diff to fetch, if any — the *single* source of truth for "which run
   * is selected" lives in the app-root `navReducer`'s `activeRunId` (see the phase-8 fix
   * report's C1: this hook used to keep its own duplicate `selectedRunId` state that nothing
   * outside `RunsView`'s row-click ever wrote to, so opening a run from the task peek panel
   * updated nav state but left this hook still pointed at whatever run — or none — it saw
   * last). Pass `null` when nothing is selected. */
  selectedRunId: string | null;
  /** Called once a run is created or re-dispatched (request-changes), so the caller can move
   * `navReducer`'s `activeRunId`/`projectView` to point at it. Replaces the old internal
   * `setSelectedRunId(meta.id)` side effect. */
  onRunDispatched?: (runId: string) => void;
}

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
  // Task 6: the merge queue's live snapshot (pending/active entries + a capped
  // history) — `null` until the query has ever resolved, so callers can show
  // an empty/loading state without treating "no entries yet" as an error.
  mergeQueue: MergeQueueSnapshot | null;
  // Item B: every open PR in the repo, not just the ones dispatch itself
  // opened — gated on `health.pr === true` (see the query's own comment),
  // so `null` covers both "hasn't loaded yet" and "this project has no pr
  // capability" alike; PullRequestsView treats both as "nothing to show".
  repoPrs: RepoPr[] | null;

  runDetail: RunDetail | undefined;
  diff: import('@dispatch/client').DiffResult | undefined;
  diffLoading: boolean;
  diffError: string | null;
  prDetail: import('@dispatch/client').PrDetail | undefined;
  prDetailLoading: boolean;
  prDetailError: string | null;
  // Every dispatch worktree/branch on disk, joined with whatever run claims it
  // — the Branches surface's data. See BranchEntry in @dispatch/client.
  branches: import('@dispatch/client').BranchEntry[];
  branchesLoading: boolean;
  handleRefreshBranches: () => Promise<void>;
  handleFreeBranchDisk: (branch: string) => Promise<void>;
  handleDeleteBranch: (
    branch: string,
    opts?: { force?: boolean }
  ) => Promise<void>;
  /** The brain-dump inbox — captured, not committed. */
  inbox: import('@dispatch/client').InboxItem[];
  /** Splits `text` server-side into one item per non-empty line. */
  handleCaptureInbox: (text: string) => Promise<void>;
  handleUpdateInboxItem: (
    id: string,
    patch: { kind?: import('@dispatch/client').InboxKind; text?: string }
  ) => Promise<void>;
  handleDismissInbox: (ids: string[]) => Promise<void>;
  /** Returns the per-item outcome so a partial failure can be surfaced, not swallowed. */
  handleConvertInbox: (
    ids: string[]
  ) => Promise<import('@dispatch/client').InboxConvertResponse>;
  notes: import('@dispatch/client').Note[];
  handleCreateNote: (
    input: import('@dispatch/client').CreateNoteInput
  ) => Promise<void>;
  handleUpdateNote: (
    id: string,
    patch: import('@dispatch/client').UpdateNotePatch
  ) => Promise<void>;
  handleDeleteNote: (id: string) => Promise<void>;
  handlePromoteNote: (id: string) => Promise<void>;
  /** Starts an AI draft of the task a note should become; the proposal lands on
   * `notePlanRecord`, and nothing is written until `handleConfirmNotePlan`. */
  handleEnrichNote: (id: string) => Promise<void>;
  handleConfirmNotePlan: (proposal: PlanProposal) => Promise<void>;
  notePlanId: string | null;
  setNotePlanId: (planId: string | null) => void;
  notePlanRecord: PlanRecord | undefined;
  pendingApprovals: Map<string, PendingApproval>;

  planId: string | null;
  setPlanId: (planId: string | null) => void;
  planRecord: PlanRecord | undefined;

  handleUpdate: (id: string, patch: UpdatePatch) => Promise<void>;
  moveTaskStatus: (id: string, status: string) => Promise<void>;
  handleCreate: (input: CreateInput) => Promise<void>;
  /** Natural-language single-task creation: turns a free-text description into a
   * structured `TaskDraft` (via the planner/Agent-SDK backend, constrained to one
   * task) for the caller to review and then persist with `handleCreate` — the
   * language-driven sibling of the structured `handleCreate` form. Returns the
   * draft without saving; nothing is written until `handleCreate` runs. */
  handleDraftTask: (prompt: string) => Promise<TaskDraft>;
  handleDispatch: (
    taskId: string,
    executor?: 'fake' | 'claude',
    model?: string
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
  handlePrReview: (
    runId: string,
    event: 'approve' | 'request-changes' | 'comment',
    body?: string
  ) => Promise<void>;
  handlePrComment: (runId: string, body: string) => Promise<void>;
  handleWorkEpic: (epicId: string, concurrency: number) => Promise<void>;
  handleStopEpic: (epicId: string) => Promise<void>;
  handleSubmitPrompt: (prompt: string) => Promise<string>;
  /** Post a follow-up message onto the active plan conversation. Returns the
   * 202 record (already flipped back to `running`); the assistant's reply +
   * refined proposal land via the `plan.changed` broadcast and refetch. */
  handleSendPlanMessage: (
    text: string
  ) => Promise<import('@dispatch/client').PlanRecord>;
  handleConfirmPlan: (proposal: PlanProposal) => Promise<void>;
  // Task 6: enqueue/dequeue a run in the merge queue. Both let the server's
  // 404/409 (unknown run, not terminal, already reviewed, already queued, or
  // "can't remove the actively-processing entry") propagate as a thrown
  // Error — callers surface `err.message` the same way every other mutation
  // here does, rather than swallowing it.
  handleEnqueueMerge: (runId: string) => Promise<void>;
  // Enqueues every reviewable run in a task's stack in one call — mirrors
  // handleEnqueueMerge's error-propagation shape (the server's 409 for "no
  // reviewable runs in this stack" surfaces as a thrown Error).
  handleEnqueueMergeStack: (taskId: string) => Promise<void>;
  handleDequeueMerge: (runId: string) => Promise<void>;
  /** Retries every entry held on a blocked checkout. Queue-wide, mirroring the server. */
  handleRecheckMergeQueue: () => Promise<void>;
}

/**
 * Ensures a dispatchd sidecar is running for `projectPath` and owns every query/mutation the
 * dispatch task/run/plan surfaces need — extracted from the old `TasksPanel` god-component so
 * the new Board/Tasks/Runs/Plans views (each its own top-level nav destination now, not tabs
 * inside one panel) can all read from the same live data and WS-invalidation wiring without
 * duplicating it four times. Pass `null` for `projectPath` when no project is active yet (the
 * get-started state) — every query below stays disabled and every field reads as empty/loading
 * rather than throwing.
 *
 * Every handler below is wrapped in `useCallback` with a complete, accurate dependency list —
 * not because any of them are passed to `useEffect`, but so callers (like `App.tsx`'s
 * `paletteEntries` memo) that *do* depend on them can list them honestly instead of reaching
 * for an `eslint-disable` to hide a dependency that changes identity every render.
 */
export function useDispatchProject(
  projectPath: string | null,
  { selectedRunId, onRunDispatched }: UseDispatchProjectOptions
): DispatchProjectData {
  const queryClient = useQueryClient();
  const [pendingApprovals, setPendingApprovals] = useState<
    Map<string, PendingApproval>
  >(new Map());
  const [planId, setPlanId] = useState<string | null>(null);
  // The Notes hub's own plan slot: the AI task draft started off a single note, kept apart
  // from `planId` so the two views never overwrite each other's in-flight proposal.
  const [notePlanId, setNotePlanId] = useState<string | null>(null);

  // A plan started against one project's dispatchd must never leak into another project's
  // Plans view — without this, switching projects while a plan was mid-flight (or just left
  // `ready`) would carry the old `planId` over and immediately try to `fetchPlan` it against
  // the *new* project's port, 404ing (see I5 in the phase-8 fix report).
  useEffect(() => {
    setPlanId(null);
    setNotePlanId(null);
  }, [projectPath]);

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
  const runPrQueryKey = useMemo(
    () => ['dispatch-run-pr', port, selectedRunId],
    [port, selectedRunId]
  );
  const healthQueryKey = useMemo(() => ['dispatch-health', port], [port]);
  const notesQueryKey = useMemo(() => ['dispatch-notes', port], [port]);
  const inboxQueryKey = useMemo(() => ['dispatch-inbox', port], [port]);
  const epicProgressKeyPrefix = useMemo(
    () => ['dispatch-epic-progress', port],
    [port]
  );
  const mergeQueueQueryKey = useMemo(
    () => ['dispatch-merge-queue', port],
    [port]
  );
  const repoPrsQueryKey = useMemo(() => ['dispatch-repo-prs', port], [port]);
  const branchesQueryKey = useMemo(() => ['dispatch-branches', port], [port]);

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
  // `retry: false` on both the run detail and diff queries below: `selectedRunId` comes from
  // nav state and can — for one render, e.g. mid project-switch — point at an id that belongs
  // to a different project's daemon (a stale `activeRunId` briefly surviving until
  // `navReducer`'s `selectProject` clears it). A 404 in that window should surface (or just
  // quietly go stale once the id changes again) rather than retry against a daemon that will
  // never have that run.
  const { data: runDetail } = useQuery({
    queryKey: runDetailQueryKey,
    queryFn: () => {
      if (client === null || selectedRunId === null) {
        throw new Error('no run selected');
      }
      return client.fetchRun(selectedRunId);
    },
    enabled: client !== null && selectedRunId !== null,
    retry: false,
  });
  // The diff is fetchable the moment a run has a worktree to diff, not just once it's
  // terminal — the worktree exists (and has a real merge base to diff against) from the
  // instant the run is dispatched, so a still-running run's diff is just as fetchable as a
  // finished one. `runDetail` is still required so this query only fires once we actually
  // know which run's diff to fetch.
  const diffEnabled =
    client !== null && selectedRunId !== null && runDetail !== undefined;
  // While the selected run is still going, poll the diff so it live-updates as the agent
  // writes/edits files — a terminal run's worktree/diff snapshot never changes again once
  // reviewed, so there's nothing to poll for and this stays `false` (react-query's "no
  // interval" value) to avoid a pointless timer.
  const diffRefetchInterval =
    runDetail !== undefined && !isTerminalRunState(runDetail.meta.state)
      ? 4000
      : false;
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
    refetchInterval: diffRefetchInterval,
    retry: false,
  });
  const diffError =
    diffErrorDetail instanceof Error ? diffErrorDetail.message : null;

  const { data: notes } = useQuery({
    queryKey: notesQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchNotes();
    },
    enabled: client !== null,
  });

  const { data: inbox } = useQuery({
    queryKey: inboxQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchInbox();
    },
    enabled: client !== null,
  });

  // Every dispatch worktree/branch on disk. Each row costs several `git`
  // shell-outs on the server (ahead count, merged check, dirty check), so this
  // deliberately has no `refetchInterval` — it refreshes on `run.changed` (see
  // the WS effect below) and on the view's manual refresh, which together cover
  // everything short of the user running git in their own terminal.
  const { data: branches, isLoading: branchesLoading } = useQuery({
    queryKey: branchesQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchBranches();
    },
    enabled: client !== null,
  });

  // The GitHub PR status + conversation for the selected run, once it has an
  // open PR (`prUrl` set). Separate from the diff query — the Pierre diff shows
  // the *code*, this shows the PR's review state/threads on top of it.
  const prEnabled =
    client !== null &&
    selectedRunId !== null &&
    runDetail !== undefined &&
    runDetail.meta.prUrl !== undefined;
  const {
    data: prDetail,
    isLoading: prDetailLoading,
    error: prDetailErrorDetail,
  } = useQuery({
    queryKey: runPrQueryKey,
    queryFn: () => {
      if (client === null || selectedRunId === null) {
        throw new Error('no run selected');
      }
      return client.fetchPrDetail(selectedRunId);
    },
    enabled: prEnabled,
    retry: false,
  });
  const prDetailError =
    prDetailErrorDetail instanceof Error ? prDetailErrorDetail.message : null;

  const { data: health } = useQuery({
    queryKey: healthQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchHealth();
    },
    enabled: client !== null,
  });

  const planRecord = usePlanRecord(client, port, planId);
  const notePlanRecord = usePlanRecord(client, port, notePlanId);

  // Task 6: the merge queue snapshot — same "poll on mount, refetch on the
  // matching WS event" shape as every other query here (see the
  // `merge-queue.changed` branch in the WS effect below).
  const { data: mergeQueue } = useQuery({
    queryKey: mergeQueueQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchMergeQueue();
    },
    enabled: client !== null,
  });

  // Item B: every open PR in the repo, gated on the project actually having
  // pr capability (same gate the "Open PR" action itself uses) — a project
  // with no gh/remote would just 409 on every fetch otherwise. No WS event
  // announces a repo PR appearing/closing on GitHub (unlike every other
  // query here, which the WS effect below invalidates on its own `*.changed`
  // event) — a moderate staleTime plus refetch-on-focus is an acceptable
  // "close enough" substitute for a surface that's read-only in this app.
  const { data: repoPrs } = useQuery({
    queryKey: repoPrsQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchRepoPrs();
    },
    enabled: client !== null && health?.pr === true,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
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
            // Every worktree/branch lifecycle event (dispatch, review, and the
            // branch actions themselves) broadcasts run.changed, so this is the
            // one signal the Branches surface needs.
            void queryClient.invalidateQueries({ queryKey: branchesQueryKey });
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
            // Read the run list straight from the query cache rather than this
            // effect's own `runs` variable — that variable is captured once when
            // this effect's dependency array last changed, so it would otherwise
            // go stale between reconnects and name the wrong task (or none).
            const liveRuns = queryClient.getQueryData<RunMeta[]>(runsQueryKey);
            const taskTitle =
              liveRuns?.find((r) => r.id === event.runId)?.taskTitle ??
              event.runId;
            void notify('Approval needed', `${event.toolName} — ${taskTitle}`);
          } else if (event.type === 'plan.changed') {
            void queryClient.invalidateQueries({
              queryKey: ['dispatch-plan', port, event.planId],
            });
          } else if (event.type === 'note.changed') {
            void queryClient.invalidateQueries({ queryKey: notesQueryKey });
          } else if (event.type === 'inbox.changed') {
            void queryClient.invalidateQueries({ queryKey: inboxQueryKey });
          } else if (event.type === 'merge-queue.changed') {
            void queryClient.invalidateQueries({
              queryKey: mergeQueueQueryKey,
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
    notesQueryKey,
    inboxQueryKey,
    epicProgressKeyPrefix,
    mergeQueueQueryKey,
    branchesQueryKey,
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

  const handleUpdate = useCallback(
    async (id: string, patch: UpdatePatch): Promise<void> => {
      if (client === null) return;
      await client.updateTask(id, patch);
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      void queryClient.invalidateQueries({ queryKey: readyQueryKey });
    },
    [client, queryClient, tasksQueryKey, readyQueryKey]
  );

  // Optimistic status change for the board's drag-and-drop: the card jumps to
  // the new column immediately (the whole point of direct manipulation — waiting
  // for a round-trip would feel broken), then the PATCH lands. On error the
  // snapshot is restored so the card snaps back to where it was.
  const moveTaskStatus = useCallback(
    async (id: string, status: string): Promise<void> => {
      if (client === null) return;
      const previous = queryClient.getQueryData<TaskDoc[]>(tasksQueryKey);
      queryClient.setQueryData<TaskDoc[]>(tasksQueryKey, (old) =>
        old?.map((doc) =>
          doc.meta.id === id ? { ...doc, meta: { ...doc.meta, status } } : doc
        )
      );
      try {
        await client.updateTask(id, { status });
      } catch (err) {
        if (previous !== undefined) {
          queryClient.setQueryData(tasksQueryKey, previous);
        }
        throw err;
      }
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      void queryClient.invalidateQueries({ queryKey: readyQueryKey });
    },
    [client, queryClient, tasksQueryKey, readyQueryKey]
  );

  const handleCreate = useCallback(
    async (input: CreateInput): Promise<void> => {
      if (client === null) return;
      await client.createTask(input);
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      void queryClient.invalidateQueries({ queryKey: readyQueryKey });
    },
    [client, queryClient, tasksQueryKey, readyQueryKey]
  );

  // No cache invalidation here on purpose: drafting is read-only (it only asks
  // the planner to structure the text) and persists nothing — the returned
  // draft is handed to the caller to review and then save via `handleCreate`,
  // which is where the task list actually refetches.
  const handleDraftTask = useCallback(
    async (prompt: string): Promise<TaskDraft> => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.draftTask(prompt);
    },
    [client]
  );

  const handleCreateNote = useCallback(
    async (
      input: import('@dispatch/client').CreateNoteInput
    ): Promise<void> => {
      if (client === null) return;
      await client.createNote(input);
      void queryClient.invalidateQueries({ queryKey: notesQueryKey });
    },
    [client, queryClient, notesQueryKey]
  );

  const handleUpdateNote = useCallback(
    async (
      id: string,
      patch: import('@dispatch/client').UpdateNotePatch
    ): Promise<void> => {
      if (client === null) return;
      await client.updateNote(id, patch);
      void queryClient.invalidateQueries({ queryKey: notesQueryKey });
    },
    [client, queryClient, notesQueryKey]
  );

  const handleDeleteNote = useCallback(
    async (id: string): Promise<void> => {
      if (client === null) return;
      await client.deleteNote(id);
      void queryClient.invalidateQueries({ queryKey: notesQueryKey });
    },
    [client, queryClient, notesQueryKey]
  );

  // Manual refetch for the Branches view. This surface has no polling (each row
  // costs several git shell-outs), and git state can change entirely outside the
  // app — the user's own terminal — so an explicit refresh is the only way to
  // pick that up.
  const handleRefreshBranches = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: branchesQueryKey });
  }, [queryClient, branchesQueryKey]);

  // Reclaims a branch's worktree directory, keeping the branch ref so the work
  // stays recoverable. Errors are deliberately allowed to propagate: the server
  // 409s with a specific reason (live run, open PR, stacked dependent) that the
  // Branches view surfaces verbatim rather than swallowing.
  const handleFreeBranchDisk = useCallback(
    async (branch: string): Promise<void> => {
      if (client === null) return;
      await client.freeBranchDisk(branch);
      void queryClient.invalidateQueries({ queryKey: branchesQueryKey });
    },
    [client, queryClient, branchesQueryKey]
  );

  // Deletes a branch ref and any worktree it still has. `force` is required by
  // the server for a branch whose commits never landed on its base — the one
  // action here that destroys work irreversibly. Also refetches runs, since a
  // deleted branch changes what the run list can still offer actions on.
  const handleDeleteBranch = useCallback(
    async (branch: string, opts?: { force?: boolean }): Promise<void> => {
      if (client === null) return;
      await client.deleteBranch(branch, opts);
      void queryClient.invalidateQueries({ queryKey: branchesQueryKey });
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
    },
    [client, queryClient, branchesQueryKey, runsQueryKey]
  );

  // Promoting a note into a task refetches both — the note gains its linked-task
  // marker and the new task shows up on the board.
  const handlePromoteNote = useCallback(
    async (id: string): Promise<void> => {
      if (client === null) return;
      await client.promoteNote(id);
      void queryClient.invalidateQueries({ queryKey: notesQueryKey });
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      void queryClient.invalidateQueries({ queryKey: readyQueryKey });
    },
    [client, queryClient, notesQueryKey, tasksQueryKey, readyQueryKey]
  );

  // The AI half of promoting: asks the daemon to draft the task this note should become and
  // parks the resulting plan in the notes slot, where `notePlanRecord` polls it to `ready`.
  // Nothing is written until the draft is confirmed — see `handleConfirmNotePlan`.
  const handleEnrichNote = useCallback(
    async (id: string): Promise<void> => {
      if (client === null) throw new Error('dispatchd client not ready');
      const { planId: newPlanId } = await client.enrichNote(id);
      setNotePlanId(newPlanId);
    },
    [client]
  );

  // Confirms the note draft: the same confirm endpoint the Plans view uses, so the proposal
  // is re-validated server-side before any task exists. The note itself is refetched too —
  // confirming links it to the task that was just created and ticks it done.
  const handleConfirmNotePlan = useCallback(
    async (proposal: PlanProposal): Promise<void> => {
      if (client === null || notePlanId === null) return;
      await client.confirmPlan(notePlanId, proposal);
      setNotePlanId(null);
      void queryClient.invalidateQueries({ queryKey: notesQueryKey });
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      void queryClient.invalidateQueries({ queryKey: readyQueryKey });
    },
    [
      client,
      notePlanId,
      queryClient,
      notesQueryKey,
      tasksQueryKey,
      readyQueryKey,
    ]
  );

  const handleDispatch = useCallback(
    async (
      taskId: string,
      executor?: 'fake' | 'claude',
      model?: string
    ): Promise<void> => {
      if (client === null) return;
      // A real ('claude') dispatch always carries a model — the per-dispatch override if given,
      // otherwise the user's saved default. The fake executor ignores it.
      const meta = await client.createRun(taskId, {
        executor,
        model: model ?? readDefaultModel(),
      });
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      void queryClient.invalidateQueries({ queryKey: readyQueryKey });
      onRunDispatched?.(meta.id);
    },
    [
      client,
      queryClient,
      runsQueryKey,
      tasksQueryKey,
      readyQueryKey,
      onRunDispatched,
    ]
  );

  const handleApprove = useCallback(
    async (runId: string, requestId: string, allow: boolean): Promise<void> => {
      if (client === null) return;
      await client.approveRun(runId, requestId, allow);
      setPendingApprovals((prev) => {
        const next = new Map(prev);
        next.delete(runId);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
      void queryClient.invalidateQueries({ queryKey: ['dispatch-run', port] });
    },
    [client, queryClient, runsQueryKey, port]
  );

  const handleSendMessage = useCallback(
    async (runId: string, text: string): Promise<void> => {
      if (client === null) return;
      await client.sendRunMessage(runId, text);
      void queryClient.invalidateQueries({ queryKey: ['dispatch-run', port] });
    },
    [client, queryClient, port]
  );

  const handleCancelRun = useCallback(
    async (runId: string): Promise<void> => {
      if (client === null) return;
      await client.cancelRun(runId);
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
      void queryClient.invalidateQueries({ queryKey: ['dispatch-run', port] });
    },
    [client, queryClient, runsQueryKey, port]
  );

  const handleReview = useCallback(
    async (runId: string, action: 'merge' | 'discard'): Promise<void> => {
      if (client === null) return;
      await client.reviewRun(runId, action);
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      void queryClient.invalidateQueries({ queryKey: readyQueryKey });
    },
    [client, queryClient, runsQueryKey, tasksQueryKey, readyQueryKey]
  );

  const handleRequestChanges = useCallback(
    async (runId: string, text: string): Promise<void> => {
      if (client === null) return;
      const meta = await client.sendRunMessage(runId, text, { resume: true });
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      void queryClient.invalidateQueries({ queryKey: readyQueryKey });
      // request-changes re-dispatches under a fresh run id — follow it so the caller keeps
      // showing the run that's now actually live.
      onRunDispatched?.(meta.id);
    },
    [
      client,
      queryClient,
      runsQueryKey,
      tasksQueryKey,
      readyQueryKey,
      onRunDispatched,
    ]
  );

  const handleOpenPr = useCallback(
    async (runId: string): Promise<void> => {
      if (client === null) return;
      await client.reviewRun(runId, 'pr');
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
      void queryClient.invalidateQueries({ queryKey: ['dispatch-run', port] });
    },
    [client, queryClient, runsQueryKey, port]
  );

  // Submitting a review or a comment returns the refreshed PrDetail, which we
  // write straight into the PR query's cache so the conversation/status update
  // without a second round trip.
  const handlePrReview = useCallback(
    async (
      runId: string,
      event: 'approve' | 'request-changes' | 'comment',
      body?: string
    ): Promise<void> => {
      if (client === null) return;
      const detail = await client.reviewPr(runId, event, body);
      queryClient.setQueryData(runPrQueryKey, detail);
    },
    [client, queryClient, runPrQueryKey]
  );

  const handlePrComment = useCallback(
    async (runId: string, body: string): Promise<void> => {
      if (client === null) return;
      const detail = await client.commentPr(runId, body);
      queryClient.setQueryData(runPrQueryKey, detail);
    },
    [client, queryClient, runPrQueryKey]
  );

  const handleWorkEpic = useCallback(
    async (epicId: string, concurrency: number): Promise<void> => {
      if (client === null) return;
      await client.startEpic(epicId, { concurrency });
      void queryClient.invalidateQueries({ queryKey: epicProgressKeyPrefix });
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
    },
    [client, queryClient, epicProgressKeyPrefix, runsQueryKey]
  );

  const handleStopEpic = useCallback(
    async (epicId: string): Promise<void> => {
      if (client === null) return;
      await client.stopEpic(epicId);
      void queryClient.invalidateQueries({ queryKey: epicProgressKeyPrefix });
    },
    [client, queryClient, epicProgressKeyPrefix]
  );

  // Returns the new plan's id so PlansView can add it to its local session history
  // immediately, without waiting on a refetch.
  const handleSubmitPrompt = useCallback(
    async (prompt: string): Promise<string> => {
      if (client === null) throw new Error('dispatchd client not ready');
      const { planId: newPlanId } = await client.startPlan(prompt);
      setPlanId(newPlanId);
      return newPlanId;
    },
    [client]
  );

  // Refine the active plan across turns: post the follow-up, then seed the plan query with
  // the 202's record — already carrying the user's message and back in `running` — so the
  // thread shows the turn the instant it's accepted instead of after a round trip. The
  // invalidate right after re-syncs with the server (and restarts the `running` poll), and
  // the assistant's reply arrives via `plan.changed` the same way the opening turn does.
  const handleSendPlanMessage = useCallback(
    async (text: string): Promise<import('@dispatch/client').PlanRecord> => {
      if (client === null || planId === null) {
        throw new Error('no plan in progress');
      }
      const record = await client.sendPlanMessage(planId, text);
      // usePlanRecord keys the plan query as ['dispatch-plan', port, planId]
      // (see the helper above). Seed that key with the 202's record first so the
      // thread shows the user's turn immediately — which is what the comment
      // above promises — then invalidate to re-sync and restart the `running`
      // poll. The incoming side used a `planQueryKey` local that no longer
      // exists here, so this keeps its optimistic behaviour on main's key form.
      const planKey = ['dispatch-plan', port, planId];
      queryClient.setQueryData(planKey, record);
      void queryClient.invalidateQueries({ queryKey: planKey });
      return record;
    },
    [client, planId, queryClient, port]
  );

  const handleConfirmPlan = useCallback(
    async (proposal: PlanProposal): Promise<void> => {
      if (client === null || planId === null) return;
      await client.confirmPlan(planId, proposal);
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      void queryClient.invalidateQueries({ queryKey: readyQueryKey });
    },
    [client, planId, queryClient, tasksQueryKey, readyQueryKey]
  );

  // Task 6: enqueue a terminal, unreviewed run into the merge queue. The
  // server 409s (unknown run, non-terminal, already reviewed, already
  // queued) surface to the caller as a thrown Error with the server's own
  // message — callers (RunReviewView) catch it and render it inline, the
  // same pattern every other review action here already uses. The queue
  // itself also broadcasts `merge-queue.changed` once the entry lands, so
  // the invalidation here is just for the immediate optimistic refetch
  // rather than the only way this query ever updates.
  const handleEnqueueMerge = useCallback(
    async (runId: string): Promise<void> => {
      if (client === null) return;
      await client.enqueueMergeQueue(runId);
      void queryClient.invalidateQueries({ queryKey: mergeQueueQueryKey });
    },
    [client, queryClient, mergeQueueQueryKey]
  );

  // Enqueues an entire stack's worth of reviewable runs in one call — see
  // MergeQueue.enqueueStack's own comment for why the server enqueues them
  // in dependency order. Same error-propagation shape as handleEnqueueMerge:
  // the server's 409 (nothing reviewable in the stack) surfaces as a thrown
  // Error for the caller to render inline.
  const handleEnqueueMergeStack = useCallback(
    async (taskId: string): Promise<void> => {
      if (client === null) return;
      await client.enqueueMergeStack(taskId);
      void queryClient.invalidateQueries({ queryKey: mergeQueueQueryKey });
    },
    [client, queryClient, mergeQueueQueryKey]
  );

  const handleDequeueMerge = useCallback(
    async (runId: string): Promise<void> => {
      if (client === null) return;
      await client.removeFromMergeQueue(runId);
      void queryClient.invalidateQueries({ queryKey: mergeQueueQueryKey });
    },
    [client, queryClient, mergeQueueQueryKey]
  );

  // Retries every entry the queue is holding on a `blocked-environment` (a dirty checkout, a
  // staged index, the wrong branch). Deliberately queue-wide rather than per-entry, because the
  // server's endpoint is: the block is a property of the shared checkout, not of one entry, so
  // one fix unblocks all of them at once.
  const invalidateInbox = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: inboxQueryKey });
  }, [queryClient, inboxQueryKey]);

  const handleCaptureInbox = useCallback(
    async (text: string): Promise<void> => {
      if (client === null) return;
      await client.addInbox({ text });
      invalidateInbox();
    },
    [client, invalidateInbox]
  );

  const handleUpdateInboxItem = useCallback(
    async (
      id: string,
      patch: { kind?: import('@dispatch/client').InboxKind; text?: string }
    ): Promise<void> => {
      if (client === null) return;
      await client.updateInbox(id, patch);
      invalidateInbox();
    },
    [client, invalidateInbox]
  );

  const handleDismissInbox = useCallback(
    async (ids: string[]): Promise<void> => {
      if (client === null || ids.length === 0) return;
      await client.dismissInbox(ids);
      invalidateInbox();
    },
    [client, invalidateInbox]
  );

  const handleConvertInbox = useCallback(
    async (ids: string[]) => {
      if (client === null) return { results: [], converted: 0, failed: 0 };
      const res = await client.convertInbox(ids);
      invalidateInbox();
      // Converting writes tasks too, so the task list has to refetch or the new tasks only
      // appear on the next poll.
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      return res;
    },
    [client, invalidateInbox, queryClient, tasksQueryKey]
  );

  const handleRecheckMergeQueue = useCallback(async (): Promise<void> => {
    if (client === null) return;
    await client.recheckMergeQueue();
    void queryClient.invalidateQueries({ queryKey: mergeQueueQueryKey });
  }, [client, queryClient, mergeQueueQueryKey]);

  // Notifies on run finished/failed and merge-queue merged/failed transitions —
  // see useTransitionNotifications's own comment for why it needs the *lists*
  // (not just this render's counts) to diff against what it last saw. `projectPath`
  // is threaded through so a project switch resets its tracking (see
  // resetTrackingForRoot) instead of diffing the new project against the old one's
  // leftover state — this hook's `projectPath` argument swaps in place rather than
  // remounting on a project switch.
  useTransitionNotifications(projectPath, runs ?? [], mergeQueue ?? null);

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
    mergeQueue: mergeQueue ?? null,
    repoPrs: repoPrs ?? null,

    runDetail,
    diff,
    diffLoading,
    diffError,
    prDetail,
    prDetailLoading,
    prDetailError,
    branches: branches ?? [],
    branchesLoading,
    handleRefreshBranches,
    handleFreeBranchDisk,
    handleDeleteBranch,
    notes: notes ?? [],
    handleCreateNote,
    handleUpdateNote,
    handleDeleteNote,
    handlePromoteNote,
    handleEnrichNote,
    handleConfirmNotePlan,
    notePlanId,
    setNotePlanId,
    notePlanRecord,
    pendingApprovals,

    planId,
    setPlanId,
    planRecord,

    handleUpdate,
    moveTaskStatus,
    handleCreate,
    handleDraftTask,
    handleDispatch,
    handleApprove,
    handleSendMessage,
    handleCancelRun,
    handleReview,
    handleRequestChanges,
    handleOpenPr,
    handlePrReview,
    handlePrComment,
    handleWorkEpic,
    handleStopEpic,
    handleSubmitPrompt,
    handleSendPlanMessage,
    handleConfirmPlan,
    handleEnqueueMerge,
    handleEnqueueMergeStack,
    handleDequeueMerge,
    handleRecheckMergeQueue,
    inbox: inbox ?? [],
    handleCaptureInbox,
    handleUpdateInboxItem,
    handleDismissInbox,
    handleConvertInbox,
  };
}
