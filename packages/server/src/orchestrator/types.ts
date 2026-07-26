// The Vibe Kanban pattern: every executor, real or fake, streams a uniform
// log shape so the transcript/UI never needs to know which executor produced
// an entry. `kind: 'usage'` entries carry running cost/turn info; everything
// else is either assistant output, a tool invocation, model "thinking", a
// system-authored note, or (agent-comms) an identified `message` — a
// human-to-agent or agent-to-agent chat turn that carries `from`/`fromLabel`
// so the transcript/UI can tell who's talking, instead of the undifferentiated
// `system` "user: ..." notes this used to be recorded as. `from: 'user'` is
// the run's own human via the Session composer; `from: 'agent'` is either
// another live run's `agent_message` (sender identified via `fromLabel`) or
// this run's own `message_user` call flagging something to the human.
export interface NormalizedEntry {
  ts: string;
  kind: 'assistant' | 'tool' | 'thinking' | 'system' | 'usage' | 'message';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  status?: 'running' | 'done' | 'error';
  from?: 'user' | 'agent';
  // Who sent a `from: 'agent'` message — e.g. the sender run's task title
  // + id ("Fix login bug (r-abc123)"), or a generic fallback when the
  // sender's identity couldn't be resolved. Never set for `from: 'user'`
  // (the app renders that as "You" unconditionally).
  fromLabel?: string;
  // Distinguishes the two `from: 'agent'` directions, which are otherwise
  // shaped identically. `true` marks this run's own `message_user` call —
  // the agent flagging something UP to the human — so the app can badge it
  // as "To you" rather than rendering it like an inbound message from
  // another agent (`inject`, where `toUser` is absent and `fromLabel` names
  // a *different* run).
  toUser?: boolean;
}

// A live handle to a running executor invocation — the orchestrator holds
// one of these per live run so API calls (approval, mid-run message, cancel)
// have somewhere to go without the executor itself needing to know about
// HTTP or the registry.
export interface ExecutorRun {
  interrupt(): Promise<void>;
  send(message: string): void;
  approve(requestId: string, allow: boolean): void;
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
  onFinish(finish: {
    state: 'finished' | 'failed';
    costUsd?: number;
    turns?: number;
    sessionId?: string;
    error?: string;
  }): void;
}

export interface ExecutorStartOptions {
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  permissionMode: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  // The Claude model this run should use (an SDK model id like
  // 'claude-opus-4-8' or an alias like 'sonnet'), chosen at dispatch time.
  // Optional — omitted falls back to the SDK/CLI default, so FakeExecutor
  // fixtures and callers that don't care never need to set it.
  model?: string;
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
  // buildDispatchMcpServerConfig) so `agent_message`/`message_user` know
  // whose identity to attach to a message without the calling agent having
  // to know or supply its own run id. Optional for the same reason
  // `projectRoot` is: FakeExecutor fixtures that never touch messaging don't
  // need to pass it; every real Orchestrator call site always does.
  runId?: string;
}

// The load-bearing seam (spec §2): every agent backend — FakeExecutor here in
// O1, the real Claude Agent SDK in O2 — implements this one interface so the
// orchestrator never branches on which executor is running.
export interface Executor {
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
  | 'cancelled';

export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  'finished',
  'failed',
  'cancelled',
]);

// Everything the registry/transcript/API need to describe a run, independent
// of whether it is still live (has a real ExecutorRun) or is being replayed
// from a transcript after a restart.
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
  // The Claude model this run was dispatched with, if one was chosen (see
  // ExecutorStartOptions.model) — surfaced so the UI can show which model ran
  // a given task.
  model?: string;
  // C2: once a run has been merged or discarded, review() must refuse any
  // further review/resume calls on it — this pair of fields, once set, is
  // that one-way marker. `state` itself stays whatever terminal value it
  // already had (finished/failed/cancelled); reviewing a run never changes
  // its RunState, it only records that the review happened.
  reviewedAt?: string;
  reviewAction?: 'merge' | 'discard' | 'pr';
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
export type BranchEntryStatus = 'active' | 'reviewable' | 'leftover' | 'orphan';

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
  dirty: boolean;
  lastCommitAt?: string;
  // Commits on this branch that its base does not have — how much work
  // deleting the ref would destroy.
  ahead: number;
  mergedIntoBase: boolean;

  // The registry half: present only when a run claims this branch.
  runId?: string;
  taskId?: string;
  taskTitle?: string;
  runState?: RunState;
  baseBranch?: string;
  reviewedAt?: string;
  prUrl?: string;

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
