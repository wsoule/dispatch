import type {
  EffortLevel,
  RunStep,
  SubagentEvent,
  SubagentSummary,
} from '@dispatch/core';

import type { RunUsage } from './usage.js';

// The Vibe Kanban pattern: every executor, real or fake, streams a uniform
// log shape so the transcript/UI never needs to know which executor produced
// an entry. `kind: 'usage'` entries carry running cost/turn info; everything
// else is either assistant output, a tool invocation, model "thinking", a
// system-authored note, or (agent-comms) an identified `message` — a
// human-to-agent or agent-to-agent chat turn that carries `from`/`fromLabel`
// so the transcript/UI can tell who's talking, instead of the undifferentiated
// `system` "user: ..." notes this used to be recorded as. `from: 'user'` is
// the run's own human via the Session composer; `from: 'agent'` is either a
// message from another sender (named by `fromLabel`) or one this run sent to a
// human.
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
  // `kind: 'tool'` and `kind: 'agent'` only: the SDK's id for the tool_use
  // block this entry records, so later events (a sub-agent's progress, a
  // tool result) can be tied back to it.
  toolUseId?: string;
  // Set on entries the agent did not make itself but one of its sub-agents
  // did: the tool_use id that spawned that sub-agent. Absent on the run's own
  // top-level activity.
  parentToolUseId?: string;
  // `kind: 'agent'` only: one lifecycle event of a sub-agent this run's agent
  // spawned (see @dispatch/core's subagents module for the fold). The entry
  // also keeps the spawning tool call's `toolName`/`toolInput` on the started
  // event, so the transcript can show what the sub-agent was asked to do.
  agent?: SubagentEvent;
  from?: 'user' | 'agent';
  // Who a message entry is from: the sender's address for a delivered
  // message, or this run's task title + id for one it sent to a human.
  fromLabel?: string;
  // `true` marks a message this run sent to a human (`logOutgoing`), so the
  // app badges it "To you" instead of rendering it as inbound.
  toUser?: boolean;
  // The id (`m-<ulid>`) of the message this entry delivered or sent.
  messageId?: string;
  // Set on entries delivered via `Orchestrator.notifyRun` — a non-interrupting
  // channel digest rather than a message the agent must respond to.
  digest?: boolean;
}

// A live handle to a running executor invocation — the orchestrator holds
// one of these per live run so API calls (approval, mid-run message, cancel)
// have somewhere to go without the executor itself needing to know about
// HTTP or the registry.
/**
 * How a human answered one approval request.
 *
 * Three outcomes rather than a boolean, because "yes", "yes and stop asking about this tool"
 * and "no, because X" are genuinely different instructions and collapsing them loses the two
 * that carry information. `scope: 'session'` grants the tool for the remainder of THIS run
 * only — the grant lives in the executor run's own closure, so it cannot outlive it. `reason`
 * is passed through as the SDK's denial message, so a refusal reaches the model as an
 * explanation rather than a bare no.
 */
export interface ApprovalDecision {
  allow: boolean;
  /** 'once' (default) answers this request; 'session' also pre-approves the same tool. */
  scope?: 'once' | 'session';
  /** Why it was denied. Ignored when allowing. */
  reason?: string;
}

/** What the orchestrator tells messaging when a run parks on a tool call. */
export interface ApprovalGateRequest {
  runId: string;
  taskId: string;
  taskTitle: string;
  requestId: string;
  toolName: string;
  input: unknown;
}

/** The tool-approval gate's lifecycle; installed by openMessaging. */
export interface ApprovalGatePort {
  raise(request: ApprovalGateRequest): void;
  settle(runId: string, requestId: string, reason: string): void;
}

/** How a new run carries memory, decided once before it starts. */
export interface PreparedMemory {
  // The prompt's memory text: the `## Memory` section, the export line, or null.
  text: string | null;
  // The `## Memory` section a prompt-mode fallback carries in place of `text`.
  indexSection: string | null;
  memory: ExecutorMemoryOptions;
}

/** Chooses each run's memory mode and follows its export; installed by the memory service at boot. */
export interface MemoryPromptPort {
  prepare(input: {
    runId: string;
    taskId: string;
    lineage: string;
    runKind: RunKind;
    isClaude: boolean;
    dispatchTools: boolean;
    // The run resumes a session, so its prompt is the continuation, not the index.
    continues: boolean;
  }): PreparedMemory;
  // The agent read exported files; `lineage` names the export directory.
  recall(
    runId: string,
    lineage: string,
    paths: readonly string[],
    via: 'read' | 'claude-recall'
  ): void;
  // A final scan of the run's export; the directory stays until its lineage closes.
  runEnded(meta: RunMeta): void;
}

/** Where the `## Docs` prompt section comes from (docs/service.ts). */
export interface DocsPromptPort {
  promptSection(input: {
    runId: string;
    taskId: string;
    dispatchTools: boolean;
  }): string | null;
}

export interface ExecutorRun {
  interrupt(): Promise<void>;
  /**
   * Asks the agent to wind down gracefully: whatever it is doing right now runs
   * to completion, but it starts no new work and then finishes normally, so the
   * run still reaches `onFinish` and the orchestrator's usual finish handling
   * (auto-commit, task -> in-review) applies.
   *
   * The opposite end of `interrupt()`, which kills the session where it stands
   * and leaves the worktree untouched. Required rather than optional so every
   * executor has to decide what winding down means for it, instead of silently
   * ignoring a stop the user pressed a button for.
   */
  requestStop(): void;
  send(message: string): void;
  approve(requestId: string, decision: ApprovalDecision): void;
  // Non-interrupting context for the agent's next step (a channel digest).
  // Never throws; a no-op once the run has finished.
  notify(text: string): void;
}

// Callbacks an Executor uses to report progress back to the orchestrator.
// The orchestrator supplies one set of these per run, closed over that run's
// id, so the executor implementation itself never needs to know a run id.
export interface ExecutorEvents {
  onEntry(entry: NormalizedEntry): void;
  onApprovalRequest(request: {
    requestId: string;
    toolName: string;
    input: unknown;
  }): void;
  // The run's resume handle, reported as soon as the executor learns it —
  // onFinish's copy arrives too late to survive a daemon that dies mid-run.
  // Optional: not every executor has a resumable session.
  onSession?(sessionId: string): void;
  // The session has its result and is winding down to onFinish; a message
  // sent from here on is never read, so delivery waits for the next run.
  onEnding?(): void;
  // Export mode's load check changed the run's memory mode; `detail` says why.
  onMemoryMode?(mode: MemoryMode, detail: string): void;
  // The agent read exported memory files, by a Read call or Claude's own recall.
  onMemoryRecall?(paths: string[], via: 'read' | 'claude-recall'): void;
  onFinish(finish: {
    state: 'finished' | 'failed';
    costUsd?: number;
    turns?: number;
    sessionId?: string;
    error?: string;
    // Token spend by billing type; absent when the executor measures none.
    usage?: RunUsage;
    // The harness experiments (experiments.ts) the run ran under, when any.
    experiments?: string[];
  }): void;
}

export interface ExecutorStartOptions {
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  permissionMode: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  // The executor-specific model this run should use, chosen at dispatch time.
  // Optional — omitted uses that executor's default behavior, so fixtures and
  // callers that don't care never need to set it.
  model?: string;
  // Reasoning effort for the session; omitted leaves the model's default.
  // Only the Claude executor acts on it.
  effort?: EffortLevel;
  // The dispatch PROJECT's root directory — distinct from `cwd`, which for a
  // real run is the run's own git worktree (a different directory than the
  // project it was cut from). ClaudeExecutor needs both: `cwd` to root the
  // agent session itself, `projectRoot` to tell the dispatch MCP server it
  // wires in where the project's real daemon file and `.dispatch/tasks`
  // live (see claude.ts's DISPATCH_PROJECT_ROOT wiring). Optional — and
  // falls back to `cwd` in claude.ts — only so FakeExecutor call sites and
  // fixtures that never touch this don't all need updating; every real
  // Orchestrator call site always passes it.
  projectRoot?: string;
  // This run's own id — ClaudeExecutor passes it through as `DISPATCH_RUN_ID`
  // in the dispatch MCP server's env (see claude.ts's
  // buildDispatchMcpServerConfig) so the tools that record the calling run
  // know which run it is without the calling agent having to know or supply
  // its own run id. Optional for the same reason
  // `projectRoot` is: FakeExecutor fixtures that never touch messaging don't
  // need to pass it; every real Orchestrator call site always does.
  runId?: string;
  // The 0600 file holding this run's messaging token. Only the path travels to
  // the dispatch MCP server, since backends put MCP env on a process's argv.
  runTokenFile?: string;
  // How a Claude session carries memory; absent is `native`, today's behavior.
  memory?: ExecutorMemoryOptions;
}

/** A run's memory mode, including the two outcomes of export's load check. */
export type MemoryMode =
  | 'export'
  | 'native'
  | 'prompt'
  | 'export-fallback'
  | 'export-unloaded';

/** The memory mode a session starts in, and what export mode needs. */
export interface ExecutorMemoryOptions {
  mode: 'export' | 'native' | 'prompt';
  // The absolute export directory Claude Code loads MEMORY.md from.
  dir?: string;
  // The oldest Claude Code version the live probe passed on.
  probeVersion?: string;
  // The task prompt, with the index, that a prompt-mode restart opens with. A
  // resume needs it: its restart is a fresh session sent the run's prompt next.
  fallbackPrompt?: string;
  // Reaches the agent with its first tool result when nothing loaded.
  unloadedNote?: string;
}

// What the orchestrator may assume about an executor beyond `start()`: which
// finish fields are real, whether it enforces the run caps itself, and which
// permission modes it can honour. Missing profile means "behaves like Claude".
export interface ExecutorProfile {
  /** Whether onFinish carries a real costUsd. */
  reportsCost: boolean;
  /** Whether onFinish carries a real turn count. */
  reportsTurns: boolean;
  /** Whether the executor itself honours maxTurns/maxBudgetUsd. */
  enforcesCaps: boolean;
  /** Whether a live run can take a mid-run message or note (send/notify). */
  acceptsMessages: boolean;
  /** Why this executor cannot run under `permissionMode`, or null when it can. */
  permissionRefusal(permissionMode: string): string | null;
  /** False when runs never get the dispatch MCP server, so the task prompt
   * must not name its tools. Absent means they do. */
  dispatchMcp?: boolean;
  /** True when the executor honours Claude Code's auto-memory settings. */
  autoMemory?: boolean;
}

/** One registered executor as GET /api/executors reports it. */
export interface ExecutorInfo {
  name: string;
  reportsCost: boolean;
  reportsTurns: boolean;
  enforcesCaps: boolean;
}

export const DEFAULT_EXECUTOR_PROFILE: ExecutorProfile = {
  reportsCost: true,
  reportsTurns: true,
  enforcesCaps: true,
  acceptsMessages: true,
  permissionRefusal: () => null,
};

// The load-bearing seam: every agent backend implements this one interface so
// the orchestrator never branches on which executor is running.
export interface Executor {
  readonly profile?: ExecutorProfile;
  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun;
}

// Run lifecycle states, exact strings per the plan:
// provisioning -> running -> awaiting-approval <-> running -> finished | failed | cancelled
export type RunState =
  | 'provisioning'
  | 'running'
  | 'awaiting-approval'
  | 'finished'
  | 'failed'
  | 'cancelled'
  // A `failed` that left uncommitted work behind — see RunSurvey.
  | 'interrupted-dirty';

// What a run was dispatched to do. 'execute' writes the code; 'review' judges
// a diff and emits findings; 'verify' runs checks against finished work.
export type RunKind = 'execute' | 'review' | 'verify';

export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  'finished',
  'failed',
  'cancelled',
  'interrupted-dirty',
]);

// What survived a run that did not finish cleanly, read straight from its
// worktree's git status — recovery info instead of a hand inspection.
export interface RunSurvey {
  runId: string;
  branch: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  lastCommit: { sha: string; subject: string } | null;
  cleanTree: boolean;
  // Commits on the run's branch authored after the run first reached `failed`
  // — work an orphaned agent process landed after the daemon lost track of it
  // (see Orchestrator.reconcileOnBoot). Newest first, like `git log`. Optional
  // so surveys recorded before this field existed replay unchanged.
  postFailCommits?: { sha: string; subject: string; date: string }[];
}

// Everything the registry/transcript/API need to describe a run, independent
// of whether it is still live (has a real ExecutorRun) or is being replayed
// from a transcript after a restart.
// Why a run's most recent review attempt did NOT complete. review() throws
// on a squash conflict, a dirty main checkout, a worktree that will not
// remove — and leaves the run unreviewed. Without a record of that, a
// finished run that failed to merge looks identical to one nobody has
// reviewed yet: no error, no marker, nothing for the operator to act on.
export interface ReviewFailure {
  action: 'merge' | 'discard';
  // The thrown error's message — for a conflict, git's own output naming the
  // conflicting files.
  reason: string;
  at: string;
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
  // Token spend by billing type (see usage.ts), set at finish alongside
  // costUsd. Absent for runs recorded before it existed and for executors
  // that measure no tokens.
  usage?: RunUsage;
  // The harness experiments this run ran under (see experiments.ts), so runs
  // can be split by arm when comparing cost per completed task. Absent for a
  // run under the defaults.
  experiments?: string[];
  sessionId?: string;
  error?: string;
  // The Claude model this run was dispatched with, if one was chosen (see
  // ExecutorStartOptions.model) — surfaced so the UI can show which model ran
  // a given task.
  model?: string;
  // The reasoning effort this run was started at; absent means the model's
  // own default. A resume keeps it, like `model`.
  effort?: EffortLevel;
  // Serialized ActorRef of the human the run is for, e.g. `human:ada`: who
  // pressed dispatch, or started the fan-out that dispatched it. A resume,
  // follow-up or review/verify run keeps its work's owner unless a person
  // pressed for it. Absent for a run nobody owns (no human at all) and for
  // runs recorded before this field existed. It is what makes a run — and the
  // files it claims, and the decisions it parks on — someone's on a daemon
  // more than one person uses.
  dispatchedBy?: string;
  // The human whose personal memory this run reads and writes (read it through
  // runOperator). null = no one; absent = recorded before the field.
  operator?: string | null;
  // The run whose Claude memory export this one shares: itself, or a
  // continuing predecessor's (read it through runLineage).
  memoryLineage?: string;
  // How the run carries memory: chosen at start, then changed by export's load
  // check. Absent for runs started with no memory service.
  memoryMode?: MemoryMode;
  // C2: once a run has been merged or discarded, review() must refuse any
  // further review/resume calls on it — this pair of fields, once set, is
  // that one-way marker. `state` itself stays whatever terminal value it
  // already had (finished/failed/cancelled); reviewing a run never changes
  // its RunState, it only records that the review happened.
  reviewedAt?: string;
  reviewAction?: 'merge' | 'discard' | 'pr';
  // The squash-merge commit sha, set only when review()'s 'merge' action
  // actually produced one (a no-op merge leaves this unset).
  mergeCommit?: string;
  // Set when a merge/discard threw partway (see ReviewFailure); the run stays
  // unreviewed and resumable. Cleared the moment a later review really lands,
  // so a discarded run never keeps advertising a conflict it no longer has.
  reviewFailure?: ReviewFailure;
  // Phase 5 P1: set once a run's PR review action has pushed the branch and
  // opened a GitHub PR (see PrManager.openPr) — the run stays un-reviewed
  // (reviewedAt unset) until PrManager's poller sees the PR merged and calls
  // Orchestrator.markRunMergedViaPr, at which point reviewAction becomes
  // 'pr'.
  prUrl?: string;
  // Set by requestChanges() on the follow-up run it creates: the id of the
  // finished run whose session this one resumed. Lets the UI point back at
  // the earlier conversation instead of the new transcript looking like the
  // chat history was wiped. Optional so pre-existing transcripts (which
  // never wrote it) hydrate unchanged.
  // Set when a run is archived: it stays on disk and stays reachable, but the
  // Runs list hides it by default. Archiving is the only marker here that is
  // meant to be undone, which is why the transcript line carrying it uses
  // `null` to clear rather than the `?? previous` fold every other field uses.
  archivedAt?: string;
  resumedFrom?: string;
  // Branches this run's worktree was stacked on at dispatch time — the
  // in-review blockers whose unmerged work it needs. Empty/absent for an
  // unblocked run, which is based on the project's default branch as before.
  // The merge queue reads this to know which dependents to restack after a
  // blocker lands.
  stackParents?: string[];
  // The exact commit this run's worktree was branched from, resolved at
  // dispatch time. This is what says where the run's OWN commits begin, which
  // is the one fact both restack paths need once the base branch has been
  // rewritten out from under it: `git rebase --onto <newBase> <this> <branch>`
  // and jj's `roots(<this>..<branch>)`. Only set for stacked runs — an
  // unblocked run has nothing above its base to preserve.
  stackBaseCommit?: string;
  // Set when the base this run was stacked on can no longer be repaired
  // automatically. Nothing is rewritten or deleted — the run is flagged so the
  // UI can surface it and the merge queue can refuse it, and the human decides
  // what to do.
  //
  // The flag is deliberately one boolean covering three distinct situations
  // (the blocker's run was discarded; a restack was attempted and failed; the
  // run sits on a multi-parent base no single blocker's merge can repair)
  // because the required response is identical in all three: stop, and ask a
  // human. Which one it actually was lives in `baseDiscardedReason` below, so
  // no surface has to guess.
  baseDiscarded?: boolean;
  // Why `baseDiscarded` was set, in the words the flagging site used. Separate
  // from `error` because `error` may already hold the run's OWN failure message
  // (which must never be clobbered — see flagRunRestackFailure), and because a
  // fixed "base discarded" label is wrong for the two restack cases, where the
  // base merged perfectly well.
  baseDiscardedReason?: string;
  // The git survey of this run's worktree, set on `failed`/`interrupted-dirty`.
  survey?: RunSurvey;
  // Absent on every run recorded before review runs existed, so readers go
  // through runKind() rather than reading this field directly.
  kind?: RunKind;
  // Files this run is touching, seeded from the task's `writes` at dispatch
  // and grown from git status as it actually edits things.
  claims?: string[];
  // When a human asked this run to stop gracefully (Orchestrator.requestStop).
  // A marker, not a state: the run keeps whatever state it had and then reaches
  // its OWN terminal state (`finished`, or `failed` if the agent errored on the
  // way out) through the normal finish path, so its work is auto-committed and
  // reviewable exactly like any other finished run. Set once and never cleared
  // — a stop cannot be taken back, only escalated to a hard cancel.
  stopRequestedAt?: string;
  // How many sub-agents this run's agent has fanned out into and where they
  // stand. Kept up to date live from the `kind: 'agent'` entries as they are
  // logged, and rebuilt from the same entries when a transcript is replayed,
  // so lists can show fan-out without reading the transcript. Absent until
  // the first sub-agent is spawned.
  subagents?: SubagentSummary;
  // What a live run's agent is doing, in words (core's runStepFromEntry), and
  // when it said so: kept current from its log entries as they are written,
  // so a list read never opens a transcript. In memory only; absent before
  // the first step and once the run is terminal.
  lastStep?: RunStep;
}

// A run's kind, defaulted for the transcripts and registry entries written
// before `kind` existed.
export function runKind(meta: Pick<RunMeta, 'kind'>): RunKind {
  return meta.kind ?? 'execute';
}

// The human a run acts for; null means no one. Runs from before the field
// fall back to dispatchedBy.
export function runOperator(
  meta: Pick<RunMeta, 'operator' | 'dispatchedBy'>
): string | null {
  return meta.operator !== undefined
    ? meta.operator
    : (meta.dispatchedBy ?? null);
}

// Who a run started, continued or woken by `actor` acts for: a human actor,
// the owner only on the owner's app token; no one for an agent, run or system.
export function actingOperator(
  actor: string,
  ownerCredential: boolean,
  ownerRef: string
): string | null {
  if (!actor.startsWith('human:')) return null;
  return actor !== ownerRef || ownerCredential ? actor : null;
}

/** Why `sender` may not message a live run acting for another human; null
 *  when it may (decide tier, the run's own operator, or a run for no one). */
export function runMessageRefusal(
  run: Pick<RunMeta, 'id' | 'taskId' | 'operator'>,
  sender: string | null,
  canDecide: boolean
): string | null {
  const operator = run.operator ?? null;
  if (canDecide || operator === null || sender === operator) return null;
  return `run ${run.id} acts for ${operator}: message its task (task:${run.taskId}) or ${operator} instead`;
}

// The first run of a continuing resume chain: the key of its Claude memory export.
export function runLineage(
  meta: Pick<RunMeta, 'id' | 'memoryLineage'>
): string {
  return meta.memoryLineage ?? meta.id;
}

// How a branch ref relates to the run registry, derived fresh on every
// listBranches() call rather than stored anywhere. It describes the *current*
// disagreement between git and the registry, and the user's own terminal can
// change git underneath the daemon at any time — a persisted copy would go
// stale with nothing to invalidate it.
//
// - 'active':     a run is still executing in this worktree. Read-only.
// - 'reviewable': the run reached a terminal state but was never reviewed, so
//                 nothing has cleaned it up. The common leftover case.
// - 'leftover':   the run WAS reviewed, yet the ref or directory is still
//                 here — meaning a prior WorktreeManager.remove() failed
//                 silently (both its git calls swallow errors by design).
//                 Should never occur; surfaced so the failure is visible.
// - 'orphan':     no run in the registry claims this ref at all (a
//                 hand-deleted transcript, or a crash between creating the
//                 ref and writing the transcript header).
// - 'epic':       an epic's integration branch (`epic/<id>`) — owned by the
//                 epic, not by any single run, so none of the run-shaped
//                 statuses above apply. Deliberately distinct from 'orphan':
//                 an epic branch with unmerged child work must never be swept
//                 up by orphan cleanup.
export type BranchEntryStatus =
  | 'active'
  | 'reviewable'
  | 'leftover'
  | 'orphan'
  | 'epic';

// One row of the branches surface: a join of what git knows (the ref exists,
// here is its worktree and how far ahead it is) with what the run registry
// knows (which run and task it belongs to, and whether it was reviewed).
// Neither side alone can answer "what dispatch branches exist and what do they
// mean", which is why this type carries both and marks the registry half
// optional.
export interface BranchEntry {
  branch: string;
  // Absent when no worktree is registered for this ref at all (an orphan ref,
  // or a run whose worktree directory was freed). Distinct from
  // `worktreeExists`, which is about the directory actually being on disk.
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
  // Commits on this branch that its base does not have — how much work
  // deleting the ref would destroy.
  ahead: number;
  // Commits the base has gained since this branch diverged — how far unmerged
  // work has fallen behind. Only measured while the branch is unmerged; once
  // the work landed the count stops meaning anything, so merged rows omit it.
  // For 'epic' entries the same count is the signal the integration branch
  // has fallen behind the default base and a human should update it —
  // dispatch deliberately never rebases or merges an epic branch on its own.
  behindBase?: number;
  mergedIntoBase: boolean;

  // The registry half: present only when a run claims this branch.
  runId?: string;
  taskId?: string;
  taskTitle?: string;
  runState?: RunState;
  baseBranch?: string;
  reviewedAt?: string;
  prUrl?: string;
  // True only once this branch's landed work is reachable from origin's copy
  // of its base branch — i.e. the merge is not just local but actually pushed.
  // Judged by the run's recorded merge commit when there is one (the only
  // truth for a squash merge, whose branch tip never becomes an ancestor of
  // base), else by the branch tip itself (covers hand-merged refs no run
  // claims). Always false when the branch is unmerged or there is no origin.
  pushedToOrigin: boolean;

  status: BranchEntryStatus;
}

// Typed errors the orchestrator throws for the API layer to map to HTTP
// status codes, mirroring the existing TaskParseError/ConfigError pattern in
// api.ts rather than inventing a new error-handling convention.
export class OrchestratorClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestratorClientError';
  }
}

export class OrchestratorNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestratorNotFoundError';
  }
}

export class OrchestratorConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestratorConflictError';
  }
}

/**
 * A merge refused because of the state of the MAIN CHECKOUT rather than
 * anything about the run itself — a dirty working tree, a staged index, or the
 * wrong branch checked out.
 *
 * Distinguished from a plain OrchestratorConflictError because these are
 * transient, global, and fixed by the user in seconds, which makes them
 * retryable: the merge queue holds an entry in line and re-checks it (see
 * MergeQueue's 'blocked-environment' state) instead of failing it out to
 * history the way it must for a genuine content conflict. Subclasses
 * OrchestratorConflictError so api.ts keeps mapping it to the same 409 and
 * every existing caller/test that checks for that type is unaffected.
 */
export class MergeEnvironmentError extends OrchestratorConflictError {
  constructor(message: string) {
    super(message);
    this.name = 'MergeEnvironmentError';
  }
}
