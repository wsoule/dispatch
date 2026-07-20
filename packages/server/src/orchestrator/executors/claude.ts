import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  Options,
  PermissionMode,
  Query,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
  NormalizedEntry,
} from '../types.js';

// A resolver for one canUseTool call this run is currently blocked on,
// waiting for the orchestrator's approve() to answer it — the same
// requestId -> resolver shape FakeExecutor uses for its own scripted
// approval gates, so both executors plug into the orchestrator's approval
// flow identically.
type ApprovalResolver = (allow: boolean) => void;

// Claude Code's own file-editing tools. Verified empirically against the
// installed SDK (0.3.207): contrary to what the SDK's own docs imply,
// `canUseTool` still fires for `Write` even under `permissionMode:
// 'acceptEdits'` — the mode does not pre-empt the callback the way
// `allowedTools` does. This executor therefore auto-allows this exact set
// itself when in `acceptEdits`, matching what a human running `claude
// --permission-mode acceptEdits` would see (edits proceed without a
// prompt); every other tool, and every tool under any other permission
// mode, always goes through the orchestrator's approval flow below.
const AUTO_ALLOWED_EDIT_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

// Builds the one SDKUserMessage shape this executor ever sends: plain text,
// no images or tool results. Both the initial task prompt and any mid-run
// `send()` follow-up go through this.
function toUserMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  };
}

// A pull-based queue that feeds `query()`'s streaming-input mode: the SDK's
// async generator blocks on `next()` until either another message is pushed
// (`send()`) or the run is done (`close()`). Streaming input is required
// here (rather than a plain string prompt) because the SDK only exposes
// `interrupt()` and the other Query control methods in streaming-input
// mode — a plain string prompt has no live Query handle to interrupt at
// all, and the plan needs both cancel() and mid-run messages to work.
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffered: SDKUserMessage[] = [];
  private waiting: (() => void) | undefined;
  private closed = false;

  constructor(initialText: string) {
    this.buffered.push(toUserMessage(initialText));
  }

  push(text: string): void {
    if (this.closed) return;
    this.buffered.push(toUserMessage(text));
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    this.waiting?.();
    this.waiting = undefined;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.buffered.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}

// The subset of Anthropic content-block fields this executor reads to build
// NormalizedEntry lines. `message.message.content` is typed as the full
// Anthropic SDK `BetaContentBlock` union (many block kinds unrelated to
// Claude Code's own log view: server tool use, web search results, etc.) —
// rather than pull in `@anthropic-ai/sdk`'s deep type-only exports as an
// extra dependency for three field names, this narrow local shape covers
// exactly the three kinds we care about (text, thinking, tool_use).
interface AssistantContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
}

// Maps one assistant turn's content blocks to the NormalizedEntry lines the
// orchestrator logs and broadcasts. Every other content-block kind (server
// tool use, citations, etc.) is silently skipped — NormalizedEntry has no
// slot for them, and the plan only asks for assistant text/tool_use/
// thinking, matching FakeExecutor's own log shape.
function entriesForAssistantContent(
  content: unknown,
  ts: string
): NormalizedEntry[] {
  const blocks = content as AssistantContentBlock[];
  const entries: NormalizedEntry[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text !== undefined) {
      entries.push({ ts, kind: 'assistant', text: block.text });
    } else if (block.type === 'thinking' && block.thinking !== undefined) {
      entries.push({ ts, kind: 'thinking', text: block.thinking });
    } else if (block.type === 'tool_use' && block.name !== undefined) {
      entries.push({
        ts,
        kind: 'tool',
        toolName: block.name,
        toolInput: block.input,
        status: 'running',
      });
    }
  }
  return entries;
}

// Turns the SDK's terminal `result` message into the ExecutorEvents.onFinish
// shape: `subtype: 'success'` is a finished run; every other subtype
// (error_max_turns, error_max_budget_usd, error_during_execution, ...) is a
// failed one, with `errors` (when present) joined into a single message.
function finishFromResult(message: SDKResultMessage): {
  state: 'finished' | 'failed';
  costUsd?: number;
  turns?: number;
  sessionId?: string;
  error?: string;
} {
  const base = {
    costUsd: message.total_cost_usd,
    turns: message.num_turns,
    sessionId: message.session_id,
  };
  if (message.subtype === 'success') {
    return { state: 'finished', ...base };
  }
  return {
    state: 'failed',
    ...base,
    error:
      message.errors.length > 0 ? message.errors.join('; ') : message.subtype,
  };
}

/**
 * The real agent backend: wraps the Claude Agent SDK's `query()` behind the
 * exact same Executor interface FakeExecutor implements, so the orchestrator
 * never branches on which one is running (spec §2's load-bearing seam).
 *
 * Every run uses streaming-input mode (a `MessageQueue` as `prompt`, not a
 * plain string) purely so `interrupt()` and mid-run `send()` are available —
 * both are streaming-input-only Query features. Tool permissions run through
 * a single `canUseTool`: under `permissionMode: 'acceptEdits'` it auto-allows
 * Claude Code's file-edit tools itself (see AUTO_ALLOWED_EDIT_TOOLS — the SDK
 * does not pre-empt the callback for these the way one might expect from its
 * own docs); every other tool, and every tool under any other permission
 * mode, raises the orchestrator's approval flow and waits for `approve()`.
 */
export class ClaudeExecutor implements Executor {
  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    const pendingApprovals = new Map<string, ApprovalResolver>();
    let interrupted = false;

    const canUseTool: CanUseTool = async (toolName, input, callOpts) => {
      if (interrupted) {
        return { behavior: 'deny', message: 'run cancelled' };
      }
      if (
        opts.permissionMode === 'acceptEdits' &&
        AUTO_ALLOWED_EDIT_TOOLS.has(toolName)
      ) {
        return { behavior: 'allow', updatedInput: input };
      }
      const { requestId } = callOpts;
      events.onApprovalRequest({ requestId, toolName, input });
      const allow = await new Promise<boolean>((resolve) => {
        pendingApprovals.set(requestId, resolve);
      });
      if (allow) return { behavior: 'allow', updatedInput: input };
      return { behavior: 'deny', message: 'denied by user' };
    };

    const queue = new MessageQueue(opts.prompt);
    const sdkOptions: Options = {
      cwd: opts.cwd,
      permissionMode: opts.permissionMode as PermissionMode,
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      resume: opts.resumeSessionId,
      canUseTool,
    };
    const sdkQuery: Query = query({ prompt: queue, options: sdkOptions });

    // Fire-and-forget: `start()` must return the ExecutorRun handle
    // synchronously (same contract as FakeExecutor), before any onEntry/
    // onFinish call can land.
    const consume = async (): Promise<void> => {
      try {
        for await (const message of sdkQuery) {
          if (interrupted) break;
          if (message.type === 'assistant') {
            const ts = new Date().toISOString();
            for (const entry of entriesForAssistantContent(
              message.message.content,
              ts
            )) {
              events.onEntry(entry);
            }
          } else if (message.type === 'result') {
            if (!interrupted) events.onFinish(finishFromResult(message));
            break;
          }
        }
      } catch (err) {
        if (!interrupted) {
          events.onFinish({ state: 'failed', error: (err as Error).message });
        }
      } finally {
        queue.close();
      }
    };
    void consume();

    return {
      async interrupt(): Promise<void> {
        interrupted = true;
        for (const resolve of pendingApprovals.values()) resolve(false);
        pendingApprovals.clear();
        queue.close();
        try {
          await sdkQuery.interrupt();
        } catch {
          // The underlying CLI process may already be gone — either way,
          // there is nothing left to interrupt.
        }
        sdkQuery.close();
      },
      send(message: string): void {
        queue.push(message);
      },
      approve(requestId: string, allow: boolean): void {
        const resolve = pendingApprovals.get(requestId);
        if (resolve !== undefined) {
          pendingApprovals.delete(requestId);
          resolve(allow);
        }
      },
    };
  }
}
