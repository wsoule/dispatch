import type {
  CreateInput,
  DispatchConfig,
  ModelConfig,
  Priority,
  TaskDoc,
  UpdatePatch,
} from '@dispatch/core';

// Extracted from @dispatch/web (Phase 2R Slice R2) so the same dispatchd
// client can serve both @dispatch/web (baseUrl '' == same origin, since
// dispatchd serves its own static files) and the Tauri desktop app (an
// explicit http://127.0.0.1:<port> the Rust sidecar hands back from
// `ensure_dispatchd`). Every function below takes `baseUrl` as its first
// argument — "baseUrl-first" — rather than reading it from `import.meta.env`,
// which was web-only and not something this package can depend on.

export interface HealthPayload {
  ok: boolean;
  version: string;
  rootDir: string;
  // Phase 5 P1: whether this project can use the PR review action (gh on
  // PATH + a configured git remote) — gates whether the desktop UI shows
  // the "Open PR" action at all.
  pr: boolean;
}

export interface TaskFilter {
  status?: string;
  kind?: string;
  parent?: string;
  archived?: boolean;
}

// Mirrors packages/server/src/orchestrator/types.ts's RunState exactly —
// dispatchd is the source of truth for these strings, this is just the
// client-side copy of the same contract (the client package can't import
// server internals across the package boundary).
export type RunState =
  | 'provisioning'
  | 'running'
  | 'awaiting-approval'
  | 'finished'
  | 'failed'
  | 'cancelled';

// Mirrors RunMeta in packages/server/src/orchestrator/types.ts.
export interface RunMeta {
  id: string;
  taskId: string;
  taskTitle: string;
  executor: string;
  state: RunState;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  createdAt: string;
  updatedAt: string;
  costUsd?: number;
  turns?: number;
  sessionId?: string;
  error?: string;
  /** The Claude model this run was dispatched with, if one was chosen. */
  model?: string;
  // Phase 5 P1: set once a run has been reviewed (merge/discard/pr) or its PR
  // has merged — mirrors RunMeta's own one-way markers in
  // packages/server/src/orchestrator/types.ts.
  reviewedAt?: string;
  reviewAction?: 'merge' | 'discard' | 'pr';
  // The squash-merge commit sha, set only when the 'merge' review action
  // actually produced one. Mirrors RunMeta.mergeCommit in
  // packages/server/src/orchestrator/types.ts.
  mergeCommit?: string;
  // Set once the PR review action has pushed the branch and opened a GitHub
  // PR — stays set (and `reviewedAt` stays unset) until the PR poller sees it
  // merged.
  prUrl?: string;
  // Set on a follow-up run created by request-changes: the id of the
  // finished run whose session this one resumed — the earlier conversation
  // lives on that run's transcript.
  // Set when a run is archived: it stays on disk and stays reachable, but the
  // Runs list hides it by default. Archiving is the only marker here that is
  // meant to be undone, which is why the transcript line carrying it uses
  // `null` to clear rather than the `?? previous` fold every other field uses.
  archivedAt?: string;
  resumedFrom?: string;
  // Branches this run's worktree was stacked on at dispatch time (the
  // in-review blockers whose unmerged work it needed). Empty/absent for an
  // ordinary unblocked run based on the project's default branch. Mirrors
  // RunMeta.stackParents in packages/server/src/orchestrator/types.ts —
  // `stackBaseCommit` from that same type is internal bookkeeping and has no
  // client-side use, so it isn't mirrored here.
  stackParents?: string[];
  // Set when the base this run was stacked on can no longer be repaired
  // automatically, so a human has to look at it. The merge queue refuses a run
  // with this set until it's rebased onto a valid base.
  //
  // It covers three different situations (a blocker's run was discarded; a
  // restack was attempted and failed; the run sits on a multi-parent base no
  // single merge can repair), so the flag alone is not enough to render — only
  // one of the three is actually a discarded base. Always surface
  // `baseDiscardedReason`, which says which it was.
  baseDiscarded?: boolean;
  baseDiscardedReason?: string;
  // Present only on merged runs (see decorateRunsWithPushed server-side) —
  // whether the merge commit has actually reached origin's base branch.
  pushedToOrigin?: boolean;
}

// Mirrors BranchEntryStatus in packages/server/src/orchestrator/types.ts.
// 'active' = a live run is writing here (read-only); 'reviewable' = a terminal
// run nobody reviewed, so nothing cleaned it up; 'leftover' = a reviewed run
// whose ref somehow survived (a silently-failed cleanup); 'orphan' = no run
// claims this ref at all.
export type BranchEntryStatus = 'active' | 'reviewable' | 'leftover' | 'orphan';

// Mirrors BranchEntry in packages/server/src/orchestrator/types.ts — one row
// of the Branches surface, joining what git knows about a `dispatch/*` ref
// with what the run registry knows about it. The registry half is optional
// because an orphan ref has no run behind it.
export interface BranchEntry {
  branch: string;
  worktreePath?: string;
  worktreeExists: boolean;
  /**
   * Bytes the worktree occupies, when it is still on disk.
   *
   * Measured rather than estimated, but capped: a worktree is a full checkout,
   * and walking a huge one on every branch listing would make the page slower
   * than the thing it is reporting on. See `dirSizeBytes`.
   */
  diskBytes?: number;
  /**
   * Branches this one was stacked on at dispatch time.
   *
   * A stacked worktree is not independently reclaimable — its commits sit on
   * top of another branch's unmerged work — so the surface that offers to
   * delete things has to be able to see the relationship, not just the badge
   * a task card shows.
   */
  stackParents?: string[];

  dirty: boolean;
  lastCommitAt?: string;
  /** Commits this branch has that its base does not — what deletion destroys. */
  ahead: number;
  mergedIntoBase: boolean;
  runId?: string;
  taskId?: string;
  taskTitle?: string;
  runState?: RunState;
  baseBranch?: string;
  reviewedAt?: string;
  prUrl?: string;
  // True only once the run's merge commit is reachable from origin's base.
  pushedToOrigin: boolean;
  status: BranchEntryStatus;
}

// Mirrors NormalizedEntry in packages/server/src/orchestrator/types.ts — the
// one log-entry shape every executor streams, real or fake. `kind: 'message'`
// is the agent-comms identified chat channel: `from: 'user'` is the run's own
// human via the Session composer, `from: 'agent'` is either another live
// run's `agent_message` (sender named in `fromLabel`) or this run's own
// `message_user` call raised to the human.
export interface NormalizedEntry {
  ts: string;
  kind: 'assistant' | 'tool' | 'thinking' | 'system' | 'usage' | 'message';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  status?: 'running' | 'done' | 'error';
  from?: 'user' | 'agent';
  fromLabel?: string;
  // Set on this run's own `message_user` call — the agent flagging something
  // UP to the human — so the app can badge it distinctly from an inbound
  // `agent_message` (which has no `toUser` and whose `fromLabel` names a
  // different run). See the server-side NormalizedEntry for the full note.
  toUser?: boolean;
}

// The body of `GET /api/runs/:id`.
export interface RunDetail {
  meta: RunMeta;
  entries: NormalizedEntry[];
}

export interface DiffFile {
  path: string;
  status: string;
}

// The body of `GET /api/runs/:id/diff`.
export interface DiffResult {
  patch: string;
  files: DiffFile[];
}

// GitHub PR status + conversation for a run's PR — mirrors PrStatus /
// PrConversationItem / PrDetail in packages/server/src/orchestrator/pr.ts. The
// body of `GET /api/runs/:id/pr` (and what the review/comment POSTs return).
export interface PrCheckSummary {
  passed: number;
  failed: number;
  pending: number;
  total: number;
}

export interface PrStatus {
  number: number;
  url: string;
  title: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  checks: PrCheckSummary;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface PrConversationItem {
  kind: 'review' | 'comment' | 'line-comment';
  author: string;
  body: string;
  createdAt: string;
  state?: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  path?: string;
  line?: number;
}

export interface PrDetail {
  status: PrStatus;
  conversation: PrConversationItem[];
}

export type PrReviewEvent = 'approve' | 'request-changes' | 'comment';

// Mirrors RepoPr in packages/server/src/orchestrator/pr.ts — the body of
// `GET /api/prs`: every open PR in the repo, not just the ones dispatch
// itself opened (see PullRequestsView's "Other open PRs" section).
export interface RepoPr {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  author: string;
  isDraft: boolean;
  updatedAt: string;
}

// The notes/triage hub — mirrors Note / NoteKind in packages/server/src/notes.ts. A
// lightweight item (triage an agent found, a follow-up, a free note, a personal todo) that
// can later be promoted into a real task.
export type NoteKind = 'note' | 'triage' | 'followup' | 'todo';

export interface Note {
  id: string;
  kind: NoteKind;
  title: string;
  body: string;
  done: boolean;
  linkedTaskId: string | null;
  createdByRunId: string | null;
  created: string;
  updated: string;
}

export interface CreateNoteInput {
  kind: NoteKind;
  title: string;
  body?: string;
}

export interface UpdateNotePatch {
  title?: string;
  body?: string;
  kind?: NoteKind;
  done?: boolean;
}

export type ServerEvent =
  | { type: 'task.changed' }
  | { type: 'hello'; version: string }
  | { type: 'run.changed' }
  | { type: 'run.log'; runId: string; entry: NormalizedEntry }
  | {
      type: 'approval.requested';
      runId: string;
      requestId: string;
      toolName: string;
    }
  // Phase 5 P2: a plan's state (running -> ready|failed) changed, or it was
  // just confirmed. Same "go refetch" contract as the other *.changed events
  // — mirrors packages/server/src/events.ts exactly.
  | { type: 'plan.changed'; planId: string }
  | { type: 'note.changed' }
  // The merge queue's state changed (entry added/removed/advanced) — same
  // "go refetch" contract as run.changed. Mirrors
  // packages/server/src/events.ts exactly.
  | { type: 'merge-queue.changed' }
  // One chunk of a merge-queue entry's verify output, as it is produced. Its own
  // event rather than part of `merge-queue.changed` because that one carries a
  // full snapshot — per-chunk snapshots would be pathologically chatty. Same
  // contract as `run.log`: the payload is the increment.
  | { type: 'merge-queue.log'; runId: string; chunk: string }
  // The queue just finished draining and attempted to push origin's base up
  // to date. Mirrors packages/server/src/events.ts exactly.
  | {
      type: 'queue.drained';
      merged: number;
      pushed: boolean;
      pushError?: string;
    }
  // The brain-dump inbox changed — captured, retyped, dismissed or converted.
  | { type: 'inbox.changed' }
  | { type: 'review.changed'; runId: string }
  | { type: 'config.changed' }
  // A task draft changed state or was dismissed — no id, refetch the list.
  | { type: 'draft.changed' }
  // A run agent's question was asked, answered, or withdrawn. Mirrors
  // packages/server/src/events.ts.
  | { type: 'question.asked'; runId: string; questionId: string }
  | { type: 'question.answered'; runId: string; questionId: string }
  | { type: 'question.closed'; runId: string };

// Mirrors RunQuestion in packages/server/src/orchestrator/questions.ts: one
// question an agent is blocked on until the human answers it.
export interface RunQuestion {
  id: string;
  runId: string;
  question: string;
  /** Suggested answers rendered as one-click chips; free text always allowed. */
  options: string[];
  askedAt: string;
  answer: string | null;
  answeredAt: string | null;
}

// Mirrors PlannedTask in packages/server/src/orchestrator/planner.ts.
// `blockedByIndices` refers to *other entries in this same proposal's
// `tasks` array* (0-based) — never a real task id, since ids are minted only
// at confirm time.
export interface PlannedTask {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  blockedByIndices: number[];
  priority: Priority;
}

// Mirrors PlanProposal in packages/server/src/orchestrator/planner.ts.
export interface PlanProposal {
  epic?: { title: string; description: string };
  tasks: PlannedTask[];
}

// Mirrors TaskDraft in packages/server/src/orchestrator/planner.ts — the body
// of `POST /api/tasks/draft`, the natural-language single-task creator's
// output. A `PlannedTask` minus `blockedByIndices`: one structured task the
// user reviews before saving through the normal createTask path.
export interface TaskDraft {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: Priority;
}

// Maps a reviewed `TaskDraft` onto core's `CreateInput` so it saves through the
// exact same createTask path CreateTaskModal uses — no server or store schema
// change. `TaskStore.create` only ever renders the `description` section (it
// always births an empty "Acceptance Criteria" section and ignores a separate
// `acceptanceCriteria` field), so the draft's criteria list is folded into the
// description as a bullet block — identical to the server's own
// buildTaskDescription, the fold a confirmed plan's tasks already go through.
export function taskDraftToCreateInput(draft: TaskDraft): CreateInput {
  const parts = [draft.description.trim()];
  if (draft.acceptanceCriteria.length > 0) {
    parts.push(
      'Acceptance criteria:',
      draft.acceptanceCriteria.map((c) => `- ${c}`).join('\n')
    );
  }
  return {
    title: draft.title,
    kind: 'task',
    priority: draft.priority,
    description: parts.join('\n\n'),
  };
}

export type PlanState = 'running' | 'ready' | 'failed';

// Mirrors PlanMessage in packages/server/src/orchestrator/plan.ts — one entry
// in a plan conversation's transcript.
export interface PlanMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

// Mirrors PlanRecord in packages/server/src/orchestrator/plan.ts — the body
// of `GET /api/plan/:id`. A plan is a multi-turn conversation: `messages` is
// the running transcript, `proposal` the latest working proposal, and
// `sessionId` the planner's opaque resume handle (an internal detail clients
// never need to read).
export interface PlanRecord {
  id: string;
  prompt: string;
  plannerName: string;
  state: PlanState;
  messages: PlanMessage[];
  proposal?: PlanProposal;
  sessionId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  /** Set when the plan was started from a note via `enrichNote` — the note
   * whose one-liner the planner was asked to expand into a task. Confirming
   * such a plan links that note to the task it creates. */
  sourceNoteId?: string;
}

// The body of `POST /api/plan/:id/confirm`.
export interface ConfirmResult {
  epicId?: string;
  taskIds: string[];
}

// Mirrors DraftRecord in packages/server/src/orchestrator/plan.ts — the body
// of `POST /api/tasks/draft` and `GET /api/tasks/drafts[/:id]`.
export interface DraftRecord {
  id: string;
  prompt: string;
  state: PlanState;
  message: string;
  proposal: PlanProposal | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// Mirrors EpicSession in packages/server/src/orchestrator/epic.ts.
export interface EpicSession {
  epicId: string;
  concurrency: number;
  active: boolean;
  completedAt?: string;
}

export interface EpicProgressChild {
  id: string;
  title: string;
  status: string;
}

// The body of `GET /api/epics/:id/progress`.
export interface EpicProgress {
  epicId: string;
  active: boolean;
  concurrency?: number;
  children: EpicProgressChild[];
  liveRuns: RunMeta[];
}

// Mirrors InboxKind/InboxItem in packages/server/src/inbox.ts — the brain-dump inbox, which
// replaced the notes store. `createdByRunId` is how "an agent flagged this mid-run" survives.
export type InboxKind = 'bug' | 'idea' | 'task' | 'note';

export interface InboxItem {
  id: string;
  kind: InboxKind;
  text: string;
  done: boolean;
  linkedTaskId: string | null;
  createdByRunId: string | null;
  created: string;
}

/** Per-item outcome of a convert. `taskId` on success, `error` when that one item failed —
 * a batch that half-succeeds has to be able to say which half. */
export interface InboxConvertResult {
  id: string;
  taskId?: string;
  error?: string;
}

// Mirrors ReviewComment/ReviewReply in packages/server/src/reviewComments.ts. `anchorText` is
// what the line said when the comment was written — the only way to tell later whether it still
// points at the code it was about.
export interface ReviewReply {
  id: string;
  author: string;
  body: string;
  created: string;
}

/** How a submitted review lands: approve queues the merge, request-changes resumes the agent
 * with the review attached, comment publishes the notes and changes nothing. */
export type ReviewVerdict = 'approve' | 'request-changes' | 'comment';

export interface ReviewComment {
  id: string;
  file: string;
  line: number;
  /** First line of a range comment; `line` is the last. Absent for a single-line comment. */
  startLine?: number;
  /** True while the comment belongs to a review that has not been submitted. */
  pending: boolean;
  anchorText: string;
  author: string;
  body: string;
  resolved: boolean;
  created: string;
  replies: ReviewReply[];
}

/** One model-proposed grouping of related captures, ready to become an epic. */
export interface InboxClusterGroup {
  epicTitle: string;
  reason: string;
  itemIds: string[];
}

export interface InboxConvertResponse {
  results: InboxConvertResult[];
  converted: number;
  failed: number;
}

// Mirrors MergeQueueEntryState in packages/server/src/orchestrator/mergeQueue.ts.
export type MergeQueueEntryState =
  | 'queued'
  | 'waiting-blockers'
  // Held because the main checkout isn't mergeable-into right now (dirty tree,
  // staged index, wrong branch). Retryable and user-resolvable — the entry
  // stays in the queue carrying `reason`; POST /api/merge-queue/recheck retries.
  | 'blocked-environment'
  | 'rebasing'
  | 'verifying'
  | 'merging'
  | 'merged'
  | 'failed';

// Mirrors MergeQueueEntry in packages/server/src/orchestrator/mergeQueue.ts.
/** One named verify gate's outcome on a queue entry. */
export interface VerifyStepResult {
  name: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  /** Wall-clock duration, set once the step comes to rest. */
  ms?: number;
}

export interface MergeQueueEntry {
  runId: string;
  taskId: string;
  taskTitle: string;
  state: MergeQueueEntryState;
  /**
   * Per-step verify results, present once verification starts. Seeded as all-pending so the
   * whole pipeline is visible from the first render rather than appearing a step at a time.
   * A project with no `verifySteps` gets a single step named "verify".
   */
  steps?: VerifyStepResult[];
  /** Failure detail — set only once an entry lands in `failed`. */
  reason?: string;
  /**
   * When this entry last changed state — distinct from `enqueuedAt`, which never
   * moves. Render elapsed time from this on in-flight entries ("Verifying · 4m"):
   * it is what distinguishes a slow step from a wedged one. Optional, since
   * entries persisted before the field existed hydrate without it.
   */
  stateSince?: string;
  /**
   * How many times this entry has been picked back up after a daemon died partway
   * through processing it. Surfaced so a repeatedly-interrupted entry is visible
   * before the queue abandons it.
   */
  attempts?: number;
  /**
   * The tail of this entry's verify output (bounded server-side). Render it while
   * an entry is `verifying` so a multi-minute gate shows progress rather than
   * looking wedged; `merge-queue.log` streams the increments live.
   */
  output?: string;
  enqueuedAt: string;
  /** Set only once an entry lands in `merged`/`failed`. */
  finishedAt?: string;
}

// The body of `GET /api/merge-queue` — mirrors MergeQueueSnapshot in
// packages/server/src/orchestrator/mergeQueue.ts.
export interface MergeQueueSnapshot {
  /** Pending + active entries, in queue order. */
  entries: MergeQueueEntry[];
  /** Terminal entries (merged/failed), most-recent-first, capped at 20. */
  history: MergeQueueEntry[];
}

// Shared fetch wrapper: resolves against `baseUrl`, throws with the server's
// `{ error }` message (falling back to the status code) on any non-2xx
// response, and parses the body as JSON on success. Every typed fetcher below
// is a thin wrapper around this.
async function request<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

function jsonBody(value: unknown): RequestInit {
  return {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

// Pure helper (no fetch involved) so the query-string shape is unit
// testable without a network layer: `?` + params when any filter is set, ''
// otherwise, in the same status/kind/parent order the server accepts.
export function taskQueryString(filter: TaskFilter = {}): string {
  const params = new URLSearchParams();
  if (filter.status !== undefined) params.set('status', filter.status);
  if (filter.kind !== undefined) params.set('kind', filter.kind);
  if (filter.parent !== undefined) params.set('parent', filter.parent);
  if (filter.archived === true) params.set('archived', '1');
  return params.size > 0 ? `?${params.toString()}` : '';
}

// Pure helper (no DOM involved): swaps an http(s) origin for its ws(s)
// equivalent and appends `/ws`.
export function httpToWs(origin: string): string {
  return `${origin.replace(/^http/, 'ws')}/ws`;
}

// Resolves the WS URL for a given baseUrl, falling back to the current
// page's own origin when baseUrl is empty — the same-origin default case
// (dispatchd serving its own static UI).
export function wsUrl(baseUrl: string): string {
  return httpToWs(baseUrl !== '' ? baseUrl : window.location.origin);
}

// The subset of the DOM `WebSocket` interface `connectEvents` needs, so
// tests can pass a plain fake object instead of a real socket (there is no
// real WS server to connect to in a unit test).
export interface SocketLike {
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void
  ): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
  close(): void;
}

export interface ConnectEventsOptions {
  // Defaults to `(url) => new WebSocket(url)`. Overridden in tests to inject
  // a fake socket instead of opening a real network connection.
  createSocket?: (url: string) => SocketLike;
  // Defaults to 1000ms. Overridden in tests so reconnect assertions don't
  // have to wait a full second.
  reconnectDelayMs?: number;
  // Called for every successfully parsed ServerEvent, including
  // `task.changed` and `hello` — the orchestrator UI (Phase 4 Slice O3) needs
  // `run.changed`/`run.log`/`approval.requested` too, which `onChange` alone
  // can't carry (it fires only for `task.changed`, unchanged from Phase 2R,
  // so existing callers keep their exact behavior). A malformed frame never
  // reaches this callback — see the `try/catch` around `JSON.parse` below.
  onEvent?: (event: ServerEvent) => void;
}

// Opens a WS connection to dispatchd and calls `onChange` for every
// `task.changed` event. Reconnects on close/error with a fixed backoff — the
// protocol is "go refetch," not a diff, so a connection dropping briefly just
// means the UI is briefly less live, never wrong. Returns a disposer that
// stops reconnecting and closes the current socket.
export function connectEvents(
  baseUrl: string,
  onChange: () => void,
  options: ConnectEventsOptions = {}
): () => void {
  const createSocket = options.createSocket ?? ((url) => new WebSocket(url));
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000;

  let closed = false;
  let socket: SocketLike | null = null;
  // A failed browser WebSocket fires 'error' then 'close' on the same
  // socket, and both listeners below call scheduleReconnect — without this
  // guard that queues two reconnect timers per failure, each of which can
  // fail the same way and double again next generation. `scheduled` caps it
  // at one pending reconnect per socket generation; connect() resets it for
  // the next one.
  let scheduled = false;

  function scheduleReconnect() {
    if (closed || scheduled) return;
    scheduled = true;
    setTimeout(connect, reconnectDelayMs);
  }

  function connect() {
    if (closed) return;
    scheduled = false;
    socket = createSocket(wsUrl(baseUrl));
    socket.addEventListener('message', (event) => {
      // A malformed frame (bad JSON, or JSON that isn't a ServerEvent) should
      // never take down the UI's reconnect loop — ignore it and wait for the
      // next message rather than letting JSON.parse throw out of this
      // handler.
      let data: ServerEvent;
      try {
        data = JSON.parse(event.data as string) as ServerEvent;
      } catch {
        return;
      }
      if (data.type === 'task.changed') onChange();
      options.onEvent?.(data);
    });
    socket.addEventListener('close', scheduleReconnect);
    socket.addEventListener('error', scheduleReconnect);
  }

  connect();
  return () => {
    closed = true;
    socket?.close();
  };
}

// Bound client shape returned by `createApiClient` — every method already
// carries `baseUrl`, so callers never repeat it.
export interface ApiClient {
  baseUrl: string;
  fetchHealth(): Promise<HealthPayload>;
  fetchConfig(): Promise<DispatchConfig>;
  fetchTasks(filter?: TaskFilter): Promise<TaskDoc[]>;
  fetchReadyTasks(): Promise<TaskDoc[]>;
  fetchTask(id: string): Promise<TaskDoc>;
  createTask(input: CreateInput): Promise<TaskDoc>;
  updateTask(id: string, patch: UpdatePatch): Promise<TaskDoc>;
  // Starts a background planner turn and returns immediately with a `running`
  // `DraftRecord`; watch it settle via `fetchDrafts` or `draft.changed`.
  draftTask(prompt: string): Promise<DraftRecord>;
  // Every draft currently held in memory (running, ready, or failed — until
  // dismissed), newest first.
  fetchDrafts(): Promise<DraftRecord[]>;
  fetchDraft(id: string): Promise<DraftRecord>;
  // Dismisses a reviewed draft (saved or discarded) so it stops showing up in
  // `fetchDrafts`. 404s an unknown id.
  dismissDraft(id: string): Promise<void>;
  // Orchestrator run endpoints (Phase 4 Slice O1/O2 API, Slice O3 client) —
  // see packages/server/src/api.ts for the exact request/response shapes
  // these mirror. `executor` defaults to 'claude' server-side when omitted;
  // 'fake' stays reachable for the dev-only manual-smoke toggle the desktop
  // UI gates behind a localStorage flag (see apps/desktop/src/lib/devTools.ts).
  createRun(
    taskId: string,
    opts?: { executor?: 'fake' | 'claude'; model?: string }
  ): Promise<RunMeta>;
  fetchRuns(): Promise<RunMeta[]>;
  fetchRun(id: string): Promise<RunDetail>;
  /** `scope: 'session'` also pre-approves the same tool for the rest of this run; `reason`
   * is passed to the model as the denial message, so a refusal explains itself. */
  approveRun(
    runId: string,
    requestId: string,
    allow: boolean,
    opts?: { scope?: 'once' | 'session'; reason?: string }
  ): Promise<void>;
  sendRunMessage(
    runId: string,
    text: string,
    opts?: { resume?: boolean }
  ): Promise<RunMeta>;
  cancelRun(runId: string): Promise<void>;
  fetchRunDiff(runId: string): Promise<DiffResult>;
  reviewRun(
    runId: string,
    action: 'merge' | 'discard' | 'pr'
  ): Promise<RunMeta>;
  // The Branches surface: every `dispatch/*` ref that exists in git right now,
  // joined with whatever run claims it. `freeBranchDisk` reclaims the working
  // copy but keeps the ref (recoverable); `deleteBranch` removes both, and
  // needs `force` for a branch whose commits have not landed on its base.
  // Discarding a run is deliberately NOT here — that's `reviewRun(id,
  // 'discard')`, the path that already does the full bookkeeping.
  fetchBranches(): Promise<BranchEntry[]>;
  freeBranchDisk(branch: string): Promise<BranchEntry>;
  deleteBranch(branch: string, opts?: { force?: boolean }): Promise<void>;
  // GitHub PR review surface (items 3+4): read a run's PR status + conversation,
  // submit a review verdict (approve/request-changes/comment), or add a
  // PR-level comment — each POST returns the refreshed PrDetail. All 409 a run
  // with no open PR.
  fetchPrDetail(runId: string): Promise<PrDetail>;
  reviewPr(
    runId: string,
    event: PrReviewEvent,
    body?: string
  ): Promise<PrDetail>;
  commentPr(runId: string, body: string): Promise<PrDetail>;
  // Item B: every open PR in the repo (`GET /api/prs`), for the PRs page's
  // "Other open PRs" section. 409s the same way every other PR route does
  // when this project lacks the `pr` capability.
  fetchRepoPrs(): Promise<RepoPr[]>;
  // Item B's in-app review for those "Other open PRs" — the same status/
  // conversation/review/comment surface as fetchPrDetail/reviewPr/commentPr
  // above, but keyed by PR number (server resolves it to a url via
  // listRepoPrs()) instead of a run id, since these rows have no run at all.
  // 404s a number that isn't among the repo's currently-open PRs; 409s the
  // same way every other PR route does when this project lacks the `pr`
  // capability.
  fetchRepoPrDetail(number: number): Promise<PrDetail>;
  reviewRepoPr(
    number: number,
    event: PrReviewEvent,
    body?: string
  ): Promise<PrDetail>;
  commentRepoPr(number: number, body: string): Promise<PrDetail>;
  // The notes/triage hub.
  // The brain-dump inbox. `addInbox` splits its text server-side into one item per line, so
  // the splitting rule has exactly one implementation. `convertInbox` reports per-item results
  // rather than throwing on a partial failure.
  fetchInbox(): Promise<InboxItem[]>;
  addInbox(input: {
    text: string;
    kind?: InboxKind;
    createdByRunId?: string;
  }): Promise<InboxItem[]>;
  updateInbox(
    id: string,
    patch: { kind?: InboxKind; text?: string; done?: boolean }
  ): Promise<InboxItem>;
  dismissInbox(ids: string[]): Promise<{ dismissed: number }>;
  convertInbox(ids: string[]): Promise<InboxConvertResponse>;
  /** Starts an AI draft that turns one captured line into a properly specified task. */
  enrichInbox(id: string): Promise<{ planId: string }>;
  /** Starts an AI draft that fleshes out a task that already exists, preserving what is there. */
  enrichTask(id: string): Promise<{ planId: string }>;
  /** Model-backed grouping of related captures, run automatically in the background. Always
   * resolves with a 200 — `error` carries a failed model call rather than throwing, so an
   * automatic call never surfaces as a hard failure. */
  clusterInbox(): Promise<{
    groups: InboxClusterGroup[];
    error: string | null;
  }>;

  // Line-level review comments on a run's diff, and the send-back that carries the unresolved
  // ones to the agent.
  fetchReviewComments(runId: string): Promise<ReviewComment[]>;
  addReviewComment(
    runId: string,
    input: {
      file: string;
      line: number;
      startLine?: number;
      anchorText: string;
      body: string;
      /** Defaults to true — a comment is staged until the review is submitted. */
      pending?: boolean;
    }
  ): Promise<ReviewComment>;
  /** Publishes the pending comments and acts on the verdict. Returns how many were published. */
  submitReview(
    runId: string,
    verdict: ReviewVerdict,
    body: string
  ): Promise<{ verdict: ReviewVerdict; published: number; error?: string }>;
  resolveReviewComment(
    runId: string,
    commentId: string,
    resolved: boolean
  ): Promise<ReviewComment>;
  replyReviewComment(
    runId: string,
    commentId: string,
    body: string
  ): Promise<ReviewComment>;
  /** Resumes the agent on the same branch with the note and every unresolved thread attached. */
  sendBackRun(runId: string, note: string): Promise<RunMeta>;
  /** Hides a run from the default Runs list, or brings it back. Nothing is deleted. */
  setRunArchived(runId: string, archived: boolean): Promise<RunMeta>;

  /** Changes the settings a person is allowed to change. Structural config (statuses) is not
   * editable here — see the server's patchConfig for why. */
  updateConfig(patch: {
    verifyCommand?: string | null;
    autoCommit?: boolean;
    epicConcurrency?: number;
    verifyTimeoutSec?: number;
    permissionMode?: string;
    models?: Partial<ModelConfig>;
  }): Promise<DispatchConfig>;
  fetchNotes(): Promise<Note[]>;
  createNote(input: CreateNoteInput): Promise<Note>;
  updateNote(id: string, patch: UpdateNotePatch): Promise<Note>;
  deleteNote(id: string): Promise<void>;
  /** Promote a note into a task; returns the new task. */
  promoteNote(id: string): Promise<{ meta: { id: string } }>;
  /** Start an AI draft of the task a note should become: returns a plan id to
   * poll with `fetchPlan`, whose proposal is confirmed through the ordinary
   * `confirmPlan` (which also links the note to the task it writes). */
  enrichNote(id: string): Promise<{ planId: string }>;
  // Phase 5 P2: the messaging half (`agent_message`'s daemon-side landing
  // spot) — injects a message into a *running* run, prefixed
  // `[message from <sender>]` server-side (a generic "another agent" label
  // when `fromRunId` is omitted or doesn't resolve to a known run). 409s
  // when the run isn't currently `running`.
  injectRun(runId: string, text: string, fromRunId?: string): Promise<RunMeta>;
  // agent-comms: the agent->human channel (`message_user`'s daemon-side
  // landing spot) — records a `from: 'agent'` message on the run's OWN
  // transcript rather than delivering into any executor. 409s when the run
  // isn't currently `running`.
  messageUser(runId: string, text: string): Promise<RunMeta>;
  // The blocking agent→human channel (`ask_user`'s landing spot):
  // every unanswered question, and the call that unblocks the agent on one.
  fetchOpenQuestions(): Promise<RunQuestion[]>;
  answerQuestion(
    runId: string,
    questionId: string,
    answer: string
  ): Promise<RunQuestion>;
  // Phase 5 P2: the big-prompt plan flow. `startPlan` returns immediately
  // (202) with the plan's id — poll `fetchPlan`/watch `plan.changed` over WS
  // for it to move to `ready`/`failed`. `confirmPlan` sends the (possibly
  // client-edited) proposal back verbatim; the server re-validates it from
  // scratch and is the only place that actually writes the epic/tasks.
  startPlan(prompt: string): Promise<{ planId: string }>;
  fetchPlan(planId: string): Promise<PlanRecord>;
  // Send a follow-up message on an existing plan conversation. Resolves (202)
  // with the record already back in `running` — poll `fetchPlan`/watch
  // `plan.changed` for the assistant's reply + refined proposal to land.
  sendPlanMessage(planId: string, text: string): Promise<PlanRecord>;
  confirmPlan(planId: string, proposal: PlanProposal): Promise<ConfirmResult>;
  // Phase 5 P2: epic-level concurrent dispatch. `concurrency` defaults
  // server-side to the project's `orchestrator.epicConcurrency` config.
  startEpic(
    epicId: string,
    opts?: { concurrency?: number; executor?: 'fake' | 'claude' }
  ): Promise<EpicSession>;
  stopEpic(epicId: string): Promise<EpicSession>;
  fetchEpicProgress(epicId: string): Promise<EpicProgress>;
  // The merge queue: serialized rebase -> verify -> merge over
  // reviewed-and-approved runs. `enqueueMergeQueue` 404/409s the same way
  // the server's MergeQueue.enqueue does (unknown run, non-terminal, already
  // reviewed, already queued); `removeFromMergeQueue` 409s only when the
  // given run is the entry actively being processed.
  fetchMergeQueue(): Promise<MergeQueueSnapshot>;
  enqueueMergeQueue(runId: string): Promise<MergeQueueEntry>;
  // Enqueues every reviewable run in taskId's stack (blockedBy-connected
  // component), blockers first — server's MergeQueue.enqueueStack. 409s only
  // when the whole stack had nothing reviewable to enqueue.
  enqueueMergeStack(taskId: string): Promise<MergeQueueEntry[]>;
  // Enqueues every eligible run across the whole registry in one call —
  // server's MergeQueue.enqueueReady. Never errors on nothing being ready;
  // resolves `[]` in that case.
  enqueueMergeReady(): Promise<MergeQueueEntry[]>;
  removeFromMergeQueue(runId: string): Promise<void>;
  // Retries entries held in 'blocked-environment' against the current main
  // checkout. Those blockers (dirty tree, staged index, wrong branch) are
  // cleared by the user outside the app, where nothing notifies the daemon —
  // so this is the explicit "I've cleaned up, try again" nudge. Never errors on
  // an unblocked queue; returns the resulting snapshot either way.
  recheckMergeQueue(): Promise<MergeQueueSnapshot>;
  wsUrl(): string;
  connectEvents(
    onChange: () => void,
    options?: ConnectEventsOptions
  ): () => void;
}

// Builds a dispatchd API client bound to one base URL. `baseUrl` is empty for
// same-origin use (the web app, served by dispatchd itself) or an explicit
// `http://127.0.0.1:<port>` for the desktop app pointing at a sidecar
// dispatchd on some other port.
export function createApiClient(baseUrl: string): ApiClient {
  return {
    baseUrl,
    fetchHealth: () => request(baseUrl, '/api/health'),
    fetchConfig: () => request(baseUrl, '/api/config'),
    fetchTasks: (filter = {}) =>
      request(baseUrl, `/api/tasks${taskQueryString(filter)}`),
    fetchReadyTasks: () => request(baseUrl, '/api/tasks/ready'),
    fetchTask: (id) => request(baseUrl, `/api/tasks/${id}`),
    createTask: (input) =>
      request(baseUrl, '/api/tasks', { method: 'POST', ...jsonBody(input) }),
    updateTask: (id, patch) =>
      request(baseUrl, `/api/tasks/${id}`, {
        method: 'PATCH',
        ...jsonBody(patch),
      }),
    draftTask: (prompt) =>
      request(baseUrl, '/api/tasks/draft', {
        method: 'POST',
        ...jsonBody({ prompt }),
      }),
    fetchDrafts: () => request(baseUrl, '/api/tasks/drafts'),
    fetchDraft: (id) => request(baseUrl, `/api/tasks/drafts/${id}`),
    dismissDraft: async (id) => {
      await request(baseUrl, `/api/tasks/drafts/${id}`, { method: 'DELETE' });
    },
    createRun: (taskId, opts = {}) =>
      request(baseUrl, `/api/tasks/${taskId}/runs`, {
        method: 'POST',
        ...jsonBody({
          ...(opts.executor !== undefined ? { executor: opts.executor } : {}),
          ...(opts.model !== undefined ? { model: opts.model } : {}),
        }),
      }),
    fetchRuns: () => request(baseUrl, '/api/runs'),
    fetchRun: (id) => request(baseUrl, `/api/runs/${id}`),
    approveRun: async (runId, requestId, allow, opts = {}) => {
      await request(baseUrl, `/api/runs/${runId}/approval`, {
        method: 'POST',
        ...jsonBody({ requestId, allow, ...opts }),
      });
    },
    sendRunMessage: (runId, text, opts = {}) =>
      request(baseUrl, `/api/runs/${runId}/message`, {
        method: 'POST',
        ...jsonBody({ text, ...opts }),
      }),
    cancelRun: async (runId) => {
      await request(baseUrl, `/api/runs/${runId}/cancel`, { method: 'POST' });
    },
    fetchRunDiff: (runId) => request(baseUrl, `/api/runs/${runId}/diff`),
    reviewRun: (runId, action) =>
      request(baseUrl, `/api/runs/${runId}/review`, {
        method: 'POST',
        ...jsonBody({ action }),
      }),
    fetchBranches: () => request(baseUrl, '/api/branches'),
    freeBranchDisk: (branch) =>
      request(baseUrl, '/api/branches/free-disk', {
        method: 'POST',
        ...jsonBody({ branch }),
      }),
    deleteBranch: async (branch, opts = {}) => {
      // Dispatch branch names always contain `/`, so the name is encoded into
      // a single path segment — the server rejoins and decodes it.
      const query = opts.force === true ? '?force=1' : '';
      await request(
        baseUrl,
        `/api/branches/${encodeURIComponent(branch)}${query}`,
        { method: 'DELETE' }
      );
    },
    fetchPrDetail: (runId) => request(baseUrl, `/api/runs/${runId}/pr`),
    reviewPr: (runId, event, body) =>
      request(baseUrl, `/api/runs/${runId}/pr/review`, {
        method: 'POST',
        ...jsonBody({ event, body: body ?? '' }),
      }),
    commentPr: (runId, body) =>
      request(baseUrl, `/api/runs/${runId}/pr/comment`, {
        method: 'POST',
        ...jsonBody({ body }),
      }),
    fetchRepoPrs: () => request(baseUrl, '/api/prs'),
    fetchRepoPrDetail: (number) =>
      request(baseUrl, `/api/prs/${number}/detail`),
    reviewRepoPr: (number, event, body) =>
      request(baseUrl, `/api/prs/${number}/review`, {
        method: 'POST',
        ...jsonBody({ event, body: body ?? '' }),
      }),
    commentRepoPr: (number, body) =>
      request(baseUrl, `/api/prs/${number}/comment`, {
        method: 'POST',
        ...jsonBody({ body }),
      }),
    fetchInbox: () => request(baseUrl, '/api/inbox'),
    addInbox: (input) =>
      request(baseUrl, '/api/inbox', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    updateInbox: (id, patch) =>
      request(baseUrl, `/api/inbox/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    dismissInbox: (ids) =>
      request(baseUrl, '/api/inbox/dismiss', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),
    convertInbox: (ids) =>
      request(baseUrl, '/api/inbox/convert', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),
    enrichInbox: (id) =>
      request(baseUrl, `/api/inbox/${encodeURIComponent(id)}/enrich`, {
        method: 'POST',
      }),
    enrichTask: (id) =>
      request(baseUrl, `/api/tasks/${encodeURIComponent(id)}/enrich`, {
        method: 'POST',
      }),
    clusterInbox: () =>
      request(baseUrl, '/api/inbox/cluster', { method: 'POST' }),
    fetchReviewComments: (runId) =>
      request(baseUrl, `/api/runs/${encodeURIComponent(runId)}/comments`),
    addReviewComment: (runId, input) =>
      request(baseUrl, `/api/runs/${encodeURIComponent(runId)}/comments`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    resolveReviewComment: (runId, commentId, resolved) =>
      request(
        baseUrl,
        `/api/runs/${encodeURIComponent(runId)}/comments/${encodeURIComponent(commentId)}`,
        { method: 'PATCH', body: JSON.stringify({ resolved }) }
      ),
    replyReviewComment: (runId, commentId, body) =>
      request(
        baseUrl,
        `/api/runs/${encodeURIComponent(runId)}/comments/${encodeURIComponent(commentId)}/reply`,
        { method: 'POST', body: JSON.stringify({ body }) }
      ),
    updateConfig: (patch) =>
      request(baseUrl, '/api/config', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    submitReview: (runId, verdict, body) =>
      request(baseUrl, `/api/runs/${encodeURIComponent(runId)}/review-submit`, {
        method: 'POST',
        body: JSON.stringify({ verdict, body }),
      }),
    sendBackRun: (runId, note) =>
      request(baseUrl, `/api/runs/${encodeURIComponent(runId)}/send-back`, {
        method: 'POST',
        body: JSON.stringify({ note }),
      }),
    setRunArchived: (runId, archived) =>
      request(baseUrl, `/api/runs/${encodeURIComponent(runId)}/archive`, {
        method: 'POST',
        body: JSON.stringify({ archived }),
      }),
    fetchNotes: () => request(baseUrl, '/api/notes'),
    createNote: (input) =>
      request(baseUrl, '/api/notes', { method: 'POST', ...jsonBody(input) }),
    updateNote: (id, patch) =>
      request(baseUrl, `/api/notes/${id}`, {
        method: 'PATCH',
        ...jsonBody(patch),
      }),
    deleteNote: async (id) => {
      await request(baseUrl, `/api/notes/${id}`, { method: 'DELETE' });
    },
    promoteNote: (id) =>
      request(baseUrl, `/api/notes/${id}/promote`, { method: 'POST' }),
    enrichNote: (id) =>
      request(baseUrl, `/api/notes/${id}/enrich`, { method: 'POST' }),
    injectRun: (runId, text, fromRunId) =>
      request(baseUrl, `/api/runs/${runId}/inject`, {
        method: 'POST',
        ...jsonBody(fromRunId !== undefined ? { text, fromRunId } : { text }),
      }),
    messageUser: (runId, text) =>
      request(baseUrl, `/api/runs/${runId}/message-user`, {
        method: 'POST',
        ...jsonBody({ text }),
      }),
    fetchOpenQuestions: () => request(baseUrl, '/api/questions'),
    answerQuestion: (runId, questionId, answer) =>
      request(baseUrl, `/api/runs/${runId}/questions/${questionId}/answer`, {
        method: 'POST',
        ...jsonBody({ answer }),
      }),
    startPlan: (prompt) =>
      request(baseUrl, '/api/plan', {
        method: 'POST',
        ...jsonBody({ prompt }),
      }),
    fetchPlan: (planId) => request(baseUrl, `/api/plan/${planId}`),
    sendPlanMessage: (planId, text) =>
      request(baseUrl, `/api/plan/${planId}/message`, {
        method: 'POST',
        ...jsonBody({ text }),
      }),
    confirmPlan: (planId, proposal) =>
      request(baseUrl, `/api/plan/${planId}/confirm`, {
        method: 'POST',
        ...jsonBody({ proposal }),
      }),
    startEpic: (epicId, opts = {}) =>
      request(baseUrl, `/api/epics/${epicId}/dispatch`, {
        method: 'POST',
        ...jsonBody(opts),
      }),
    stopEpic: (epicId) =>
      request(baseUrl, `/api/epics/${epicId}/stop`, { method: 'POST' }),
    fetchEpicProgress: (epicId) =>
      request(baseUrl, `/api/epics/${epicId}/progress`),
    fetchMergeQueue: () => request(baseUrl, '/api/merge-queue'),
    enqueueMergeQueue: (runId) =>
      request(baseUrl, '/api/merge-queue', {
        method: 'POST',
        ...jsonBody({ runId }),
      }),
    enqueueMergeStack: (taskId) =>
      request(baseUrl, '/api/merge-queue/stack', {
        method: 'POST',
        ...jsonBody({ taskId }),
      }),
    enqueueMergeReady: () =>
      request(baseUrl, '/api/merge-queue/ready', { method: 'POST' }),
    recheckMergeQueue: () =>
      request(baseUrl, '/api/merge-queue/recheck', { method: 'POST' }),
    // Not routed through the shared `request()` helper: the server answers
    // this one with 204 No Content (per the merge queue's REST contract), and
    // `request()` always tries to parse a JSON body on success — which throws
    // on an empty 204 body. This mirrors `request()`'s own error-handling
    // shape otherwise (throw the server's `{ error }` message on non-2xx).
    removeFromMergeQueue: async (runId) => {
      const res = await fetch(`${baseUrl}/api/merge-queue/${runId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `request failed: ${res.status}`);
      }
    },
    wsUrl: () => wsUrl(baseUrl),
    connectEvents: (onChange, options) =>
      connectEvents(baseUrl, onChange, options),
  };
}
