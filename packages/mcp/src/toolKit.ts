import { z } from 'zod';

// Primitives shared by tools.ts and messaging.ts; it imports neither, so the
// two can both depend on it without an import cycle.

// The index signature makes this satisfy the SDK's open CallToolResult shape
// without importing its deeply generic result type.
export interface ToolOutcome {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// The line breaks JSON.stringify leaves raw inside a string: NEL and the
// Unicode line and paragraph separators.
const RAW_JSON_LINE_BREAK = /[\u0085\u2028\u2029]/g;

// A tool's JSON result, with every line break escaped so no string value, such
// as a message body, can start a line of its own in the model's context.
export function toolResult(
  structuredContent: Record<string, unknown>
): ToolOutcome {
  const text = JSON.stringify(structuredContent).replace(
    RAW_JSON_LINE_BREAK,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
  return { content: [{ type: 'text', text }], structuredContent };
}

export function toolError(message: string): ToolOutcome {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Inside a run `rootDir` is its worktree; daemon discovery and writes that
// outlive the run use the executor's DISPATCH_PROJECT_ROOT instead.
export function projectRoot(rootDir: string): string {
  const override = process.env.DISPATCH_PROJECT_ROOT;
  return override !== undefined && override !== '' ? override : rootDir;
}

// The calling run's id, which the executor passes as DISPATCH_RUN_ID; undefined
// outside a dispatch run, and each caller decides whether it needs one.
export function callingRunId(): string | undefined {
  const id = process.env.DISPATCH_RUN_ID;
  return id !== undefined && id !== '' ? id : undefined;
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

// The executor sets the MCP client's tool timeout above `humanTotalWaitMs` (see
// dispatchMcp.ts); the agent fallback matches DEFAULT_MESSAGING's 600s.
export const DEFAULT_MESSAGE_BLOCKING_TIMING: MessageBlockingTiming = {
  humanTotalWaitMs: 30 * 60_000,
  defaultAgentTotalWaitMs: 600_000,
  requestTimeoutMs: 45_000,
  retryDelayMs: 250,
  errorDelayMs: 2000,
};

// List tools page their results so a large board fits one MCP response.
export const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;

export const pageInput = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .optional()
    .describe(`At most this many (default ${DEFAULT_PAGE_LIMIT}).`),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Skip this many first; pass the last nextOffset to page on.'),
};

export const pageOutput = {
  total: z.number(),
  nextOffset: z.number().nullable(),
};

// One page of `items`, its total, and where the next page starts (null when
// this is the last).
export function pageOf<T>(
  items: readonly T[],
  args: { limit?: number; offset?: number }
): { items: T[]; total: number; nextOffset: number | null } {
  const offset = args.offset ?? 0;
  const end = offset + (args.limit ?? DEFAULT_PAGE_LIMIT);
  return {
    items: items.slice(offset, end),
    total: items.length,
    nextOffset: end < items.length ? end : null,
  };
}
