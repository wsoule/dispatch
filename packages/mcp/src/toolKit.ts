// Shared primitives every tool module in this package builds on: the tool
// result/error shape, the run-worktree/project-root split, a poll loop's
// abort signal, and the timing knobs each long-polling tool family takes.
// A leaf module (no imports from tools.ts or messaging.ts) so those two can
// both depend on it without an import cycle between them.

// Index signature matches the SDK's CallToolResult shape (an open record
// with a few known fields) so this satisfies ToolCallback's return type
// without pulling in the SDK's own (deeply generic) result type here.
export interface ToolOutcome {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function toolResult(
  structuredContent: Record<string, unknown>
): ToolOutcome {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

export function toolError(message: string): ToolOutcome {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Inside a dispatch run, `rootDir` is the run's git worktree, but daemon
// discovery and any write meant to outlive the run must target the PROJECT
// root instead — the executor records that override when the two differ.
export function projectRoot(rootDir: string): string {
  const override = process.env.DISPATCH_PROJECT_ROOT;
  return override !== undefined && override !== '' ? override : rootDir;
}

// One poll's abort signal: its own timeout, plus the client's cancellation
// when there is one, so a cancelled tool call doesn't sit out the full poll.
export function pollSignal(
  timeoutMs: number,
  signal?: AbortSignal
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
}

/** How long `ask_user` waits, and how hard it polls while waiting. */
export interface QuestionTiming {
  /** Total budget across every poll before giving up on an answer. */
  totalWaitMs: number;
  /** Per-request timeout; longer than the daemon's own 30s poll window. */
  requestTimeoutMs: number;
  /** Pause after a clean unanswered poll, and after a failed one. */
  retryDelayMs: number;
  errorDelayMs: number;
}

// The MCP client aborts a tool call at its own tool timeout, so the executor
// sets that ceiling above `totalWaitMs` for this server — see claude.ts.
export const DEFAULT_QUESTION_TIMING: QuestionTiming = {
  totalWaitMs: 30 * 60_000,
  requestTimeoutMs: 45_000,
  retryDelayMs: 250,
  errorDelayMs: 2000,
};

/** How long `request_scope` waits, and how hard it polls while waiting. */
export interface ScopeTiming {
  /** Total budget across every poll before self-denying. */
  totalWaitMs: number;
  /** Per-request timeout; longer than the daemon's own 30s poll window. */
  requestTimeoutMs: number;
  /** Pause after a clean undecided poll, and after a failed one. */
  retryDelayMs: number;
  errorDelayMs: number;
}

// Same numbers as DEFAULT_QUESTION_TIMING, and the same reasoning: the
// executor's MCP client timeout sits above totalWaitMs (see claude.ts).
export const DEFAULT_SCOPE_TIMING: ScopeTiming = {
  totalWaitMs: 30 * 60_000,
  requestTimeoutMs: 45_000,
  retryDelayMs: 250,
  errorDelayMs: 2000,
};

/** How long `msg_send` waits for a blocking answer, and how hard it polls. */
export interface MessageBlockingTiming {
  /** Total budget when any recipient is a human. */
  humanTotalWaitMs: number;
  /** Total budget for a non-human recipient when `GET /api/config` can't be
   *  read; `messaging.agentBlockingTimeoutSec` wins whenever available. */
  defaultAgentTotalWaitMs: number;
  /** Per-request timeout; longer than the daemon's own 30s poll window. */
  requestTimeoutMs: number;
  /** Pause after a clean unanswered poll, and after a failed one. */
  retryDelayMs: number;
  errorDelayMs: number;
}

// humanTotalWaitMs/requestTimeoutMs/retryDelayMs/errorDelayMs match
// DEFAULT_QUESTION_TIMING; defaultAgentTotalWaitMs matches core's
// DEFAULT_MESSAGING.agentBlockingTimeoutSec (600s).
export const DEFAULT_MESSAGE_BLOCKING_TIMING: MessageBlockingTiming = {
  humanTotalWaitMs: 30 * 60_000,
  defaultAgentTotalWaitMs: 600_000,
  requestTimeoutMs: 45_000,
  retryDelayMs: 250,
  errorDelayMs: 2000,
};
