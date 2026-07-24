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

import { openClaudeQuery, rewriteMissingCliError } from '../claudeCli.js';
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
// worktree. `DISPATCH_RUN_ID` (agent-comms) is this run's own id — the
// dispatch MCP server's `agent_message`/`message_user` tools (packages/mcp/
// src/tools.ts) read it back out so a calling agent never has to know or
// supply its own run id just to be identified as the sender/raiser.
function buildDispatchMcpServerConfig(
  cwd: string,
  projectRoot: string,
  runId: string
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
  env.DISPATCH_RUN_ID = runId;
  // `DISPATCH_MCP_BIN` is set by the packaged desktop app's sidecar wiring to
  // the bundled, `bun build --compile`d MCP server binary — run it directly so
  // a self-contained release needs neither `bun` on PATH nor the monorepo
  // checkout `resolveMcpBin()` walks to. Unset in dev / a plain `dispatch
  // serve`, where the TS entry runs through `bun` as before.
  const mcpBin = process.env.DISPATCH_MCP_BIN;
  if (mcpBin !== undefined && mcpBin !== '') {
    return { type: 'stdio', command: mcpBin, args: ['--root', cwd], env };
  }
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
//
// `'auto'` gets the exact same treatment: under that mode the SDK's own
// model classifier handles approval for tools it covers, so `canUseTool`
// simply never fires for most of them — but these edit tools hit the same
// gap `acceptEdits` has above and still reach this callback. Falling
// through to the orchestrator's human-approval flow for them would leave a
// dispatched `'auto'` run stalled waiting on a human who was never meant to
// be in the loop, so this auto-allows them here exactly as `acceptEdits`
// does.
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
 * a single `canUseTool`: under `permissionMode: 'acceptEdits'` or `'auto'` it
 * auto-allows Claude Code's file-edit tools itself (see
 * AUTO_ALLOWED_EDIT_TOOLS — the SDK does not pre-empt the callback for these
 * the way one might expect from its own docs); every other tool, and every
 * tool under any other permission mode, raises the orchestrator's approval
 * flow and waits for `approve()`.
 */
export class ClaudeExecutor implements Executor {
  // Defaults to the real SDK's `query()`; tests inject a stub that yields a
  // scripted `SDKMessage` stream instead of spinning up a real Agent SDK
  // session (which claude-executor.test.ts's DISPATCH_CLAUDE_SMOKE-gated
  // test is what actually exercises) — this is the seam that makes
  // consume()'s own message-handling logic (e.g. M7's session-id capture)
  // unit-testable.
  constructor(private readonly queryFn: typeof query = query) {}

  // Opens the SDK query, resolving the Claude Code CLI the SDK spawns
  // robustly via the shared openClaudeQuery() (see claudeCli.ts for the exact
  // fallback chain and doc comment) — the exact failure this guards against
  // used to escape as an opaque 500 and leave a run stuck 'running'. The
  // orchestrator's startAndRegister catches this throw and marks the run
  // failed carrying exactly that text, which the UI surfaces on the run
  // instead of hanging on 'running'.
  private openQuery(prompt: MessageQueue, options: Options): Query {
    return openClaudeQuery(this.queryFn, prompt, options);
  }

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    const pendingApprovals = new Map<string, ApprovalResolver>();
    let interrupted = false;

    const canUseTool: CanUseTool = async (toolName, input, callOpts) => {
      if (interrupted) {
        return { behavior: 'deny', message: 'run cancelled' };
      }
      if (
        (opts.permissionMode === 'acceptEdits' ||
          opts.permissionMode === 'auto') &&
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
      model: opts.model,
      resume: opts.resumeSessionId,
      canUseTool,
      // Same "query() doesn't auto-load what the CLI does" class of bug as
      // the `.mcp.json` fix directly below: a dispatched run must behave
      // like a human running `claude` in this checkout, not like a bare SDK
      // session with none of its project context. `systemPrompt` opts into
      // the CLI's own default system prompt (sdk.d.ts ~1977: the untyped
      // default here is a minimal one with none of Claude Code's own
      // instructions) and `settingSources` opts into loading this worktree's
      // filesystem settings — sdk.d.ts ~1861-1870: omitting `settingSources`
      // already loads all sources by default, matching CLI behavior, but
      // pinning it explicitly here means a future SDK default change can't
      // silently stop a dispatched agent from reading CLAUDE.md/AGENTS.md;
      // the doc there is also explicit that `'project'` specifically is
      // required to load CLAUDE.md files at all. The run's `cwd` is this
      // run's own git WORKTREE, a full checkout of the project (worktrees
      // share the same working files as any other clone), so its committed
      // CLAUDE.md/AGENTS.md/.claude/settings.json are all present on disk for
      // these to actually find.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
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
          opts.projectRoot ?? opts.cwd,
          opts.runId ?? ''
        ),
      },
    };
    const sdkQuery: Query = this.openQuery(queue, sdkOptions);

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
      // Set only by the 'result' branch below — tracks whether the loop
      // actually reached a terminal SDK message, as opposed to the
      // underlying async iterator simply running out (the CLI process
      // exiting, a killed session, etc.) with no 'result' ever emitted.
      // That "ran out with no result" case throws nothing, so without this
      // flag the loop would fall through silently: no onFinish call at all,
      // leaving the run stuck 'running' forever until a dispatchd restart's
      // reconcileOnBoot eventually force-fails it with no error/turns/cost
      // recorded (the bug this flag exists to prevent).
      let gotResult = false;
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
            gotResult = true;
            if (!interrupted) events.onFinish(finishFromResult(message));
            break;
          }
        }
        if (!gotResult && !interrupted) {
          events.onFinish({
            state: 'failed',
            error: 'agent session ended without a final result',
            sessionId,
          });
        }
      } catch (err) {
        if (!interrupted) {
          const message = (err as Error).message;
          // The missing-CLI error can also surface lazily on the first
          // iteration (rather than synchronously from query() above), so apply
          // the same install-hint rewrite here too.
          events.onFinish({
            state: 'failed',
            error:
              message.length > 0
                ? rewriteMissingCliError(message)
                : 'agent session error',
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
