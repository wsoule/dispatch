import type {
  ApiClient,
  DraftRecord,
  EpicProgress,
  MergeQueueSnapshot,
  PlanProposal,
  PlanRecord,
  RepoPr,
  RunDetail,
  RunMeta,
  RunState,
} from '@dispatch/client';
import { createApiClient } from '@dispatch/client';
import type {
  CreateInput,
  DispatchConfig,
  ModelConfig,
  TaskDoc,
  UpdatePatch,
} from '@dispatch/core';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { hideArchivedRuns } from '../lib/archiveFilter';
import type { InboxEntryDraft, InboxState } from '../lib/inbox';
import { addEntries, loadInbox, markAllRead, saveInbox } from '../lib/inbox';
import { resolveExecuteModel } from '../lib/models';
import { notify } from '../lib/notifications';
import { isTerminalRunState } from '../lib/runState';
import { computeBlockedIds } from '../lib/taskGraph';
import { ensureDispatchd } from '../lib/tauri';
import { useTransitionNotifications } from './useTransitionNotifications';

// One entry per pending approval this window has seen live via the `approval.requested` WS
// event — the REST API has no way to hand back a paused run's requestId on a plain refetch,
// only the live event carries it (see the WS effect below).
type PendingApproval = { requestId: string; toolName: string };

// Persists the Board/List/Runs "show archived" toggle across restarts — mirrors BoardView's
// own `dispatch:tasks-view-mode` persistence. Guarded for `window` for the same reason (this
// is a Tauri/browser-only app, never SSR'd, but a stray server-side render of this module
// shouldn't throw on a missing `localStorage`).
const SHOW_ARCHIVED_STORAGE_KEY = 'dispatch:show-archived';

function readStoredShowArchived(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(SHOW_ARCHIVED_STORAGE_KEY) === '1';
}

// Loads a project's persisted notification inbox — empty (not a throw) when there's no
// active project yet or this module somehow renders outside a browser/Tauri window.
function readStoredInbox(root: string | null): InboxState {
  if (root === null || typeof window === 'undefined') return { entries: [] };
  return loadInbox(root, window.localStorage);
}

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
  // Task 8 fix: the same task list as `tasks`, but including archived tasks
  // (`fetchTasks({ archived: true })`) — feed this, not `tasks`, to
  // countMergeReady, or an archived done own-task/blocker will be missing
  // from its lookup entirely. No other consumer here should use this; every
  // other surface wants the default board-view (archived-excluded) `tasks`.
  tasksIncludingArchived: TaskDoc[];
  // Task 9: just the archived subset of `tasksIncludingArchived` (`archivedAt !== undefined`)
  // — feeds the Board/List "Archived (N)" toggle chip and its muted group/column rendering.
  archivedTasks: TaskDoc[];
  // Task 9: whether archived tasks/runs are currently shown — persisted to localStorage.
  // Neither `runs` nor `tasks`/`tasksIncludingArchived` are filtered by this (callers combine
  // `tasks` with `archivedTasks` themselves when it's on, e.g. BoardView's column grouping) —
  // see `visibleRuns` below for the one field that *is* filtered by it.
  showArchived: boolean;
  setShowArchived: (value: boolean) => void;
  config: DispatchConfig | null;
  // The full, unfiltered run list — archivedAt is orthogonal to a task's status (an archived
  // task need not be done/cancelled), so every eligibility computation here (countMergeReady,
  // the merge queue) MUST keep reading this rather than `visibleRuns`, or a still-mergeable
  // run would silently stop being offered the moment its task is archived. Only the Runs
  // view's own run-*list* rendering should read `visibleRuns` instead.
  runs: RunMeta[];
  // Task 9: `runs` filtered to hide archived-task runs, unless `showArchived` is on — feeds
  // only the Runs view's run-list UI (which run rows show up on the left). Every other
  // consumer of run data (countMergeReady, liveRunStateByTaskId, latestRunByTaskId, the merge
  // queue) reads the unfiltered `runs` above on purpose.
  visibleRuns: RunMeta[];
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
  /**
   * Starts an AI draft that adds the detail a one-line capture is missing. Its own slot,
   * `inboxEnrich` — kept apart from `enrichPlan` (a task's own draft) and `notePlanId` (the
   * unbuilt note-promotion feature's slot) so none of the three can clobber another's in-flight
   * draft. The proposal lands on `inboxEnrichPlanRecord` for that row to review; nothing is
   * written until `handleApplyInboxEnrich`.
   */
  handleEnrichInboxItem: (id: string) => Promise<void>;
  /** Which inbox item the open draft belongs to, so another row doesn't show it. */
  inboxEnrichItemId: string | null;
  inboxEnrichPlanRecord: PlanRecord | undefined;
  /** Drops the open draft without writing anything — Dismiss, and the cleanup after Apply. */
  handleDismissInboxEnrich: () => void;
  /** Writes the drafted body back onto the inbox item via the ordinary PATCH /api/inbox/:id
   * update path, then drops the draft. */
  handleApplyInboxEnrich: (itemId: string, text: string) => Promise<void>;
  /**
   * Starts an AI draft that adds the context an under-specified task is missing. Its own slot,
   * not the note one: the detail dialog reviews `enrichPlanRecord` and patches the drafted
   * sections onto `enrichTaskId`, rather than confirming them into a second task.
   */
  handleEnrichTask: (taskId: string) => Promise<void>;
  /** Which task the open draft belongs to, so another task's dialog doesn't show it. */
  enrichTaskId: string | null;
  enrichPlanRecord: PlanRecord | undefined;
  /** Drops the open draft — Discard, and the cleanup after it's been applied. */
  handleDismissEnrich: () => void;
  /** Model-backed grouping of related captures, run automatically in the background by
   * BrainDumpView. Always resolves — `error` carries a failed/timed-out model call rather than
   * throwing, so a background pass never surfaces as a hard failure. */
  handleClusterInbox: () => Promise<{
    groups: import('@dispatch/client').InboxClusterGroup[];
    error: string | null;
  }>;

  /** Line-level review comments on the selected run's diff. */
  reviewComments: import('@dispatch/client').ReviewComment[];
  handleAddReviewComment: (input: {
    file: string;
    line: number;
    startLine?: number;
    anchorText: string;
    body: string;
  }) => Promise<void>;
  /** Submits the staged review: publishes its comments, then acts on the verdict. */
  handleSubmitReview: (
    verdict: import('@dispatch/client').ReviewVerdict,
    body: string
  ) => Promise<{ published: number; error?: string }>;
  handleResolveReviewComment: (
    commentId: string,
    resolved: boolean
  ) => Promise<void>;
  handleReplyReviewComment: (commentId: string, body: string) => Promise<void>;
  /** Resumes the agent on the same branch with the note and every unresolved thread. */
  handleSendBack: (note: string) => Promise<void>;
  /** Writes the settings a person may change back to .dispatch/config.yml. */
  handleUpdateConfig: (patch: {
    verifyCommand?: string | null;
    autoCommit?: boolean;
    epicConcurrency?: number;
    verifyTimeoutSec?: number;
    permissionMode?: string;
    models?: Partial<ModelConfig>;
  }) => Promise<void>;
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
  /** Starts a background single-task draft; caller polls `client.fetchDraft`
   * for it to settle, then reviews and persists it with `handleCreate`. */
  handleDraftTask: (prompt: string) => Promise<DraftRecord>;
  handleDispatch: (
    taskId: string,
    executor?: 'fake' | 'claude',
    model?: string
  ) => Promise<void>;
  handleApprove: (
    runId: string,
    requestId: string,
    allow: boolean,
    opts?: { scope?: 'once' | 'session'; reason?: string }
  ) => Promise<void>;
  handleSendMessage: (runId: string, text: string) => Promise<void>;
  handleCancelRun: (runId: string) => Promise<void>;
  /** Hides a run from the Runs list, or brings it back. Nothing is deleted. */
  handleArchiveRun: (runId: string, archived: boolean) => Promise<void>;
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
  // Task 8: enqueues every eligible run across the project in one shot (the
  // "Merge all ready" toolbar action) — thin wrapper over enqueueMergeReady,
  // since the server owns the actual eligibility/ordering logic.
  handleMergeAllReady: () => Promise<void>;
  /** Retries every entry held on a blocked checkout. Queue-wide, mirroring the server. */
  handleRecheckMergeQueue: () => Promise<void>;
  // Set from the `queue.drained` WS event when the queue's auto-push after a
  // drain fails (merged locally, origin didn't get the commit) — surfaced as
  // a banner in RunsView. Cleared on the next successful drain-push.
  lastPushError: string | null;

  // Task 10: the persisted notification inbox — the recoverable record behind every
  // transient run/queue toast `useTransitionNotifications` fires (see inbox.ts). Named
  // `notificationInbox` to stay distinct from the brain-dump `inbox` above. Loaded
  // per-project and re-saved on every change so it survives a restart/project switch.
  notificationInbox: InboxState;
  // Marks every notification entry read — called once when the panel opens, not per-entry.
  markNotificationInboxRead: () => void;
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
  // The "Add detail" slot, carrying the task it was started from. Separate from `notePlanId`
  // because those proposals get confirmed into new tasks and these get patched onto one.
  const [enrichPlan, setEnrichPlan] = useState<{
    taskId: string;
    planId: string;
  } | null>(null);
  // The brain dump row's "Add detail" slot — carries the inbox item it was started from, same
  // shape as `enrichPlan` and for the same reason: its proposal gets written back onto that
  // item (via PATCH /api/inbox/:id), not confirmed into a second task, so it can't share
  // `notePlanId` (the unbuilt note-promotion feature's slot) or `enrichPlan` (a task's own).
  const [inboxEnrich, setInboxEnrich] = useState<{
    itemId: string;
    planId: string;
  } | null>(null);
  // Task 8: last drain-push failure reported by `queue.drained`, for the
  // RunsView banner — `null` once a later drain pushes successfully.
  const [lastPushError, setLastPushError] = useState<string | null>(null);
  // Task 9: the Board/List/Runs "show archived" toggle — read from localStorage once on
  // mount, then kept in sync with every write via `setShowArchived` below.
  const [showArchived, setShowArchivedState] = useState<boolean>(
    readStoredShowArchived
  );
  const setShowArchived = useCallback((value: boolean) => {
    setShowArchivedState(value);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SHOW_ARCHIVED_STORAGE_KEY, value ? '1' : '0');
    }
  }, []);

  // Task 10: the notification inbox — one per project root, loaded lazily on mount and
  // reloaded whenever the active project switches (this hook's `projectPath` swaps in place
  // rather than remounting on a project switch, same as `planId` below).
  const [notificationInbox, setNotificationInboxState] = useState<InboxState>(
    () => readStoredInbox(projectPath)
  );
  useEffect(() => {
    setNotificationInboxState(readStoredInbox(projectPath));
  }, [projectPath]);

  // Applies `updater` to the notification inbox and persists the result under the current
  // project's storage key in the same step, so every mutation (a new transition recorded, or
  // markAllRead) survives a restart without a separate "save" call site.
  const updateNotificationInbox = useCallback(
    (updater: (prev: InboxState) => InboxState) => {
      setNotificationInboxState((prev) => {
        const next = updater(prev);
        if (projectPath !== null && typeof window !== 'undefined') {
          saveInbox(projectPath, next, window.localStorage);
        }
        return next;
      });
    },
    [projectPath]
  );

  // Handed to useTransitionNotifications below as its `onRecord` callback — appends every
  // batch of run/queue transitions it detects onto the persisted inbox as new unread entries.
  const onRecordInbox = useCallback(
    (adds: InboxEntryDraft[]) => {
      updateNotificationInbox((prev) => addEntries(prev, adds));
    },
    [updateNotificationInbox]
  );

  // Marks the whole notification inbox read in one step — fired once when the panel opens
  // (see App.tsx), not per-entry.
  const markNotificationInboxRead = useCallback(() => {
    updateNotificationInbox((prev) => markAllRead(prev));
  }, [updateNotificationInbox]);

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
  // The drafts list (`GET /api/tasks/drafts`) query key, invalidated below
  // on `draft.changed`.
  const draftsQueryKey = useMemo(() => ['dispatch-drafts', port], [port]);
  const reviewQueryKey = useMemo(
    () => ['dispatch-review', port, selectedRunId],
    [port, selectedRunId]
  );
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
  // Task 8 fix: a *separate* archived-inclusive tasks query, used only for
  // countMergeReady's own-task/blocker lookups — `tasks` below stays the
  // default board-view (archived-excluded) list every other consumer here
  // relies on. Without this, an archived done own-task or blocker would be
  // missing from countMergeReady's lookup map entirely and read as
  // "not done", wrongly inflating the "Merge all ready" count.
  const allTasksQueryKey = useMemo(() => ['dispatch-tasks-all', port], [port]);

  const { data: tasks, isLoading: tasksLoading } = useQuery({
    queryKey: tasksQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchTasks();
    },
    enabled: client !== null,
  });
  const { data: allTasksIncludingArchived } = useQuery({
    queryKey: allTasksQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchTasks({ archived: true });
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

  const { data: reviewComments } = useQuery({
    queryKey: reviewQueryKey,
    queryFn: () => {
      if (client === null || selectedRunId === null) {
        throw new Error('no run selected');
      }
      return client.fetchReviewComments(selectedRunId);
    },
    enabled: client !== null && selectedRunId !== null,
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
  const enrichPlanRecord = usePlanRecord(
    client,
    port,
    enrichPlan?.planId ?? null
  );
  const inboxEnrichPlanRecord = usePlanRecord(
    client,
    port,
    inboxEnrich?.planId ?? null
  );

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

  // Task 9: the archived subset of the archived-inclusive query — derived here (rather than a
  // second `fetchTasks({ archived: true })` call) since `allTasksIncludingArchived` already
  // carries every archived task Task 8 needed for countMergeReady's lookups.
  const archivedTasks = useMemo(
    () =>
      (allTasksIncludingArchived ?? []).filter(
        (t) => t.meta.archivedAt !== undefined
      ),
    [allTasksIncludingArchived]
  );
  const archivedTaskIds = useMemo(
    () => new Set(archivedTasks.map((t) => t.meta.id)),
    [archivedTasks]
  );
  // The Runs list, filtered to hide archived tasks' runs unless the toggle is on — every other
  // consumer of the raw `runs` query data below (liveRunStateByTaskId, latestRunByTaskId, the
  // WS notification effect) stays unfiltered on purpose, since those key off task ids that are
  // only ever looked up for tasks actually being rendered.
  const visibleRuns = useMemo(
    () =>
      showArchived
        ? (runs ?? [])
        : hideArchivedRuns(runs ?? [], archivedTaskIds),
    [runs, archivedTaskIds, showArchived]
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
        void queryClient.invalidateQueries({ queryKey: allTasksQueryKey });
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
          } else if (event.type === 'draft.changed') {
            void queryClient.invalidateQueries({ queryKey: draftsQueryKey });
          } else if (event.type === 'review.changed') {
            void queryClient.invalidateQueries({ queryKey: reviewQueryKey });
          } else if (event.type === 'inbox.changed') {
            void queryClient.invalidateQueries({ queryKey: inboxQueryKey });
          } else if (event.type === 'merge-queue.changed') {
            void queryClient.invalidateQueries({
              queryKey: mergeQueueQueryKey,
            });
          } else if (event.type === 'queue.drained') {
            // The drain reviewed runs (tasks/runs move to done) and may have
            // pushed origin (branches' pushedToOrigin flips) — refetch all
            // four rather than waiting on their own *.changed broadcasts.
            void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
            void queryClient.invalidateQueries({ queryKey: allTasksQueryKey });
            void queryClient.invalidateQueries({ queryKey: runsQueryKey });
            void queryClient.invalidateQueries({
              queryKey: mergeQueueQueryKey,
            });
            // pushedToOrigin flips on every merged branch too — Branches needs
            // its own refetch, same as run.changed's invalidation above.
            void queryClient.invalidateQueries({ queryKey: branchesQueryKey });
            // Per-run "Merged" toasts already come from
            // useTransitionNotifications' own merge-queue diff — this event
            // only needs to report the *push* outcome, not repeat that a
            // merge happened. Both outcomes below also go through
            // onRecordInbox, not just `notify`: this is the exact event
            // class the inbox exists for — `lastPushError`'s RunsView banner
            // clears on the next drain, but without an inbox row a failed
            // auto-push would otherwise leave no trace at all once that
            // banner is gone.
            if (event.pushError !== undefined) {
              setLastPushError(event.pushError);
              void notify('Push failed', event.pushError);
              onRecordInbox([
                {
                  ts: new Date().toISOString(),
                  title: 'Push failed',
                  body: event.pushError,
                  target: { kind: 'runs-page' },
                },
              ]);
            } else if (event.pushed && event.merged === 0) {
              // A retry-only drain: nothing new merged this pass, just a
              // previously-failed push that finally landed. Recording it in
              // the inbox is still worthwhile (the earlier failure got a row
              // too), but "0 merge(s) now on origin" would misread as if
              // nothing happened at all — so no toast here.
              setLastPushError(null);
              onRecordInbox([
                {
                  ts: new Date().toISOString(),
                  title: 'Push retry succeeded',
                  body: 'Origin is now up to date.',
                  target: { kind: 'runs-page' },
                },
              ]);
            } else if (event.pushed) {
              setLastPushError(null);
              const body = `${event.merged} merge(s) now on origin`;
              void notify('Pushed to origin', body);
              onRecordInbox([
                {
                  ts: new Date().toISOString(),
                  title: 'Pushed to origin',
                  body,
                  target: { kind: 'runs-page' },
                },
              ]);
            } else {
              // Merged locally with nothing to push to (no origin remote
              // configured) — not a failure, so no toast, no banner, and no
              // inbox row either.
              setLastPushError(null);
            }
          }
        },
      }
    );
  }, [
    client,
    queryClient,
    tasksQueryKey,
    allTasksQueryKey,
    configQueryKey,
    readyQueryKey,
    runsQueryKey,
    notesQueryKey,
    draftsQueryKey,
    inboxQueryKey,
    reviewQueryKey,
    epicProgressKeyPrefix,
    mergeQueueQueryKey,
    branchesQueryKey,
    port,
    onRecordInbox,
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
      // Task 9: an archived task is read-only — gated here (not just at the drag-and-drop
      // call site) so every path that can move a task's status, board drag or the inline
      // status picker alike, is covered by one check rather than each caller remembering it.
      if (archivedTaskIds.has(id)) return;
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
    [client, queryClient, tasksQueryKey, readyQueryKey, archivedTaskIds]
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

  // No task-list invalidation here — drafting persists nothing; the task
  // list refetches from `handleCreate` once the reviewed draft is saved.
  const handleDraftTask = useCallback(
    async (prompt: string): Promise<DraftRecord> => {
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
      // otherwise the user's stored localStorage override layered over the project's configured
      // `models.execute` (see lib/models.ts's resolveExecuteModel). The fake executor ignores it.
      const meta = await client.createRun(taskId, {
        executor,
        model: model ?? resolveExecuteModel(config),
      });
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      void queryClient.invalidateQueries({ queryKey: readyQueryKey });
      onRunDispatched?.(meta.id);
    },
    [
      client,
      config,
      queryClient,
      runsQueryKey,
      tasksQueryKey,
      readyQueryKey,
      onRunDispatched,
    ]
  );

  const handleApprove = useCallback(
    async (
      runId: string,
      requestId: string,
      allow: boolean,
      opts?: { scope?: 'once' | 'session'; reason?: string }
    ): Promise<void> => {
      if (client === null) return;
      await client.approveRun(runId, requestId, allow, opts);
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

  const handleArchiveRun = useCallback(
    async (runId: string, archived: boolean): Promise<void> => {
      if (client === null) return;
      await client.setRunArchived(runId, archived);
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

  // Task 8: the "Merge all ready" toolbar action — enqueues every eligible
  // run in the project in one call. Also doubles as the push-failure Retry
  // button: called with nothing new to enqueue, this still kicks the queue's
  // pump, which retries a failed drain-push per `lastDrainPushFailed` on the
  // server (see mergeQueue.ts). The `merge-queue.changed`/`queue.drained`
  // broadcasts (not this invalidation) are what actually update the
  // lastPushError banner once the retry resolves.
  const handleMergeAllReady = useCallback(async (): Promise<void> => {
    if (client === null) return;
    await client.enqueueMergeReady();
    void queryClient.invalidateQueries({ queryKey: mergeQueueQueryKey });
  }, [client, queryClient, mergeQueueQueryKey]);

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

  // The AI half of "Add detail" on a brain dump row: the proposal lands on
  // `inboxEnrichPlanRecord` for that row to review inline, and nothing is written until
  // `handleApplyInboxEnrich` patches it onto the item.
  const handleEnrichInboxItem = useCallback(
    async (id: string): Promise<void> => {
      if (client === null) throw new Error('dispatchd client not ready');
      // Clear first, or the previous pass's draft stays up while this one runs.
      setInboxEnrich(null);
      const { planId } = await client.enrichInbox(id);
      setInboxEnrich({ itemId: id, planId });
    },
    [client]
  );

  const handleDismissInboxEnrich = useCallback((): void => {
    setInboxEnrich(null);
  }, []);

  // Writes the drafted body back onto the inbox item through the ordinary update path (the same
  // PATCH /api/inbox/:id route the row's other edits use), then drops the draft.
  const handleApplyInboxEnrich = useCallback(
    async (itemId: string, text: string): Promise<void> => {
      if (client === null) return;
      await client.updateInbox(itemId, { text });
      invalidateInbox();
      setInboxEnrich(null);
    },
    [client, invalidateInbox]
  );

  // The AI half of specifying an existing task: the proposal lands on `enrichPlanRecord` for
  // the detail dialog to review, and nothing is written until someone accepts it there.
  const handleEnrichTask = useCallback(
    async (taskId: string): Promise<void> => {
      if (client === null) throw new Error('dispatchd client not ready');
      // Clear first, or the previous pass's draft stays up while this one runs.
      setEnrichPlan(null);
      const { planId } = await client.enrichTask(taskId);
      setEnrichPlan({ taskId, planId });
    },
    [client]
  );

  const handleDismissEnrich = useCallback((): void => {
    setEnrichPlan(null);
  }, []);

  const invalidateReview = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: reviewQueryKey });
  }, [queryClient, reviewQueryKey]);

  const handleAddReviewComment = useCallback(
    async (input: {
      file: string;
      line: number;
      startLine?: number;
      anchorText: string;
      body: string;
    }): Promise<void> => {
      if (client === null || selectedRunId === null) return;
      await client.addReviewComment(selectedRunId, input);
      invalidateReview();
    },
    [client, selectedRunId, invalidateReview]
  );

  const handleResolveReviewComment = useCallback(
    async (commentId: string, resolved: boolean): Promise<void> => {
      if (client === null || selectedRunId === null) return;
      await client.resolveReviewComment(selectedRunId, commentId, resolved);
      invalidateReview();
    },
    [client, selectedRunId, invalidateReview]
  );

  const handleReplyReviewComment = useCallback(
    async (commentId: string, body: string): Promise<void> => {
      if (client === null || selectedRunId === null) return;
      await client.replyReviewComment(selectedRunId, commentId, body);
      invalidateReview();
    },
    [client, selectedRunId, invalidateReview]
  );

  const handleSubmitReview = useCallback(
    async (
      verdict: import('@dispatch/client').ReviewVerdict,
      body: string
    ): Promise<{ published: number; error?: string }> => {
      if (client === null || selectedRunId === null) return { published: 0 };
      const res = await client.submitReview(selectedRunId, verdict, body);
      invalidateReview();
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
      void queryClient.invalidateQueries({ queryKey: mergeQueueQueryKey });
      return { published: res.published, error: res.error };
    },
    [
      client,
      selectedRunId,
      invalidateReview,
      queryClient,
      runsQueryKey,
      mergeQueueQueryKey,
    ]
  );

  const handleSendBack = useCallback(
    async (note: string): Promise<void> => {
      if (client === null || selectedRunId === null) return;
      await client.sendBackRun(selectedRunId, note);
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
      invalidateReview();
    },
    [client, selectedRunId, queryClient, runsQueryKey, invalidateReview]
  );

  const handleUpdateConfig = useCallback(
    async (patch: {
      verifyCommand?: string | null;
      autoCommit?: boolean;
      epicConcurrency?: number;
      verifyTimeoutSec?: number;
      permissionMode?: string;
      models?: Partial<ModelConfig>;
    }): Promise<void> => {
      if (client === null) return;
      await client.updateConfig(patch);
      void queryClient.invalidateQueries({ queryKey: configQueryKey });
    },
    [client, queryClient, configQueryKey]
  );

  const handleClusterInbox = useCallback(async () => {
    if (client === null) return { groups: [], error: null };
    return await client.clusterInbox();
  }, [client]);

  // Retries every entry the queue is holding on a `blocked-environment` (a dirty checkout, a
  // staged index, the wrong branch). Deliberately queue-wide rather than per-entry, because the
  // server's endpoint is: the block is a property of the shared checkout, not of one entry, so
  // one fix unblocks all of them at once.
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
  useTransitionNotifications(
    projectPath,
    runs ?? [],
    mergeQueue ?? null,
    onRecordInbox
  );

  return {
    client,
    portLoading,
    portError,
    portErrorDetail,
    retryEnsureDispatchd: () => void retryEnsureDispatchd(),

    tasks: tasks ?? [],
    tasksLoading,
    tasksIncludingArchived: allTasksIncludingArchived ?? [],
    archivedTasks,
    showArchived,
    setShowArchived,
    config: config ?? null,
    runs: runs ?? [],
    visibleRuns,
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
    handleArchiveRun,
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
    handleMergeAllReady,
    handleRecheckMergeQueue,
    lastPushError,

    notificationInbox,
    markNotificationInboxRead,

    inbox: inbox ?? [],
    handleCaptureInbox,
    handleUpdateInboxItem,
    handleDismissInbox,
    handleConvertInbox,
    handleEnrichInboxItem,
    inboxEnrichItemId: inboxEnrich?.itemId ?? null,
    inboxEnrichPlanRecord,
    handleDismissInboxEnrich,
    handleApplyInboxEnrich,
    handleEnrichTask,
    enrichTaskId: enrichPlan?.taskId ?? null,
    enrichPlanRecord,
    handleDismissEnrich,
    handleClusterInbox,
    reviewComments: reviewComments ?? [],
    handleAddReviewComment,
    handleResolveReviewComment,
    handleReplyReviewComment,
    handleSendBack,
    handleSubmitReview,
    handleUpdateConfig,
  };
}
