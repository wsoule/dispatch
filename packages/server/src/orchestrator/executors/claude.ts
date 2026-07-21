import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  McpServerConfig,
  Options,
  PermissionMode,
  Query,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type {
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
  NormalizedEntry,
} from '../types.js';

// Locates the dispatch MCP server's stdio entry point via Node's own module
// resolution rather than a hardcoded relative path — the exact pattern
// packages/cli/src/commands/daemon.ts's `resolveDaemonBin` already uses for
// @dispatch/server's bin. `@dispatch/mcp`'s `exports` map only exposes
// `./package.json` for this purpose (see its package.json — mirroring
// @dispatch/server's own minimal export), so this resolve() call has
// something to anchor on regardless of whether the CLI is run from source or
// from a built `dist/`; the bin script itself sits alongside it at
// `src/bin.ts`, run directly by Bun (which executes TypeScript natively, no
// build step required).
//
// TODO(Phase 6 packaging): once dispatchd ships as a packaged binary rather
// than running from source under `bun`, this should resolve the *built*
// `dist/bin.js` (or shell out to the `dispatch-mcp` bin on PATH once one is
// installed alongside the packaged server) instead of `src/bin.ts` — mirror
// whatever bin-resolution story the packaged @dispatch/server ends up using.
function resolveMcpBin(): string {
  const pkgJsonPath = createRequire(import.meta.url).resolve(
    '@dispatch/mcp/package.json'
  );
  return join(dirname(pkgJsonPath), 'src', 'bin.ts');
}

// Builds the `mcpServers` entry the SDK's `query()` needs to actually load
// the dispatch MCP server for a run — see the module-level comment on why
// this is required at all. Rooted at the run's own git WORKTREE (`cwd`) via
// `--root` so task_list/task_get/task_save/task_next read and write the
// exact task files the run's own repo checkout sees; `DISPATCH_PROJECT_ROOT`
// is set to the dispatch PROJECT's root (a different directory than the
// worktree) so run_list/agent_message's daemon discovery and task_comment's
// write both target the project's real daemon file and `.dispatch/tasks`
// instead of the worktree's copy — see packages/mcp/src/tools.ts's
// `projectRoot()` helper for why those two specifically cannot use the
// worktree.
function buildDispatchMcpServerConfig(
  cwd: string,
  projectRoot: string
): McpServerConfig {
  // `McpStdioServerConfig.env` is `Record<string, string>`, but
  // `process.env` is `Record<string, string | undefined>` (any key can be
  // unset) — drop the unset ones rather than passing `undefined` through.
  // An explicit `env` on the spawned child replaces its inherited
  // environment entirely (unlike omitting `env`, which inherits as-is), so
  // this has to carry everything the child needs — PATH for `bun` to find
  // itself included — not just the one new variable.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.DISPATCH_PROJECT_ROOT = projectRoot;
  return {
    type: 'stdio',
    command: 'bun',
    args: [resolveMcpBin(), '--root', cwd],
    env,
  };
}

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
      // TODO(M7): every tool entry is logged as `status: 'running'` and
      // never resolved to 'done'/'error'. Doing that cheaply would need (a)
      // a stable id to update — NormalizedEntry/the transcript's append-only
      // JSONL have neither; the transcript would need a new line kind that
      // *patches* a prior entry by tool_use_id rather than only ever
      // appending, and every reader (getRun's replay, the web UI's log view)
      // would need to apply that patch when folding entries — and (b)
      // reading the SDK's own tool_result content blocks, which arrive on a
      // *user*-typed message this loop currently ignores entirely (only
      // 'assistant'/'system'/'result' are handled above). Neither half is
      // cheap, so this stays 'running' until that transcript-patching seam
      // exists.
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
  // Defaults to the real SDK's `query()`; tests inject a stub that yields a
  // scripted `SDKMessage` stream instead of spinning up a real Agent SDK
  // session (which claude-executor.test.ts's DISPATCH_CLAUDE_SMOKE-gated
  // test is what actually exercises) — this is the seam that makes
  // consume()'s own message-handling logic (e.g. M7's session-id capture)
  // unit-testable.
  constructor(private readonly queryFn: typeof query = query) {}

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
      // Bug fix (fix/executor-mcp-wiring): `query()` does NOT auto-load a
      // project's committed `.mcp.json` the way the interactive `claude` CLI
      // does — without this, a dispatched run has no dispatch MCP tools at
      // all (run_list/task_comment), despite the prompt telling it to use
      // them. `opts.projectRoot` falls back to `opts.cwd` for callers that
      // never pass it (FakeExecutor fixtures; a real run always passes it —
      // see orchestrator.ts).
      mcpServers: {
        dispatch: buildDispatchMcpServerConfig(
          opts.cwd,
          opts.projectRoot ?? opts.cwd
        ),
      },
    };
    const sdkQuery: Query = this.queryFn({
      prompt: queue,
      options: sdkOptions,
    });

    // Fire-and-forget: `start()` must return the ExecutorRun handle
    // synchronously (same contract as FakeExecutor), before any onEntry/
    // onFinish call can land.
    const consume = async (): Promise<void> => {
      // M7: captured as soon as it's known (the 'system' init message,
      // always the first message of a session) rather than only off the
      // terminal 'result' message — a run that fails mid-stream, before any
      // 'result' ever arrives, still has a real session underneath it, and
      // without this its `catch` block below would report a failure with no
      // sessionId, making it impossible to resume via sendMessage's
      // `resume: true` path.
      let sessionId: string | undefined;
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
          } else if (message.type === 'system') {
            sessionId = message.session_id;
          } else if (message.type === 'result') {
            if (!interrupted) events.onFinish(finishFromResult(message));
            break;
          }
        }
      } catch (err) {
        if (!interrupted) {
          events.onFinish({
            state: 'failed',
            error: (err as Error).message,
            sessionId,
          });
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
