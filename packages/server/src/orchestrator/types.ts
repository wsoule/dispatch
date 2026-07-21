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
  maxTurns: number;
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
