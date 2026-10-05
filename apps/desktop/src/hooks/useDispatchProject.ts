import type {
  AgentSessionMeta,
  AgentSummary,
  ApiClient,
  AuthTier,
  ConfirmResult,
  DraftRecord,
  EpicProgress,
  ExecutorsResponse,
  FixLoopState,
  HealthPayload,
  LandingSnapshot,
  LinearIssueLink,
  LinearStatus,
  LinearSyncSummary,
  LinearTeam,
  LinearViewer,
  MergeQueueSnapshot,
  Message,
  PlanProposal,
  PlanRecord,
  PresenceEntry,
  ReadinessReading,
  RepoPr,
  ReviewComment,
  RunDetail,
  RunMeta,
  RunState,
  SyncStatus,
} from '@dispatch/client';
import { ApiError, createApiClient } from '@dispatch/client';
import type {
  CreateInput,
  DispatchConfig,
  EffortLevel,
  EscalationStep,
  ModelConfig,
  NotificationKind,
  Person,
  PolicyGate,
  PolicyGateMode,
  StatusRoles,
  TaskDoc,
  TaskListItem,
  UpdatePatch,
} from '@dispatch/core/browser';
import {
  isContainer,
  isUnstartedStatus,
  parentIdsOf,
  readyTasks,
  statusModelOf,
} from '@dispatch/core/browser';
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  agentRosterKey,
  mayChangeAgentRoster,
  mutedAddresses,
} from '../lib/agentRoster';
import { hideArchivedRuns } from '../lib/archiveFilter';
import {
  configChangedQueryKeys,
  dispatchConfigKey,
  linearStatusKey,
  peopleKey,
  syncStatusKey,
} from '../lib/configEvents';
import type {
  DaemonConnection,
  DecideAvailability,
  MessageAccess,
} from '../lib/daemonAuth';
import {
  assertCanDecide,
  assertCanMessage,
  credentialTier,
  daemonBaseUrl,
  decideAvailability,
  messageAccess,
  resolveDaemonAuth,
} from '../lib/daemonAuth';
import type { DecisionItem } from '../lib/decisionFeed';
import { fetchDecisions, isDecisionsChanged } from '../lib/decisionFeed';
import { isFakeExecutorDevToolEnabled } from '../lib/devTools';
import type { WorkEpicOptions } from '../lib/epicSession';
import { epicPausedNotice } from '../lib/epicSession';
import { fixLoopCappedNotice } from '../lib/fixLoopStatus';
import type { RunQuestion, RunScopeRequest } from '../lib/gates';
import {
  approvalReply,
  findToolApprovalGate,
  foldsIntoOpenApproval,
  gateNotification,
  openGatesAfter,
  openGatesKey,
  questionsByRun,
  runsAskingMe,
  scopeRequestsByRun,
} from '../lib/gates';
import type { InboxEntryDraft, InboxState } from '../lib/inbox';
import {
  addEntries,
  loadInbox,
  markAllRead,
  markRead,
  saveInbox,
} from '../lib/inbox';
import { applyLabelColors } from '../lib/labelColor';
import { memoryQueryRootKey } from '../lib/memory';
import { resolveExecuteModel } from '../lib/models';
import { notify, setNotificationKinds } from '../lib/notifications';
import {
  patchedBody,
  patchedMeta,
  touchesBody,
  touchesMeta,
} from '../lib/optimisticPatch';
import type { PendingApproval } from '../lib/pendingApprovals';
import { pendingApprovalsFromGates } from '../lib/pendingApprovals';
import { isTerminalRunState, runSurveyNotice } from '../lib/runState';
import { runStepFromRecord, runSteps } from '../lib/runStep';
import { setActiveStatusModel } from '../lib/statusModel';
import { taskIdsWithOpenAsks } from '../lib/taskAsks';
import type { TaskAttention } from '../lib/taskAttention';
import { deriveTaskAttentionById } from '../lib/taskAttention';
import { computeBlockedIds } from '../lib/taskGraph';
import {
  removeTaskListItem,
  sameItems,
  touchesFanout,
  upsertTaskListItem,
  withDispatching,
} from '../lib/taskListCache';
import { ensureDispatchd, restartDispatchd } from '../lib/tauri';
import { applyDocsEvent } from './useDocs';
import { gitQueryRootKey } from './useGit';
import { useOptimisticDispatch } from './useOptimisticDispatch';
import {
  findingsQueryRootKey,
  fixLoopQueryRootKey,
  ledgerQueryRootKey,
  taskVerificationKey,
  useFixLoops,
  useStopFixLoop,
} from './useOrchestration';
import { overseerKey, overseerKeyPrefix } from './useOverseerSession';
import { readinessKey, useReadiness } from './useReadiness';
import { runDiffKey, runReviewKey } from './useRunData';
import { commentsRootKey, taskCommentsKey } from './useTaskComments';
import { taskDocKey, tasksKey } from './useTaskDoc';
import { applyThreadEvent } from './useThreads';
import { useTransitionNotifications } from './useTransitionNotifications';

// Shared empty list, so the maps derived from the open gates keep their
// identity while the query is loading or disabled.
const NO_GATES: Message[] = [];

// A `task.changed` naming more tasks than this refetches the list instead.
const MAX_PATCHED_TASKS = 20;
// Coalesces a burst of `task.changed` events into one refetch per query.
const TASK_REFRESH_DEBOUNCE_MS = 250;
// Coalesces the run, epic and task events that move fan-out progress into one refetch.
const EPIC_REFRESH_DEBOUNCE_MS = 250;

// Drops an answered gate from the cached open list at once, so its card goes
// before the refetch lands and cannot send a second answer to a closed gate.
function dropOpenGate(
  queryClient: QueryClient,
  port: number | undefined,
  gateId: string
): void {
  queryClient.setQueryData<{ items: Message[] }>(openGatesKey(port), (prev) =>
    prev === undefined
      ? prev
      : { items: prev.items.filter((m) => m.id !== gateId) }
  );
}

// The daemon's notice saying why a wake-requesting message woke nothing, read
// from the sender's unread mail; null when there is none or it cannot be read.
async function wakeNoticeFor(
  client: ApiClient,
  messageId: string
): Promise<string | null> {
  try {
    const { items } = await client.getMailbox(undefined, [
      'held',
      'notified',
      'pushed',
    ]);
    const notice = items.findLast(
      ({ message }) =>
        message.kind === 'notice' &&
        message.refs.some((r) => r.type === 'message' && r.id === messageId)
    );
    return notice?.message.body ?? null;
  } catch {
    return null;
  }
}

// Persists the Board/List/Runs "show archived" toggle across restarts — mirrors BoardView's
// own `dispatch:tasks-view-mode` persistence. Guarded for `window` for the same reason (this
// is a Tauri/browser-only app, never SSR'd, but a stray server-side render of this module
// shouldn't throw on a missing `localStorage`).
const SHOW_ARCHIVED_STORAGE_KEY = 'dispatch:show-archived';

// An in-place dispatch's failure reaches its caller as a rejection instead.
const ignoreDispatchFailure = () => {};

// Stable empty registry while the people query loads.
const NO_PEOPLE: readonly Person[] = [];

// The open-repo-PRs query key, exported so the PR review page can refresh it for
// as long as it is the page on screen (no WS event announces a PR moving).
export function repoPrsKey(
  port: number | undefined
): [string, number | undefined] {
  return ['dispatch-repo-prs', port];
}

// The unified-PR-table query key (`GET /api/landing`), exported so
// `LandingTableView` can invalidate it itself after a worktree create/remove.
export function landingKey(
  port: number | undefined
): [string, number | undefined] {
  return ['dispatch-landing', port];
}

function runsKey(port: number | undefined): [string, number | undefined] {
  return ['dispatch-runs', port];
}

function whoamiKey(port: number | undefined): [string, number | undefined] {
  return ['dispatch-whoami', port];
}

/**
 * Starts the Cockpit's first-paint reads (the list, config, identity, runs, people) the
 * moment a connection resolves, instead of after the renders that hand React the new
 * client. The hook's queries share these keys, so they pick the fetches up in flight.
 */
function prefetchFirstPaint(
  queryClient: QueryClient,
  connection: DaemonConnection
): void {
  const client = createApiClient(
    daemonBaseUrl(connection),
    resolveDaemonAuth(connection).token
  );
  const { port } = connection;
  void queryClient.prefetchQuery({
    queryKey: tasksKey(port),
    queryFn: () => client.fetchTaskList({ archived: true }),
  });
  void queryClient.prefetchQuery({
    queryKey: dispatchConfigKey(port),
    queryFn: () => client.fetchConfig(),
  });
  void queryClient.prefetchQuery({
    queryKey: whoamiKey(port),
    queryFn: () => client.fetchWhoami(),
  });
  void queryClient.prefetchQuery({
    queryKey: runsKey(port),
    queryFn: () => client.fetchRuns(),
  });
  void queryClient.prefetchQuery({
    queryKey: peopleKey(port),
    queryFn: () => client.fetchPeople(),
  });
}

/**
 * The daemon connection for a project, which also starts the first-paint reads. Shared by
 * the hook and the boot warm-up (`bootWarm.ts`), so both land on one cache entry.
 */
export function connectionQuery(
  queryClient: QueryClient,
  projectPath: string | null
) {
  return {
    queryKey: ['dispatchd-port', projectPath] as const,
    queryFn: async () => {
      if (projectPath === null) throw new Error('no active project');
      const connection = await ensureDispatchd(projectPath);
      prefetchFirstPaint(queryClient, connection);
      return connection;
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  };
}

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
   * outside the old Runs page's row-click ever wrote to, so opening a run from the task peek
   * panel updated nav state but left this hook still pointed at whatever run — or none — it
   * saw last). Pass `null` when nothing is selected. */
  selectedRunId: string | null;
  /** Called once a run is created or re-dispatched (request-changes), so the caller can move
   * `navReducer` to point at it. The run's task travels with it: a brand-new run has not
   * reached the caller's run list yet, and the task view is where it now gets shown.
   *
   * Not called for a dispatch marked `batch` — see `DispatchOptions`. */
  onRunDispatched?: (runId: string, taskId: string) => void;
}

/** Extra intent a caller can attach to a single `handleDispatch` call. Not exported: callers
 *  pass an object literal, and `DispatchProjectData` names the shape for them. */
interface DispatchOptions {
  /**
   * True when this dispatch is one of several started by a single gesture (the tasks list's
   * "Send agents at N selected tasks" bar loops `handleDispatch` once per task).
   *
   * Such a dispatch does not fire `onRunDispatched`. Firing it per task would navigate the app
   * once per iteration — the user is yanked through each new run's Chat tab in turn and left on
   * the last one, several history entries deep, having asked to stay in the list. A batch of
   * exactly one is not a batch: pass `false` and it jumps like any single dispatch.
   */
  batch?: boolean;
  /**
   * The list's and board's dispatch: the task shows as started at once and the user stays
   * put (no `onRunDispatched`), like the Cockpit's `d`. A refused dispatch puts the task
   * back and rejects. Always the default executor and model.
   */
  optimistic?: boolean;
  /** The effort the task page's picker chose; absent lets the daemon apply
   * config `effort.execute`, or the model's own default. */
  effort?: EffortLevel;
}

export interface DispatchProjectData {
  /** `null` until the dispatchd sidecar's port resolves; every field below stays in its own
   * loading/empty state while this is `null` — callers should show a project-level "starting
   * the task daemon…" state, matching the previous TasksPanel behavior. */
  client: ApiClient | null;
  /** The active project's dispatchd port, `undefined` until it resolves — exposed so a view
   * can scope its own query keys (e.g. `useGit`) the same way this hook's queries do. */
  port: number | undefined;
  /** The daemon's HTTP base, or `null` before one resolves. Exposed for the
   *  few things that address the daemon directly rather than through
   *  `client` — a run preview's iframe is one, since a browser frame loads a
   *  URL and cannot go through the API client at all. Honours the web demo's
   *  proxy base the same way every API call does. */
  daemonBaseUrl: string | null;
  /** Everyone connected to this daemon right now, you included. One entry on
   *  a solo project; more once teammates hold their own tokens. */
  presence: PresenceEntry[];
  /** This window's own ActorRef (`human:<handle>`), or `null` until the daemon
   *  has said. While null, nothing is treated as a teammate's. */
  me: string | null;
  /** Why the daemon has not said who this window is, while its last answer failed;
   *  `null` once it has, or while it is still asked. */
  whoamiError: Error | null;
  /** Asks the daemon who this window is again, after `whoamiError`. */
  retryWhoami: () => void;
  /** The daemon's own human, whom a fan-out takes a legacy bare `human`
   *  assignee to mean; `null` until the daemon has said (or an older one). */
  localHuman: string | null;
  /** The project's people registry (team roster + config `people`) — what pickers offer
   *  and avatars resolve names from. Empty until fetched. */
  people: readonly Person[];
  /** The tier this window's credential carries. The daemon's own answer from
   *  `/api/whoami` wins once it arrives; until then (or if it never does, on a
   *  daemon without that route) it is read off the credential itself — see
   *  `credentialTier`. `null` only while there is no connection at all. */
  myTier: AuthTier | null;
  /** Whether this window attached to a daemon it did not start, and so holds
   *  only the request-tier agent token even for the machine's owner. */
  attachedWithoutAppToken: boolean;
  portLoading: boolean;
  portError: boolean;
  portErrorDetail: unknown;
  retryEnsureDispatchd: () => void;

  tasks: TaskListItem[];
  tasksLoading: boolean;
  /** True once the task list has been fetched for this
   * connection — readiness, not an in-flight flag, since `isLoading` is false for a query
   * that is merely disabled (no daemon client yet). The deep-link router waits on this. */
  tasksReady: boolean;
  // Task 8 fix: the same task list as `tasks`, but including archived tasks
  // (`fetchTaskList({ archived: true })`) — feed this, not `tasks`, to
  // countMergeReady, or an archived done own-task/blocker will be missing
  // from its lookup entirely. No other consumer here should use this; every
  // other surface wants the default board-view (archived-excluded) `tasks`.
  tasksIncludingArchived: TaskListItem[];
  // Task 9: just the archived subset of `tasksIncludingArchived` (`archivedAt !== undefined`)
  // — feeds the Board/List "Archived (N)" toggle chip and its muted group/column rendering.
  archivedTasks: TaskListItem[];
  // Task 9: whether archived tasks/runs are currently shown — persisted to localStorage.
  // Neither `runs` nor `tasks`/`tasksIncludingArchived` are filtered by this (callers combine
  // `tasks` with `archivedTasks` themselves when it's on, e.g. BoardView's column grouping) —
  // see `visibleRuns` below for the one field that *is* filtered by it.
  showArchived: boolean;
  setShowArchived: (value: boolean) => void;
  config: DispatchConfig | null;
  /** What the daemon can dispatch on and which executor it defaults to; null until fetched. */
  executors: ExecutorsResponse | null;
  // The full, unfiltered run list — archivedAt is orthogonal to a task's status (an archived
  // task need not be done/cancelled), so every eligibility computation here (countMergeReady,
  // the merge queue) MUST keep reading this rather than `visibleRuns`, or a still-mergeable
  // run would silently stop being offered the moment its task is archived. Only the Runs
  // view's own run-*list* rendering should read `visibleRuns` instead.
  runs: RunMeta[];
  // Task 9: `runs` filtered to hide archived-task runs, unless `showArchived` is on — feeds
  // only the run-list UI that offers a show-archived toggle. Every other
  // consumer of run data (countMergeReady, liveRunStateByTaskId, latestRunByTaskId, the merge
  // queue) reads the unfiltered `runs` above on purpose.
  visibleRuns: RunMeta[];
  /** GET /api/health, undefined until it loads. `storageBackend` is absent
   *  on daemons older than it. */
  health: Pick<HealthPayload, 'pr' | 'storageBackend'> | undefined;
  readyIds: Set<string>;
  blockedIds: Set<string>;
  epics: TaskListItem[];
  epicProgressById: Map<string, EpicProgress>;
  /** The epics with a fan-out session that is `active` or `paused` right now
   * — what the live rail groups under and the status strip sums ceilings
   * over. Order follows the bulk progress response. */
  liveEpicSessions: EpicProgress[];
  liveRunStateByTaskId: Map<string, RunState>;
  latestRunByTaskId: Map<string, RunMeta>;
  /** Tasks whose latest run needs a human right now (waiting on approval/question, failed,
   * or finished-but-unreviewed) — drives the attention tint on Board cards and List rows. */
  attentionByTaskId: Map<string, TaskAttention>;
  // Task 6: the merge queue's live snapshot (pending/active entries + a capped
  // history) — `null` until the query has ever resolved, so callers can show
  // an empty/loading state without treating "no entries yet" as an error.
  mergeQueue: MergeQueueSnapshot | null;
  // Every open PR in the repo, not just the ones dispatch itself opened —
  // gated on `health.pr === true` (see the query's own comment), so `null`
  // covers both "hasn't loaded yet" and "this project has no pr capability"
  // alike; the review queue treats both as "no PRs to show".
  repoPrs: RepoPr[] | null;
  // The unified PR table snapshot (`GET /api/landing`) — `null` until loaded.
  // `landingIsError` is the separate "stale" signal; see the query's comment.
  landing: LandingSnapshot | null;
  landingIsError: boolean;
  // Manual retry for the first load's error state — see `landingIsError`'s
  // comment; a background refetch already retries on its own, this is for
  // when there is no snapshot yet to fall back on.
  landingRefetch: () => void;

  runDetail: RunDetail | undefined;
  diff: import('@dispatch/client').DiffResult | undefined;
  diffLoading: boolean;
  diffError: string | null;
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
  /** Model-backed grouping of related captures, run in the background by
   * BrainDumpView. Always resolves — `error` carries a failed model call. */
  handleClusterInbox: () => Promise<{
    groups: import('@dispatch/client').InboxClusterGroup[];
    error: string | null;
  }>;
  /** The persisted result of the last clustering pass — rendered on load so a
   * page visit never bills a model call of its own. Null until fetched or when
   * no pass has ever run. */
  inboxClusters: import('@dispatch/client').InboxClusterSnapshot | null;
  /** The persisted result of the last triage pass — kind, epic and possible
   * duplicates per capture. Null until fetched or when no pass has run. */
  inboxTriage: import('@dispatch/client').InboxTriageSnapshot | null;
  /** Readiness readings by task id, for the tasks the daemon has judged
   * (ready ones only — it judges as it serves `/api/tasks/ready`). */
  readinessById: ReadonlyMap<string, ReadinessReading>;
  /** Every plan's summary, newest activity first — the Plans page's history,
   * persisted server-side so it survives restarts and spans windows. */
  plans: import('@dispatch/client').PlanSummary[];

  /** Line-level review comments on the selected run's diff. */
  reviewComments: import('@dispatch/client').ReviewComment[];
  /**
   * Resolves with the created comment, not just `void` — the composer's `Apply now` action
   * needs the new comment's id back so it can immediately apply its suggestion through the
   * same path the thread's own Apply button uses.
   */
  handleAddReviewComment: (input: {
    file: string;
    line: number;
    startLine?: number;
    anchorText: string;
    body: string;
    /** Replacement text for the commented lines. Omitted for a prose-only comment. */
    suggestion?: string;
  }) => Promise<ReviewComment>;
  /** Commits a comment's suggestion onto the run branch. Fails with a 409 `anchor-drifted`
   * `ApiError` if the code named by the comment's line range has moved since it was written. */
  handleApplySuggestion: (commentId: string) => Promise<void>;
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
    maxConcurrency?: number;
    runCostEstimateUsd?: number;
    verifyTimeoutSec?: number;
    permissionMode?: string;
    models?: Partial<ModelConfig>;
    linear?: {
      enabled?: boolean;
      teamId?: string | null;
      teamIds?: string[];
      statusMap?: Record<string, string>;
      intervalSec?: number;
      direction?: 'both' | 'pull' | 'push';
      includeAcceptanceCriteria?: boolean;
    };
    statusRoles?: StatusRoles | null;
    maxTurns?: number | null;
    maxBudgetUsd?: number | null;
    fixLoop?: { cap?: number; escalation?: EscalationStep[] };
    verify?: { command?: string; url?: string; notes?: string };
    notifications?: {
      kinds?: Partial<Record<NotificationKind, boolean>>;
      webhook?: string | null;
    };
    policy?: {
      rung?: number;
      gates?: Partial<Record<PolicyGate, PolicyGateMode | null>>;
    };
  }) => Promise<void>;
  /** The board syncer's last attempt plus live pending counts — the sync chip's data source.
   * `null` until the status query has ever resolved. */
  syncStatus: SyncStatus | null;
  /** `null` until the status query has ever resolved. Carries no API key — only where the
   * daemon found one (`keySource`), never what it is. */
  linearStatus: LinearStatus | null;
  /** This Linear workspace's teams, fetched once connected — the Settings team picker. */
  linearTeams: LinearTeam[];
  /** Why the team list is empty, when it is empty because the fetch failed rather than because
   *  the workspace has no teams. Null-ish when the fetch succeeded. */
  linearTeamsError: unknown;
  refetchLinearTeams: () => void;
  /** Issue UUID -> display identifier/URL, for resolving `TaskMeta.external` into a real chip. */
  linearLinks: Record<string, LinearIssueLink>;
  handleConnectLinear: (
    apiKey: string
  ) => Promise<{ connected: boolean; viewer: LinearViewer }>;
  handleDisconnectLinear: () => Promise<void>;
  /** Runs a sync pass now, returning its summary. With `taskIds`, pushes exactly those tasks
   * regardless of the cursor filter — the task dialog's "Push to Linear" action. */
  handleSyncLinear: (taskIds?: string[]) => Promise<LinearSyncSummary>;
  /** Brings down every Linear issue in the configured team that has no local task yet — the
   * explicit opt-in a fresh clone or new machine needs, since sync never bulk-imports on its own. */
  handleImportLinear: () => Promise<LinearSyncSummary>;
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
  /** Run id -> each tool call it is parked on, oldest first, from the open gates. */
  pendingApprovals: Map<string, PendingApproval[]>;
  /** Run id -> the newest open scope gate its agent raised, live or ended. */
  pendingScopeRequests: Map<string, RunScopeRequest>;
  handleDecideScopeRequest: (
    runId: string,
    requestId: string,
    granted: boolean,
    reason?: string
  ) => Promise<void>;
  /** Whether this window holds the app token that scope decisions require, plus the notice
   * and restart affordance to show when it does not. */
  scopeDecide: DecideAvailability;
  /** What this window may do on the message bus (send; answer gates), and why not. */
  messageAccess: MessageAccess;
  /** Replaces an attached daemon with one this app spawns, to regain decide tier. Ends any
   * run in flight — gate on `scopeDecide.restart.safe`. */
  handleRestartDaemon: () => Promise<void>;
  /** Run id -> every blocking question that run's agent sent a human, oldest first. */
  openQuestions: Map<string, RunQuestion[]>;
  /** Runs with an open gate or question addressed to this window's human
   *  (XH-R9): theirs to answer, whoever the run acts for. */
  asksMe: ReadonlySet<string>;
  /** The daemon's decision feed: everything awaiting a human plus the
   * just-resolved tail, in the server's order (open longest-waiting first). */
  decisions: DecisionItem[];
  handleAnswerQuestion: (
    runId: string,
    questionId: string,
    answer: string
  ) => Promise<void>;

  planId: string | null;
  setPlanId: (planId: string | null) => void;
  planRecord: PlanRecord | undefined;

  handleUpdate: (id: string, patch: UpdatePatch) => Promise<void>;
  moveTaskStatus: (id: string, status: string) => Promise<void>;
  /** Resolves with the created doc (the create dialog attaches pending files to its id);
   * `null` without a client. */
  handleCreate: (input: CreateInput) => Promise<TaskDoc | null>;
  /** Multipart upload against a task; `task.changed` then refreshes the list. */
  handleUploadAttachments: (taskId: string, files: File[]) => Promise<void>;
  /** Every task draft currently held in memory, newest first — feeds the app-wide drafts
   * tray. Running and ready drafts survive navigation and a tray reopen; see `drafts`. */
  drafts: DraftRecord[];
  /** Every in-memory conversation agent (planner chats, enrich agents, task drafts, overseer
   * chats), newest activity first — the non-run half of the All agents page. */
  agentSessions: AgentSessionMeta[];
  /** Starts a background single-task draft and returns immediately with its `running`
   * record; the tray/`drafts` picks up its progress via `draft.changed`. `parent` is the
   * container the saved task goes under. */
  handleStartDraft: (
    prompt: string,
    options?: { parent?: string | null }
  ) => Promise<DraftRecord>;
  /** Dismisses a draft so it stops appearing in the tray — used both for "Discard" in the
   * review dialog and for "Create task", once a ready draft has become a real task. */
  handleDismissDraft: (id: string) => Promise<void>;
  /** Post a follow-up message (typically answers to its clarifying questions) on an existing
   * draft. Returns the 202 record, already back in `running`. */
  handleSendDraftMessage: (
    draftId: string,
    text: string
  ) => Promise<DraftRecord>;
  handleDispatch: (
    taskId: string,
    executor?: string,
    model?: string,
    opts?: DispatchOptions
  ) => Promise<void>;
  handleApprove: (
    runId: string,
    requestId: string,
    allow: boolean,
    opts?: { scope?: 'once' | 'session'; reason?: string }
  ) => Promise<void>;
  /** The full input of a call a run is parked on, which its gate may only preview. */
  fetchApprovalInput: (runId: string, requestId: string) => Promise<unknown>;
  /** The same for a call an Assistant conversation is parked on. */
  fetchOverseerApprovalInput: (
    conversation: string,
    requestId: string
  ) => Promise<unknown>;
  handleSendMessage: (runId: string, text: string) => Promise<void>;
  handleCancelRun: (runId: string) => Promise<void>;
  /** Asks a live run to wind down: it finishes its current operation, then stops,
   * keeping its work. `handleCancelRun` is the hard form that kills it outright. */
  handleStopRun: (runId: string) => Promise<void>;
  /** Hides a run from the Runs list, or brings it back. Nothing is deleted. */
  handleArchiveRun: (runId: string, archived: boolean) => Promise<void>;
  handleReview: (runId: string, action: 'merge' | 'discard') => Promise<void>;
  handleRequestChanges: (runId: string, text: string) => Promise<void>;
  handleOpenPr: (runId: string) => Promise<void>;
  /** Starts a fan-out session on an epic. A bare number is the pre-fan-out
   * form, `{ concurrency }` with no ceilings — kept until every caller passes
   * options (Parked). */
  handleWorkEpic: (
    epicId: string,
    opts: number | WorkEpicOptions
  ) => Promise<void>;
  /** Stops a session filling; live runs finish. Resume picks it back up. */
  handlePauseEpic: (epicId: string) => Promise<void>;
  /** Resumes a paused session, optionally with new ceilings or concurrency —
   * `null` lifts a ceiling, `undefined` keeps the session's value. */
  handleResumeEpic: (
    epicId: string,
    opts?: Partial<WorkEpicOptions>
  ) => Promise<void>;
  handleStopEpic: (epicId: string) => Promise<void>;
  /** Lands a finished epic branch on the default base — one PR or one local
   * merge, decided server-side off the project's `pr` capability. */
  handleLandEpic: (epicId: string) => Promise<void>;
  /** Opens a plan. `model` is the composer's pick for it, over the configured
   * `plan` role's model; the plan keeps it for every follow-up. */
  handleSubmitPrompt: (prompt: string, model?: string) => Promise<string>;
  /** Post a follow-up message onto the active plan conversation. Returns the
   * 202 record (already flipped back to `running`); the assistant's reply +
   * refined proposal land via the `plan.changed` broadcast and refetch. */
  handleSendPlanMessage: (
    text: string
  ) => Promise<import('@dispatch/client').PlanRecord>;
  /** Turns a proposal into tasks. Resolves to the created epic's id (when the
   * plan had one) and the task ids, so the caller can open the milestone. */
  handleConfirmPlan: (proposal: PlanProposal) => Promise<ConfirmResult>;
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
  /** Every task's fix-loop state, by task id — the feed annotates rows and
   * offers Stop from this. Empty until the bulk fetch resolves. */
  fixLoops: ReadonlyMap<string, FixLoopState>;
  /** Caps a task's fix loop where it stands; "Review & fix" resumes it. */
  handleStopFixLoop: (taskId: string) => Promise<void>;
  // Task 8: enqueues every eligible run across the project in one shot (the
  // "Merge all ready" toolbar action) — thin wrapper over enqueueMergeReady,
  // since the server owns the actual eligibility/ordering logic.
  handleMergeAllReady: () => Promise<void>;
  /** Retries every entry held on a blocked checkout. Queue-wide, mirroring the server. */
  handleRecheckMergeQueue: () => Promise<void>;
  // Set from the `queue.drained` WS event when the queue's auto-push after a
  // drain fails (merged locally, origin didn't get the commit) — rendered as
  // the Landing table's push-failure banner, whose Retry is handleMergeAllReady.
  // Cleared on the next successful drain-push.
  lastPushError: string | null;

  // Task 10: the persisted notification inbox — the recoverable record behind every
  // transient run/queue toast `useTransitionNotifications` fires (see inbox.ts). Named
  // `notificationInbox` to stay distinct from the brain-dump `inbox` above. Loaded
  // per-project and re-saved on every change so it survives a restart/project switch.
  notificationInbox: InboxState;
  // Marks every notification entry read — called once when the panel opens, not per-entry.
  markNotificationInboxRead: () => void;
  /** Flips one entry to read — the Inbox page selecting a notification row. */
  markNotificationRead: (id: string) => void;
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
  // Task 8: last drain-push failure reported by `queue.drained`, for
  // the Landing table's push-failure banner — `null` once a later drain pushes
  // successfully.
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

  const markNotificationRead = useCallback(
    (id: string) => {
      updateNotificationInbox((prev) => markRead(prev, id));
    },
    [updateNotificationInbox]
  );

  // A plan started against one project's dispatchd must never leak into another project's
  // Plans view — without this, switching projects while a plan was mid-flight (or just left
  // `ready`) would carry the old `planId` over and immediately try to `fetchPlan` it against
  // the *new* project's port, 404ing (see I5 in the phase-8 fix report).
  useEffect(() => {
    setPlanId(null);
    setNotePlanId(null);
  }, [projectPath]);

  const {
    data: connection,
    isLoading: portLoading,
    isError: portError,
    error: portErrorDetail,
    refetch: retryEnsureDispatchd,
  } = useQuery({
    ...connectionQuery(queryClient, projectPath),
    enabled: projectPath !== null,
  });

  const port = connection?.port;
  // The credential every call below presents. `canDecide` is false whenever the
  // app attached to a daemon it did not spawn, because the app token only ever
  // arrives on a spawned daemon's stdout.
  const auth = useMemo(() => resolveDaemonAuth(connection), [connection]);

  const client = useMemo(
    () =>
      connection !== undefined
        ? createApiClient(daemonBaseUrl(connection), auth.token)
        : null,
    [connection, auth.token]
  );

  const tasksQueryKey = useMemo(() => tasksKey(port), [port]);
  const configQueryKey = useMemo(() => dispatchConfigKey(port), [port]);
  const runsQueryKey = useMemo(() => runsKey(port), [port]);
  const presenceQueryKey = useMemo(() => ['dispatch-presence', port], [port]);
  const whoamiQueryKey = useMemo(() => whoamiKey(port), [port]);
  const runDetailQueryKey = useMemo(
    () => ['dispatch-run', port, selectedRunId],
    [port, selectedRunId]
  );
  const runDiffQueryKey = useMemo(
    () => ['dispatch-run-diff', port, selectedRunId],
    [port, selectedRunId]
  );
  const healthQueryKey = useMemo(() => ['dispatch-health', port], [port]);
  const notesQueryKey = useMemo(() => ['dispatch-notes', port], [port]);
  const inboxQueryKey = useMemo(() => ['dispatch-inbox', port], [port]);
  const inboxClustersQueryKey = useMemo(
    () => ['dispatch-inbox-clusters', port],
    [port]
  );
  const inboxTriageQueryKey = useMemo(
    () => ['dispatch-inbox-triage', port],
    [port]
  );
  // The drafts list (`GET /api/tasks/drafts`) query key, invalidated below
  // on `draft.changed`.
  const draftsQueryKey = useMemo(() => ['dispatch-drafts', port], [port]);
  // The conversation-agents list (`GET /api/agents`), invalidated below on
  // `plan.changed`, `draft.changed` and `overseer.changed` — the three events
  // that cover every kind of session it returns.
  const agentSessionsQueryKey = useMemo(
    () => ['dispatch-agent-sessions', port],
    [port]
  );
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
  const repoPrsQueryKey = useMemo(() => repoPrsKey(port), [port]);
  const landingQueryKey = useMemo(() => landingKey(port), [port]);
  const branchesQueryKey = useMemo(() => ['dispatch-branches', port], [port]);
  const decisionsQueryKey = useMemo(() => ['dispatch-decisions', port], [port]);
  const linearStatusQueryKey = useMemo(() => linearStatusKey(port), [port]);
  const linearTeamsQueryKey = useMemo(
    () => ['dispatch-linear-teams', port],
    [port]
  );
  const linearLinksQueryKey = useMemo(
    () => ['dispatch-linear-links', port],
    [port]
  );
  const syncStatusQueryKey = useMemo(() => syncStatusKey(port), [port]);

  // One archived-inclusive, body-less list; `tasks` (active only) and
  // `archivedTasks` are derived from it below rather than fetched separately.
  const {
    data: listedTasks,
    isLoading: tasksLoading,
    isFetched: allTasksFetched,
  } = useQuery({
    queryKey: tasksQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchTaskList({ archived: true });
    },
    enabled: client !== null,
  });

  // What the first paint does not draw waits for the list, so its requests and renders
  // stay off the cold load's critical path.
  const afterList = client !== null && allTasksFetched;

  // Writes one fetched doc into the caches in place of a list refetch: its list entry
  // (meta only) and, when a task page holds it, its full doc. Stale responses lose.
  const applyTaskDoc = useCallback(
    (doc: TaskDoc) => {
      queryClient.setQueryData<TaskListItem[]>(tasksQueryKey, (old) =>
        old === undefined ? old : upsertTaskListItem(old, doc.meta)
      );
      queryClient.setQueryData<TaskDoc>(taskDocKey(port, doc.meta.id), (old) =>
        old === undefined || old.meta.updated > doc.meta.updated ? old : doc
      );
    },
    [queryClient, tasksQueryKey, port]
  );
  const { data: config } = useQuery({
    queryKey: configQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchConfig();
    },
    enabled: client !== null,
  });
  // Registered at daemon boot, so it only needs fetching once per connection.
  const { data: executors } = useQuery({
    queryKey: ['dispatch-executors', port] as const,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchExecutors();
    },
    enabled: afterList,
    staleTime: Infinity,
  });
  // The OS-notification toggles live at module level in notifications.ts
  // because the WS handler below fires `notify` without re-subscribing on a
  // config change. Reset to "everything on" while a project's config is
  // still loading, rather than carrying the previous project's toggles over.
  useEffect(() => {
    setNotificationKinds(config?.notifications.kinds ?? null);
    applyLabelColors(config?.labels ?? null);
  }, [config]);
  // The sync chip's data source — refetched only on mount and on the
  // `board.sync` WS event below (see the effect's invalidation), not polled.
  const { data: syncStatus } = useQuery({
    queryKey: syncStatusQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchSyncStatus();
    },
    enabled: afterList,
  });
  const { data: linearStatus } = useQuery({
    queryKey: linearStatusQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchLinearStatus();
    },
    enabled: afterList,
  });
  const {
    data: linearTeams,
    error: linearTeamsError,
    refetch: refetchTeamsQuery,
  } = useQuery({
    queryKey: linearTeamsQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchLinearTeams();
    },
    enabled: client !== null && linearStatus?.connected === true,
    // A rejected key is a settled answer, not a blip — retrying it three times
    // only delays the error the picker needs to show.
    retry: false,
  });
  // Reads from disk, not the Linear API, so it stays available for chip rendering even while
  // disconnected — a task linked before a key was removed should still show its identifier.
  const { data: linearLinks } = useQuery({
    queryKey: linearLinksQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchLinearLinks();
    },
    enabled: afterList,
  });
  // TanStack's own `refetch` is stable, so wrapping it in useCallback with it as the only
  // dependency gives callers (e.g. a Settings Retry button) an identity that never churns.
  const refetchLinearTeams = useCallback(
    () => void refetchTeamsQuery(),
    [refetchTeamsQuery]
  );
  // Who this window is, as the daemon sees its credential. Fetched once per
  // connection — a credential does not change identity mid-session — and read
  // wherever the app has to tell "mine" from "a teammate's".
  const {
    data: whoami,
    error: whoamiError,
    refetch: refetchWhoami,
  } = useQuery({
    queryKey: whoamiQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchWhoami();
    },
    enabled: client !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  // The people registry. Changes with config (`people:`) and the team roster, so a
  // `config.changed` refetches it; otherwise it holds for the connection.
  const peopleQueryKey = useMemo(
    () => (port === undefined ? ['dispatch-people'] : peopleKey(port)),
    [port]
  );
  const { data: peopleSnapshot } = useQuery({
    queryKey: peopleQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchPeople();
    },
    enabled: client !== null,
    staleTime: 60_000,
  });
  // Who else is on this daemon. Refetched on `presence.changed` (someone
  // arrived or left) and `run.changed` (what they are running moved).
  const { data: presence } = useQuery({
    queryKey: presenceQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchPresence();
    },
    enabled: afterList,
  });
  const { data: runs } = useQuery({
    queryKey: runsQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchRuns();
    },
    enabled: client !== null,
  });
  // The open gates the approval, scope and question cards read. Listed to
  // deciding humans only, so a window that cannot decide never asks.
  const openGatesQuery = useQuery({
    queryKey: openGatesKey(port),
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.openDecisions();
    },
    enabled: client !== null && auth.canDecide,
    refetchInterval: 60_000,
    retry: false,
  });
  const openGates = openGatesQuery.data?.items ?? NO_GATES;

  // The list's and board's dispatch (`DispatchOptions.optimistic`): the Cockpit's pending
  // map, shown as the dispatched status over the listed tasks until the daemon's own
  // change or the run arrives. A failure is kept for `dispatchInPlace` to rethrow.
  const liveRunTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of runs ?? []) {
      if (!isTerminalRunState(run.state)) ids.add(run.taskId);
    }
    return ids;
  }, [runs]);
  const statusModel = useMemo(() => statusModelOf(config), [config]);
  // Before paint, so a subscribed glyph never shows a frame of the old statuses.
  useLayoutEffect(() => {
    setActiveStatusModel(statusModel);
  }, [statusModel]);
  const stillWaiting = useCallback(
    (taskId: string) => {
      const task = listedTasks?.find((t) => t.meta.id === taskId);
      return (
        task !== undefined && isUnstartedStatus(task.meta.status, statusModel)
      );
    },
    [listedTasks, statusModel]
  );
  const dispatchFailures = useRef(new Map<string, unknown>());
  const sendInPlace = useCallback(
    async (taskId: string) => {
      if (client === null) throw new Error('dispatchd client not ready');
      const claude = (executors?.default ?? 'claude') === 'claude';
      try {
        await client.createRun(taskId, {
          model: claude ? resolveExecuteModel(config) : undefined,
        });
      } catch (err) {
        dispatchFailures.current.set(taskId, err);
        throw err;
      }
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
    },
    [client, config, executors, queryClient, runsQueryKey]
  );
  const inPlace = useOptimisticDispatch(
    sendInPlace,
    liveRunTaskIds,
    stillWaiting,
    ignoreDispatchFailure
  );
  const dispatchInPlace = inPlace.dispatch;
  const allTasksIncludingArchived = useMemo(
    () =>
      listedTasks === undefined
        ? undefined
        : withDispatching(listedTasks, inPlace.pending, statusModel),
    [listedTasks, inPlace.pending, statusModel]
  );
  const tasks = useMemo(
    () =>
      allTasksIncludingArchived?.filter((t) => t.meta.archivedAt === undefined),
    [allTasksIncludingArchived]
  );
  const pendingApprovals = useMemo(
    () => pendingApprovalsFromGates(openGates, runs),
    [openGates, runs]
  );
  const pendingScopeRequests = useMemo(
    () => scopeRequestsByRun(openGates),
    [openGates]
  );
  // Keyed by run so a view holding one run finds its questions in one lookup.
  const openQuestions = useMemo(() => questionsByRun(openGates), [openGates]);
  const me = whoami?.ref ?? null;
  const asksMe = useMemo(() => runsAskingMe(openGates, me), [openGates, me]);
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

  // The daemon's decision feed — everything awaiting a human, resolved tail
  // included (see lib/decisionFeed.ts). Event-driven via `decisions.changed`,
  // with a slow interval on top: the daemon prunes its five-minute resolved
  // retention only when something reads or triggers the feed, so without a
  // periodic poll a settled row could sit dimmed in the panel indefinitely.
  const { data: decisionList } = useQuery({
    queryKey: decisionsQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return fetchDecisions(client.baseUrl, auth.token);
    },
    enabled: afterList,
    refetchInterval: 60_000,
  });

  const { data: notes } = useQuery({
    queryKey: notesQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchNotes();
    },
    enabled: afterList,
  });

  // Feeds the app-wide drafts tray; refetched on `draft.changed` regardless of whether the
  // composer that started a draft is still open.
  const { data: drafts } = useQuery({
    queryKey: draftsQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchDrafts();
    },
    enabled: afterList,
  });

  // Feeds the All agents page's conversation-agent rows (planners, enrich
  // agents, drafts, overseers); refetched on the three WS events below.
  const { data: agentSessions } = useQuery({
    queryKey: agentSessionsQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchAgentSessions();
    },
    enabled: afterList,
  });

  const { data: reviewComments } = useQuery({
    queryKey: reviewQueryKey,
    queryFn: () => {
      if (client === null || selectedRunId === null) {
        throw new Error('no run selected');
      }
      return client.fetchReviewComments({ kind: 'run', runId: selectedRunId });
    },
    enabled: client !== null && selectedRunId !== null,
  });

  const { data: inbox } = useQuery({
    queryKey: inboxQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchInbox();
    },
    enabled: afterList,
  });

  // Every plan's summary — the Plans page's server-backed history.
  const { data: plans } = useQuery({
    queryKey: ['dispatch-plans', port],
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchPlans();
    },
    enabled: afterList,
  });

  // The persisted last clustering pass — what BrainDumpView renders on load
  // instead of billing a fresh model call per visit (see handleClusterInbox).
  const { data: inboxClusters } = useQuery({
    queryKey: inboxClustersQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchInboxClusters();
    },
    enabled: afterList,
  });

  // The last triage pass (kind, epic, duplicates per capture) — written by
  // the same cluster call, so it shares that call's invalidation.
  const { data: inboxTriage } = useQuery({
    queryKey: inboxTriageQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchInboxTriage();
    },
    enabled: afterList,
  });

  // The ready set from the cached list under the project's status model — what
  // `/api/tasks/ready` computes server-side, without re-sending every ready body
  // whenever one task changes. Empty until config says which statuses are ready.
  const readyIds = useMemo(() => {
    if (config === undefined || allTasksIncludingArchived === undefined) {
      return new Set<string>();
    }
    return new Set(
      readyTasks(allTasksIncludingArchived, statusModel).map((t) => t.meta.id)
    );
  }, [config, allTasksIncludingArchived, statusModel]);
  const { readinessById, noteTask, scheduleJudge, reconnected } = useReadiness(
    client,
    port,
    allTasksFetched,
    readyIds
  );

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
    enabled: afterList,
  });

  const { data: health } = useQuery({
    queryKey: healthQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchHealth();
    },
    enabled: afterList,
  });

  const planRecord = usePlanRecord(client, port, planId);
  const notePlanRecord = usePlanRecord(client, port, notePlanId);
  const enrichPlanRecord = usePlanRecord(
    client,
    port,
    enrichPlan?.planId ?? null
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

  // `getLanding` never 409s, so this is gated on `client` only (not
  // `health.pr`); `landingIsError` flags a failed refetch's stale `data`.
  const {
    data: landing,
    isError: landingIsError,
    refetch: landingRefetch,
  } = useQuery({
    queryKey: landingQueryKey,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.getLanding();
    },
    enabled: afterList,
    staleTime: 15_000,
  });

  // Every container: a container kind, or any task with children.
  // The same array while it holds the same containers: every list row takes it, so a
  // copy per task change (a dispatch, a patch) redrew them all.
  const epicsRef = useRef<TaskListItem[]>([]);
  const epics = useMemo(() => {
    const all = tasks ?? [];
    const parentIds = parentIdsOf(all);
    const next = all.filter((t) => isContainer(t.meta, parentIds));
    return sameItems(epicsRef.current, next) ? epicsRef.current : next;
  }, [tasks]);
  useEffect(() => {
    epicsRef.current = epics;
  }, [epics]);

  // Task 9: the archived subset of the archived-inclusive query.
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

  // One GET for every epic's progress rather than one per epic: the prefix
  // is invalidated on every run/epic change, and a fan-out of dozens of
  // milestones made that a burst of dozens of requests each time.
  const { data: allEpicProgress } = useQuery({
    queryKey: [...epicProgressKeyPrefix, 'all'],
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchAllEpicProgress();
    },
    enabled: client !== null,
  });
  const epicProgressById = useMemo(() => {
    const map = new Map<string, EpicProgress>();
    for (const progress of allEpicProgress ?? []) {
      map.set(progress.epicId, progress);
    }
    return map;
  }, [allEpicProgress]);
  const liveEpicSessions = useMemo(
    () =>
      (allEpicProgress ?? []).filter(
        (p) => p.session?.state === 'active' || p.session?.state === 'paused'
      ),
    [allEpicProgress]
  );

  // Read through a ref, so a new judge callback never reopens the socket.
  const readinessRef = useRef({ noteTask, scheduleJudge, reconnected });
  useEffect(() => {
    readinessRef.current = { noteTask, scheduleJudge, reconnected };
  }, [noteTask, scheduleJudge, reconnected]);

  useEffect(() => {
    if (client === null) return;
    // One pending refetch each for the list and for fan-out progress, so a
    // burst of events costs one round trip apiece. Config is not refetched
    // here: a daemon write to it broadcasts `config.changed`, and a pull or a
    // reconnect refetches it below.
    let listTimer: ReturnType<typeof setTimeout> | null = null;
    let epicTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshEpicProgress = () => {
      if (epicTimer !== null) return;
      epicTimer = setTimeout(() => {
        epicTimer = null;
        void queryClient.invalidateQueries({ queryKey: epicProgressKeyPrefix });
      }, EPIC_REFRESH_DEBOUNCE_MS);
    };
    // Tasks changed unseen, so readings may have too.
    const refetchTaskList = () => {
      refreshEpicProgress();
      readinessRef.current.scheduleJudge();
      if (listTimer !== null) return;
      listTimer = setTimeout(() => {
        listTimer = null;
        void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      }, TASK_REFRESH_DEBOUNCE_MS);
    };
    const cachedList = () =>
      queryClient.getQueryData<TaskListItem[]>(tasksQueryKey);
    const refetchConfig = () => {
      for (const key of configChangedQueryKeys(port)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    };
    // Refetches just the named tasks into the cached list; an unscoped or
    // wide change, or a list fetch already in flight, refetches the list.
    // Fan-out progress and readiness refetch only when a changed task can
    // move them.
    const patchTasks = (ids: readonly string[] | undefined) => {
      if (
        ids === undefined ||
        ids.length === 0 ||
        ids.length > MAX_PATCHED_TASKS ||
        cachedList() === undefined ||
        queryClient.isFetching({ queryKey: tasksQueryKey, exact: true }) > 0
      ) {
        refetchTaskList();
        return;
      }
      for (const id of ids) {
        client.fetchTask(id).then(
          (doc) => {
            const list = cachedList();
            if (touchesFanout(list, id, doc.meta)) refreshEpicProgress();
            readinessRef.current.noteTask(
              list?.find((t) => t.meta.id === id)?.meta,
              doc
            );
            applyTaskDoc(doc);
          },
          (err: unknown) => {
            if (!(err instanceof ApiError && err.status === 404)) {
              refetchTaskList();
              return;
            }
            if (touchesFanout(cachedList(), id, null)) refreshEpicProgress();
            queryClient.setQueryData<TaskListItem[]>(tasksQueryKey, (old) =>
              old === undefined ? old : removeTaskListItem(old, id)
            );
            queryClient.removeQueries({ queryKey: taskDocKey(port, id) });
          }
        );
      }
    };
    // task.changed is patched in onEvent below; onChange only re-reads the
    // team, since a teammate's change may come with roster ops (Settings →
    // Machines).
    const refreshTeamKeys = () => {
      void queryClient.invalidateQueries({ queryKey: ['team-keys'] });
    };
    const disconnect = client.connectEvents(refreshTeamKeys, {
      onEvent: (event) => {
        applyThreadEvent(queryClient, port, event);
        applyDocsEvent(queryClient, port, event);
        // Checked structurally (see isDecisionsChanged): the client's
        // ServerEvent union predates this broadcast, so a literal comparison
        // here would not typecheck. First in the chain because no later
        // branch can match an out-of-union frame anyway.
        if (isDecisionsChanged(event)) {
          void queryClient.invalidateQueries({ queryKey: decisionsQueryKey });
        } else if (event.type === 'task.changed') {
          patchTasks(event.ids);
        } else if (event.type === 'hello') {
          // Events sent while the socket was down are lost, so a reconnect
          // refetches the list rather than trusting the patched cache.
          if (cachedList() !== undefined) {
            readinessRef.current.reconnected();
            refetchTaskList();
            void queryClient.invalidateQueries({
              queryKey: readinessKey(port),
            });
          }
          // A restarted daemon may have read a config.yml changed while it was down.
          if (queryClient.getQueryData(configQueryKey) !== undefined) {
            refetchConfig();
          }
          void queryClient.invalidateQueries({
            queryKey: commentsRootKey(port),
          });
          // The daemon sends `hello` from its websocket `open` handler
          // (packages/server/src/index.ts), so this fires once per socket:
          // on the first connect and again on every reconnect. A reconnect
          // usually means dispatchd restarted, and overseer records live in an
          // in-memory Map — so every cached id 404s now, and no
          // `overseer.changed` can ever arrive for a conversation the daemon
          // no longer has. Without this refetch the cached record keeps a
          // pending action alive that exists nowhere: the rail shows a
          // waiting row and an amber badge, Approve/Deny 404, and
          // `hasPendingAction` disables both "New conversation" controls
          // until the window happens to lose and regain focus.
          //
          // It has to be the whole prefix rather than one conversation's
          // key: the open conversation, and its id, live in
          // useOverseerSession, which this hook cannot see. On the first
          // connect nothing is cached yet, so the invalidation is a no-op
          // there rather than a wasted refetch.
          void queryClient.invalidateQueries({
            queryKey: overseerKeyPrefix(port),
          });
          // Who this window is: the answer never goes stale, so a whoami that
          // failed while the daemon was coming up is asked again here.
          void queryClient.invalidateQueries({ queryKey: whoamiQueryKey });
          // Presence too, and for a reason of its own: the daemon announces
          // this socket's arrival before the socket joins the event bus, so
          // the one event saying "you are here now" never reaches the window
          // it is about. A presence fetch that raced ahead of the upgrade
          // would otherwise leave a teammate seeing a room without
          // themselves — and the stack hidden — until someone else moved.
          //
          // Invalidating is not enough on its own when that fetch is the
          // query's first and still in flight: react-query then hands back
          // the in-flight promise instead of restarting (it only cancels a
          // query that already has data), so the stale answer lands. In that
          // case, invalidate again once it has — the second fetch leaves
          // after this socket is registered. Seen 1 in 12 in a browser.
          const presence = queryClient.getQueryState(presenceQueryKey);
          const firstFetchInFlight =
            presence?.fetchStatus === 'fetching' && presence.data === undefined;
          void queryClient
            .invalidateQueries({ queryKey: presenceQueryKey })
            .then(() =>
              firstFetchInFlight
                ? queryClient.invalidateQueries({
                    queryKey: presenceQueryKey,
                  })
                : undefined
            );
        } else if (event.type === 'presence.changed') {
          void queryClient.invalidateQueries({ queryKey: presenceQueryKey });
        } else if (event.type === 'run.changed') {
          void queryClient.invalidateQueries({ queryKey: runsQueryKey });
          void queryClient.invalidateQueries({ queryKey: presenceQueryKey });
          void queryClient.invalidateQueries({
            queryKey: ['dispatch-run', port],
          });
          refreshEpicProgress();
          // Every worktree/branch lifecycle event (dispatch, review, and the
          // branch actions themselves) broadcasts run.changed, so this is the
          // one signal the Branches surface needs.
          void queryClient.invalidateQueries({ queryKey: branchesQueryKey });
        } else if (event.type === 'run.log') {
          runSteps.record(event.runId, event.entry);
          queryClient.setQueryData<RunDetail>(
            ['dispatch-run', port, event.runId],
            (prev) =>
              prev !== undefined
                ? { ...prev, entries: [...prev.entries, event.entry] }
                : prev
          );
        } else if (event.type === 'message.new') {
          const message = event.message;
          const openGatesKeyNow = openGatesKey(port);
          // The cached list follows the event at once, so the fold below sees
          // gates answered elsewhere and gates the refetch has not brought.
          const openNow =
            queryClient.setQueryData<{ items: Message[] }>(
              openGatesKeyNow,
              (prev) => {
                if (prev === undefined) return prev;
                const items = openGatesAfter(prev.items, message);
                return items === prev.items ? prev : { items };
              }
            )?.items ?? NO_GATES;
          // Only a new blocking question or an answer opens or closes a gate.
          if (message.blocking || message.kind === 'answer') {
            void queryClient.invalidateQueries({ queryKey: openGatesKeyNow });
          }
          // A window that cannot decide is not told about gates it cannot see,
          // nor anyone about a muted agent; runs and roster come from the cache.
          const muted = mutedAddresses(
            queryClient.getQueryData<{ agents: AgentSummary[] }>(
              agentRosterKey(port)
            )?.agents ?? []
          );
          const note =
            auth.canDecide && !muted.has(message.from)
              ? gateNotification(
                  message,
                  (runId) =>
                    queryClient
                      .getQueryData<RunMeta[]>(runsQueryKey)
                      ?.find((r) => r.id === runId)?.taskTitle,
                  queryClient.getQueryData<{ ref: string }>(whoamiQueryKey)
                    ?.ref ?? null
                )
              : null;
          if (note !== null && !foldsIntoOpenApproval(message, openNow)) {
            void notify(note.title, note.body, note.kind);
          }
          // A registration gate adds a pending agent; any answer may settle one.
          if (mayChangeAgentRoster(message)) {
            void queryClient.invalidateQueries({
              queryKey: agentRosterKey(port),
            });
          }
        } else if (event.type === 'plan.changed') {
          void queryClient.invalidateQueries({
            queryKey: ['dispatch-plan', port, event.planId],
          });
          // The history list carries every plan's state — refresh it with
          // the record so the two never disagree.
          void queryClient.invalidateQueries({
            queryKey: ['dispatch-plans', port],
          });
          void queryClient.invalidateQueries({
            queryKey: agentSessionsQueryKey,
          });
        } else if (event.type === 'overseer.changed') {
          // The overseer record query itself lives in useOverseerSession; this
          // hook owns the one WS connection, so the invalidation happens
          // here — the same split useOrchestration's keys use.
          void queryClient.invalidateQueries({
            queryKey: overseerKey(port, event.conversationId),
          });
          void queryClient.invalidateQueries({
            queryKey: agentSessionsQueryKey,
          });
        } else if (event.type === 'note.changed') {
          void queryClient.invalidateQueries({ queryKey: notesQueryKey });
        } else if (event.type === 'draft.changed') {
          void queryClient.invalidateQueries({ queryKey: draftsQueryKey });
          void queryClient.invalidateQueries({
            queryKey: agentSessionsQueryKey,
          });
        } else if (event.type === 'review.changed') {
          // The run the event names, whichever surface shows it — the selected run here
          // or a task page's own (useRunData shares these keys).
          void queryClient.invalidateQueries({
            queryKey: runReviewKey(port, event.runId),
          });
          // The server broadcasts this same event for a reviewer's inline edit and an
          // applied suggestion — both commit straight onto the run branch, so the diff
          // itself (not just its comment thread) is now stale too.
          void queryClient.invalidateQueries({
            queryKey: runDiffKey(port, event.runId),
          });
        } else if (event.type === 'comment.changed') {
          // One thread refetches, and only while a page shows it; the board never does.
          void queryClient.invalidateQueries({
            queryKey: taskCommentsKey(port, event.taskId),
          });
        } else if (event.type === 'inbox.changed') {
          void queryClient.invalidateQueries({ queryKey: inboxQueryKey });
          // The daemon triages captures in the background and announces
          // the result on the same event, so the hints refresh with the rows.
          void queryClient.invalidateQueries({
            queryKey: inboxTriageQueryKey,
          });
        } else if (event.type === 'git.changed') {
          // Prefix match: invalidates every query useGit.ts builds in one call.
          void queryClient.invalidateQueries({ queryKey: gitQueryRootKey });
          // A git-level mutation can change dispatch's own worktree bookkeeping too, so
          // the Branches panel's GitSummary chips don't go stale until a manual refresh.
          void queryClient.invalidateQueries({ queryKey: branchesQueryKey });
          // A pull can rewrite config.yml, which broadcasts no `config.changed`.
          refetchConfig();
        } else if (event.type === 'merge-queue.changed') {
          void queryClient.invalidateQueries({
            queryKey: mergeQueueQueryKey,
          });
          // Queue progress moves the landing table's in-queue rows too.
          void queryClient.invalidateQueries({
            queryKey: landingQueryKey,
          });
        } else if (event.type === 'landing.changed') {
          void queryClient.invalidateQueries({
            queryKey: landingQueryKey,
          });
        } else if (event.type === 'finding.changed') {
          void queryClient.invalidateQueries({
            queryKey: findingsQueryRootKey(port),
          });
        } else if (event.type === 'ledger.changed') {
          void queryClient.invalidateQueries({
            queryKey: ledgerQueryRootKey(port),
          });
        } else if (event.type === 'memory.changed') {
          // A personal change names no entry, so every memory query refetches.
          void queryClient.invalidateQueries({
            queryKey: memoryQueryRootKey(port),
          });
        } else if (event.type === 'fixloop.changed') {
          // The root covers the per-task query and the bulk by-task map.
          void queryClient.invalidateQueries({
            queryKey: fixLoopQueryRootKey(port),
          });
        } else if (event.type === 'fixloop.capped') {
          void queryClient.invalidateQueries({
            queryKey: fixLoopQueryRootKey(port),
          });
          // A stopped loop needs a human — a toast plus a durable inbox row,
          // worded from the stop reason.
          const liveTasks =
            queryClient.getQueryData<TaskListItem[]>(tasksQueryKey);
          const taskTitle =
            liveTasks?.find((t) => t.meta.id === event.taskId)?.meta.title ??
            event.taskId;
          const notice = fixLoopCappedNotice(
            taskTitle,
            event.reason,
            event.message
          );
          void notify(notice.title, taskTitle, 'fix-loop-capped');
          onRecordInbox([
            {
              ts: new Date().toISOString(),
              title: notice.title,
              body: notice.body,
              target: { kind: 'task', taskId: event.taskId },
            },
          ]);
        } else if (event.type === 'epic.changed') {
          // A session started, paused, resumed, stopped, completed or filled
          // a batch — the bulk progress query is the one reader.
          refreshEpicProgress();
        } else if (event.type === 'epic.paused') {
          refreshEpicProgress();
          // A session that paused itself needs a human to resume or raise
          // the ceiling — a toast plus a durable inbox row, worded from the
          // event's own numbers so neither waits on the refetch above.
          const liveTasks =
            queryClient.getQueryData<TaskListItem[]>(tasksQueryKey);
          const epicTitle =
            liveTasks?.find((t) => t.meta.id === event.epicId)?.meta.title ??
            event.epicId;
          const notice = epicPausedNotice(epicTitle, event);
          void notify(notice.title, notice.body);
          onRecordInbox([
            {
              ts: new Date().toISOString(),
              title: notice.title,
              body: notice.body,
              target: { kind: 'task', taskId: event.epicId },
            },
          ]);
        } else if (event.type === 'config.changed') {
          // Settings in another window, the CLI, and Linear connect/disconnect
          // all write config; without this branch they sit stale here.
          refetchConfig();
        } else if (event.type === 'run.survey') {
          // Same cache-read reason as message.new above. This is the
          // only signal that a terminal run left uncommitted work behind.
          const liveRuns = queryClient.getQueryData<RunMeta[]>(runsQueryKey);
          const taskTitle =
            liveRuns?.find((r) => r.id === event.runId)?.taskTitle ??
            event.runId;
          const notice = runSurveyNotice(taskTitle, event.survey);
          if (notice !== null) {
            void notify(notice.title, notice.body, 'run-stalled');
            onRecordInbox([
              {
                ts: new Date().toISOString(),
                title: notice.title,
                body: notice.body,
                target: { kind: 'run', runId: event.runId },
              },
            ]);
          }
        } else if (event.type === 'a2a.changed') {
          // Every Settings → A2A query shares this prefix (lib/a2a.ts).
          void queryClient.invalidateQueries({ queryKey: ['dispatch-a2a'] });
        } else if (event.type === 'verification.changed') {
          void queryClient.invalidateQueries({
            queryKey: taskVerificationKey(port, event.taskId),
          });
        } else if (
          event.type === 'board.sync' ||
          event.type === 'receipts.export'
        ) {
          // Both feed the same chip — a project has a board syncer or a
          // receipts exporter, never both — and GET /api/sync carries both
          // halves. Refetches rather than reading `event.result` straight
          // into the cache: the pending counts the chip also shows are
          // computed live server-side and aren't part of either payload.
          void queryClient.invalidateQueries({
            queryKey: syncStatusQueryKey,
          });
        } else if (event.type === 'linear.progress') {
          // An import moved on: patch the status in place, no refetch.
          queryClient.setQueryData<LinearStatus>(linearStatusQueryKey, (prev) =>
            prev === undefined ? prev : { ...prev, progress: event.progress }
          );
        } else if (event.type === 'linear.changed') {
          // A sync pass finished — refetch status (lastSyncAt/lastSummary/lastError) so
          // Settings reflects it immediately rather than waiting on its own poll.
          void queryClient.invalidateQueries({
            queryKey: linearStatusQueryKey,
          });
          // The pass may have linked a new issue — refetch so a chip appears without
          // waiting for this window's own action to trigger it.
          void queryClient.invalidateQueries({
            queryKey: linearLinksQueryKey,
          });
        } else if (event.type === 'queue.drained') {
          // The drain reviewed runs (tasks/runs move to done) and may have
          // pushed origin (branches' pushedToOrigin flips) — refetch all
          // four rather than waiting on their own *.changed broadcasts.
          void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
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
          // class the inbox exists for — `lastPushError`'s own banner
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
    });
    return () => {
      if (listTimer !== null) clearTimeout(listTimer);
      if (epicTimer !== null) clearTimeout(epicTimer);
      disconnect();
    };
  }, [
    client,
    queryClient,
    applyTaskDoc,
    tasksQueryKey,
    configQueryKey,
    runsQueryKey,
    presenceQueryKey,
    whoamiQueryKey,
    notesQueryKey,
    draftsQueryKey,
    agentSessionsQueryKey,
    inboxQueryKey,
    inboxTriageQueryKey,
    epicProgressKeyPrefix,
    mergeQueueQueryKey,
    landingQueryKey,
    branchesQueryKey,
    decisionsQueryKey,
    linearStatusQueryKey,
    linearLinksQueryKey,
    syncStatusQueryKey,
    port,
    onRecordInbox,
    auth,
  ]);

  const blockedIds = useMemo(
    () => computeBlockedIds(tasks ?? [], statusModel),
    [tasks, statusModel]
  );

  // A run already live when the window opened shows the step its record carries (a daemon
  // that sends `lastStep`) until its next `run.log`, instead of the agent's name.
  useEffect(() => {
    for (const run of runs ?? []) {
      if (isTerminalRunState(run.state)) continue;
      const step = runStepFromRecord(run);
      if (step !== null) runSteps.seed(run.id, step);
    }
  }, [runs]);

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

  const attentionByTaskId = useMemo(
    () =>
      deriveTaskAttentionById(
        latestRunByTaskId,
        taskIdsWithOpenAsks(runs ?? [], openQuestions, pendingScopeRequests),
        mergeQueue ?? null
      ),
    [latestRunByTaskId, runs, openQuestions, pendingScopeRequests, mergeQueue]
  );

  // Optimistic like the board's status drag: the list row and the open task's body show
  // the edit at once; a refused PATCH restores just this task, not a whole-list snapshot
  // that could clobber events that landed meanwhile.
  const handleUpdate = useCallback(
    async (id: string, patch: UpdatePatch): Promise<void> => {
      if (client === null) return;
      const docKey = taskDocKey(port, id);
      const prevItem = queryClient
        .getQueryData<TaskListItem[]>(tasksQueryKey)
        ?.find((t) => t.meta.id === id);
      const prevDoc = queryClient.getQueryData<TaskDoc>(docKey);
      if (prevItem !== undefined && touchesMeta(patch)) {
        queryClient.setQueryData<TaskListItem[]>(tasksQueryKey, (old) =>
          old?.map((t) =>
            t.meta.id === id ? { ...t, meta: patchedMeta(t.meta, patch) } : t
          )
        );
      }
      if (prevDoc !== undefined && touchesBody(patch)) {
        queryClient.setQueryData<TaskDoc>(docKey, {
          ...prevDoc,
          body: patchedBody(prevDoc.body, patch),
        });
      }
      let updated: TaskDoc;
      try {
        updated = await client.updateTask(id, patch);
      } catch (err) {
        if (prevItem !== undefined) {
          queryClient.setQueryData<TaskListItem[]>(tasksQueryKey, (old) =>
            old?.map((t) => (t.meta.id === id ? prevItem : t))
          );
        }
        if (prevDoc !== undefined) queryClient.setQueryData(docKey, prevDoc);
        throw err;
      }
      applyTaskDoc(updated);
    },
    [client, queryClient, applyTaskDoc, tasksQueryKey, port]
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
      // Read from the cache, so the callback keeps its identity as tasks change.
      const previous = queryClient.getQueryData<TaskListItem[]>(tasksQueryKey);
      const moving = previous?.find((doc) => doc.meta.id === id);
      if (moving?.meta.archivedAt !== undefined) return;
      queryClient.setQueryData<TaskListItem[]>(tasksQueryKey, (old) =>
        old?.map((doc) =>
          doc.meta.id === id ? { ...doc, meta: { ...doc.meta, status } } : doc
        )
      );
      let updated: TaskDoc;
      try {
        updated = await client.updateTask(id, { status });
      } catch (err) {
        if (previous !== undefined) {
          queryClient.setQueryData(tasksQueryKey, previous);
        }
        throw err;
      }
      applyTaskDoc(updated);
    },
    [client, queryClient, applyTaskDoc, tasksQueryKey]
  );

  const handleCreate = useCallback(
    async (input: CreateInput): Promise<TaskDoc | null> => {
      if (client === null) return null;
      const created = await client.createTask(input);
      applyTaskDoc(created);
      return created;
    },
    [client, applyTaskDoc]
  );

  // The create dialog's post-create upload; the `handle` prefix puts it under
  // withActionFeedback's error toasts. The task page's row talks to the client
  // itself and toasts per file.
  const handleUploadAttachments = useCallback(
    async (taskId: string, files: File[]): Promise<void> => {
      if (client === null) return;
      applyTaskDoc(await client.uploadTaskAttachments(taskId, files));
    },
    [client, applyTaskDoc]
  );

  // Seeds the drafts query with the 202's `running` record immediately, so the tray shows it
  // without waiting on a refetch.
  const handleStartDraft = useCallback(
    async (
      prompt: string,
      options?: { parent?: string | null }
    ): Promise<DraftRecord> => {
      if (client === null) throw new Error('dispatchd client not ready');
      const record = await client.draftTask(prompt, options);
      queryClient.setQueryData<DraftRecord[]>(draftsQueryKey, (prev) => [
        record,
        ...(prev ?? []),
      ]);
      return record;
    },
    [client, queryClient, draftsQueryKey]
  );

  // Removed from the cache optimistically, ahead of the round trip, so the tray row
  // disappears the instant it's actioned.
  const handleDismissDraft = useCallback(
    async (id: string): Promise<void> => {
      if (client === null) return;
      queryClient.setQueryData<DraftRecord[]>(draftsQueryKey, (prev) =>
        prev?.filter((d) => d.id !== id)
      );
      await client.dismissDraft(id);
      void queryClient.invalidateQueries({ queryKey: draftsQueryKey });
    },
    [client, queryClient, draftsQueryKey]
  );

  // Seeds the drafts cache with the 202's `running` record (mirrors handleSendPlanMessage),
  // then invalidates to re-sync once the follow-up turn settles via `draft.changed`.
  const handleSendDraftMessage = useCallback(
    async (draftId: string, text: string): Promise<DraftRecord> => {
      if (client === null) throw new Error('dispatchd client not ready');
      const record = await client.sendDraftMessage(draftId, text);
      queryClient.setQueryData<DraftRecord[]>(draftsQueryKey, (prev) =>
        prev?.map((d) => (d.id === draftId ? record : d))
      );
      void queryClient.invalidateQueries({ queryKey: draftsQueryKey });
      return record;
    },
    [client, queryClient, draftsQueryKey]
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

  // Manual refetch for the Branches and Landed views. This surface has no
  // polling (each row costs several git shell-outs), and git state can change
  // entirely outside the app — the user's own terminal — so an explicit
  // refresh is the only way to pick that up. Runs are invalidated too: both
  // views join branch refs with run data (Landed's merged rows are run rows).
  const handleRefreshBranches = useCallback(async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: branchesQueryKey }),
      queryClient.invalidateQueries({ queryKey: runsQueryKey }),
    ]);
  }, [queryClient, branchesQueryKey, runsQueryKey]);

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

  // Promoting a note into a task refetches the note (it gains its linked-task
  // marker); the new task reaches the board through its `task.changed`.
  const handlePromoteNote = useCallback(
    async (id: string): Promise<void> => {
      if (client === null) return;
      await client.promoteNote(id);
      void queryClient.invalidateQueries({ queryKey: notesQueryKey });
    },
    [client, queryClient, notesQueryKey]
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
    },
    [client, notePlanId, queryClient, notesQueryKey, tasksQueryKey]
  );

  const handleDispatch = useCallback(
    async (
      taskId: string,
      executor?: string,
      model?: string,
      opts?: DispatchOptions
    ): Promise<void> => {
      if (client === null) return;
      if (opts?.optimistic === true) {
        await dispatchInPlace(taskId);
        const failure = dispatchFailures.current.get(taskId);
        dispatchFailures.current.delete(taskId);
        if (failure !== undefined) throw failure;
        return;
      }
      // Only a Claude dispatch carries the picker's model (the picker lists
      // Claude ids); any other executor resolves its own default server-side.
      const effective = executor ?? executors?.default ?? 'claude';
      const meta = await client.createRun(taskId, {
        executor,
        model:
          model ??
          (effective === 'claude' ? resolveExecuteModel(config) : undefined),
        effort: opts?.effort,
      });
      // The task's own status change arrives as a `task.changed` naming it.
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
      // A batch member stays where the user is; only a lone dispatch follows its
      // run. See DispatchOptions for what firing this per task looks like.
      if (opts?.batch !== true) onRunDispatched?.(meta.id, meta.taskId);
    },
    [
      client,
      config,
      executors,
      queryClient,
      runsQueryKey,
      onRunDispatched,
      dispatchInPlace,
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
      // Answering a gate needs a deciding human, so an attached window fails
      // here with the actionable sentence rather than a 403.
      assertCanDecide(auth);
      const gates =
        queryClient.getQueryData<{ items: Message[] }>(openGatesKey(port))
          ?.items ?? NO_GATES;
      const gate = findToolApprovalGate(gates, runId, requestId);
      if (gate === null) {
        throw new Error('This approval is no longer waiting for you.');
      }
      await client.replyToMessage(gate.id, approvalReply(allow, opts));
      dropOpenGate(queryClient, port, gate.id);
      void queryClient.invalidateQueries({ queryKey: openGatesKey(port) });
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
      void queryClient.invalidateQueries({ queryKey: ['dispatch-run', port] });
    },
    [client, queryClient, runsQueryKey, port, auth]
  );

  const fetchApprovalInput = useCallback(
    async (runId: string, requestId: string): Promise<unknown> => {
      if (client === null) throw new Error('dispatchd client not ready');
      // The full input is decide-tier, like the gate it belongs to.
      assertCanDecide(auth);
      return (await client.fetchRunApproval(runId, requestId)).input;
    },
    [client, auth]
  );

  const fetchOverseerApprovalInput = useCallback(
    async (conversation: string, requestId: string): Promise<unknown> => {
      if (client === null) throw new Error('dispatchd client not ready');
      assertCanDecide(auth);
      const { pendingApprovals } = await client.getOverseer(conversation);
      const parked = pendingApprovals.find((a) => a.requestId === requestId);
      if (parked === undefined) {
        throw new Error('The Assistant is no longer waiting on this call.');
      }
      return parked.input;
    },
    [client, auth]
  );

  const handleDecideScopeRequest = useCallback(
    async (
      _runId: string,
      requestId: string,
      granted: boolean,
      reason?: string
    ): Promise<void> => {
      if (client === null) return;
      // Deciding is a gate answer, which an attached session cannot give; the
      // daemon would 403 it, so fail here with the actionable sentence.
      assertCanDecide(auth);
      await client.replyToMessage(requestId, {
        body: reason ?? '',
        choice: granted ? 'grant' : 'deny',
      });
      dropOpenGate(queryClient, port, requestId);
      void queryClient.invalidateQueries({ queryKey: openGatesKey(port) });
      void queryClient.invalidateQueries({ queryKey: ['dispatch-run', port] });
    },
    [client, queryClient, port, auth]
  );

  // Replaces an attached daemon with one this app spawns, so it can read the
  // app token off stdout. Refetches the connection query, which rebuilds the
  // client (new port, new token) and re-enables the decide surfaces.
  const handleRestartDaemon = useCallback(async (): Promise<void> => {
    if (projectPath === null) return;
    await restartDispatchd(projectPath);
    await retryEnsureDispatchd();
    await queryClient.invalidateQueries();
  }, [projectPath, retryEnsureDispatchd, queryClient]);

  const handleAnswerQuestion = useCallback(
    async (
      _runId: string,
      questionId: string,
      answer: string
    ): Promise<void> => {
      if (client === null) return;
      // Questions go to the owner, so only a deciding human takes part.
      assertCanDecide(auth);
      const choices = queryClient
        .getQueryData<{ items: Message[] }>(openGatesKey(port))
        ?.items.find((m) => m.id === questionId)?.choices;
      await client.replyToMessage(
        questionId,
        choices?.includes(answer) === true
          ? { body: answer, choice: answer }
          : { body: answer }
      );
      dropOpenGate(queryClient, port, questionId);
      void queryClient.invalidateQueries({ queryKey: openGatesKey(port) });
      void queryClient.invalidateQueries({ queryKey: ['dispatch-run', port] });
    },
    [client, queryClient, port, auth]
  );

  const handleSendMessage = useCallback(
    async (runId: string, text: string): Promise<void> => {
      if (client === null) return;
      assertCanMessage(auth);
      await client.sendMessage({
        to: [`run:${runId}`],
        kind: 'message',
        body: text,
      });
      void queryClient.invalidateQueries({ queryKey: ['dispatch-run', port] });
    },
    [client, queryClient, port, auth]
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

  const handleStopRun = useCallback(
    async (runId: string): Promise<void> => {
      if (client === null) return;
      await client.stopRun(runId);
      // The run is still live — this refetch is what swaps the button to
      // "Stopping…"; the terminal state arrives later on its own.
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
      // Task changes arrive over `task.changed`.
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
    },
    [client, queryClient, runsQueryKey]
  );

  const handleRequestChanges = useCallback(
    async (runId: string, text: string): Promise<void> => {
      if (client === null) return;
      assertCanMessage(auth);
      const before = new Set((await client.fetchRuns()).map((r) => r.id));
      // A human's wake of an ended run continues exactly that run, inside the
      // send, so its continuation is already listed below.
      const sent = await client.sendMessage({
        to: [`run:${runId}`],
        kind: 'message',
        body: text,
        wake: 'request',
      });
      const runs = await client.fetchRuns();
      // Task changes arrive over `task.changed`.
      queryClient.setQueryData(runsQueryKey, runs);
      const continued = runs.find(
        (r) => r.resumedFrom === runId && !before.has(r.id)
      );
      if (continued !== undefined) {
        // Follow the continuation so the caller keeps showing the live run.
        onRunDispatched?.(continued.id, continued.taskId);
        return;
      }
      // A live run that took the message into its conversation simply got it.
      if (
        sent.deliveries.some(
          (d) => d.recipient === `run:${runId}` && d.state === 'pushed'
        )
      ) {
        return;
      }
      throw new Error(
        (await wakeNoticeFor(client, sent.message.id)) ??
          'The run did not continue. Your message is waiting for it.'
      );
    },
    [client, queryClient, runsQueryKey, onRunDispatched, auth]
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

  const handleWorkEpic = useCallback(
    async (epicId: string, opts: number | WorkEpicOptions): Promise<void> => {
      if (client === null) return;
      const { concurrency, maxSpendUsd, maxRuns } =
        typeof opts === 'number' ? { concurrency: opts } : opts;
      // The same opt-in the task page's hidden fake control uses: a fan-out
      // against a DISPATCH_ENABLE_FAKES daemon runs scripted agents, not Claude.
      const executor = isFakeExecutorDevToolEnabled() ? 'fake' : undefined;
      await client.startEpic(epicId, {
        concurrency,
        maxSpendUsd,
        maxRuns,
        executor,
      });
      void queryClient.invalidateQueries({ queryKey: epicProgressKeyPrefix });
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
    },
    [client, queryClient, epicProgressKeyPrefix, runsQueryKey]
  );

  const handlePauseEpic = useCallback(
    async (epicId: string): Promise<void> => {
      if (client === null) return;
      await client.pauseEpic(epicId);
      void queryClient.invalidateQueries({ queryKey: epicProgressKeyPrefix });
      void queryClient.invalidateQueries({ queryKey: runsQueryKey });
    },
    [client, queryClient, epicProgressKeyPrefix, runsQueryKey]
  );

  // Runs refetch too: a resume fills the queue straight away.
  const handleResumeEpic = useCallback(
    async (epicId: string, opts?: Partial<WorkEpicOptions>): Promise<void> => {
      if (client === null) return;
      await client.resumeEpic(epicId, opts ?? {});
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

  // Lands a finished epic branch on the default base — one PR or one local
  // merge, decided server-side. Tasks refetch because a local land flips the
  // epic to done immediately (the PR path flips it later, off the poller).
  const handleLandEpic = useCallback(
    async (epicId: string): Promise<void> => {
      if (client === null) return;
      await client.landEpic(epicId);
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      void queryClient.invalidateQueries({ queryKey: epicProgressKeyPrefix });
    },
    [client, queryClient, tasksQueryKey, epicProgressKeyPrefix]
  );

  // Returns the new plan's id so PlansView can add it to its local session history
  // immediately, without waiting on a refetch.
  const handleSubmitPrompt = useCallback(
    async (prompt: string, model?: string): Promise<string> => {
      if (client === null) throw new Error('dispatchd client not ready');
      const { planId: newPlanId } = await client.startPlan(
        prompt,
        model !== undefined ? { model } : {}
      );
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
    async (proposal: PlanProposal): Promise<ConfirmResult> => {
      if (client === null || planId === null) {
        throw new Error('no plan open to confirm');
      }
      const result = await client.confirmPlan(planId, proposal);
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      // The new epic shows up in the bulk progress list on the next fetch.
      void queryClient.invalidateQueries({ queryKey: epicProgressKeyPrefix });
      return result;
    },
    [client, planId, queryClient, tasksQueryKey, epicProgressKeyPrefix]
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

  // The feed's per-task fix-loop annotations and its Stop button.
  const fixLoops = useFixLoops(client, port);
  const stopFixLoop = useStopFixLoop(client, port);
  const handleStopFixLoop = useCallback(
    async (taskId: string): Promise<void> => {
      if (client === null) return;
      await stopFixLoop(taskId);
    },
    [client, stopFixLoop]
  );

  // Task 8: the "Merge all ready" toolbar action — enqueues every eligible
  // run in the project in one call. Also doubles as the Landing table's push-failure
  // Retry: called with nothing new to enqueue, this still kicks the queue's
  // pump, which retries a failed drain-push per `lastDrainPushFailed` on the
  // server (see mergeQueue.ts). The `merge-queue.changed`/`queue.drained`
  // broadcasts (not this invalidation) are what actually clear the
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
      /** Replacement text for the commented lines. Omitted for a prose-only comment. */
      suggestion?: string;
    }): Promise<ReviewComment> => {
      // Mirrors `handleEnrichTask`'s guard: this must resolve with a real comment or throw,
      // never resolve with nothing — `Apply now` awaits this to get the id it applies next.
      if (client === null || selectedRunId === null) {
        throw new Error('dispatchd client not ready');
      }
      const created = await client.addReviewComment(
        { kind: 'run', runId: selectedRunId },
        input
      );
      invalidateReview();
      return created;
    },
    [client, selectedRunId, invalidateReview]
  );

  // Commits a comment's suggestion onto the run branch. The server broadcasts `review.changed`
  // on success, which the socket handler above already turns into a `runDiffQueryKey`
  // invalidation — this call adds the same immediate `reviewQueryKey` refresh the other review
  // actions here give themselves, rather than waiting on that round trip.
  const handleApplySuggestion = useCallback(
    async (commentId: string): Promise<void> => {
      // Same rule as `handleAddReviewComment`: resolve only when the POST really happened, or
      // throw. Resolving with nothing would let the thread render a landed "Applied" — and
      // evict the file cache — for a request that was never sent.
      if (client === null || selectedRunId === null) {
        throw new Error('dispatchd client not ready');
      }
      await client.applySuggestion(selectedRunId, commentId);
      invalidateReview();
    },
    [client, selectedRunId, invalidateReview]
  );

  const handleResolveReviewComment = useCallback(
    async (commentId: string, resolved: boolean): Promise<void> => {
      if (client === null || selectedRunId === null) return;
      await client.resolveReviewComment(
        { kind: 'run', runId: selectedRunId },
        commentId,
        resolved
      );
      invalidateReview();
    },
    [client, selectedRunId, invalidateReview]
  );

  const handleReplyReviewComment = useCallback(
    async (commentId: string, body: string): Promise<void> => {
      if (client === null || selectedRunId === null) return;
      await client.replyReviewComment(
        { kind: 'run', runId: selectedRunId },
        commentId,
        body
      );
      invalidateReview();
    },
    [client, selectedRunId, invalidateReview]
  );

  const handleSubmitReview = useCallback(
    async (
      verdict: import('@dispatch/client').ReviewVerdict,
      body: string,
      postToGitHub = false
    ): Promise<{ published: number; error?: string }> => {
      if (client === null || selectedRunId === null) return { published: 0 };
      const res = await client.submitReview(
        selectedRunId,
        verdict,
        body,
        postToGitHub
      );
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
      maxConcurrency?: number;
      runCostEstimateUsd?: number;
      verifyTimeoutSec?: number;
      permissionMode?: string;
      models?: Partial<ModelConfig>;
      linear?: {
        enabled?: boolean;
        teamId?: string | null;
        teamIds?: string[];
        statusMap?: Record<string, string>;
        intervalSec?: number;
        direction?: 'both' | 'pull' | 'push';
        includeAcceptanceCriteria?: boolean;
      };
      statusRoles?: StatusRoles | null;
      maxTurns?: number | null;
      maxBudgetUsd?: number | null;
      fixLoop?: { cap?: number; escalation?: EscalationStep[] };
      verify?: { command?: string; url?: string; notes?: string };
      notifications?: {
        kinds?: Partial<Record<NotificationKind, boolean>>;
        webhook?: string | null;
      };
      policy?: {
        rung?: number;
        gates?: Partial<Record<PolicyGate, PolicyGateMode | null>>;
      };
    }): Promise<void> => {
      if (client === null) return;
      await client.updateConfig(patch);
      void queryClient.invalidateQueries({ queryKey: configQueryKey });
    },
    [client, queryClient, configQueryKey]
  );

  // Posts the key once via POST /api/linear/connect and never sees it again — the response
  // carries the viewer Linear validated it against, not the key itself.
  const handleConnectLinear = useCallback(
    async (
      apiKey: string
    ): Promise<{ connected: boolean; viewer: LinearViewer }> => {
      if (client === null) throw new Error('dispatchd client not ready');
      const result = await client.connectLinear(apiKey);
      void queryClient.invalidateQueries({ queryKey: linearStatusQueryKey });
      return result;
    },
    [client, queryClient, linearStatusQueryKey]
  );

  const handleDisconnectLinear = useCallback(async (): Promise<void> => {
    if (client === null) return;
    await client.disconnectLinear();
    void queryClient.invalidateQueries({ queryKey: linearStatusQueryKey });
    void queryClient.invalidateQueries({ queryKey: linearTeamsQueryKey });
  }, [client, queryClient, linearStatusQueryKey, linearTeamsQueryKey]);

  const handleSyncLinear = useCallback(
    async (taskIds?: string[]): Promise<LinearSyncSummary> => {
      if (client === null) throw new Error('dispatchd client not ready');
      const result = await client.syncLinear(taskIds);
      void queryClient.invalidateQueries({ queryKey: linearStatusQueryKey });
      void queryClient.invalidateQueries({ queryKey: linearLinksQueryKey });
      // A push-only pass never broadcasts task.changed (that only fires on a pull), so the
      // tasks caches need their own invalidation here too — same shape as handleImportLinear.
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      return result;
    },
    [
      client,
      queryClient,
      linearStatusQueryKey,
      linearLinksQueryKey,
      tasksQueryKey,
    ]
  );

  const handleImportLinear =
    useCallback(async (): Promise<LinearSyncSummary> => {
      if (client === null) throw new Error('dispatchd client not ready');
      const result = await client.importLinearIssues();
      void queryClient.invalidateQueries({ queryKey: linearStatusQueryKey });
      void queryClient.invalidateQueries({ queryKey: linearLinksQueryKey });
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      return result;
    }, [
      client,
      queryClient,
      linearStatusQueryKey,
      linearLinksQueryKey,
      tasksQueryKey,
    ]);

  const handleClusterInbox = useCallback(async () => {
    if (client === null) return { groups: [], error: null };
    const res = await client.clusterInbox();
    // A successful pass was persisted server-side; refetch the snapshot so
    // every consumer renders the same result the call returned.
    void queryClient.invalidateQueries({ queryKey: inboxClustersQueryKey });
    void queryClient.invalidateQueries({ queryKey: inboxTriageQueryKey });
    return res;
  }, [client, queryClient, inboxClustersQueryKey, inboxTriageQueryKey]);

  // Retries every entry the queue is holding on a `blocked-environment` (a dirty checkout, a
  // staged index, the wrong branch). Deliberately queue-wide rather than per-entry, because the
  // server's endpoint is: the block is a property of the shared checkout, not of one entry, so
  // one fix unblocks all of them at once.
  const handleRecheckMergeQueue = useCallback(async (): Promise<void> => {
    if (client === null) return;
    await client.recheckMergeQueue();
    void queryClient.invalidateQueries({ queryKey: mergeQueueQueryKey });
  }, [client, queryClient, mergeQueueQueryKey]);

  // Notifies on run finished/failed transitions, merge-queue merged/failed
  // transitions, and planner/run questions waiting on the user — see
  // useTransitionNotifications's own comment for why it needs the *lists*
  // (not just this render's counts) to diff against what it last saw. `projectPath`
  // is threaded through so a project switch resets its tracking (see
  // resetTrackingForRoot) instead of diffing the new project against the old one's
  // leftover state — this hook's `projectPath` argument swaps in place rather than
  // remounting on a project switch.
  useTransitionNotifications(
    projectPath,
    runs ?? [],
    mergeQueue ?? null,
    drafts ?? [],
    planRecord,
    openQuestions,
    onRecordInbox
  );

  // Whether this window can adjudicate scope requests, plus what to say and
  // offer when it cannot. Depends on the run list because a restart ends any
  // run in flight.
  const scopeDecide = useMemo(
    () => decideAvailability(auth, runs ?? []),
    [auth, runs]
  );
  const access = useMemo(() => messageAccess(auth), [auth]);

  // Memoized so consumers holding `data` (and memo'd rows reading from it) only
  // re-render when something they could read actually changed.
  return useMemo(
    () => ({
      client,
      port,
      daemonBaseUrl:
        connection === undefined ? null : daemonBaseUrl(connection),
      presence: presence ?? [],
      me: whoami?.ref ?? null,
      whoamiError,
      retryWhoami: () => void refetchWhoami(),
      localHuman: peopleSnapshot?.local ?? null,
      people: peopleSnapshot?.people ?? NO_PEOPLE,
      myTier: whoami?.tier ?? credentialTier(connection),
      attachedWithoutAppToken:
        connection !== undefined &&
        connection.session === undefined &&
        (connection.appToken === null || connection.appToken === ''),
      portLoading,
      portError,
      portErrorDetail,
      retryEnsureDispatchd: () => void retryEnsureDispatchd(),

      tasks: tasks ?? [],
      tasksLoading,
      tasksReady: tasks !== undefined && allTasksFetched,
      tasksIncludingArchived: allTasksIncludingArchived ?? [],
      archivedTasks,
      showArchived,
      setShowArchived,
      config: config ?? null,
      executors: executors ?? null,
      runs: runs ?? [],
      visibleRuns,
      health,
      readyIds,
      blockedIds,
      epics,
      epicProgressById,
      liveEpicSessions,
      liveRunStateByTaskId,
      latestRunByTaskId,
      attentionByTaskId,
      mergeQueue: mergeQueue ?? null,
      repoPrs: repoPrs ?? null,
      landing: landing ?? null,
      landingIsError,
      landingRefetch: () => void landingRefetch(),

      runDetail,
      diff,
      diffLoading,
      diffError,
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
      pendingScopeRequests,
      handleDecideScopeRequest,
      scopeDecide,
      messageAccess: access,
      handleRestartDaemon,
      openQuestions,
      asksMe,
      decisions: decisionList ?? [],
      handleAnswerQuestion,

      planId,
      setPlanId,
      planRecord,

      handleUpdate,
      moveTaskStatus,
      handleCreate,
      handleUploadAttachments,
      drafts: drafts ?? [],
      agentSessions: agentSessions ?? [],
      handleStartDraft,
      handleDismissDraft,
      handleSendDraftMessage,
      handleDispatch,
      handleApprove,
      fetchApprovalInput,
      fetchOverseerApprovalInput,
      handleSendMessage,
      handleCancelRun,
      handleStopRun,
      handleArchiveRun,
      handleReview,
      handleRequestChanges,
      handleOpenPr,
      handleWorkEpic,
      handlePauseEpic,
      handleResumeEpic,
      handleStopEpic,
      handleLandEpic,
      handleSubmitPrompt,
      handleSendPlanMessage,
      handleConfirmPlan,
      handleEnqueueMerge,
      handleEnqueueMergeStack,
      handleDequeueMerge,
      fixLoops,
      handleStopFixLoop,
      handleMergeAllReady,
      handleRecheckMergeQueue,
      lastPushError,

      notificationInbox,
      markNotificationInboxRead,
      markNotificationRead,

      inbox: inbox ?? [],
      handleCaptureInbox,
      handleUpdateInboxItem,
      handleDismissInbox,
      handleConvertInbox,
      handleEnrichTask,
      enrichTaskId: enrichPlan?.taskId ?? null,
      enrichPlanRecord,
      handleDismissEnrich,
      handleClusterInbox,
      inboxClusters: inboxClusters ?? null,
      inboxTriage: inboxTriage ?? null,
      readinessById,
      plans: plans ?? [],
      reviewComments: reviewComments ?? [],
      handleAddReviewComment,
      handleApplySuggestion,
      handleResolveReviewComment,
      handleReplyReviewComment,
      handleSendBack,
      handleSubmitReview,
      handleUpdateConfig,
      syncStatus: syncStatus ?? null,
      linearStatus: linearStatus ?? null,
      linearTeams: linearTeams ?? [],
      linearTeamsError,
      refetchLinearTeams,
      linearLinks: linearLinks ?? {},
      handleConnectLinear,
      handleDisconnectLinear,
      handleSyncLinear,
      handleImportLinear,
    }),
    [
      client,
      port,
      connection,
      presence,
      whoami,
      whoamiError,
      refetchWhoami,
      peopleSnapshot,
      portLoading,
      portError,
      portErrorDetail,
      retryEnsureDispatchd,
      tasks,
      tasksLoading,
      allTasksFetched,
      allTasksIncludingArchived,
      archivedTasks,
      showArchived,
      setShowArchived,
      config,
      executors,
      runs,
      visibleRuns,
      health,
      readyIds,
      blockedIds,
      epics,
      epicProgressById,
      liveEpicSessions,
      liveRunStateByTaskId,
      latestRunByTaskId,
      attentionByTaskId,
      mergeQueue,
      repoPrs,
      landing,
      landingIsError,
      landingRefetch,
      runDetail,
      diff,
      diffLoading,
      diffError,
      branches,
      branchesLoading,
      handleRefreshBranches,
      handleFreeBranchDisk,
      handleDeleteBranch,
      notes,
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
      pendingScopeRequests,
      handleDecideScopeRequest,
      scopeDecide,
      access,
      handleRestartDaemon,
      openQuestions,
      asksMe,
      decisionList,
      handleAnswerQuestion,
      planId,
      setPlanId,
      planRecord,
      handleUpdate,
      moveTaskStatus,
      handleCreate,
      handleUploadAttachments,
      drafts,
      agentSessions,
      handleStartDraft,
      handleDismissDraft,
      handleSendDraftMessage,
      handleDispatch,
      handleApprove,
      fetchApprovalInput,
      fetchOverseerApprovalInput,
      handleSendMessage,
      handleCancelRun,
      handleStopRun,
      handleArchiveRun,
      handleReview,
      handleRequestChanges,
      handleOpenPr,
      handleWorkEpic,
      handlePauseEpic,
      handleResumeEpic,
      handleStopEpic,
      handleLandEpic,
      handleSubmitPrompt,
      handleSendPlanMessage,
      handleConfirmPlan,
      handleEnqueueMerge,
      handleEnqueueMergeStack,
      handleDequeueMerge,
      fixLoops,
      handleStopFixLoop,
      handleMergeAllReady,
      handleRecheckMergeQueue,
      lastPushError,
      notificationInbox,
      markNotificationInboxRead,
      markNotificationRead,
      inbox,
      handleCaptureInbox,
      handleUpdateInboxItem,
      handleDismissInbox,
      handleConvertInbox,
      handleEnrichTask,
      enrichPlan,
      enrichPlanRecord,
      handleDismissEnrich,
      handleClusterInbox,
      inboxClusters,
      inboxTriage,
      readinessById,
      plans,
      reviewComments,
      handleAddReviewComment,
      handleApplySuggestion,
      handleResolveReviewComment,
      handleReplyReviewComment,
      handleSendBack,
      handleSubmitReview,
      handleUpdateConfig,
      syncStatus,
      linearStatus,
      linearTeams,
      linearTeamsError,
      refetchLinearTeams,
      linearLinks,
      handleConnectLinear,
      handleDisconnectLinear,
      handleSyncLinear,
      handleImportLinear,
    ]
  );
}
