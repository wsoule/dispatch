// The Vibe Kanban pattern: every executor, real or fake, streams a uniform
// log shape so the transcript/UI never needs to know which executor produced
// an entry. `kind: 'usage'` entries carry running cost/turn info; everything
// else is either assistant output, a tool invocation, model "thinking", or a
// system-authored note (e.g. a user's mid-run message).
export interface NormalizedEntry {
  ts: string;
  kind: 'assistant' | 'tool' | 'thinking' | 'system' | 'usage';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  status?: 'running' | 'done' | 'error';
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
