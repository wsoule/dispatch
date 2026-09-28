import type {
  CommandEvidence,
  ConfigPatch,
  CreateInput,
  DispatchConfig,
  EffortLevel,
  Finding,
  FindingRecommendation,
  FindingSeverity,
  FindingVerdict,
  LedgerEntry,
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
  // Which process is answering and what it will run — optional because a
  // daemon predating these fields still answers health without them.
  pid?: number;
  startedAt?: string;
  models?: ModelConfig;
  // Whether the answering process is still the one this project's daemon
  // file names: 'displaced' when another dispatchd has overwritten the file
  // (clients following it reach that one instead), 'unregistered' when the
  // file is gone (the next CLI call will spawn a second daemon). The same
  // fact is spelled out in `problems`; this is for branching without
  // matching the string.
  identity?: 'ok' | 'displaced' | 'unregistered';
  // The daemon's event-loop watchdog. 'failed' means it never came up — for
  // a compiled daemon, that its worker module was left out of the build.
  watchdog?: 'idle' | 'starting' | 'armed' | 'failed' | 'stopped';
  // Which backend this daemon's task store uses. Absent on older daemons;
  // treat that as 'sqlite', the default.
  storageBackend?: 'files' | 'sqlite';
  // Records the daemon's last cache rebuild could not read, plus the
  // identity problem above when there is one — visibility only, `ok` stays
  // true.
  problems: string[];
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
  // Commits on the run's branch authored after the run first reached `failed`
  // — work an orphaned agent process landed after the daemon lost track of it.
  // Newest first. Optional: surveys recorded before this field existed.
  postFailCommits?: { sha: string; subject: string; date: string }[];
}

// Mirrors RunMeta in packages/server/src/orchestrator/types.ts.
// Mirrors SubagentStatus / SubagentEvent / SubagentSummary in
// packages/core/src/subagents.ts, the module that folds a run's `agent`
// entries into its sub-agent tree. Kept structurally identical so a
// NormalizedEntry from here satisfies core's SubagentSourceEntry directly.
export type SubagentStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface SubagentEvent {
  /** The spawning tool_use id — the one handle every event about the same sub-agent shares. */
  id: string;
  phase: 'started' | 'progress' | 'finished';
  status: SubagentStatus;
  label?: string;
  type?: string;
  toolUses?: number;
  tokens?: number;
  durationMs?: number;
  lastTool?: string;
  summary?: string;
}

export interface SubagentSummary {
  total: number;
  running: number;
  done: number;
  failed: number;
  stopped: number;
}

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
  /** The reasoning effort this run started at; absent is the model default. */
  effort?: EffortLevel;
  /** ActorRef of the human who dispatched this run — see the server's RunMeta. */
  dispatchedBy?: string;
  // How many sub-agents this run's agent has fanned out into and where they
  // stand, kept live by the daemon from the run's `agent` entries and rebuilt
  // from them on replay. Absent until the first sub-agent is spawned. Mirrors
  // RunMeta.subagents / SubagentSummary in @dispatch/core.
  subagents?: SubagentSummary;
  // Phase 5 P1: set once a run has been reviewed (merge/discard/pr) or its PR
  // has merged — mirrors RunMeta's own one-way markers in
  // packages/server/src/orchestrator/types.ts.
  reviewedAt?: string;
  reviewAction?: 'merge' | 'discard' | 'pr';
  // The squash-merge commit sha, set only when the 'merge' review action
  // actually produced one. Mirrors RunMeta.mergeCommit in
  // packages/server/src/orchestrator/types.ts.
  mergeCommit?: string;
  // Why the most recent merge/discard attempt threw and left the run
  // unreviewed (a squash conflict names its files here). Cleared once a later
  // review completes. Mirrors RunMeta.reviewFailure.
  reviewFailure?: { action: 'merge' | 'discard'; reason: string; at: string };
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
  // Set when a human asked this run to stop gracefully (`stopRun`). A marker,
  // not a state: the run stays live while the agent finishes what it is doing,
  // then reaches its own terminal state normally. So a run with this set and a
  // non-terminal `state` is stopping; one with this set and a terminal `state`
  // was stopped, as opposed to having run to its own conclusion.
  stopRequestedAt?: string;
}

// Mirrors BranchEntryStatus in packages/server/src/orchestrator/types.ts.
// 'active' = a live run is writing here (read-only); 'reviewable' = a terminal
// run nobody reviewed, so nothing cleaned it up; 'leftover' = a reviewed run
// whose ref somehow survived (a silently-failed cleanup); 'orphan' = no run
// claims this ref at all; 'epic' = an epic's integration branch (`epic/<id>`),
// owned by the epic rather than any single run.
export type BranchEntryStatus =
  | 'active'
  | 'reviewable'
  | 'leftover'
  | 'orphan'
  | 'epic';

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
  /** Commits the base gained since this branch diverged — how far the branch
   * has fallen behind. Absent on merged branches, where the count no longer
   * means anything. For 'epic' entries it is the drift signal: dispatch never
   * updates an integration branch on its own, a human should. */
  behindBase?: number;
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
// is a message delivered to the run (`from` names a human or an agent) or one
// the run sent to a human (`toUser`).
export interface NormalizedEntry {
  ts: string;
  kind:
    | 'assistant'
    | 'tool'
    | 'thinking'
    | 'system'
    | 'usage'
    | 'message'
    | 'agent';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  status?: 'running' | 'done' | 'error';
  // `tool`/`agent` entries: the SDK's id for the tool_use block recorded.
  toolUseId?: string;
  // Set on entries a sub-agent made rather than the run's own agent: the
  // tool_use id that spawned it. Absent on the run's own top-level activity.
  parentToolUseId?: string;
  // `kind: 'agent'` only: one lifecycle event of a sub-agent this run's agent
  // spawned. The started event also keeps the spawning call's
  // `toolName`/`toolInput`, so the transcript can show the prompt.
  agent?: SubagentEvent;
  from?: 'user' | 'agent';
  fromLabel?: string;
  // Set on a message this run sent to a human, so the app badges it "To you"
  // instead of rendering it as inbound.
  toUser?: boolean;
  // The messaging-core message id (`m-<ulid>`) this entry delivered or sent.
  messageId?: string;
  // Set on entries delivered via the orchestrator's `notifyRun` — a
  // non-interrupting channel digest rather than a message to respond to.
  digest?: boolean;
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

// Mirrors PrCheckRun in packages/server/src/orchestrator/pr.ts — one named
// check from GitHub's rollup, normalized to a single verdict string.
export interface PrCheckRun {
  name: string;
  conclusion: string;
  url: string;
}

// GitHub PR status + conversation for a run's PR — mirrors PrStatus /
// PrConversationItem / PrDetail in packages/server/src/orchestrator/pr.ts. The
// body of `GET /api/runs/:id/pr` (and what the review/comment POSTs return).
export interface PrCheckSummary {
  passed: number;
  failed: number;
  pending: number;
  total: number;
  runs: PrCheckRun[];
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
  /** The branch this PR targets — the merge-base anchor for its review. */
  baseRefName: string;
  author: string;
  isDraft: boolean;
  updatedAt: string;
  /** Head commit SHA — the `commit_id` GitHub wants when posting a review comment. */
  headRefOid: string;
  /**
   * Open on GitHub, or closed/merged. Only an OPEN PR accepts a review, so
   * the server refuses a staged batch — and says which — before the POST.
   */
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  /** True when the head branch lives in a fork; gates Phase 4's confirm. */
  isCrossRepository: boolean;
  /** Login owning the head repository, named in that confirm. */
  headRepositoryOwner: string;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  checks: PrCheckSummary;
  additions: number;
  deletions: number;
  changedFiles: number;
}

// Mirrors PrWorktreeState in packages/server/src/orchestrator/prWorktree.ts —
// one PR review worktree's live state, as of the last create/list call.
export interface PrWorktreeState {
  prNumber: number;
  path: string;
  headOid: string;
  dirty: boolean;
  behind: boolean;
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
// packages/server/src/orchestrator/fixLoop.ts. `stopped` is the user's own
// Stop button — resumable through `startFixLoop`.
type FixLoopStop = 'rounds-exhausted' | 'standing-block' | 'error' | 'stopped';

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
  /** Open findings handed to each round's review, oldest first — [9, 4, 1] is
   * converging, [9, 9] is thrashing. Present on API reads. */
  findingsTrace?: number[];
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

// A task, run, file, commit or message a message points at; mirrors
// @dispatch/protocol's Ref.
export interface Ref {
  type: string;
  id: string;
  /** Commit sha for `file` refs. */
  at?: string;
}

// Structural mirror of @dispatch/protocol's Message, so the client needs no
// runtime dependency on the protocol package.
export interface Message {
  id: string;
  thread: string;
  replyTo: string | null;
  from: string;
  session?: string;
  to: string[];
  kind: string;
  body: string;
  refs: Ref[];
  data?: unknown;
  urgent: boolean;
  blocking: boolean;
  choices?: string[];
  choice?: string;
  wake: 'none' | 'request';
  createdAt: string;
}

export type DeliveryState =
  | 'held'
  | 'sending'
  | 'pushed'
  | 'notified'
  | 'read'
  | 'answered';

export type DeliveryVia = 'direct' | 'channel';

// One recipient's copy of a message, carrying that recipient's read state;
// mirrors @dispatch/protocol's Delivery.
export interface Delivery {
  id: string;
  messageId: string;
  recipient: string;
  runId: string | null;
  via: DeliveryVia;
  state: DeliveryState;
  updatedAt: string;
}

// Body of POST /api/messages — structural mirror of @dispatch/protocol's
// SendInput.
export interface SendInput {
  to: string[];
  kind: string;
  body: string;
  refs?: Ref[];
  data?: unknown;
  urgent?: boolean;
  blocking?: boolean;
  choices?: string[];
  choice?: string;
  replyTo?: string | null;
  wake?: 'none' | 'request';
  session?: string;
}

// Body of POST /api/messages/:id/reply — the server fills in `to`/`kind`/
// `replyTo` from the target message, so only these survive from SendInput.
export interface ReplyInput {
  body: string;
  choice?: string;
  refs?: Ref[];
  data?: unknown;
  session?: string;
}

// Response of both a send and a reply — structural mirror of
// @dispatch/protocol's SendResult.
export interface SendResult {
  message: Message;
  deliveries: Delivery[];
  /** True when `urgent` was dropped because the sender hit its quota. */
  downgraded: boolean;
}

// Gate payloads dispatchd puts in `Message.data` (mirrors the protocol's
// GateData). Unvalidated here: narrow on `type` before reading the rest.
export type GateData =
  | {
      type: 'tool-approval';
      requestId: string;
      runId?: string;
      conversation?: string;
      tool: string;
      input: unknown;
      truncated?: true; // set when `input` was cut to fit
      floor: boolean; // the irreversibility floor holds the call, judged on its full input
    }
  | { type: 'scope'; paths: string[]; reason: string }
  | { type: 'wake'; target: string; message: string }
  | {
      type: 'agent-registration';
      agent: string;
      client: string;
      // The human who asked; the agent registers under their handle.
      requestedBy?: string;
    }
  | {
      type: 'overseer-action';
      conversation: string;
      actionId: string;
      summary: string;
    }
  | {
      type: 'memory';
      proposalId: string; // the content stays in memory.db
      action: 'add' | 'supersede' | 'retire';
      scope: 'project' | 'team';
      kind: MemoryKind;
    };

// Structural mirrors of @dispatch/memory's views and the memory routes'
// bodies (packages/server/src/memory/routes.ts).
export type MemoryKind =
  | 'preference'
  | 'convention'
  | 'constraint'
  | 'hazard'
  | 'decision'
  | 'fact'
  | 'reference';
export type MemoryScope = 'personal' | 'project' | 'team';
export type MemoryTrust = 'human' | 'confirmed' | 'agent';
/** Retired when retired or expired; what agents and the UI see. */
export type MemoryState = 'active' | 'stale' | 'retired';

export interface MemoryEntryView {
  id: string;
  handle: string;
  scope: MemoryScope;
  kind: MemoryKind;
  title: string;
  body: string;
  refs: Ref[];
  epic: string | null;
  appliesTo: string[];
  projectKey: string | null;
  author: string;
  trust: MemoryTrust;
  status: 'active' | 'retired';
  statusReason: 'forgotten' | 'superseded' | 'undone' | null;
  decay: 'fresh' | 'stale' | 'expired';
  pinned: boolean;
  supersedes: string | null;
  supersededBy: string | null;
  origin: string | null;
  proposal: string | null;
  decidedBy: string | null;
  decidedByPolicy: { rung: number; authorizedBy: 'rung' | 'override' } | null;
  rev: number;
  createdAt: string;
  updatedAt: string;
  lastRecalledAt: string | null;
  recallCount: number;
  state: MemoryState;
}

export interface MemorySearchHit {
  id: string;
  handle: string;
  title: string;
  kind: MemoryKind;
  scope: MemoryScope;
  trust: MemoryTrust;
  state: MemoryState;
  updatedAt: string;
  snippet: string;
}

export interface MemoryReadResult {
  entry: MemoryEntryView;
  revisions: {
    memoryId: string;
    rev: number;
    by: string;
    cause: string;
    at: string;
  }[];
  recallCount: number;
}

export interface MemoryIndexResult {
  text: string | null;
  /** Handles of the entries the index shows, in rank order. */
  included: string[];
  omitted: number;
  pinnedOverflow: boolean;
}

export interface LedgerImportReport {
  outcome: 'ok' | 'MISMATCH' | 'dry-run';
  read: number;
  byKind: Record<string, number>;
  memory: {
    total: number;
    imported: number;
    proposed: number;
    truncated: number;
    alreadyImported: number;
    alreadyDeleted: number;
  };
  audit: Record<string, number>;
  damaged: number;
  memoryRows: { before: number; after: number };
  openProposals: { before: number; after: number };
  mismatches: string[];
  at: string;
}

/** Mirrors ClaudeImportReport in packages/server/src/memory/claudeImport.ts. */
export interface ClaudeImportReport {
  state: 'complete' | 'failed' | 'unconfirmed';
  /** The directory read, or null when nothing was. */
  source: string | null;
  imported: number;
  updated: number;
  unchanged: number;
  duplicates: number;
  tombstoned: number;
  problems: string[];
  /** Where the notes may be, when none were found. */
  candidates: string[];
}

export interface MemoryHealth {
  available: boolean;
  /** Why memory.db would not open, when it did not. */
  reason: string | null;
  search: 'fts5' | 'like' | null;
  entries: number;
  openProposals: number;
  ledgerImport: LedgerImportReport | null;
  configWarnings: { key: string; message: string }[];
  lastDecayAt: string | null;
  /** The caller's own personal store; null when the caller acts for no one. */
  personal: { available: boolean; reason: string | null } | null;
  /** The caller's pinned entries alone exceed the index budget. */
  pinnedOverflow: boolean;
  /** The owner's Claude-notes import; null for anyone but the daemon's own human. */
  claudeImport: {
    state: 'complete' | 'failed' | 'unconfirmed' | 'running' | null;
    source: string | null;
    candidates: string[];
  } | null;
}

/** `proposed` waits on a decision; `active` or `retired` took effect. */
export type MemorySaveResult =
  | { status: 'active' | 'retired'; id: string; handle: string }
  | { status: 'proposed'; proposal: string; gate: string | null };

export type MemoryProposalState = 'open' | 'approved' | 'rejected' | 'expired';

export interface MemoryProposalView {
  id: string;
  action: 'add' | 'supersede' | 'retire';
  scope: 'project' | 'team';
  target: string | null;
  baseRev: number | null;
  content: {
    kind: MemoryKind;
    title: string;
    body: string;
    refs: Ref[];
    epic: string | null;
    appliesTo: string[];
  } | null;
  reason: string | null;
  author: string;
  authorTrust: 'human' | 'agent';
  operator: string | null;
  runId: string | null;
  taskId: string | null;
  origin: string | null;
  contentHash: string | null;
  gate: string | null;
  state: MemoryProposalState;
  matchedPersonal: boolean;
  decidedBy: string | null;
  decidedByPolicy: { rung: number; authorizedBy: 'rung' | 'override' } | null;
  decisionReason: string | null;
  result: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/** One line of the caller's personal activity, which the Inbox lists with an Undo. */
export interface MemoryActivityRow {
  id: string;
  at: string;
  kind:
    | 'saved'
    | 'edited'
    | 'retired'
    | 'ingested'
    | 'throttled'
    | 'ingest-problem';
  memoryId: string | null;
  runId: string | null;
  summary: string;
}

/** A Claude memory file a scan skipped, without its kept content. */
export interface MemoryIngestProblem {
  id: string;
  lineage: string;
  file: string;
  reason: string;
  size: number;
  at: string;
}

export type AgentStatus = 'pending' | 'approved' | 'revoked';

// An agent roster entry with its token hash stripped — structural mirror of
// the server's own AgentSummary (Omit<AgentRecord, 'tokenHash'>).
export interface AgentSummary {
  address: string;
  displayName: string;
  client: string;
  status: AgentStatus;
  muted: boolean;
  approvedBy: string | null;
  createdAt: string;
}

// One entry of GET /api/channels.
export interface ChannelSummary {
  name: string;
  auto: boolean;
  members: string[];
}

// One thread's most recent state, as GET /api/threads?limit=N lists them.
export interface ThreadSummary {
  thread: string;
  root: Message;
  last: Message;
  count: number;
}

// GET /api/threads/:id's body: every message in the thread and their
// deliveries, enough to render the conversation from one fetch.
export interface ThreadDetail {
  messages: Message[];
  deliveries: Delivery[];
}

// One row of GET /api/mailbox: a delivery paired with the message it
// delivers, so a mailbox view never needs a second fetch per row.
export interface MailboxItem {
  delivery: Delivery;
  message: Message;
}

export type ServerEvent =
  | { type: 'task.changed' }
  | { type: 'hello'; version: string }
  | { type: 'run.changed' }
  | { type: 'run.log'; runId: string; entry: NormalizedEntry }
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
  // A terminal session produced output, or ended. Both carry only the id: a
  // client holds a byte cursor and pulls the increment, so a dropped event
  // costs a round trip rather than leaving a gap.
  | { type: 'terminal.output'; terminalId: string }
  | { type: 'terminal.exited'; terminalId: string }
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
  // A overseer conversation's record changed (turn settled, action queued or
  // confirmed). Mirrors packages/server/src/events.ts exactly.
  | { type: 'overseer.changed'; conversationId: string }
  | { type: 'review.changed'; runId: string }
  | { type: 'config.changed' }
  // A task draft changed state or was dismissed — no id, refetch the list.
  | { type: 'draft.changed' }
  // The repo's git state changed via one of the `/api/git/*` mutation
  // routes. Mirrors packages/server/src/events.ts.
  | { type: 'git.changed' }
  // A finding's verdict/ruling changed, or a review run raised a new one.
  | { type: 'finding.changed' }
  // A decision, hazard or constraint was added to the ledger.
  | { type: 'ledger.changed' }
  // Memory changed: a bare refetch signal, with no id for a personal change.
  | {
      type: 'memory.changed';
      scope: 'personal' | 'project' | 'team';
      id?: string;
    }
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
  // An epic's dispatch session changed: started, paused, resumed, stopped,
  // completed, or a fill dispatched a batch. Same "go refetch, no payload
  // beyond the id" contract as `plan.changed`. Mirrors
  // packages/server/src/events.ts.
  | { type: 'epic.changed'; epicId: string }
  // An epic's session paused on its own (a ceiling or a fill that kept
  // failing — never a human's pause). Carries the spend numbers like
  // `fixloop.capped` so a client can toast the reason without a fetch.
  | {
      type: 'epic.paused';
      epicId: string;
      reason: EpicPauseReason;
      settledUsd: number;
      estimatedLiveUsd: number;
      maxSpendUsd: number | null;
      runsStarted: number;
      maxRuns: number | null;
      detail?: string;
    }
  // A run was surveyed on reaching `failed`/`interrupted-dirty`. Mirrors
  // packages/server/src/events.ts.
  | { type: 'run.survey'; runId: string; survey: RunSurvey }
  // A verify run finished and recorded a structured result for the task.
  | { type: 'verification.changed'; taskId: string }
  // The board syncer attempted a sync (debounced off local task edits).
  // Carries its own result, unlike the *.changed events, so a live feed can
  // render the outcome without a follow-up fetch. Mirrors
  // packages/server/src/events.ts exactly.
  | { type: 'board.sync'; result: SyncResult }
  // The receipts exporter attempted an export of the git audit trail. The
  // database backend's counterpart to `board.sync`.
  | { type: 'receipts.export'; result: ReceiptsResult }
  // The decision feed's contents changed: something started or stopped
  // awaiting a human. Same "go refetch" contract as task.changed — the feed
  // is derived on every read, so there is no increment to carry. Mirrors
  // packages/server/src/events.ts exactly.
  | { type: 'decisions.changed' }
  // The PR poll's cached repo-PR set changed (a delta in number, head sha,
  // state, mergeable, review decision, checks, draft-ness, or updatedAt) —
  // refetch GET /api/landing. No payload: the cache itself is the source of
  // truth, same "go refetch" contract as task.changed. Mirrors
  // packages/server/src/events.ts exactly.
  | { type: 'landing.changed' }
  // Someone arrived or left; refetch GET /api/presence.
  | { type: 'presence.changed' }
  // A message was stored. Carries it inline: every client renders it at once.
  // Mirrors packages/server/src/events.ts exactly.
  | { type: 'message.new'; message: Message }
  // A delivery changed state (pushed, read, answered…) — refetch the thread.
  // Mirrors packages/server/src/events.ts exactly.
  | { type: 'delivery.changed'; deliveryId: string; messageId: string }
  // The A2A bridge's clients, tasks or listener changed; go refetch.
  | { type: 'a2a.changed' };

// The body of `GET /api/runs/claims` — one entry per live run.
export interface RunClaim {
  runId: string;
  taskId: string;
  claims: string[];
  /** ActorRef of who dispatched the run holding these claims, when anyone did. */
  dispatchedBy?: string;
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
  /** The model this plan was opened on when the composer chose one; every
   *  follow-up reuses it. Absent: the configured `plan` role's model. */
  model?: string;
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
  /** The epic `confirmPlan` minted for this plan, when the proposal carried
   * one, so a row can link straight to its milestone. Absent on a flat plan. */
  epicId?: string;
  /** Set when the plan was started from a note via `enrichNote` — the note
   * whose one-liner the planner was asked to expand into a task. Confirming
   * such a plan links that note to the task it creates. */
  sourceNoteId?: string;
  /** What the plan is about, for list rows: the task/note/capture title an
   * enrich plan was started from. Absent on free-form plans. */
  subject?: string;
}

// The body of `POST /api/plan/:id/confirm`.
export interface ConfirmResult {
  epicId?: string;
  taskIds: string[];
}

// Mirrors PlanSummary in packages/server/src/orchestrator/plan.ts — one row
// of GET /api/plans, the record minus its heavy transcript.
export interface PlanSummary {
  id: string;
  prompt: string;
  subject?: string;
  state: PlanState;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  epicId?: string;
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

// Mirrors OverseerState in packages/server/src/orchestrator/overseer.ts:
// `running` means a turn is in flight; `ready` means the last turn settled and
// the conversation is idle (possibly with actions awaiting confirmation);
// `failed` means the last turn errored.
export type OverseerState = 'running' | 'ready' | 'failed';

// Mirrors OverseerMessage in packages/server/src/orchestrator/overseer.ts — one
// transcript entry. `user`/`assistant` are the conversation proper; `tool`
// records a tool call the assistant made mid-turn (a registry status tool or
// a built-in one); `action` records a mutating registry call's life: queued
// at `pending`, then `applied`/`denied`/`failed` once a human decides;
// `approval` records a built-in tool call's life: parked at `pending`, then
// `allowed`/`denied`.
export interface OverseerMessage {
  role: 'user' | 'assistant' | 'tool' | 'action' | 'approval';
  text: string;
  at: string;
  /** `tool`, `action` and `approval` entries: which tool the entry is about. */
  tool?: string;
  /** `action` entries: the OverseerAction this entry reports on. */
  actionId?: string;
  /** `approval` entries: the OverseerApproval this entry reports on. */
  requestId?: string;
  /**
   * `action` and `approval` entries only. `failed` means the human approved
   * an action but the effect itself threw — the action stays pending so it
   * can be retried. `allowed` is an approval's yes; `applied` an action's.
   */
  outcome?: 'pending' | 'applied' | 'allowed' | 'denied' | 'failed';
  /** `user` and `assistant` entries posted to the bus: the message there. */
  messageId?: string;
}

// Mirrors OverseerApproval in packages/server/src/orchestrator/overseer.ts —
// a built-in tool call (Bash, Edit, a project MCP tool) the overseer's running
// turn is blocked on until a human answers its `tool-approval` gate. Allowing
// runs the call at once.
export interface OverseerApproval {
  /** The backend's handle for the call; what its gate's `requestId` names. */
  requestId: string;
  toolName: string;
  /** The call's input, exactly as the tool will receive it if allowed. */
  input: unknown;
  /** One line, safe to render verbatim, saying what the call would do. */
  summary: string;
  requestedAt: string;
}

// Mirrors OverseerAction in packages/server/src/orchestrator/overseerTools.ts —
// one queued mutating tool call awaiting (or past) its human decision.
export interface OverseerAction {
  id: string;
  /** The mutating tool this action would invoke. */
  tool: string;
  /** The validated input, exactly as the server's `apply` will receive it. */
  input: unknown;
  /** One sentence, safe to render verbatim in the chat UI. */
  summary: string;
  createdAt: string;
  status: 'pending' | 'applied' | 'denied';
}

// Mirrors OverseerRecord in packages/server/src/orchestrator/overseer.ts — the
// body of `POST /api/overseer` and `GET /api/overseer/:id`.
export interface OverseerRecord {
  id: string;
  /** The opening prompt, kept alongside `messages[0]` for callers that only want the ask. */
  prompt: string;
  /** Which registered backend this conversation talks to; follow-ups re-resolve it. */
  backendName: string;
  /** The model this conversation was opened on when the composer chose one;
   *  every follow-up reuses it. Absent: the configured `overseer` role's model. */
  model?: string;
  /** Same rule as `model`, falling back to config `effort.overseer`. */
  effort?: EffortLevel;
  state: OverseerState;
  messages: OverseerMessage[];
  /**
   * Mutating tool calls this conversation has queued that nobody has decided
   * on yet — the confirmation queue the chat UI renders.
   */
  pendingActions: OverseerAction[];
  /**
   * Built-in tool calls the running turn is blocked on, oldest first. Only
   * non-empty while `state` is `running`.
   */
  pendingApprovals: OverseerApproval[];
  /**
   * Decisions the human has made since the last turn, not yet shown to the
   * model; drained into the next `sendOverseerMessage` turn server-side.
   */
  undeliveredDecisions: string[];
  /** The backend's resume handle from the most recent turn. */
  sessionId?: string;
  /** The bus thread this conversation's lines are posted to, once one is. */
  thread?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// Mirrors AgentSessionKind in packages/server/src/orchestrator/agentSessions.ts:
// which kind of conversation agent a session row is — planner chat, enrich
// ("add detail") agent, single-task draft, or overseer chat. Task runs are not
// part of this union; they are listed by `fetchRuns` and merged client-side.
export type AgentSessionKind = 'plan' | 'enrich' | 'draft' | 'overseer';

// Mirrors AgentSessionMeta in packages/server/src/orchestrator/agentSessions.ts
// — the body of `GET /api/agents`: every in-memory conversation agent the
// daemon holds, normalized for a list row, newest activity first.
export interface AgentSessionMeta {
  id: string;
  kind: AgentSessionKind;
  /** What the agent is working on: an enrich plan's task/note/capture title,
   * or the opening prompt's first line for free-form conversations. */
  title: string;
  /** The shared conversation lifecycle: turn in flight, settled, or errored. */
  state: 'running' | 'ready' | 'failed';
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// Mirrors packages/server/src/orchestrator/types.ts's ExecutorInfo.
export interface ExecutorInfo {
  name: string;
  /** Whether a finished run's `costUsd` is real; a `false` executor's runs show no cost. */
  reportsCost: boolean;
  reportsTurns: boolean;
  /** Whether the executor honours `orchestrator.maxTurns`/`maxBudgetUsd` itself. */
  enforcesCaps: boolean;
}

export interface ExecutorsResponse {
  executors: ExecutorInfo[];
  /** `orchestrator.executor`: what a dispatch that names no executor runs on. */
  default: string;
}

// Mirrors EpicSessionState / EpicPauseReason in
// packages/server/src/orchestrator/epic.ts.
export type EpicSessionState = 'active' | 'paused' | 'stopped' | 'complete';
export type EpicPauseReason = 'human' | 'budget' | 'runs' | 'fill-failed';

// Mirrors EpicSession in packages/server/src/orchestrator/epic.ts — the body
// of `POST /api/epics/:id/dispatch`, `/pause`, `/resume` and `/stop`.
export interface EpicSession {
  epicId: string;
  concurrency: number;
  executor: string;
  state: EpicSessionState;
  /** Set while paused, cleared on resume. */
  pausedReason?: EpicPauseReason;
  /** The message behind a `fill-failed` pause. */
  pausedDetail?: string;
  /** `null` = no spend ceiling. */
  maxSpendUsd: number | null;
  /** `null` = no run ceiling. */
  maxRuns: number | null;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  /** The human who started the session; its auto-fill runs act for them. */
  startedBy?: string;
  /** `state === 'active'` — kept for `formatEpicProgress` and `--watch`. */
  active: boolean;
}

// Mirrors EpicSpend in packages/server/src/orchestrator/epicPhase.ts: what
// one session has spent and started, against its ceilings.
export interface EpicSpend {
  /** Σ `RunMeta.costUsd` over the session's runs (stamped at finish). */
  settledUsd: number;
  /** Non-terminal session runs, any kind. */
  liveCount: number;
  /** `liveCount × orchestrator.runCostEstimateUsd`. */
  estimatedLiveUsd: number;
  /** Session runs of every kind — what `maxRuns` bounds. */
  runsStarted: number;
  maxSpendUsd: number | null;
  maxRuns: number | null;
}

// Mirrors EpicChildPhase in packages/server/src/orchestrator/epicPhase.ts:
// where a child stands inside its epic's fan-out, derived server-side so the
// CLI and desktop agree.
export type EpicChildPhase =
  | 'draft'
  | 'waiting'
  | 'queued'
  | 'held'
  | 'working'
  | 'reviewing'
  | 'fixing'
  | 'needs-review'
  | 'capped'
  | 'failed'
  | 'blocked'
  | 'landing'
  | 'landed'
  | 'dropped';

// Mirrors EpicProgressChild in packages/server/src/orchestrator/epicPhase.ts.
export interface EpicProgressChild {
  id: string;
  title: string;
  status: string;
  phase: EpicChildPhase;
  /** Depth along `blockedBy` edges inside the epic, 1-based. */
  wave: number;
  reason?: string;
  /** The live run, else the latest one. */
  runId?: string;
  /** The latest run's cost. */
  costUsd?: number;
  openFindings: number;
}

// Mirrors EpicWave in packages/server/src/orchestrator/epicPhase.ts.
export interface EpicWave {
  index: number;
  total: number;
  byPhase: Partial<Record<EpicChildPhase, number>>;
}

// Mirrors EpicProgress in packages/server/src/orchestrator/epic.ts — the
// body of `GET /api/epics/:id/progress` (and one row of `GET
// /api/epics/progress`).
export interface EpicProgress {
  epicId: string;
  active: boolean;
  concurrency?: number;
  /** `null` until the epic's first `startEpic`. */
  session: EpicSession | null;
  /** For the session's runs, or for every child run when there is none. */
  spend: EpicSpend;
  children: EpicProgressChild[];
  waves: EpicWave[];
  liveRuns: RunMeta[];
}

/** The optional body `startEpic` and `resumeEpic` take. `null` lifts a
 * ceiling; the server ranges every value and 400s out of range. */
export interface EpicSessionOptions {
  concurrency?: number;
  executor?: string;
  maxSpendUsd?: number | null;
  maxRuns?: number | null;
}

/**
 * The body of `POST /api/epics/:id/land`. `pr`: a landing PR was opened and
 * the server's poller will flip the epic to done once GitHub reports it
 * merged. `merge`: the epic landed locally right now — `mergeCommit` is the
 * merge commit's sha, absent only when the branch carried no commits and
 * landing just closed the epic out. Not exported until a consumer needs it
 * by name (knip gates unused exports at zero); reach it via
 * `Awaited<ReturnType<ApiClient['landEpic']>>` meanwhile.
 */
type EpicLandResult =
  | { mode: 'pr'; prUrl: string }
  | { mode: 'merge'; mergeCommit?: string };

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
  /** An existing task the triage judged this capture a duplicate of; the
   * task was still created — this is a heads-up, not a refusal. */
  duplicateOf?: string;
  error?: string;
}

// Mirrors Snippet/ChatMessage in packages/server/src/conversations.ts.
export interface Snippet {
  file: string;
  startLine: number;
  endLine: number;
  /** The code as it read when attached, so the message survives the branch moving. */
  text: string;
}

export interface ChatMessage {
  id: string;
  role: 'human' | 'agent';
  body: string;
  snippets: Snippet[];
  /** Which target a human message was sent to; absent on an agent reply. */
  target?: string;
  created: string;
}

// Mirrors ReviewComment/ReviewReply in packages/server/src/reviewComments.ts. `anchorText` is
// what the line said when the comment was written — the only way to tell later whether it still
// points at the code it was about.
export interface ReviewReply {
  id: string;
  author: string;
  body: string;
  created: string;
  /** GitHub comment id, when this reply was posted to or pulled from GitHub. */
  githubId?: number;
}

/**
 * What a review is looking at: a local run's diff, or a GitHub pull request.
 * Mirrors packages/server/src/reviewTarget.ts; the desktop re-exports this
 * one rather than declaring a third copy.
 */
export type ReviewTarget =
  | { kind: 'run'; runId: string }
  | { kind: 'pr'; number: number };

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
  /** Replacement text for `startLine..line`, when the reviewer wrote one. */
  suggestion?: string;
  resolved: boolean;
  created: string;
  replies: ReviewReply[];
  /**
   * GitHub's own comment id, set once the comment exists on the PR. This —
   * not `pending` — is what says whether GitHub can be talked to about this
   * comment: replying needs an id GitHub already knows.
   */
  githubId?: number;
  /** GitHub comment update timestamp, when synced from GitHub. */
  githubUpdatedAt?: string;
  /**
   * GraphQL node id of the comment's GitHub review thread. Resolution lives
   * on the thread, so resolving is only offered once this is known.
   */
  githubThreadId?: string;
  /** Which side of the mirror wrote this record first. */
  origin?: 'local' | 'github';
}

/** One filter clause the AI filter proposes — the desktop's own facet/op
 * vocabulary (apps/desktop/src/lib/taskFilters.ts), mirrors AiFilterClause in
 * packages/server/src/aiTaskFilter.ts. */
export interface AiTaskFilterClause {
  facet: string;
  op: string;
  values: string[];
}

/** What POST /api/tasks/filter/ai answers for a sentence. */
export interface AiTaskFilterResult {
  clauses: AiTaskFilterClause[];
  join: 'and' | 'or';
}

/** One model-proposed grouping of related captures, ready to become an epic. */
export interface InboxClusterGroup {
  epicTitle: string;
  reason: string;
  itemIds: string[];
}

/** The persisted last clustering pass — mirrors InboxClusterSnapshot in
 * packages/server/src/inboxClusterer.ts. */
export interface InboxClusterSnapshot {
  groups: InboxClusterGroup[];
  /** The open item ids the pass covered, for judging staleness client-side. */
  itemIds: string[];
  updatedAt: string;
}

/** How completely a task spec says what done looks like — mirrors
 * ReadinessReading in packages/server/src/judgments/readiness.ts. */
export interface ReadinessReading {
  /** 0 = title only .. 3 = acceptance criteria and surface both named. */
  level: 0 | 1 | 2 | 3;
  label: string;
  confidence: number;
  /** Probability the task bundles two or more independently doable changes. */
  splitProbability: number;
}

/** What the triage judged one capture to be — mirrors InboxTriage in
 * packages/server/src/judgments/inboxTriage.ts. */
export interface InboxTriage {
  itemId: string;
  hash: string;
  /** The judged kind; `noise` means it is not about the project at all. */
  kind: InboxKind | 'noise';
  kindConfidence: number;
  /** The open epic this belongs to, or null when none won with confidence. */
  epicId: string | null;
  /** That epic's title at triage time, so a row can name it without a lookup. */
  epicTitle: string | null;
  epicConfidence: number;
  /** Tasks or other captures this looks like a duplicate of, strongest first. */
  duplicates: { id: string; probability: number }[];
}

/** The persisted last triage pass, keyed by item id. */
export interface InboxTriageSnapshot {
  items: Record<string, InboxTriage>;
  updatedAt: string;
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
  // Held because the PR itself isn't green on GitHub (draft, conflicting,
  // failing/pending checks, or an outstanding review verdict). Same contract
  // as 'blocked-environment' — stays in the queue carrying `reason`, retried
  // automatically as PrManager's poll cache updates.
  | 'waiting-github'
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

// Mirrors GateStatus in packages/server/src/landing.ts — what a landing row
// is currently blocked on, if anything.
export type GateStatus =
  | 'ready'
  | 'waiting-checks'
  | 'waiting-review'
  | 'conflicts'
  | 'draft'
  | 'queue-position'
  | 'verifying'
  | 'merging'
  | 'blocked'
  | 'none';

// Mirrors LandingGate in packages/server/src/landing.ts.
export interface LandingGate {
  status: GateStatus;
  detail: string;
}

// Mirrors LandingWorktree in packages/server/src/landing.ts.
export interface LandingWorktree {
  path: string;
  syncState: 'synced' | 'behind' | 'dirty-hold';
  headOid: string;
}

// The body of `GET /api/landing` — mirrors LandingRow in
// packages/server/src/landing.ts.
export interface LandingRow {
  id: string;
  kind: 'pr' | 'run-pr' | 'queue-local';
  title: string;
  taskId?: string;
  runId?: string;
  pr?: RepoPr;
  queue?: { position: number; entry: MergeQueueEntry };
  gate: LandingGate;
  worktree?: LandingWorktree;
  /** How many of the task's requirements the run's diff was judged to
   * implement, when a checklist exists for it. `weak` lists the ones below
   * 0.5 — worth a human look. Annotation only; never gates a merge. */
  checklist?: { passed: number; total: number; weak: string[] };
}

/** What a credential may do, lowest first; each tier includes the ones
 *  before it. Mirrors packages/server/src/tiers.ts. */
export type AuthTier = 'request' | 'decide' | 'operator';

/** One person connected to this daemon — mirrors PresenceEntry in
 * packages/server/src/presence.ts. */
export interface PresenceEntry {
  handle: string;
  ref: string;
  /** How many of their clients are open; two means app plus a tab. */
  connections: number;
  since: string;
  /** Live runs they dispatched. */
  runs: string[];
  /** The task they have open, or null. */
  viewing: string | null;
}

/** Someone holding a credential for this daemon, never the credential —
 *  mirrors IssuedTokenSummary in packages/server/src/identity.ts. */
export interface TeamTokenHolder {
  handle: string;
  tier: AuthTier;
  /** The daemon's own pair, which belongs to whoever runs it. */
  builtIn: boolean;
  issuedAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  expired: boolean;
}

/** A just-issued teammate credential: the only response that carries one. */
export interface IssuedTeamToken {
  handle: string;
  tier: AuthTier;
  token: string;
  expiresAt: string | null;
}

/** Why board sync isn't running — mirrors BoardSyncOffReason in
 *  packages/server/src/api.ts: the board is kept as files, which it can't
 *  share; it is off; or it is on in config.yml but didn't start. */
export type BoardSyncOffReason = 'files' | 'off' | 'not-started';

/** Board sync's state — mirrors SyncStatus in
 *  packages/server/src/team/boardSync/service.ts. `reason` is absent on
 *  daemons older than it. */
export type BoardSyncStatus =
  | { enabled: false; reason?: BoardSyncOffReason }
  | {
      enabled: true;
      replica: string;
      remote: string;
      branch: string;
      lastSyncAt: string | null;
      lastError: string | null;
      pending: number;
      applied: number;
      problems: { task: string; message: string; at: string }[];
      /** People sharing the branch, and how many the license covers. */
      people: number;
      seats: number;
      /** Why this machine is paused though the remote is fine — it is past
       *  the license's seats — or null while it syncs. */
      paused: string | null;
    };

/** The plan a project runs on: how many people may use it together, and
 *  how many do. Mirrors licenseView in packages/server/src/team/routes.ts. */
export interface LicenseStatus {
  kind: 'free' | 'licensed' | 'expired' | 'invalid';
  seats: number;
  used: number;
  org: string | null;
  expiresAt: string | null;
  /** Why an installed key was not accepted, for `invalid`. */
  reason: string | null;
}

/** Where teammates reach this daemon. `origins` is empty unless it is bound
 *  beyond loopback. */
export interface TeamAddress {
  shared: boolean;
  origins: string[];
}

/** One run's dev-server preview — mirrors PreviewState in
 * packages/server/src/preview.ts. */
export interface RunPreview {
  runId: string;
  status: 'starting' | 'ready' | 'failed' | 'stopped';
  port: number;
  /** Daemon-relative, e.g. `/preview/r-abc123/`. Resolve it against the
   *  daemon's base URL; the dev server's own port is never the address. */
  url: string;
  /** Team-local mode only: a signed, expiring link to this preview on an
   *  origin of its own, for a teammate's browser — see previewGateway.ts. */
  remoteUrl?: string;
  command: string;
  error?: string;
  startedAt: string;
  lastRequestedAt: string;
}

/** Why there is no preview, when there is none. `disabled` and `no-command`
 *  are ordinary states a surface renders as an empty state rather than an
 *  error — most repos that are not web apps answer `no-command`. */
export type RunPreviewReason = 'disabled' | 'no-command' | 'no-worktree';

export interface RunPreviewResult {
  preview: RunPreview | null;
  reason?: RunPreviewReason;
}

/** A finished run's diff judged against its task's requirements — mirrors
 * RunChecklist in packages/server/src/judgments/landingChecklist.ts. */
export interface RunChecklist {
  runId: string;
  taskId: string;
  items: { text: string; probability: number }[];
  passed: number;
  total: number;
  weak: string[];
  /** Probability the diff changes behaviour no requirement asks for. */
  scopeCreep: number;
  createdAt: string;
}

// Mirrors LandedRow in packages/server/src/landing.ts — one entry in the
// landing feed's "recently landed" history.
export interface LandedRow {
  id: string;
  title: string;
  via: 'pr' | 'local';
  prNumber?: number;
  mergeCommit?: string;
  finishedAt: string;
}

// Mirrors LandingGroup in packages/server/src/landing.ts — the four landing
// sections a row's gate buckets into.
export type LandingGroup = 'needs-you' | 'in-queue' | 'waiting-github' | 'open';

// The body of `GET /api/landing` — mirrors LandingSnapshot in
// packages/server/src/landing.ts.
export interface LandingSnapshot {
  rows: LandingRow[];
  landed: LandedRow[];
  generatedAt: string;
}

// Mirrors SyncState in packages/server/src/sync/boardSyncer.ts. No real
// SyncResult a `syncOnce()` produces ever carries `'disabled'` or `'off'` —
// GET /api/sync synthesizes `'disabled'` when no scheduler exists (database
// backend, or no trunk resolvable at boot) and `'off'` when "Commit task
// files to the main branch" (config `autoCommit`) is off.
export type SyncState = 'idle' | 'local-only' | 'blocked' | 'disabled' | 'off';

// Mirrors SyncResult in packages/server/src/sync/boardSyncer.ts — the
// `board.sync` WS event's payload.
export interface SyncResult {
  pushed: number;
  /** How many files materialize() wrote or removed in the working tree. */
  pulled: number;
  state: SyncState;
  detail: string | null;
}

// The body of `GET /api/sync` — mirrors packages/server/src/api.ts's
// SyncStatus. `pendingOutgoing`/`pendingIncoming` are read live on every
// request, not frozen at the last sync attempt.
export interface SyncStatus extends SyncResult {
  pendingOutgoing: number;
  pendingIncoming: number;
  /** When the last sync attempt finished, or `null` before the first one. */
  lastSyncedAt: string | null;
  /** Null when `dispatch merge-task` resolves on the daemon's PATH; otherwise why it doesn't. */
  mergeDriverWarning: string | null;
  /**
   * The receipt log's last export — the database backend's half of "is
   * dispatch keeping git up to date". A project has a board syncer or a
   * receipts exporter, never both, so a UI that only reads the board-sync
   * fields reports a database-backed project as permanently disabled.
   */
  receipts: ReceiptsStatus;
}

/**
 * Mirrors `ReceiptsStatus` in packages/server/src/api.ts.
 *
 * `disabled` means the file backend, where the board syncer commits task
 * files directly and there is no receipt log — not that anything is wrong.
 */
export interface ReceiptsStatus {
  state: 'committed' | 'clean' | 'failed' | 'idle' | 'disabled';
  detail: string | null;
  /** The commit the last export made, when it made one. */
  commit: string | null;
  changed: number;
  removed: number;
  /** Records the export could not read out of the database. */
  problems: number;
  lastExportedAt: string | null;
}

/** Mirrors `ReceiptsResult` in packages/server/src/receipts/exporter.ts. */
export interface ReceiptsResult {
  state: 'committed' | 'clean' | 'failed';
  dir: string;
  commit: string | null;
  changed: number;
  removed: number;
  problems: number;
  detail: string;
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
  keySource: 'project' | 'env' | 'global' | null;
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

// Mirrors ImpactSubject in packages/server/src/impact.ts — what a blast-radius
// query was asked about.
export type ImpactSubject =
  | { kind: 'file'; path: string }
  | { kind: 'run'; runId: string }
  | { kind: 'task'; taskId: string };

// Mirrors SUBJECT_KINDS in packages/server/src/api/impact.ts — the `subject`
// query param GET /api/impact accepts. Checked against the server source in
// server-parity.test.ts.
export const IMPACT_SUBJECT_KINDS = ['file', 'run', 'task'] as const;
export type ImpactSubjectKind = (typeof IMPACT_SUBJECT_KINDS)[number];

// Mirrors BlastEntry in packages/server/src/depmap.ts — one file reachable
// from the subject's seed set, at its closest hop distance.
export interface ImpactEntry {
  path: string;
  hops: number;
}

// Mirrors ReachResult in packages/server/src/depmap.ts — the blast radius
// computed over a subject's seed file set.
export interface ImpactReach {
  entries: ImpactEntry[];
  count: number;
  maxHops: number;
  sources: ('carto' | 'scanner')[];
  degraded: boolean;
  truncated: boolean;
  // Seeds none of `sources` could analyse (e.g. a non-.ts file under a
  // scanner-only result) — a 0 count here means "not analysed", not "no
  // dependents", and callers must render the two differently.
  unanalyzedSeeds: string[];
}

// The body of `GET /api/impact`. `reason` is set only on the 200s a task
// subject can get back with an empty reach that is still a real answer, not
// an error: `no-declared-writes` (nothing declared) or `writes-match-nothing`
// (declared writes matched no tracked file) — see getImpact in
// packages/server/src/api/impact.ts.
export interface ImpactResponse {
  subject: ImpactSubject;
  seeds: string[];
  reach: ImpactReach;
  reason?: string;
}

/** Thrown by `request()` on a non-2xx response. `message` is unchanged from
 *  a plain `Error`; `status` is additive, for telling e.g. 404 from 500. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /**
     * The server's stable `code`, when it sent one — `auth_missing_token`,
     * `auth_invalid_token`, `auth_insufficient_tier`. Key on this rather than
     * the message, which is prose and will be reworded.
     */
    public readonly code?: string,
    /** The messaging routes' `field`: which input was bad (`to[0]`,
     *  `choice`, `about`). */
    public readonly field?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** True for the 403 that means "this token is valid but ranks below decide tier". */
export function isInsufficientTier(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'auth_insufficient_tier';
}

/** Where a request goes and what credential it presents. */
interface ApiTarget {
  baseUrl: string;
  /** The daemon token; omitted only when none is available, which 401s. */
  token?: string;
}

// The daemon injects its agent token into the HTML it serves, because a
// browser page has no filesystem and so cannot read the daemon file itself.
export function injectedDaemonToken(): string | undefined {
  const value = (globalThis as { __DISPATCH_DAEMON_TOKEN__?: unknown })
    .__DISPATCH_DAEMON_TOKEN__;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Whether a request should declare `content-type: application/json`. Reads are
// excluded on purpose: a content-type on a GET would make it a non-simple
// cross-origin request and cost a preflight for nothing.
function isStateChanging(init: RequestInit | undefined): boolean {
  if (init?.body !== undefined) return true;
  return STATE_CHANGING_METHODS.has((init?.method ?? 'GET').toUpperCase());
}

// send() with the body parsed as JSON. Every typed fetcher below is a thin
// wrapper around this.
async function request<T>(
  target: ApiTarget,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await send(target, path, init);
  return (await res.json()) as T;
}

// Shared fetch wrapper behind request() and requestBlob(): resolves against
// `target.baseUrl`, presents its token, and throws with the server's
// `{ error }` message (falling back to the status code) on any non-2xx.
// Defaults content-type here (not per call site), so a bare `{ body: ... }`
// still passes the server's Content-Type gate. It goes on every state-changing
// request, body or not, so the gate can be a blanket rule rather than one the
// body-less POSTs (cancelRun, gitPull, clusterInbox, …) have to be exempt from.
// A FormData body is left without one so fetch writes the multipart boundary
// itself.
async function send(
  target: ApiTarget,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (
    !headers.has('content-type') &&
    isStateChanging(init) &&
    !(init?.body instanceof FormData)
  ) {
    headers.set('content-type', 'application/json');
  }
  if (target.token !== undefined) {
    headers.set('authorization', `Bearer ${target.token}`);
  }
  const res = await fetch(`${target.baseUrl}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      field?: string;
    };
    throw new ApiError(
      body.error ?? `request failed: ${res.status}`,
      res.status,
      body.code,
      body.field
    );
  }
  return res;
}

// request() for a binary body: same auth and error handling, the response
// as a Blob (an attachment download).
async function requestBlob(target: ApiTarget, path: string): Promise<Blob> {
  return (await send(target, path)).blob();
}

// An entry's route; a `#handle` travels as %23 so it is not read as a fragment.
function memoryPath(ref: string): string {
  return `/api/memory/${encodeURIComponent(ref)}`;
}

function jsonBody(value: unknown): RequestInit {
  return {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

// The base path a ReviewTarget's comment routes hang off — /api/runs/:id
// or /api/prs/:number, matching the server's own run- vs PR-keyed split.
// Shared by every fetch/add/resolve/reply call below so a target's routing
// lives in exactly one place.
function reviewTargetPath(reviewTarget: ReviewTarget): string {
  return reviewTarget.kind === 'run'
    ? `/api/runs/${encodeURIComponent(reviewTarget.runId)}`
    : `/api/prs/${reviewTarget.number}`;
}

// `?k=v&…` from the defined values in insertion order, booleans as 1/0;
// '' when none is defined.
function queryString(
  params: Record<string, string | number | boolean | undefined>
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(
      key,
      typeof value === 'boolean' ? (value ? '1' : '0') : String(value)
    );
  }
  return search.size > 0 ? `?${search.toString()}` : '';
}

// Pure helper (no fetch involved) so the query-string shape is unit
// testable without a network layer: `?` + params when any filter is set, ''
// otherwise, in the same status/kind/parent order the server accepts.
// The `path` (+ optional `runId`) query every /api/files route takes. One
// builder so a scope is never half-applied — a tree request that forgot the
// run would silently browse the main checkout instead.
function workspaceQuery(path: string, scope: WorkspaceScope): string {
  const params = new URLSearchParams({ path });
  if (scope.runId != null) params.set('runId', scope.runId);
  return params.toString();
}

export function taskQueryString(filter: TaskFilter = {}): string {
  const params = new URLSearchParams();
  if (filter.status !== undefined) params.set('status', filter.status);
  if (filter.kind !== undefined) params.set('kind', filter.kind);
  if (filter.parent !== undefined) params.set('parent', filter.parent);
  if (filter.archived === true) params.set('archived', '1');
  return params.size > 0 ? `?${params.toString()}` : '';
}

/**
 * Whether a run's `prUrl` is one `submitReview({ postToGitHub: true })` can
 * actually reach. The server resolves the PR by parsing the url and 400s
 * anything it cannot, so a UI keyed on "has a prUrl" alone would offer a
 * choice that always fails. Kept in step with `parsePrUrl` in
 * packages/server/src/orchestrator/pr.ts.
 */
export function canPostReviewToPr(prUrl: string | undefined): boolean {
  if (prUrl === undefined) return false;
  return /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(prUrl);
}

// Pure helper (no DOM involved): swaps an http(s) origin for its ws(s)
// equivalent and appends `/ws`.
export function httpToWs(origin: string): string {
  return `${origin.replace(/^http/, 'ws')}/ws`;
}

// Resolves the WS URL for a given baseUrl, falling back to the current
// page's own origin when baseUrl is empty — the same-origin default case
// (dispatchd serving its own static UI). The token rides in the query string
// because the browser WebSocket API cannot set an Authorization header; the
// daemon accepts it there for `/ws` and nowhere else.
export function wsUrl(baseUrl: string, token?: string): string {
  const url = httpToWs(baseUrl !== '' ? baseUrl : window.location.origin);
  return token === undefined
    ? url
    : `${url}?token=${encodeURIComponent(token)}`;
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
  // Called for every parsed ServerEvent, where `onChange` hears only
  // `task.changed`; a malformed frame never reaches it (see JSON.parse below).
  onEvent?: (event: ServerEvent) => void;
  // Daemon token for the upgrade, since the guard covers `/ws` too. Defaults
  // to whatever the daemon injected into the page it served.
  token?: string;
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
  const token = options.token ?? injectedDaemonToken();

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
    socket = createSocket(wsUrl(baseUrl, token));
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

/**
 * A shell session the daemon holds open — see packages/server/src/terminals.ts.
 *
 * `total` and `trimmed` bound the byte cursor a reader holds: everything
 * between them is still in scrollback, anything below `trimmed` has aged out.
 */
export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  command: string[];
  cols: number;
  rows: number;
  startedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
  /** `orphaned` is a session this daemon inherited from a previous process:
   * its output is readable, but nothing is listening on its stdin. */
  state: 'running' | 'exited' | 'orphaned';
  pty: boolean;
  total: number;
  trimmed: number;
  runId: string | null;
}

export interface TerminalOutput {
  id: string;
  /** Where this read actually began, clamped forward past `trimmed`. */
  since: number;
  total: number;
  trimmed: number;
  /** Base64 — output is bytes, not text, and a chunk can split a code point. */
  data: string;
  state: TerminalInfo['state'];
  exitCode: number | null;
  /** The cursor to pass to the next read. */
  next: number;
  /** True when the read hit its size cap and more is already waiting. */
  more: boolean;
}

export interface CreateTerminalInput {
  /** A run, to open on its worktree. Takes precedence over `cwd`. */
  runId?: string;
  /** A path inside the project or one of its worktrees; defaults to the root. */
  cwd?: string;
  /** Defaults to the user's login shell. */
  command?: string[];
  title?: string;
  cols?: number;
  rows?: number;
}

/** One entry in a directory listing. `path` is relative to the scope's base. */
export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size: number;
  modifiedAt: string | null;
}

export interface WorkspaceTree {
  path: string;
  runId: string | null;
  entries: WorkspaceEntry[];
}

/**
 * A file the editor opened.
 *
 * `kind` is why there may be no text: `binary` and `too-large` are facts about
 * the file that the UI renders, not errors — both arrive with a 200.
 */
export interface WorkspaceFile {
  path: string;
  runId: string | null;
  size: number;
  modifiedAt: string;
  mime: string;
  /** How the preview pane should render it, when it cannot be edited as text. */
  preview: 'image' | 'pdf' | 'video' | 'audio' | 'none';
  kind: 'text' | 'binary' | 'too-large';
  text: string | null;
}

export interface WorkspaceSearchHit {
  path: string;
  score: number;
  /** Indices in `path` that matched, for highlighting. */
  positions: number[];
}

export interface WorkspaceSearchResult {
  runId: string | null;
  query: string;
  /** How many files were considered, so a UI can say "12 of 4,300". */
  total: number;
  results: WorkspaceSearchHit[];
}

/** Which checkout a file request is against: a run's worktree, or the repo. */
export interface WorkspaceScope {
  runId?: string | null;
}

/** A Chromium the daemon is driving — see packages/server/src/browser. */
export interface BrowserInfo {
  id: string;
  url: string;
  headless: boolean;
  startedAt: string;
  /** True while Design Mode is armed and waiting for a click. */
  picking: boolean;
}

/** What Design Mode captured: enough to tell an agent which thing is meant. */
export interface PickedElement {
  selector: string;
  tagName: string;
  id: string | null;
  className: string | null;
  text: string;
  outerHTML: string;
  /** True when the markup was cut at the capture limit. */
  outerHTMLTruncated: boolean;
  styles: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  devicePixelRatio: number;
  url: string;
}

export type PickOutcome =
  | { state: 'picked'; element: PickedElement; screenshot: string }
  | { state: 'cancelled' }
  | { state: 'waiting' };

// Bound client shape returned by `createApiClient` — every method already
// carries `baseUrl`, so callers never repeat it.
export interface ApiClient {
  baseUrl: string;
  fetchHealth(): Promise<HealthPayload>;
  fetchConfig(): Promise<DispatchConfig>;
  /** The board syncer's last attempt plus live pending counts — the sync chip's data source. */
  fetchSyncStatus(): Promise<SyncStatus>;
  fetchTasks(filter?: TaskFilter): Promise<TaskDoc[]>;
  /** Each doc carries `readiness` when the daemon has a judgment client. */
  fetchReadyTasks(): Promise<(TaskDoc & { readiness?: ReadinessReading })[]>;
  /** The cached readiness readings by task id, for the board — no judging
   * happens here; `fetchReadyTasks` is what refreshes stale ones. */
  fetchReadiness(): Promise<Record<string, ReadinessReading>>;
  fetchTask(id: string): Promise<TaskDoc>;
  createTask(input: CreateInput): Promise<TaskDoc>;
  updateTask(id: string, patch: UpdatePatch): Promise<TaskDoc>;
  amendTask(id: string, input: AmendTaskInput): Promise<TaskDoc>;
  /** Multipart upload of `files` against the task; resolves with the doc
   * carrying the grown `attachments` list. */
  uploadTaskAttachments(id: string, files: File[]): Promise<TaskDoc>;
  removeTaskAttachment(id: string, name: string): Promise<TaskDoc>;
  /** The attachment's bytes — 404 when this daemon's machine lacks the blob. */
  fetchTaskAttachment(id: string, name: string): Promise<Blob>;
  /** Whether this daemon's machine has the blob (a HEAD), so Tauri can ask
   * before handing the path to the OS. */
  hasTaskAttachment(id: string, name: string): Promise<boolean>;
  /** Turns a sentence into filter clauses the Tasks page applies as chips. */
  aiFilterTasks(sentence: string): Promise<AiTaskFilterResult>;
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
  // `fresh` forces a brand-new run: without it the server resumes the task's
  // most recent run when that run failed with its worktree still intact, so a
  // re-dispatch cannot silently abandon work an agent had nearly finished.
  createRun(
    taskId: string,
    opts?: {
      executor?: string;
      model?: string;
      effort?: EffortLevel;
      fresh?: boolean;
    }
  ): Promise<RunMeta>;
  fetchRuns(): Promise<RunMeta[]>;
  // The executors this daemon registered (`GET /api/executors`) and which
  // one a dispatch that names none runs on.
  fetchExecutors(): Promise<ExecutorsResponse>;
  // Every in-memory conversation agent (planner chats, enrich agents, task
  // drafts, overseer chats), newest activity first — the non-run half of the
  // All agents page; merge with `fetchRuns` for the full picture. Refetch on
  // `plan.changed`, `draft.changed` and `overseer.changed`.
  fetchAgentSessions(): Promise<AgentSessionMeta[]>;
  fetchRun(id: string): Promise<RunDetail>;
  fetchRunClaims(): Promise<RunClaim[]>;
  cancelRun(runId: string): Promise<void>;
  /**
   * Asks a live run to stop gracefully: the agent finishes its current
   * operation, then ends, so its work is committed and reviewable. Unlike
   * `cancelRun` the run is still live when this resolves — the returned meta
   * carries `stopRequestedAt`, and the run reaches its terminal state later.
   */
  stopRun(runId: string): Promise<RunMeta>;
  // Agent-death recovery: starts a new run in a terminal run's same worktree
  // that reattaches its agent session, so the conversation it was in the
  // middle of carries over, with its survey (if any) rendered into the
  // continuation prompt. A run that never started a session gets a fresh
  // agent instead, and the run's Activity/transcript say so.
  resumeRun(runId: string): Promise<RunMeta>;
  fetchRunDiff(runId: string): Promise<DiffResult>;
  /** What the daemon is holding for this run, without starting anything —
   *  safe to poll while a preview is coming up. */
  /** Who is connected right now, and what each is running. */
  fetchPresence(): Promise<PresenceEntry[]>;
  /** Tells everyone which task this client has open, or null for none. */
  setPresenceFocus(taskId: string | null): Promise<void>;
  /** Decide-tier: who holds a credential. */
  fetchTeamTokens(): Promise<TeamTokenHolder[]>;
  /** Decide-tier, capped at the caller's own tier. `expiresInDays: null` is
   *  never; absent is the daemon's default. */
  issueTeamToken(input: {
    email?: string;
    handle?: string;
    displayName?: string;
    tier?: AuthTier;
    expiresInDays?: number | null;
  }): Promise<IssuedTeamToken>;
  /** Decide-tier: revokes whatever token the handle holds. */
  revokeTeamToken(handle: string): Promise<void>;
  /** Decide-tier: where teammates reach this daemon. */
  fetchTeamAddress(): Promise<TeamAddress>;
  /** Board sync between replicas' databases (boardSync/ on the server);
   *  `{ enabled: false }` when it is off. Not `fetchSyncStatus`, which is the
   *  file backend's board syncer. */
  fetchBoardSyncStatus(): Promise<BoardSyncStatus>;
  /** Runs a board sync pass and answers with the state after it. */
  syncBoardNow(): Promise<BoardSyncStatus>;
  /** The plan this project runs on, and how many seats are in use. */
  fetchLicense(): Promise<LicenseStatus>;
  /** Installs a license key. Rejects with the reason when it does not
   *  verify; the key already installed stays. */
  installLicense(key: string): Promise<LicenseStatus>;
  /** Who this client's credential speaks for. */
  fetchWhoami(): Promise<{
    handle: string;
    ref: string;
    tier: AuthTier;
  }>;
  fetchRunPreview(runId: string): Promise<RunPreviewResult>;
  /** Starts this run's dev server if it has none. Decide-tier: it runs a
   *  command out of the run's own worktree. Resolves with `preview: null` and
   *  a reason when the repo has no dev script or previews are switched off —
   *  an ordinary empty state, not an error. */
  startRunPreview(runId: string): Promise<RunPreviewResult>;
  stopRunPreview(runId: string): Promise<void>;
  /** The run's requirement checklist; 404s until the finish hook wrote one. */
  fetchRunChecklist(runId: string): Promise<RunChecklist>;
  /** The full input of a call the run is parked on, which its tool-approval
   *  gate may carry only a preview of. Decide-tier; 404s once it is settled. */
  fetchRunApproval(
    runId: string,
    requestId: string
  ): Promise<{ tool: string; input: unknown }>;
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
  /** The PR's diff in the same shape `fetchRunDiff` returns. */
  fetchRepoPrDiff(number: number): Promise<DiffResult>;
  reviewRepoPr(
    number: number,
    event: PrReviewEvent,
    body?: string
  ): Promise<PrDetail>;
  commentRepoPr(number: number, body: string): Promise<PrDetail>;
  /**
   * Hands a repo PR to a review agent, which checks the PR's head out and
   * runs in it — executing that code on this machine. A fork PR 409s (the
   * message names the head owner) until `confirmFork` says the user agreed.
   * Resolves with the review run it started, so a caller can confirm it.
   */
  startPrAgentReview(
    number: number,
    input?: { confirmFork?: boolean }
  ): Promise<RunMeta>;
  /**
   * What agent reviews of this PR found. A located finding is also a line
   * comment on the diff; an unlocated one ("this approach is wrong") has
   * nowhere to anchor, so this is the only surface it reaches.
   */
  fetchPrFindings(number: number): Promise<Finding[]>;
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
  /** Starts an AI draft that fleshes out a task that already exists, preserving what is there. */
  enrichTask(id: string): Promise<{ planId: string }>;
  /** Model-backed grouping of related captures. Always resolves with a 200 —
   * `error` carries a failed model call. A successful pass is persisted
   * server-side; `fetchInboxClusters` reads it back. */
  clusterInbox(): Promise<{
    groups: InboxClusterGroup[];
    error: string | null;
  }>;
  /** The persisted result of the last clustering pass, or null when none has
   * ever run — what a page load renders instead of billing a fresh call. */
  fetchInboxClusters(): Promise<InboxClusterSnapshot | null>;
  /** The persisted result of the last triage pass (run as part of
   * `clusterInbox`), or null when none has run or judgments are off. */
  fetchInboxTriage(): Promise<InboxTriageSnapshot | null>;

  /** One side of a file in a run's worktree. `sha` is the precondition for applyRunEdit. */
  fetchRunFile(
    runId: string,
    path: string,
    side: 'old' | 'new'
  ): Promise<{ contents: string; sha: string }>;
  /** Writes a reviewer's edit into the run's worktree and commits it on the run branch. */
  applyRunEdit(
    runId: string,
    input: { file: string; contents: string; baseSha: string }
  ): Promise<{ commit: string }>;
  /** Commits a comment's suggestion. Fails if the comment's anchor line has drifted. */
  applySuggestion(
    runId: string,
    commentId: string
  ): Promise<{ commit: string }>;

  // Line-level review comments, keyed by ReviewTarget so the same four calls
  // work against a run's diff or a GitHub PR — see reviewTargetPath, which
  // picks the /api/runs/:id/… or /api/prs/:number/… URL per target.kind.
  fetchReviewComments(target: ReviewTarget): Promise<ReviewComment[]>;
  addReviewComment(
    target: ReviewTarget,
    input: {
      file: string;
      line: number;
      startLine?: number;
      anchorText: string;
      body: string;
      /** Replacement text for the commented lines. Omit for a prose-only comment. */
      suggestion?: string;
      /** Defaults to true — a comment is staged until the review is submitted. */
      pending?: boolean;
    }
  ): Promise<ReviewComment>;
  resolveReviewComment(
    target: ReviewTarget,
    commentId: string,
    resolved: boolean
  ): Promise<ReviewComment>;
  replyReviewComment(
    target: ReviewTarget,
    commentId: string,
    body: string
  ): Promise<ReviewComment>;
  /** Publishes a run's pending comments and acts on the verdict. Returns
   * how many were published. Run-keyed only — a PR target's equivalent is
   * pushPrReview below, which submits straight to GitHub instead of
   * resuming an agent or enqueuing a merge.
   *
   * `postToGitHub` (default false) also pushes the batch to the run's PR as
   * one GitHub review. Left off, the review still publishes and still goes
   * back to the agent — only the PR is untouched. True on a run with no PR
   * is a 400. */
  submitReview(
    runId: string,
    verdict: ReviewVerdict,
    body: string,
    postToGitHub?: boolean
  ): Promise<{ verdict: ReviewVerdict; published: number; error?: string }>;
  /** Submits a PR target's pending comments as one GitHub review. Hits
   * .../review-submit, not reviewRepoPr's .../review — that path already
   * exists as a one-shot `gh pr review` verdict, so reusing it here would
   * fire both for one submit action. */
  pushPrReview(
    number: number,
    verdict: ReviewVerdict,
    body: string
  ): Promise<{ pushed: number }>;
  /** Resumes the agent on the same branch with the note and every unresolved thread attached. */
  sendBackRun(runId: string, note: string): Promise<RunMeta>;
  /** Hides a run from the default Runs list, or brings it back. Nothing is deleted. */
  setRunArchived(runId: string, archived: boolean): Promise<RunMeta>;

  /** Changes settings. Mirrors core's ConfigPatch exactly — one type, so
   *  what Settings can send is what the daemon accepts. Changing any needs
   *  the decide tier; keys that run a command or send data off the machine
   *  need operator (the server's patchConfig). */
  updateConfig(patch: ConfigPatch): Promise<DispatchConfig>;
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
  // Phase 5 P2: the big-prompt plan flow. `startPlan` returns immediately
  // (202) with the plan's id — poll `fetchPlan`/watch `plan.changed` over WS
  // for it to move to `ready`/`failed`. `confirmPlan` sends the (possibly
  // client-edited) proposal back verbatim; the server re-validates it from
  // scratch and is the only place that actually writes the epic/tasks.
  // `model` is the composer's pick for this plan, over the configured `plan`
  // role's model; the plan keeps it for every follow-up.
  startPlan(
    prompt: string,
    opts?: { model?: string }
  ): Promise<{ planId: string }>;
  fetchPlan(planId: string): Promise<PlanRecord>;
  /** Every plan's summary, newest activity first — the Plans page's history.
   * Persisted server-side, so it survives restarts and spans windows. */
  fetchPlans(): Promise<PlanSummary[]>;
  // Send a follow-up message on an existing plan conversation. Resolves (202)
  // with the record already back in `running` — poll `fetchPlan`/watch
  // `plan.changed` for the assistant's reply + refined proposal to land.
  sendPlanMessage(planId: string, text: string): Promise<PlanRecord>;
  confirmPlan(planId: string, proposal: PlanProposal): Promise<ConfirmResult>;
  // The overseer chat — the project-assistant conversation with human-confirmed
  // mutations. `startOverseer` opens a conversation and resolves (202) with the
  // full record already at `running`; the assistant's reply lands via
  // `overseer.changed`. `backend` follows createRun's `executor` contract:
  // optional, defaults to 'claude' server-side, 400s on an unknown name.
  // `model` is the composer's pick for this conversation, over the configured
  // `overseer` role's model; the conversation keeps it for every follow-up.
  startOverseer(
    prompt: string,
    opts?: { backend?: string; model?: string; effort?: EffortLevel }
  ): Promise<OverseerRecord>;
  getOverseer(id: string): Promise<OverseerRecord>;
  // Sends a follow-up on an existing conversation. Resolves (202) with the
  // record already back in `running` — watch `overseer.changed` for the reply.
  // 404s an unknown conversation and 409s one mid-turn.
  sendOverseerMessage(
    conversationId: string,
    text: string
  ): Promise<OverseerRecord>;
  // Phase 5 P2: epic-level concurrent dispatch. `concurrency` defaults
  // server-side to the project's `orchestrator.epicConcurrency` config;
  // `maxSpendUsd`/`maxRuns` are ceilings that pause the session when reached.
  startEpic(epicId: string, opts?: EpicSessionOptions): Promise<EpicSession>;
  /** Halts new dispatches; live runs continue. 409 unless the session is active. */
  pauseEpic(epicId: string): Promise<EpicSession>;
  /** Fills again, optionally with new ceilings or concurrency. 409 unless paused. */
  resumeEpic(
    epicId: string,
    opts?: Omit<EpicSessionOptions, 'executor'>
  ): Promise<EpicSession>;
  stopEpic(epicId: string): Promise<EpicSession>;
  fetchEpicProgress(epicId: string): Promise<EpicProgress>;
  /** Progress for every non-archived epic, `session: null` where never started. */
  fetchAllEpicProgress(): Promise<EpicProgress[]>;
  // Lands a finished epic branch on the default base — one PR (when the
  // project has the `pr` capability) or one local merge. 409s with the
  // server's reason when the epic is only partially done.
  landEpic(epicId: string): Promise<EpicLandResult>;
  /** The epic branch's diff against the default base, in `fetchRunDiff`'s shape —
   * served from the land-time snapshot once the branch is gone. */
  fetchEpicDiff(epicId: string): Promise<DiffResult>;
  // The merge queue: serialized rebase -> verify -> merge over
  // reviewed-and-approved runs. `enqueueMergeQueue` 404/409s the same way
  // the server's MergeQueue.enqueue does (unknown run, non-terminal, already
  // reviewed, already queued); `removeFromMergeQueue` 409s only when the
  // given run is the entry actively being processed.
  fetchMergeQueue(): Promise<MergeQueueSnapshot>;
  // The unified PR table: runs, the merge queue, and open/merged PRs joined
  // into one feed — server's GET /api/landing. Never 409s: a project with no
  // pr capability still gets its queue-local rows back.
  getLanding(): Promise<LandingSnapshot>;
  // Cuts (POST) or retires (DELETE) a PR's on-demand review worktree — the
  // landing row's "review this locally" action. `confirmFork` mirrors
  // startPrAgentReview's own fork-confirm contract. A dirty worktree 409s on
  // delete; both throw an ApiError the caller can inspect for that.
  createPrWorktree(
    number: number,
    opts?: { confirmFork?: boolean }
  ): Promise<PrWorktreeState>;
  removePrWorktree(number: number): Promise<{ removed: true }>;
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
  // `startFixLoop` is the "Review & fix" button — it opens the loop off the
  // task's own latest implementer, so no caller has to know its base commit.
  // `advanceFixLoop` drives one step (and opens the loop when `baseSha` is
  // supplied); `adjudicateFinding` is the ruling a capped loop demands.
  fetchFixLoop(taskId: string): Promise<FixLoopState>;
  /** Every task's loop state in one read — feeds annotate rows from this. */
  fetchFixLoops(): Promise<FixLoopState[]>;
  startFixLoop(taskId: string): Promise<FixLoopState>;
  /** Caps the loop where it stands (`stopped`) and winds down its live runs.
   * `startFixLoop` on a stopped loop resumes it. */
  stopFixLoop(taskId: string): Promise<FixLoopState>;
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
  // `class: 'audit'` keeps only receipts; the lessons live in memory.
  fetchLedger(filter?: {
    epicId?: string | null;
    class?: 'audit';
  }): Promise<LedgerEntry[]>;
  /** Every message on a subject. `subject` is `run:…`, `worktree:…` or `pr:…`. */
  fetchConversation(subject: string): Promise<ChatMessage[]>;
  addChatMessage(input: {
    subject: string;
    role: 'human' | 'agent';
    body: string;
    snippets: Snippet[];
    target?: string;
  }): Promise<ChatMessage>;
  // The blast radius of a file, a run's diff, or a task's declared writes —
  // `GET /api/impact?subject=<kind>&id=<id>`.
  getImpact(subject: ImpactSubjectKind, id: string): Promise<ImpactResponse>;

  // Messaging; the server's messaging/routes.ts defines these shapes.
  /** Sends a message. A retry with the same `opts.idempotencyKey` replays the
   *  first attempt's result (200) instead of sending twice (201). */
  sendMessage(
    input: SendInput,
    opts?: { idempotencyKey?: string }
  ): Promise<SendResult>;
  getMessage(id: string): Promise<Message>;
  /** An answer if the target is a question or handoff, a plain message
   *  otherwise — the server decides which. */
  replyToMessage(id: string, input: ReplyInput): Promise<SendResult>;
  /** `wait: true` long-polls up to the server's timeout for an answer;
   *  omitted, it checks once and returns immediately. */
  waitForAnswer(
    id: string,
    opts?: { wait?: boolean }
  ): Promise<{ answer: Message | null }>;
  getThread(id: string): Promise<ThreadDetail>;
  /** The most recently active threads project-wide (deciding humans only);
   *  `about: 'task:<id>'` keeps those the task or its runs took part in. */
  listRecentThreads(
    limit?: number,
    opts?: { about?: string }
  ): Promise<{ threads: ThreadSummary[] }>;
  /** `address` defaults to the caller's own mailbox; `states` filters by
   *  delivery state. */
  getMailbox(
    address?: string,
    states?: DeliveryState[]
  ): Promise<{ items: MailboxItem[] }>;
  markDeliveryRead(id: string): Promise<Delivery>;
  listChannels(): Promise<{ channels: ChannelSummary[] }>;
  /** `member` defaults to the caller (a run defaults to its task). */
  joinChannel(name: string, member?: string): Promise<void>;
  /** `member` defaults to the caller (a run defaults to its task), same as
   *  `joinChannel`. */
  leaveChannel(name: string, member?: string): Promise<void>;
  listAgentRoster(): Promise<{ agents: AgentSummary[] }>;
  approveAgent(address: string): Promise<AgentSummary>;
  revokeAgent(address: string): Promise<AgentSummary>;
  /** `muted: true` mutes, `false` unmutes. */
  muteAgent(address: string, muted: boolean): Promise<AgentSummary>;
  /** Open blocking questions addressed to a human (deciding humans only). */
  openDecisions(): Promise<{ items: Message[] }>;
  /** The caller's visible entries; `state` defaults to active and stale. */
  listMemory(q?: {
    scope?: MemoryScope;
    kind?: MemoryKind;
    state?: MemoryState | 'all';
    taskId?: string;
    /** Entries imported from that source (their origin's prefix). */
    origin?: 'ledger' | 'claude' | 'amendment';
    trust?: MemoryTrust;
    limit?: number;
  }): Promise<{ entries: MemoryEntryView[] }>;
  searchMemory(q: {
    query: string;
    scope?: MemoryScope;
    kind?: MemoryKind;
    includeStale?: boolean;
    includeRetired?: boolean;
    limit?: number;
  }): Promise<{ hits: MemorySearchHit[]; search: 'fts5' | 'like' }>;
  /** `ref` is an entry id or a `#handle`. */
  getMemory(ref: string): Promise<MemoryReadResult>;
  /** The caller's index for a task, or the index a run got (the run itself
   *  or a deciding human only). */
  memoryIndex(
    q: { taskId: string } | { runId: string }
  ): Promise<MemoryIndexResult>;
  memoryRecalls(runId: string): Promise<{
    recalls: {
      memoryId: string;
      handle: string | null;
      via: string;
      at: string;
    }[];
  }>;
  memoryHealth(): Promise<MemoryHealth>;
  /** Deciding humans only; `dryRun` reports without writing. */
  importLedger(opts?: {
    dryRun?: boolean;
  }): Promise<{ report: LedgerImportReport; text: string }>;
  /** The daemon's own human only: re-runs the import of their Claude notes;
   *  `from` (absolute) or `none` answers an unconfirmed one. */
  importClaude(opts?: {
    from?: string;
    none?: boolean;
    dryRun?: boolean;
  }): Promise<{ report: ClaudeImportReport }>;
  /** A save to shared memory by anyone but a deciding human is a proposal.
   *  A retry with the same `opts.idempotencyKey` replays the first result. */
  saveMemory(
    input: {
      scope: MemoryScope;
      kind: MemoryKind;
      title: string;
      body: string;
      refs?: Ref[];
      epic?: string | null;
      appliesTo?: string[];
      supersedes?: string;
      projectOnly?: boolean;
    },
    opts?: { idempotencyKey?: string }
  ): Promise<MemorySaveResult>;
  retireMemory(ref: string, reason: string): Promise<MemorySaveResult>;
  /** Restores the entry's previous revision. */
  undoMemory(ref: string): Promise<MemoryEntryView>;
  /** Raises an agent-trust entry to confirmed. */
  confirmMemory(ref: string): Promise<MemoryEntryView>;
  pinMemory(ref: string, pinned: boolean): Promise<MemoryEntryView>;
  /** Copies a personal entry into shared memory; the personal one stays. */
  promoteMemory(
    ref: string,
    scope: 'project' | 'team'
  ): Promise<MemorySaveResult>;
  /** The entry and its history, for good. */
  deleteMemory(ref: string): Promise<void>;
  /** Deciding humans see every proposal; anyone else their own. */
  listMemoryProposals(
    state?: MemoryProposalState
  ): Promise<{ proposals: MemoryProposalView[] }>;
  /** A proposal with its target as proposed against (`base`) and as it is now. */
  getMemoryProposal(id: string): Promise<{
    proposal: MemoryProposalView;
    base: MemoryEntryView | null;
    current: MemoryEntryView | null;
  }>;
  /** The caller's own personal activity, oldest first; the last day when `since` is absent. */
  memoryActivity(since?: string): Promise<{ activity: MemoryActivityRow[] }>;
  memoryIdentity(): Promise<{
    identity: string;
    aliases: { projectKey: string; handle: string }[];
    placeholderEmail: boolean;
  }>;
  /** A one-time code for linking another project, or with `fresh` a new, empty identity. */
  startMemoryLink(opts?: {
    fresh?: boolean;
  }): Promise<{ code: string; expiresAt: string } | { identity: string }>;
  completeMemoryLink(code: string): Promise<{ identity: string }>;
  listIngestProblems(): Promise<{ problems: MemoryIngestProblem[] }>;
  /** Saves a skipped file's kept content to the caller's memory with agent trust. */
  acceptIngestProblem(id: string): Promise<MemorySaveResult>;

  /** The `/ws` URL, token included — it is a credential, so never render or log it. */
  /** One directory's children, for a lazily expanded tree. */
  fetchWorkspaceTree(
    path: string,
    scope?: WorkspaceScope
  ): Promise<WorkspaceTree>;
  fetchWorkspaceFile(
    path: string,
    scope?: WorkspaceScope
  ): Promise<WorkspaceFile>;
  saveWorkspaceFile(
    path: string,
    text: string,
    scope?: WorkspaceScope
  ): Promise<{ path: string; size: number; modifiedAt: string }>;
  /** A URL the browser can put straight in an `img` or `embed` tag. */
  workspaceFileUrl(path: string, scope?: WorkspaceScope): string;
  /** Quick open: fuzzy filename search, gitignore-aware. */
  searchWorkspace(
    query: string,
    scope?: WorkspaceScope & { limit?: number }
  ): Promise<WorkspaceSearchResult>;
  /** Open a Chromium the daemon drives. Headed unless `headless` is set. */
  launchBrowser(opts?: {
    url?: string;
    headless?: boolean;
    width?: number;
    height?: number;
  }): Promise<BrowserInfo>;
  listBrowsers(): Promise<BrowserInfo[]>;
  closeBrowser(id: string): Promise<void>;
  navigateBrowser(id: string, url: string): Promise<BrowserInfo>;
  browserClick(id: string, selector: string): Promise<void>;
  browserFill(id: string, selector: string, value: string): Promise<void>;
  browserEvaluate(id: string, expression: string): Promise<{ value: unknown }>;
  /** A base64 PNG of the page. */
  browserScreenshot(id: string): Promise<{ screenshot: string }>;
  /** Arms Design Mode: the next click in the page is captured, not delivered. */
  browserStartPick(id: string): Promise<{ picking: boolean }>;
  /** Polled while a pick is armed. */
  browserPickResult(id: string): Promise<PickOutcome>;
  /** Every shell session this daemon knows about, oldest first. */
  fetchTerminals(): Promise<TerminalInfo[]>;
  fetchTerminal(id: string): Promise<TerminalInfo>;
  createTerminal(input?: CreateTerminalInput): Promise<TerminalInfo>;
  /** Scrollback after `since`; pass back the reply's `next` to resume. */
  fetchTerminalOutput(id: string, since: number): Promise<TerminalOutput>;
  /** Keystrokes, verbatim — the caller encodes its own control sequences. */
  sendTerminalInput(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<TerminalInfo>;
  /** Ends the process, keeping the scrollback readable. */
  closeTerminal(id: string): Promise<void>;
  /** Ends the process and forgets the session, scrollback included. */
  removeTerminal(id: string): Promise<void>;
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
//
// `token` is the daemon token every call presents. Pass the app token to reach
// the decide-tier calls and to answer gates; the agent token reaches
// everything else. Omitting it falls back to the token the daemon injected
// into the page it served, which is how the browser UI gets one at all.
export function createApiClient(baseUrl: string, token?: string): ApiClient {
  const target: ApiTarget = { baseUrl, token: token ?? injectedDaemonToken() };
  return {
    baseUrl,
    fetchHealth: () => request(target, '/api/health'),
    fetchConfig: () => request(target, '/api/config'),
    fetchSyncStatus: () => request(target, '/api/sync'),
    fetchTasks: (filter = {}) =>
      request(target, `/api/tasks${taskQueryString(filter)}`),
    fetchReadyTasks: () => request(target, '/api/tasks/ready'),
    fetchReadiness: () => request(target, '/api/tasks/readiness'),
    fetchTask: (id) => request(target, `/api/tasks/${id}`),
    createTask: (input) =>
      request(target, '/api/tasks', { method: 'POST', ...jsonBody(input) }),
    updateTask: (id, patch) =>
      request(target, `/api/tasks/${id}`, {
        method: 'PATCH',
        ...jsonBody(patch),
      }),
    amendTask: (id, input) =>
      request(target, `/api/tasks/${id}/amend`, {
        method: 'POST',
        ...jsonBody(input),
      }),
    uploadTaskAttachments: (id, files) => {
      const form = new FormData();
      for (const file of files) form.append('files', file, file.name);
      return request(
        target,
        `/api/tasks/${encodeURIComponent(id)}/attachments`,
        { method: 'POST', body: form }
      );
    },
    removeTaskAttachment: (id, name) =>
      request(
        target,
        `/api/tasks/${encodeURIComponent(id)}/attachments/${encodeURIComponent(name)}`,
        { method: 'DELETE' }
      ),
    fetchTaskAttachment: (id, name) =>
      requestBlob(
        target,
        `/api/tasks/${encodeURIComponent(id)}/attachments/${encodeURIComponent(name)}`
      ),
    hasTaskAttachment: async (id, name) => {
      try {
        await send(
          target,
          `/api/tasks/${encodeURIComponent(id)}/attachments/${encodeURIComponent(name)}`,
          { method: 'HEAD' }
        );
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return false;
        throw err;
      }
    },
    aiFilterTasks: (sentence) =>
      request(target, '/api/tasks/filter/ai', {
        method: 'POST',
        ...jsonBody({ sentence }),
      }),
    draftTask: (prompt) =>
      request(target, '/api/tasks/draft', {
        method: 'POST',
        ...jsonBody({ prompt }),
      }),
    fetchDrafts: () => request(target, '/api/tasks/drafts'),
    fetchDraft: (id) => request(target, `/api/tasks/drafts/${id}`),
    dismissDraft: async (id) => {
      await request(target, `/api/tasks/drafts/${id}`, { method: 'DELETE' });
    },
    sendDraftMessage: (draftId, text) =>
      request(target, `/api/tasks/drafts/${draftId}/message`, {
        method: 'POST',
        ...jsonBody({ text }),
      }),
    createRun: (taskId, opts = {}) =>
      request(target, `/api/tasks/${taskId}/runs`, {
        method: 'POST',
        ...jsonBody({
          ...(opts.executor !== undefined ? { executor: opts.executor } : {}),
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
          ...(opts.fresh !== undefined ? { fresh: opts.fresh } : {}),
        }),
      }),
    fetchRuns: () => request(target, '/api/runs'),
    fetchExecutors: () => request(target, '/api/executors'),
    fetchAgentSessions: () => request(target, '/api/agents'),
    fetchRun: (id) => request(target, `/api/runs/${id}`),
    fetchRunClaims: () => request(target, '/api/runs/claims'),
    cancelRun: async (runId) => {
      await request(target, `/api/runs/${runId}/cancel`, { method: 'POST' });
    },
    stopRun: (runId) =>
      request(target, `/api/runs/${runId}/stop`, { method: 'POST' }),
    resumeRun: (runId) =>
      request(target, `/api/runs/${runId}/resume`, { method: 'POST' }),
    fetchRunDiff: (runId) => request(target, `/api/runs/${runId}/diff`),
    fetchPresence: () => request(target, '/api/presence'),
    setPresenceFocus: async (taskId) => {
      await request(target, '/api/presence/focus', {
        method: 'POST',
        ...jsonBody({ taskId }),
      });
    },
    fetchTeamTokens: () => request(target, '/api/team/tokens'),
    issueTeamToken: (input) =>
      request(target, '/api/team/tokens', {
        method: 'POST',
        ...jsonBody(input),
      }),
    revokeTeamToken: async (handle) => {
      await request(target, `/api/team/tokens/${encodeURIComponent(handle)}`, {
        method: 'DELETE',
      });
    },
    fetchTeamAddress: () => request(target, '/api/team/address'),
    fetchBoardSyncStatus: () => request(target, '/api/board-sync'),
    syncBoardNow: () =>
      request(target, '/api/board-sync/now', { method: 'POST' }),
    fetchLicense: () => request(target, '/api/license'),
    installLicense: (key) =>
      request(target, '/api/license', {
        method: 'PUT',
        body: JSON.stringify({ key }),
      }),
    fetchWhoami: () => request(target, '/api/whoami'),
    fetchRunPreview: (runId) => request(target, `/api/runs/${runId}/preview`),
    startRunPreview: (runId) =>
      request(target, `/api/runs/${runId}/preview`, { method: 'POST' }),
    stopRunPreview: async (runId) => {
      await request(target, `/api/runs/${runId}/preview`, { method: 'DELETE' });
    },
    fetchRunChecklist: (runId) =>
      request(target, `/api/runs/${runId}/checklist`),
    fetchRunApproval: (runId, requestId) =>
      request(target, `/api/runs/${runId}/approvals/${requestId}`),
    reviewRun: (runId, action) =>
      request(target, `/api/runs/${runId}/review`, {
        method: 'POST',
        ...jsonBody({ action }),
      }),
    fetchBranches: () => request(target, '/api/branches'),
    freeBranchDisk: (branch) =>
      request(target, '/api/branches/free-disk', {
        method: 'POST',
        ...jsonBody({ branch }),
      }),
    deleteBranch: async (branch, opts = {}) => {
      // Dispatch branch names always contain `/`, so the name is encoded into
      // a single path segment — the server rejoins and decodes it.
      const query = opts.force === true ? '?force=1' : '';
      await request(
        target,
        `/api/branches/${encodeURIComponent(branch)}${query}`,
        { method: 'DELETE' }
      );
    },
    fetchGitStatus: () => request(target, '/api/git/status'),
    fetchGitLog: (opts = {}) => {
      const params = new URLSearchParams();
      if (opts.ref !== undefined) params.set('ref', opts.ref);
      if (opts.limit !== undefined) params.set('limit', String(opts.limit));
      if (opts.skip !== undefined) params.set('skip', String(opts.skip));
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return request(target, `/api/git/log${query}`);
    },
    fetchGitBranches: () => request(target, '/api/git/branches'),
    fetchGitDiff: (opts = {}) => {
      const params = new URLSearchParams();
      if (opts.staged === true) params.set('staged', '1');
      if (opts.path !== undefined) params.set('path', opts.path);
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return request(target, `/api/git/diff${query}`);
    },
    fetchGitCommitDiff: (sha) =>
      request(target, `/api/git/commit/${encodeURIComponent(sha)}`),
    gitStage: (paths) =>
      request(target, '/api/git/stage', {
        method: 'POST',
        ...jsonBody({ paths }),
      }),
    gitUnstage: (paths) =>
      request(target, '/api/git/unstage', {
        method: 'POST',
        ...jsonBody({ paths }),
      }),
    gitStageHunk: (patch) =>
      request(target, '/api/git/stage-hunk', {
        method: 'POST',
        ...jsonBody({ patch }),
      }),
    gitUnstageHunk: (patch) =>
      request(target, '/api/git/unstage-hunk', {
        method: 'POST',
        ...jsonBody({ patch }),
      }),
    gitDiscard: (paths, confirm) =>
      request(target, '/api/git/discard', {
        method: 'POST',
        ...jsonBody({ paths, confirm }),
      }),
    gitCommit: (message, opts = {}) =>
      request(target, '/api/git/commit', {
        method: 'POST',
        ...jsonBody({ message, ...opts }),
      }),
    generateCommitMessage: () =>
      request(target, '/api/git/commit-message', { method: 'POST' }),
    gitCheckout: (branch) =>
      request(target, '/api/git/checkout', {
        method: 'POST',
        ...jsonBody({ branch }),
      }),
    gitCreateBranch: (name, from) =>
      request(target, '/api/git/branch', {
        method: 'POST',
        ...jsonBody(from !== undefined ? { name, from } : { name }),
      }),
    gitDeleteBranch: (name, opts = {}) =>
      request(target, `/api/git/branch/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        ...jsonBody(opts),
      }),
    gitStashPush: (message) =>
      request(target, '/api/git/stash', {
        method: 'POST',
        ...jsonBody(message !== undefined ? { message } : {}),
      }),
    fetchGitStashList: () => request(target, '/api/git/stash'),
    gitStashPop: (index) =>
      request(target, '/api/git/stash/pop', {
        method: 'POST',
        ...jsonBody({ index }),
      }),
    gitStashDrop: (index, confirm) =>
      request(target, '/api/git/stash/drop', {
        method: 'POST',
        ...jsonBody({ index, confirm }),
      }),
    gitFetch: (remote) =>
      request(target, '/api/git/fetch', {
        method: 'POST',
        ...jsonBody(remote !== undefined ? { remote } : {}),
      }),
    gitPull: () => request(target, '/api/git/pull', { method: 'POST' }),
    gitPush: (opts = {}) =>
      request(target, '/api/git/push', { method: 'POST', ...jsonBody(opts) }),
    gitCherryPick: (sha) =>
      request(target, '/api/git/cherry-pick', {
        method: 'POST',
        ...jsonBody({ sha }),
      }),
    gitRevert: (sha) =>
      request(target, '/api/git/revert', {
        method: 'POST',
        ...jsonBody({ sha }),
      }),
    fetchPrDetail: (runId) => request(target, `/api/runs/${runId}/pr`),
    reviewPr: (runId, event, body) =>
      request(target, `/api/runs/${runId}/pr/review`, {
        method: 'POST',
        ...jsonBody({ event, body: body ?? '' }),
      }),
    commentPr: (runId, body) =>
      request(target, `/api/runs/${runId}/pr/comment`, {
        method: 'POST',
        ...jsonBody({ body }),
      }),
    fetchRepoPrs: () => request(target, '/api/prs'),
    fetchRepoPrDetail: (number) => request(target, `/api/prs/${number}/detail`),
    fetchRepoPrDiff: (number) => request(target, `/api/prs/${number}/diff`),
    reviewRepoPr: (number, event, body) =>
      request(target, `/api/prs/${number}/review`, {
        method: 'POST',
        ...jsonBody({ event, body: body ?? '' }),
      }),
    commentRepoPr: (number, body) =>
      request(target, `/api/prs/${number}/comment`, {
        method: 'POST',
        ...jsonBody({ body }),
      }),
    startPrAgentReview: (number, input) =>
      request(target, `/api/prs/${number}/review-agent`, {
        method: 'POST',
        ...jsonBody({ confirmFork: input?.confirmFork === true }),
      }),
    fetchPrFindings: (number) => request(target, `/api/prs/${number}/findings`),
    fetchInbox: () => request(target, '/api/inbox'),
    addInbox: (input) =>
      request(target, '/api/inbox', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    updateInbox: (id, patch) =>
      request(target, `/api/inbox/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    dismissInbox: (ids) =>
      request(target, '/api/inbox/dismiss', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),
    convertInbox: (ids) =>
      request(target, '/api/inbox/convert', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),
    enrichTask: (id) =>
      request(target, `/api/tasks/${encodeURIComponent(id)}/enrich`, {
        method: 'POST',
      }),
    clusterInbox: () =>
      request(target, '/api/inbox/cluster', { method: 'POST' }),
    fetchInboxClusters: () => request(target, '/api/inbox/clusters'),
    fetchInboxTriage: () => request(target, '/api/inbox/triage'),
    fetchRunFile: (runId, path, side) =>
      request(
        target,
        `/api/runs/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(path)}&side=${side}`
      ),
    applyRunEdit: (runId, input) =>
      request(target, `/api/runs/${encodeURIComponent(runId)}/edits`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    applySuggestion: (runId, commentId) =>
      request(
        target,
        `/api/runs/${encodeURIComponent(runId)}/comments/${encodeURIComponent(commentId)}/apply`,
        { method: 'POST' }
      ),
    fetchReviewComments: (reviewTarget) =>
      request(target, `${reviewTargetPath(reviewTarget)}/comments`),
    addReviewComment: (reviewTarget, input) =>
      request(target, `${reviewTargetPath(reviewTarget)}/comments`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    resolveReviewComment: (reviewTarget, commentId, resolved) =>
      request(
        target,
        `${reviewTargetPath(reviewTarget)}/comments/${encodeURIComponent(commentId)}`,
        { method: 'PATCH', body: JSON.stringify({ resolved }) }
      ),
    replyReviewComment: (reviewTarget, commentId, body) =>
      request(
        target,
        `${reviewTargetPath(reviewTarget)}/comments/${encodeURIComponent(commentId)}/reply`,
        { method: 'POST', body: JSON.stringify({ body }) }
      ),
    updateConfig: (patch) =>
      request(target, '/api/config', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    fetchLinearStatus: () => request(target, '/api/linear/status'),
    connectLinear: (apiKey) =>
      request(target, '/api/linear/connect', {
        method: 'POST',
        ...jsonBody({ apiKey }),
      }),
    disconnectLinear: () =>
      request(target, '/api/linear/disconnect', { method: 'POST' }),
    fetchLinearTeams: () => request(target, '/api/linear/teams'),
    fetchLinearStates: (teamId) =>
      request(
        target,
        `/api/linear/states?teamId=${encodeURIComponent(teamId)}`
      ),
    syncLinear: (taskIds) =>
      request(target, '/api/linear/sync', {
        method: 'POST',
        ...jsonBody(taskIds === undefined ? {} : { taskIds }),
      }),
    fetchLinearLinks: () => request(target, '/api/linear/links'),
    importLinearIssues: () =>
      request(target, '/api/linear/import', { method: 'POST' }),
    submitReview: (runId, verdict, body, postToGitHub = false) =>
      request(target, `/api/runs/${encodeURIComponent(runId)}/review-submit`, {
        method: 'POST',
        body: JSON.stringify({ verdict, body, postToGitHub }),
      }),
    pushPrReview: (number, verdict, body) =>
      request(target, `/api/prs/${number}/review-submit`, {
        method: 'POST',
        body: JSON.stringify({ verdict, body }),
      }),
    sendBackRun: (runId, note) =>
      request(target, `/api/runs/${encodeURIComponent(runId)}/send-back`, {
        method: 'POST',
        body: JSON.stringify({ note }),
      }),
    setRunArchived: (runId, archived) =>
      request(target, `/api/runs/${encodeURIComponent(runId)}/archive`, {
        method: 'POST',
        body: JSON.stringify({ archived }),
      }),
    fetchNotes: () => request(target, '/api/notes'),
    createNote: (input) =>
      request(target, '/api/notes', { method: 'POST', ...jsonBody(input) }),
    updateNote: (id, patch) =>
      request(target, `/api/notes/${id}`, {
        method: 'PATCH',
        ...jsonBody(patch),
      }),
    deleteNote: async (id) => {
      await request(target, `/api/notes/${id}`, { method: 'DELETE' });
    },
    promoteNote: (id) =>
      request(target, `/api/notes/${id}/promote`, { method: 'POST' }),
    enrichNote: (id) =>
      request(target, `/api/notes/${id}/enrich`, { method: 'POST' }),
    startPlan: (prompt, opts = {}) =>
      request(target, '/api/plan', {
        method: 'POST',
        ...jsonBody({
          prompt,
          ...(opts.model !== undefined ? { model: opts.model } : {}),
        }),
      }),
    fetchPlan: (planId) => request(target, `/api/plan/${planId}`),
    fetchPlans: () => request(target, '/api/plans'),
    sendPlanMessage: (planId, text) =>
      request(target, `/api/plan/${planId}/message`, {
        method: 'POST',
        ...jsonBody({ text }),
      }),
    confirmPlan: (planId, proposal) =>
      request(target, `/api/plan/${planId}/confirm`, {
        method: 'POST',
        ...jsonBody({ proposal }),
      }),
    startOverseer: (prompt, opts = {}) =>
      request(target, '/api/overseer', {
        method: 'POST',
        ...jsonBody({
          prompt,
          ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
        }),
      }),
    getOverseer: (id) => request(target, `/api/overseer/${id}`),
    sendOverseerMessage: (conversationId, text) =>
      request(target, `/api/overseer/${conversationId}/message`, {
        method: 'POST',
        ...jsonBody({ text }),
      }),
    startEpic: (epicId, opts = {}) =>
      request(target, `/api/epics/${epicId}/dispatch`, {
        method: 'POST',
        ...jsonBody(opts),
      }),
    pauseEpic: (epicId) =>
      request(target, `/api/epics/${epicId}/pause`, { method: 'POST' }),
    resumeEpic: (epicId, opts = {}) =>
      request(target, `/api/epics/${epicId}/resume`, {
        method: 'POST',
        ...jsonBody(opts),
      }),
    stopEpic: (epicId) =>
      request(target, `/api/epics/${epicId}/stop`, { method: 'POST' }),
    fetchEpicProgress: (epicId) =>
      request(target, `/api/epics/${epicId}/progress`),
    fetchAllEpicProgress: () => request(target, '/api/epics/progress'),
    landEpic: (epicId) =>
      request(target, `/api/epics/${epicId}/land`, { method: 'POST' }),
    fetchEpicDiff: (epicId) => request(target, `/api/epics/${epicId}/diff`),
    fetchMergeQueue: () => request(target, '/api/merge-queue'),
    getLanding: () => request(target, '/api/landing'),
    createPrWorktree: (number, opts = {}) =>
      request(target, `/api/prs/${number}/worktree`, {
        method: 'POST',
        ...jsonBody(opts),
      }),
    removePrWorktree: (number) =>
      request(target, `/api/prs/${number}/worktree`, { method: 'DELETE' }),
    enqueueMergeQueue: (runId) =>
      request(target, '/api/merge-queue', {
        method: 'POST',
        ...jsonBody({ runId }),
      }),
    enqueueMergeStack: (taskId) =>
      request(target, '/api/merge-queue/stack', {
        method: 'POST',
        ...jsonBody({ taskId }),
      }),
    enqueueMergeReady: () =>
      request(target, '/api/merge-queue/ready', { method: 'POST' }),
    recheckMergeQueue: () =>
      request(target, '/api/merge-queue/recheck', { method: 'POST' }),
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
      return request(target, `/api/findings${query}`);
    },
    createFinding: (input) =>
      request(target, '/api/findings', { method: 'POST', ...jsonBody(input) }),
    updateFinding: (id, patch) =>
      request(target, `/api/findings/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        ...jsonBody(patch),
      }),
    fetchTaskFindings: (taskId) =>
      request(target, `/api/tasks/${encodeURIComponent(taskId)}/findings`),
    startReview: (taskId, input) =>
      request(target, `/api/tasks/${encodeURIComponent(taskId)}/review`, {
        method: 'POST',
        ...jsonBody(input),
      }),
    startVerification: (taskId, head) =>
      request(target, `/api/tasks/${encodeURIComponent(taskId)}/verify`, {
        method: 'POST',
        ...jsonBody({ head }),
      }),
    fetchTaskVerification: (taskId) =>
      request(target, `/api/tasks/${encodeURIComponent(taskId)}/verification`),
    fetchFixLoop: (taskId) =>
      request(target, `/api/tasks/${encodeURIComponent(taskId)}/fix-loop`),
    fetchFixLoops: () => request(target, '/api/fix-loops'),
    startFixLoop: (taskId) =>
      request(
        target,
        `/api/tasks/${encodeURIComponent(taskId)}/fix-loop/start`,
        { method: 'POST' }
      ),
    stopFixLoop: (taskId) =>
      request(
        target,
        `/api/tasks/${encodeURIComponent(taskId)}/fix-loop/stop`,
        { method: 'POST' }
      ),
    advanceFixLoop: (taskId, input = {}) =>
      request(
        target,
        `/api/tasks/${encodeURIComponent(taskId)}/fix-loop/advance`,
        { method: 'POST', ...jsonBody(input) }
      ),
    adjudicateFinding: (taskId, findingId, input) =>
      request(
        target,
        `/api/tasks/${encodeURIComponent(taskId)}/findings/${encodeURIComponent(findingId)}/adjudicate`,
        { method: 'POST', ...jsonBody(input) }
      ),
    fetchLedger: (filter = {}) => {
      const params = new URLSearchParams();
      if (filter.epicId !== undefined) {
        params.set('epicId', filter.epicId ?? '');
      }
      if (filter.class !== undefined) params.set('class', filter.class);
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return request(target, `/api/ledger${query}`);
    },
    fetchConversation: (subject) =>
      request(
        target,
        `/api/conversations?subject=${encodeURIComponent(subject)}`
      ),
    addChatMessage: (input) =>
      request(target, '/api/conversations', {
        method: 'POST',
        ...jsonBody(input),
      }),
    getImpact: (subject, id) =>
      request(
        target,
        `/api/impact?${new URLSearchParams({ subject, id }).toString()}`
      ),
    // Agent-communication bus — packages/server/src/messaging/routes.ts is
    // the source of truth for these request/response shapes.
    sendMessage: (input, opts) => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (opts?.idempotencyKey !== undefined) {
        headers['Idempotency-Key'] = opts.idempotencyKey;
      }
      return request(target, '/api/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      });
    },
    getMessage: (id) => request(target, `/api/messages/${id}`),
    replyToMessage: (id, input) =>
      request(target, `/api/messages/${id}/reply`, {
        method: 'POST',
        ...jsonBody(input),
      }),
    waitForAnswer: (id, opts = {}) =>
      request(
        target,
        `/api/messages/${id}/answer${opts.wait === true ? '?wait=1' : ''}`
      ),
    getThread: (id) => request(target, `/api/threads/${id}`),
    listRecentThreads: (limit, opts = {}) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set('limit', String(limit));
      if (opts.about !== undefined) params.set('about', opts.about);
      const qs = params.size > 0 ? `?${params.toString()}` : '';
      return request(target, `/api/threads${qs}`);
    },
    getMailbox: (address, states) => {
      const params = new URLSearchParams();
      if (address !== undefined) params.set('address', address);
      if (states !== undefined && states.length > 0) {
        params.set('state', states.join(','));
      }
      const qs = params.size > 0 ? `?${params.toString()}` : '';
      return request(target, `/api/mailbox${qs}`);
    },
    markDeliveryRead: (id) =>
      request(target, `/api/deliveries/${id}/read`, { method: 'POST' }),
    listChannels: () => request(target, '/api/channels'),
    // Uses send(), not request(): the server answers 204 with no JSON body,
    // which request() would fail to parse.
    joinChannel: async (name, member) => {
      await send(target, `/api/channels/${encodeURIComponent(name)}/members`, {
        method: 'POST',
        ...jsonBody(member !== undefined ? { member } : {}),
      });
    },
    leaveChannel: async (name, member) => {
      const path =
        member !== undefined
          ? `/api/channels/${encodeURIComponent(name)}/members/${encodeURIComponent(member)}`
          : `/api/channels/${encodeURIComponent(name)}/members`;
      await send(target, path, { method: 'DELETE' });
    },
    listAgentRoster: () => request(target, '/api/agents/roster'),
    approveAgent: (address) =>
      request(target, `/api/agents/${encodeURIComponent(address)}/approve`, {
        method: 'POST',
      }),
    revokeAgent: (address) =>
      request(target, `/api/agents/${encodeURIComponent(address)}/revoke`, {
        method: 'POST',
      }),
    muteAgent: (address, muted) =>
      request(
        target,
        `/api/agents/${encodeURIComponent(address)}/${muted ? 'mute' : 'unmute'}`,
        { method: 'POST' }
      ),
    openDecisions: () => request(target, '/api/decisions/open'),
    listMemory: (q = {}) =>
      request(
        target,
        `/api/memory${queryString({ scope: q.scope, kind: q.kind, state: q.state, taskId: q.taskId, origin: q.origin, trust: q.trust, limit: q.limit })}`
      ),
    searchMemory: (q) =>
      request(
        target,
        `/api/memory/search${queryString({ q: q.query, scope: q.scope, kind: q.kind, includeStale: q.includeStale, includeRetired: q.includeRetired, limit: q.limit })}`
      ),
    getMemory: (ref) =>
      request(target, `/api/memory/${encodeURIComponent(ref)}`),
    memoryIndex: (q) =>
      request(
        target,
        `/api/memory/index${queryString('taskId' in q ? { taskId: q.taskId } : { runId: q.runId })}`
      ),
    memoryRecalls: (runId) =>
      request(target, `/api/memory/recalls${queryString({ runId })}`),
    memoryHealth: () => request(target, '/api/memory/health'),
    importLedger: (opts = {}) =>
      request(
        target,
        `/api/memory/import/ledger${opts.dryRun === true ? '?dryRun=1' : ''}`,
        { method: 'POST' }
      ),
    importClaude: (opts = {}) =>
      request(
        target,
        `/api/memory/import/claude${queryString({
          from: opts.from,
          none: opts.none === true ? true : undefined,
          dryRun: opts.dryRun === true ? true : undefined,
        })}`,
        { method: 'POST' }
      ),
    saveMemory: (input, opts) =>
      request(target, '/api/memory', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts?.idempotencyKey === undefined
            ? {}
            : { 'Idempotency-Key': opts.idempotencyKey }),
        },
        body: JSON.stringify(input),
      }),
    retireMemory: (ref, reason) =>
      request(target, `${memoryPath(ref)}/retire`, {
        method: 'POST',
        ...jsonBody({ reason }),
      }),
    undoMemory: (ref) =>
      request(target, `${memoryPath(ref)}/undo`, { method: 'POST' }),
    confirmMemory: (ref) =>
      request(target, `${memoryPath(ref)}/confirm`, { method: 'POST' }),
    pinMemory: (ref, pinned) =>
      request(target, `${memoryPath(ref)}/${pinned ? 'pin' : 'unpin'}`, {
        method: 'POST',
      }),
    promoteMemory: (ref, scope) =>
      request(target, `${memoryPath(ref)}/promote`, {
        method: 'POST',
        ...jsonBody({ scope }),
      }),
    deleteMemory: async (ref) => {
      await send(target, memoryPath(ref), { method: 'DELETE' });
    },
    listMemoryProposals: (state) =>
      request(target, `/api/memory/proposals${queryString({ state })}`),
    getMemoryProposal: (id) =>
      request(target, `/api/memory/proposals/${encodeURIComponent(id)}`),
    memoryActivity: (since) =>
      request(target, `/api/memory/activity${queryString({ since })}`),
    memoryIdentity: () => request(target, '/api/memory/identity'),
    startMemoryLink: (opts = {}) =>
      request(target, '/api/memory/link', {
        method: 'POST',
        ...jsonBody(opts.fresh === true ? { fresh: true } : {}),
      }),
    completeMemoryLink: (code) =>
      request(target, `/api/memory/link/${encodeURIComponent(code)}`, {
        method: 'POST',
      }),
    listIngestProblems: () => request(target, '/api/memory/ingest-problems'),
    acceptIngestProblem: (id) =>
      request(
        target,
        `/api/memory/ingest-problems/${encodeURIComponent(id)}/accept`,
        { method: 'POST' }
      ),
    fetchWorkspaceTree: (path, scope = {}) =>
      request(target, `/api/files/tree?${workspaceQuery(path, scope)}`),
    fetchWorkspaceFile: (path, scope = {}) =>
      request(target, `/api/files/read?${workspaceQuery(path, scope)}`),
    saveWorkspaceFile: (path, text, scope = {}) =>
      request(target, '/api/files/write', {
        method: 'POST',
        ...jsonBody({
          path,
          text,
          ...(scope.runId == null ? {} : { runId: scope.runId }),
        }),
      }),
    workspaceFileUrl: (path, scope = {}) =>
      `${baseUrl}/api/files/raw?${workspaceQuery(path, scope)}`,
    searchWorkspace: (query, scope = {}) => {
      const params = new URLSearchParams({ q: query });
      if (scope.runId != null) params.set('runId', scope.runId);
      if (scope.limit !== undefined) params.set('limit', String(scope.limit));
      return request(target, `/api/files/search?${params.toString()}`);
    },
    launchBrowser: (opts = {}) =>
      request(target, '/api/browser', { method: 'POST', ...jsonBody(opts) }),
    listBrowsers: () => request(target, '/api/browser'),
    closeBrowser: async (id) => {
      await request(target, `/api/browser/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },
    navigateBrowser: (id, url) =>
      request(target, `/api/browser/${encodeURIComponent(id)}/navigate`, {
        method: 'POST',
        ...jsonBody({ url }),
      }),
    browserClick: async (id, selector) => {
      await request(target, `/api/browser/${encodeURIComponent(id)}/click`, {
        method: 'POST',
        ...jsonBody({ selector }),
      });
    },
    browserFill: async (id, selector, value) => {
      await request(target, `/api/browser/${encodeURIComponent(id)}/fill`, {
        method: 'POST',
        ...jsonBody({ selector, value }),
      });
    },
    browserEvaluate: (id, expression) =>
      request(target, `/api/browser/${encodeURIComponent(id)}/evaluate`, {
        method: 'POST',
        ...jsonBody({ expression }),
      }),
    browserScreenshot: (id) =>
      request(target, `/api/browser/${encodeURIComponent(id)}/screenshot`),
    browserStartPick: (id) =>
      request(target, `/api/browser/${encodeURIComponent(id)}/pick`, {
        method: 'POST',
        ...jsonBody({}),
      }),
    browserPickResult: (id) =>
      request(target, `/api/browser/${encodeURIComponent(id)}/pick`),
    fetchTerminals: () => request(target, '/api/terminals'),
    fetchTerminal: (id) =>
      request(target, `/api/terminals/${encodeURIComponent(id)}`),
    createTerminal: (input = {}) =>
      request(target, '/api/terminals', { method: 'POST', ...jsonBody(input) }),
    fetchTerminalOutput: (id, since) =>
      request(
        target,
        `/api/terminals/${encodeURIComponent(id)}/output?since=${since}`
      ),
    sendTerminalInput: async (id, data) => {
      await request(target, `/api/terminals/${encodeURIComponent(id)}/input`, {
        method: 'POST',
        ...jsonBody({ data }),
      });
    },
    resizeTerminal: (id, cols, rows) =>
      request(target, `/api/terminals/${encodeURIComponent(id)}/resize`, {
        method: 'POST',
        ...jsonBody({ cols, rows }),
      }),
    closeTerminal: async (id) => {
      await request(target, `/api/terminals/${encodeURIComponent(id)}/close`, {
        method: 'POST',
        ...jsonBody({}),
      });
    },
    removeTerminal: async (id) => {
      await request(target, `/api/terminals/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },
    wsUrl: () => wsUrl(baseUrl, target.token),
    connectEvents: (onChange, options) =>
      connectEvents(baseUrl, onChange, { token: target.token, ...options }),
  };
}
