import type {
  CommandEvidence,
  CreateInput,
  DispatchConfig,
  Finding,
  FindingRecommendation,
  FindingSeverity,
  FindingVerdict,
  LedgerEntry,
  LedgerKind,
  ModelConfig,
  MutationEvidence,
  Priority,
  TaskDoc,
  TaskRisk,
  UpdatePatch,
} from '@dispatch/core';
// Re-exported (not just imported) so a consumer of this package can name
// these types directly, the same way it already can with `ApiClient`.
export type {
  Finding,
  FindingRecommendation,
  FindingSeverity,
  FindingVerdict,
  LedgerEntry,
  LedgerKind,
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
  | 'cancelled'
  // A `failed` that left uncommitted work behind — see RunSurvey.
  | 'interrupted-dirty';

// Mirrors RunKind in packages/server/src/orchestrator/types.ts. An absent
// `kind` means 'execute'.
export type RunKind = 'execute' | 'review' | 'verify';

// Mirrors RunSurvey in packages/server/src/orchestrator/types.ts — what git
// found in a terminal run's worktree, used to recover or resume it.
export interface RunSurvey {
  runId: string;
  branch: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  lastCommit: { sha: string; subject: string } | null;
  cleanTree: boolean;
}

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
  // The git survey of this run's worktree, set on `failed`/`interrupted-dirty`.
  survey?: RunSurvey;
  // Absent on runs recorded before review runs existed; treat that as
  // 'execute'.
  kind?: RunKind;
  // Files this run is touching — seeded from its task's declared writes and
  // grown from its worktree's own git status as it edits things.
  claims?: string[];
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
  evidence: CommandEvidence[];
  mutations: MutationEvidence[];
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

// The Git page (`/api/git/*`) — mirrors packages/server/src/git/*.ts. `ok:
// false` is a normal git result, not a `request()`-thrown HTTP error.
export type GitOutcome<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; stderr: string };

export interface GitFileChange {
  path: string;
  status: string;
  origPath?: string;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: string[];
  conflicted: string[];
}

export interface GitLogEntry {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
  parents: string[];
}

export interface GitBranch {
  name: string;
  isRemote: boolean;
  isCurrent: boolean;
  isDispatchBranch: boolean;
  sha: string;
  shortSha: string;
  subject: string;
  date: string;
  upstream?: string;
  ahead: number;
  behind: number;
}

// `GitBranch` joined with whatever dispatch run claims that branch name, when
// one does — mirrors GitBranchWithRun in packages/server/src/api.ts.
export interface GitBranchWithRun extends GitBranch {
  runId?: string;
  taskId?: string;
  taskTitle?: string;
}

export interface GitStash {
  index: number;
  ref: string;
  sha: string;
  message: string;
  date: string;
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

// The findings/ledger carry-forward surface — mirrors
// packages/server/src/api/findings.ts's request bodies.
export interface CreateFindingInput {
  taskId: string;
  runId?: string | null;
  severity: FindingSeverity;
  title: string;
  detail: string;
  file?: string | null;
  line?: number | null;
  round?: number;
  // The reviewer's blocks-or-park call. `ruling` on the Finding itself is the
  // controller's answer to it.
  recommendation?: FindingRecommendation;
}

// Mirrors PATCHABLE_VERDICTS in packages/server/src/api/findings.ts: `parked`
// and `blocked` are adjudications and only land through the adjudicate route.
export const PATCHABLE_FINDING_VERDICTS = [
  'open',
  'addressed',
] as const satisfies readonly FindingVerdict[];
export type PatchableFindingVerdict =
  (typeof PATCHABLE_FINDING_VERDICTS)[number];

export interface UpdateFindingPatch {
  verdict?: PatchableFindingVerdict;
  ruling?: string | null;
}

// Why a stopped fix loop is not `complete`. Mirrors FixLoopStop in
// packages/server/src/orchestrator/fixLoop.ts.
export type FixLoopStop = 'rounds-exhausted' | 'standing-block' | 'error';

// Mirrors FixLoopState in packages/server/src/orchestrator/fixLoop.ts: where a
// task's review -> fix -> re-review loop currently stands.
export interface FixLoopState {
  taskId: string;
  round: number;
  cap: number;
  state: 'idle' | 'implementing' | 'reviewing' | 'capped' | 'complete';
  baseSha: string;
  lastReviewedSha: string | null;
  // Set while `capped`: what the loop is waiting for. `round` alone does not
  // say — a loop can stop well short of its cap on a ruling or an error.
  stopReason?: FixLoopStop;
  stopDetail?: string;
  updatedAt: string;
}

// Mirrors POST /api/tasks/:id/fix-loop/advance's body. `baseSha` opens the loop
// on the first call and is ignored afterwards.
export interface AdvanceFixLoopInput {
  baseSha?: string;
  cap?: number;
}

// Mirrors POST /api/tasks/:id/findings/:fid/adjudicate. `ruling` is required
// and non-empty — the server rejects a blank one.
export interface AdjudicateFindingInput {
  verdict: 'parked' | 'blocked';
  ruling: string;
}

export interface AdjudicateFindingResult {
  finding: Finding;
  fixLoop: FixLoopState | null;
}

// Mirrors POST /api/tasks/:id/review's body. The open findings a `fix`
// re-review is scoped to are read server-side, never sent from here.
export interface StartReviewInput {
  base: string;
  head: string;
  scope?: 'full' | 'fix';
  round?: number;
  extraRisks?: string[];
  // The execute run whose evidence (record_evidence/record_mutation) the
  // review prompt should render — omit when no single run maps to the diff.
  runId?: string;
}

export interface CreateLedgerInput {
  epicId?: string | null;
  sourceTaskId?: string | null;
  kind: LedgerKind;
  title: string;
  detail: string;
  appliesTo?: string[];
}

// Mirrors POST /api/tasks/:id/amend's body — a correction to a task's spec,
// what changes and why, recorded in the task's `## Amendments` section.
export interface AmendTaskInput {
  overrides: string;
  reason: string;
  source?: string;
}

// Mirrors VerificationCheck in packages/server/src/orchestrator/verify.ts —
// one check a verify run ran against the live app.
export interface VerificationCheck {
  check: string;
  expected: string;
  actual: string;
  pass: boolean;
}

// Mirrors VerificationResult in packages/server/src/orchestrator/verify.ts —
// the structured outcome `GET /api/tasks/:id/verification` serves.
export interface VerificationResult {
  runId: string;
  taskId: string;
  pass: boolean;
  checks: VerificationCheck[];
  artifacts: string[];
  createdAt: string;
}

// Mirrors POST /api/tasks/:id/verify's response: a dispatched run, or a skip
// (narrow on `'skipped' in result`) when the project has no `verify` config.
export type StartVerificationResult =
  | RunMeta
  | { skipped: true; reason: string };

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
  // A Linear sync pass finished, carrying its own summary. Mirrors
  // packages/server/src/events.ts exactly.
  | { type: 'linear.changed'; summary: LinearSyncSummary }
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
  | { type: 'question.closed'; runId: string }
  // A run agent asked to edit outside its scope, or that request was
  // granted/denied. Mirrors packages/server/src/events.ts.
  | { type: 'scope.requested'; runId: string; requestId: string }
  | { type: 'scope.decided'; runId: string; requestId: string }
  // The repo's git state changed via one of the `/api/git/*` mutation
  // routes. Mirrors packages/server/src/events.ts.
  | { type: 'git.changed' }
  // A finding's verdict/ruling changed, or a review run raised a new one.
  | { type: 'finding.changed' }
  // A decision/hazard/constraint/handoff was added to the ledger.
  | { type: 'ledger.changed' }
  // A task's fix loop moved between states, or stopped. Mirrors
  // packages/server/src/events.ts exactly.
  | { type: 'fixloop.changed'; taskId: string }
  | {
      type: 'fixloop.capped';
      taskId: string;
      round: number;
      cap: number;
      reason: FixLoopStop;
      message?: string;
    }
  // A run was surveyed on reaching `failed`/`interrupted-dirty`. Mirrors
  // packages/server/src/events.ts.
  | { type: 'run.survey'; runId: string; survey: RunSurvey }
  // A verify run finished and recorded a structured result for the task.
  | { type: 'verification.changed'; taskId: string };

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

// Mirrors RunScopeRequest in packages/server/src/orchestrator/scopeRequests.ts:
// an out-of-scope edit an agent asked for, blocked until it is decided.
export interface RunScopeRequest {
  id: string;
  runId: string;
  paths: string[];
  reason: string;
  requestedAt: string;
  granted: boolean | null;
  decisionReason: string | null;
  decidedAt: string | null;
}

// The body of `GET /api/runs/claims` — one entry per live run.
export interface RunClaim {
  runId: string;
  taskId: string;
  claims: string[];
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
  writes?: string[];
  risk?: TaskRisk;
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

// Mirrors PlannerQuestion in packages/server/src/orchestrator/planner.ts.
export interface PlannerQuestion {
  id: string;
  question: string;
  options: string[];
}

// Mirrors PlanRecord.role in packages/server/src/orchestrator/plan.ts: which
// `config.models` role the plan resolves its model from, not a message author.
export const PLAN_ROLES = ['plan', 'enrich'] as const;
export type PlanRole = (typeof PLAN_ROLES)[number];

// Mirrors PlanRecord in packages/server/src/orchestrator/plan.ts — the body
// of `GET /api/plan/:id`. A plan is a multi-turn conversation: `messages` is
// the running transcript, `proposal` the latest working proposal, and
// `sessionId` the planner's opaque resume handle (an internal detail clients
// never need to read).
export interface PlanRecord {
  id: string;
  prompt: string;
  plannerName: string;
  /** `enrich` for a thread expanding an existing task, inbox item or note;
   *  `plan` for the ordinary prompt-first flow. */
  role: PlanRole;
  state: PlanState;
  messages: PlanMessage[];
  proposal?: PlanProposal;
  /** Clarifying questions from the latest assistant turn, answerable via `sendPlanMessage`. */
  questions: PlannerQuestion[];
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
  plannerName: string;
  state: PlanState;
  message: string;
  proposal: PlanProposal | null;
  /** Clarifying questions from the latest turn, answerable via `sendDraftMessage`. */
  questions: PlannerQuestion[];
  sessionId?: string;
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

// Mirrors LinearSyncSummary in packages/server/src/linear/sync.ts: `created`
// counts new local tasks, `createdIssues` counts new Linear issues.
export interface LinearSyncSummary {
  at: string;
  pulled: number;
  pushed: number;
  created: number;
  createdIssues: number;
  conflicts: number;
  errors: string[];
  rateLimited: boolean;
}

/** Display data for a linked issue, keyed by issue UUID. `TaskMeta.external` holds the UUID. */
export interface LinearIssueLink {
  identifier: string;
  url: string;
}

// Mirrors LinearStatus in packages/server/src/linear/sync.ts. Carries no API key
// — `keySource` says where the daemon found one, never what it is.
export interface LinearStatus {
  enabled: boolean;
  connected: boolean;
  keySource: 'env' | 'file' | null;
  teamId: string | null;
  direction: 'both' | 'pull' | 'push';
  intervalSec: number;
  statusMap: Record<string, string>;
  cursor: string | null;
  bootstrappedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  lastSummary: LinearSyncSummary | null;
  syncing: boolean;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
}

export interface LinearViewer {
  id: string;
  name: string;
  email: string;
}

/** Thrown by `request()` on a non-2xx response. `message` is unchanged from
 *  a plain `Error`; `status` is additive, for telling e.g. 404 from 500. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
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
  // Defaults content-type here (not per call site), so a bare `{ body: ... }`
  // still passes the server's Content-Type gate.
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(
      body.error ?? `request failed: ${res.status}`,
      res.status
    );
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
  amendTask(id: string, input: AmendTaskInput): Promise<TaskDoc>;
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
  // Mirrors sendPlanMessage's shape for a draft's follow-up message.
  sendDraftMessage(draftId: string, text: string): Promise<DraftRecord>;
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
  fetchRunClaims(): Promise<RunClaim[]>;
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
  // Agent-death recovery: dispatches a fresh run into a terminal run's same
  // worktree, with its survey (if any) rendered into the new prompt.
  resumeRun(runId: string): Promise<RunMeta>;
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
  // The Git page. `gitDiscard`/`gitStashDrop`/a force `gitDeleteBranch` take
  // `confirm` because the matching server route 400s outright without it.
  fetchGitStatus(): Promise<GitOutcome<GitStatus>>;
  fetchGitLog(opts?: {
    ref?: string;
    limit?: number;
    skip?: number;
  }): Promise<GitOutcome<{ commits: GitLogEntry[] }>>;
  fetchGitBranches(): Promise<GitOutcome<{ branches: GitBranchWithRun[] }>>;
  fetchGitDiff(opts?: {
    staged?: boolean;
    path?: string;
  }): Promise<GitOutcome<{ patch: string }>>;
  fetchGitCommitDiff(sha: string): Promise<GitOutcome<{ patch: string }>>;
  gitStage(paths: string[]): Promise<GitOutcome>;
  gitUnstage(paths: string[]): Promise<GitOutcome>;
  gitStageHunk(patch: string): Promise<GitOutcome>;
  gitUnstageHunk(patch: string): Promise<GitOutcome>;
  gitDiscard(paths: string[], confirm: boolean): Promise<GitOutcome>;
  gitCommit(
    message: string,
    opts?: { amend?: boolean }
  ): Promise<GitOutcome<{ sha: string }>>;
  /** `POST /api/git/commit-message` — an AI-generated Conventional Commits message
   * from the currently staged diff. Throws when nothing is staged. */
  generateCommitMessage(): Promise<{ message: string }>;
  gitCheckout(branch: string): Promise<GitOutcome>;
  gitCreateBranch(name: string, from?: string): Promise<GitOutcome>;
  gitDeleteBranch(
    name: string,
    opts?: { force?: boolean; confirm?: boolean }
  ): Promise<GitOutcome>;
  gitStashPush(message?: string): Promise<GitOutcome>;
  fetchGitStashList(): Promise<GitOutcome<{ stashes: GitStash[] }>>;
  gitStashPop(index: number): Promise<GitOutcome>;
  gitStashDrop(index: number, confirm: boolean): Promise<GitOutcome>;
  gitFetch(remote?: string): Promise<GitOutcome>;
  gitPull(): Promise<GitOutcome>;
  gitPush(opts?: { setUpstream?: boolean }): Promise<GitOutcome>;
  gitCherryPick(sha: string): Promise<GitOutcome>;
  gitRevert(sha: string): Promise<GitOutcome>;
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
    linear?: {
      enabled?: boolean;
      teamId?: string | null;
      statusMap?: Record<string, string>;
      intervalSec?: number;
      direction?: 'both' | 'pull' | 'push';
    };
  }): Promise<DispatchConfig>;
  // Linear sync. `connectLinear` posts the key once and never gets it back; every later
  // call reads `fetchLinearStatus`, which reports where a key was found but not what it is.
  fetchLinearStatus(): Promise<LinearStatus>;
  connectLinear(apiKey: string): Promise<{
    connected: boolean;
    viewer: LinearViewer;
  }>;
  disconnectLinear(): Promise<LinearStatus>;
  fetchLinearTeams(): Promise<LinearTeam[]>;
  fetchLinearStates(teamId: string): Promise<LinearWorkflowState[]>;
  // Runs a pass now. `taskIds` pushes exactly those tasks, bypassing the gate
  // that stops a first sync from creating an issue for every pre-existing task.
  syncLinear(taskIds?: string[]): Promise<LinearSyncSummary>;
  // Issue UUID -> { identifier, url }. `TaskMeta.external` is `linear:<uuid>`;
  // look the uuid up here to render an "ENG-123" chip that links out.
  fetchLinearLinks(): Promise<Record<string, LinearIssueLink>>;
  // Creates local tasks for Linear issues that have none. An ordinary sync never
  // imports a backlog, so this is the explicit first-sync action.
  importLinearIssues(): Promise<LinearSyncSummary>;
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
  // The blocking agent->orchestrator channel (`request_scope`'s landing
  // spot): look up one request by id, and the call that decides it.
  fetchScopeRequest(runId: string, requestId: string): Promise<RunScopeRequest>;
  decideScopeRequest(
    runId: string,
    requestId: string,
    granted: boolean,
    reason?: string
  ): Promise<RunScopeRequest>;
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
  // The findings/ledger carry-forward surface — `updateFinding` reopens or
  // clears a finding; parking and blocking go through `adjudicateFinding`.
  fetchFindings(filter?: {
    taskId?: string;
    verdict?: FindingVerdict;
    severity?: FindingSeverity;
  }): Promise<Finding[]>;
  createFinding(input: CreateFindingInput): Promise<Finding>;
  updateFinding(id: string, patch: UpdateFindingPatch): Promise<Finding>;
  fetchTaskFindings(taskId: string): Promise<Finding[]>;
  // Dispatches a review run over base..head. Resolves with the run's meta as
  // soon as it is accepted; the findings land asynchronously when it ends.
  startReview(taskId: string, input: StartReviewInput): Promise<RunMeta>;
  // Dispatches a verify run against `head`; resolves to a skip payload
  // instead when the project has no `verify` config.
  startVerification(
    taskId: string,
    head: string
  ): Promise<StartVerificationResult>;
  fetchTaskVerification(taskId: string): Promise<VerificationResult>;
  // `advanceFixLoop` drives one step (and opens the loop when `baseSha` is
  // supplied); `adjudicateFinding` is the ruling a capped loop demands.
  fetchFixLoop(taskId: string): Promise<FixLoopState>;
  advanceFixLoop(
    taskId: string,
    input?: AdvanceFixLoopInput
  ): Promise<FixLoopState>;
  adjudicateFinding(
    taskId: string,
    findingId: string,
    input: AdjudicateFindingInput
  ): Promise<AdjudicateFindingResult>;
  // `epicId: null` asks for project-wide entries only; omit it for every entry.
  fetchLedger(filter?: { epicId?: string | null }): Promise<LedgerEntry[]>;
  createLedgerEntry(input: CreateLedgerInput): Promise<LedgerEntry>;
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
    amendTask: (id, input) =>
      request(baseUrl, `/api/tasks/${id}/amend`, {
        method: 'POST',
        ...jsonBody(input),
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
    sendDraftMessage: (draftId, text) =>
      request(baseUrl, `/api/tasks/drafts/${draftId}/message`, {
        method: 'POST',
        ...jsonBody({ text }),
      }),
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
    fetchRunClaims: () => request(baseUrl, '/api/runs/claims'),
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
    resumeRun: (runId) =>
      request(baseUrl, `/api/runs/${runId}/resume`, { method: 'POST' }),
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
    fetchGitStatus: () => request(baseUrl, '/api/git/status'),
    fetchGitLog: (opts = {}) => {
      const params = new URLSearchParams();
      if (opts.ref !== undefined) params.set('ref', opts.ref);
      if (opts.limit !== undefined) params.set('limit', String(opts.limit));
      if (opts.skip !== undefined) params.set('skip', String(opts.skip));
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return request(baseUrl, `/api/git/log${query}`);
    },
    fetchGitBranches: () => request(baseUrl, '/api/git/branches'),
    fetchGitDiff: (opts = {}) => {
      const params = new URLSearchParams();
      if (opts.staged === true) params.set('staged', '1');
      if (opts.path !== undefined) params.set('path', opts.path);
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return request(baseUrl, `/api/git/diff${query}`);
    },
    fetchGitCommitDiff: (sha) =>
      request(baseUrl, `/api/git/commit/${encodeURIComponent(sha)}`),
    gitStage: (paths) =>
      request(baseUrl, '/api/git/stage', {
        method: 'POST',
        ...jsonBody({ paths }),
      }),
    gitUnstage: (paths) =>
      request(baseUrl, '/api/git/unstage', {
        method: 'POST',
        ...jsonBody({ paths }),
      }),
    gitStageHunk: (patch) =>
      request(baseUrl, '/api/git/stage-hunk', {
        method: 'POST',
        ...jsonBody({ patch }),
      }),
    gitUnstageHunk: (patch) =>
      request(baseUrl, '/api/git/unstage-hunk', {
        method: 'POST',
        ...jsonBody({ patch }),
      }),
    gitDiscard: (paths, confirm) =>
      request(baseUrl, '/api/git/discard', {
        method: 'POST',
        ...jsonBody({ paths, confirm }),
      }),
    gitCommit: (message, opts = {}) =>
      request(baseUrl, '/api/git/commit', {
        method: 'POST',
        ...jsonBody({ message, ...opts }),
      }),
    generateCommitMessage: () =>
      request(baseUrl, '/api/git/commit-message', { method: 'POST' }),
    gitCheckout: (branch) =>
      request(baseUrl, '/api/git/checkout', {
        method: 'POST',
        ...jsonBody({ branch }),
      }),
    gitCreateBranch: (name, from) =>
      request(baseUrl, '/api/git/branch', {
        method: 'POST',
        ...jsonBody(from !== undefined ? { name, from } : { name }),
      }),
    gitDeleteBranch: (name, opts = {}) =>
      request(baseUrl, `/api/git/branch/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        ...jsonBody(opts),
      }),
    gitStashPush: (message) =>
      request(baseUrl, '/api/git/stash', {
        method: 'POST',
        ...jsonBody(message !== undefined ? { message } : {}),
      }),
    fetchGitStashList: () => request(baseUrl, '/api/git/stash'),
    gitStashPop: (index) =>
      request(baseUrl, '/api/git/stash/pop', {
        method: 'POST',
        ...jsonBody({ index }),
      }),
    gitStashDrop: (index, confirm) =>
      request(baseUrl, '/api/git/stash/drop', {
        method: 'POST',
        ...jsonBody({ index, confirm }),
      }),
    gitFetch: (remote) =>
      request(baseUrl, '/api/git/fetch', {
        method: 'POST',
        ...jsonBody(remote !== undefined ? { remote } : {}),
      }),
    gitPull: () => request(baseUrl, '/api/git/pull', { method: 'POST' }),
    gitPush: (opts = {}) =>
      request(baseUrl, '/api/git/push', { method: 'POST', ...jsonBody(opts) }),
    gitCherryPick: (sha) =>
      request(baseUrl, '/api/git/cherry-pick', {
        method: 'POST',
        ...jsonBody({ sha }),
      }),
    gitRevert: (sha) =>
      request(baseUrl, '/api/git/revert', {
        method: 'POST',
        ...jsonBody({ sha }),
      }),
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
    fetchLinearStatus: () => request(baseUrl, '/api/linear/status'),
    connectLinear: (apiKey) =>
      request(baseUrl, '/api/linear/connect', {
        method: 'POST',
        ...jsonBody({ apiKey }),
      }),
    disconnectLinear: () =>
      request(baseUrl, '/api/linear/disconnect', { method: 'POST' }),
    fetchLinearTeams: () => request(baseUrl, '/api/linear/teams'),
    fetchLinearStates: (teamId) =>
      request(
        baseUrl,
        `/api/linear/states?teamId=${encodeURIComponent(teamId)}`
      ),
    syncLinear: (taskIds) =>
      request(baseUrl, '/api/linear/sync', {
        method: 'POST',
        ...jsonBody(taskIds === undefined ? {} : { taskIds }),
      }),
    fetchLinearLinks: () => request(baseUrl, '/api/linear/links'),
    importLinearIssues: () =>
      request(baseUrl, '/api/linear/import', { method: 'POST' }),
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
    fetchScopeRequest: (runId, requestId) =>
      request(baseUrl, `/api/runs/${runId}/scope-requests/${requestId}`),
    decideScopeRequest: (runId, requestId, granted, reason) =>
      request(
        baseUrl,
        `/api/runs/${runId}/scope-requests/${requestId}/decide`,
        { method: 'POST', ...jsonBody({ granted, reason }) }
      ),
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
    fetchFindings: (filter = {}) => {
      const params = new URLSearchParams();
      if (filter.taskId !== undefined) params.set('taskId', filter.taskId);
      if (filter.verdict !== undefined) params.set('verdict', filter.verdict);
      if (filter.severity !== undefined) {
        params.set('severity', filter.severity);
      }
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return request(baseUrl, `/api/findings${query}`);
    },
    createFinding: (input) =>
      request(baseUrl, '/api/findings', { method: 'POST', ...jsonBody(input) }),
    updateFinding: (id, patch) =>
      request(baseUrl, `/api/findings/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        ...jsonBody(patch),
      }),
    fetchTaskFindings: (taskId) =>
      request(baseUrl, `/api/tasks/${encodeURIComponent(taskId)}/findings`),
    startReview: (taskId, input) =>
      request(baseUrl, `/api/tasks/${encodeURIComponent(taskId)}/review`, {
        method: 'POST',
        ...jsonBody(input),
      }),
    startVerification: (taskId, head) =>
      request(baseUrl, `/api/tasks/${encodeURIComponent(taskId)}/verify`, {
        method: 'POST',
        ...jsonBody({ head }),
      }),
    fetchTaskVerification: (taskId) =>
      request(baseUrl, `/api/tasks/${encodeURIComponent(taskId)}/verification`),
    fetchFixLoop: (taskId) =>
      request(baseUrl, `/api/tasks/${encodeURIComponent(taskId)}/fix-loop`),
    advanceFixLoop: (taskId, input = {}) =>
      request(
        baseUrl,
        `/api/tasks/${encodeURIComponent(taskId)}/fix-loop/advance`,
        { method: 'POST', ...jsonBody(input) }
      ),
    adjudicateFinding: (taskId, findingId, input) =>
      request(
        baseUrl,
        `/api/tasks/${encodeURIComponent(taskId)}/findings/${encodeURIComponent(findingId)}/adjudicate`,
        { method: 'POST', ...jsonBody(input) }
      ),
    fetchLedger: (filter = {}) => {
      const params = new URLSearchParams();
      if (filter.epicId !== undefined) {
        params.set('epicId', filter.epicId ?? '');
      }
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return request(baseUrl, `/api/ledger${query}`);
    },
    createLedgerEntry: (input) =>
      request(baseUrl, '/api/ledger', { method: 'POST', ...jsonBody(input) }),
    wsUrl: () => wsUrl(baseUrl),
    connectEvents: (onChange, options) =>
      connectEvents(baseUrl, onChange, options),
  };
}
