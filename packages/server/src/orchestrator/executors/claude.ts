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
  ApprovalDecision,
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
// The only inherited environment variables the dispatch MCP server child is
// given. This is an ALLOWLIST, and deliberately so: the SDK serializes this
// `env` into the `--mcp-config` value on the spawned CLI's **argv**, where it
// is readable by any local process through `ps`. Copying the whole
// `process.env` (what this used to do) therefore published every credential
// dispatchd happened to inherit — GITHUB_TOKEN, API keys, DB passwords — to
// anything that could list processes.
//
// A denylist can't work here; secrets have no reliable naming convention. An
// allowlist can, because the child's needs are tiny and known: the three
// DISPATCH_* variables it actually reads (see packages/mcp/src/tools.ts and
// daemon.ts) plus the handful the runtime itself needs to start.
//
// Note this restricts *only* the MCP server child. The agent's own tools run
// in the Claude Code CLI's environment, so nothing here limits what a
// dispatched agent can use in Bash.
const MCP_ENV_PASSTHROUGH: readonly string[] = [
  // Required for `bun` to be found and to run at all.
  'PATH',
  'HOME',
  'TMPDIR',
  // Locale — keeps the child's stdio encoding matching the parent's.
  'LANG',
  'LC_ALL',
  // Bun's own install/cache root, when the install isn't in the default place.
  'BUN_INSTALL',
  // Redirects all dispatch state away from the real home directory; the
  // child's own daemon discovery reads it (packages/mcp/src/daemon.ts), so
  // dropping it would break every test harness and non-default install.
  'DISPATCH_HOME',
];

// Per-call ceiling the CLI enforces on dispatch's own MCP tools. Must stay
// above `ask_user`'s 30-minute wait budget or it cuts that tool call off.
const DISPATCH_MCP_TOOL_TIMEOUT_MS = 31 * 60_000;

function buildDispatchMcpServerConfig(
  cwd: string,
  projectRoot: string,
  runId: string
): McpServerConfig {
  // `McpStdioServerConfig.env` is `Record<string, string>`, but `process.env`
  // is `Record<string, string | undefined>` (any key can be unset) — drop the
  // unset ones rather than passing `undefined` through. An explicit `env` on
  // the spawned child replaces its inherited environment entirely (unlike
  // omitting `env`, which inherits as-is), so this must carry everything the
  // child needs — see MCP_ENV_PASSTHROUGH for why that set is an allowlist
  // rather than the whole environment.
  const env: Record<string, string> = {};
  for (const key of MCP_ENV_PASSTHROUGH) {
    const value = process.env[key];
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
    return {
      type: 'stdio',
      command: mcpBin,
      args: ['--root', cwd],
      env,
      timeout: DISPATCH_MCP_TOOL_TIMEOUT_MS,
    };
  }
  return {
    type: 'stdio',
    command: 'bun',
    args: [resolveMcpBin(), '--root', cwd],
    env,
    timeout: DISPATCH_MCP_TOOL_TIMEOUT_MS,
  };
}

// A resolver for one canUseTool call this run is currently blocked on,
// waiting for the orchestrator's approve() to answer it — the same
// requestId -> resolver shape FakeExecutor uses for its own scripted
// approval gates, so both executors plug into the orchestrator's approval
// flow identically.
type ApprovalResolver = (decision: ApprovalDecision) => void;

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
// Deliberately NOT extended to `'auto'`: under that mode the SDK's own
// model classifier already auto-approves the routine calls itself (the vast
// majority never even reach `canUseTool`) and only routes a call here when
// it judged that specific call worth a human look (surfaced via
// `decisionReason`, e.g. `'safetyCheck'`). Force-allowing edit tools that
// reach this callback under `'auto'` would make it behave exactly like
// `bypassPermissions` and throw away the one safety valve the mode actually
// offers — these escalations are meant to be rare, and the orchestrator's
// approval flow (below) is exactly where they should surface for a human to
// look at, not somewhere they get silently rubber-stamped.
const AUTO_ALLOWED_EDIT_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

// Auto-allowed alongside the edit tools under `acceptEdits`: gating it would
// make the user approve a tool call before being shown the question it asks.
const ASK_USER_TOOL = 'mcp__dispatch__ask_user';

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

// Human-readable explanations for the `terminal_reason` values that mean the
// agent was CUT OFF rather than finishing its work. Only `'completed'` means
// genuinely done, so this map exists purely to give the common truncation
// causes a message a human can act on; anything absent from it still fails
// (see reasonForTruncation) carrying the raw reason string.
//
// The load-bearing entry is `'blocking_limit'` — the Claude usage/session
// limit. See the doc comment on finishFromResult for why that one silently
// looked like success.
const TRUNCATING_TERMINAL_REASONS: Record<string, string> = {
  blocking_limit:
    'Claude usage limit reached before the agent finished — resume this run once your limit resets',
  rapid_refill_breaker:
    'Claude rate limiter stopped the session before the agent finished — resume this run shortly',
  budget_exhausted: 'run hit its cost budget before the agent finished',
  max_turns: 'run hit its turn limit before the agent finished',
  prompt_too_long:
    'conversation grew too long for the model before the agent finished',
  hook_stopped: 'a hook stopped the session before the agent finished',
  stop_hook_prevented: 'a stop hook prevented the agent from finishing',
  api_error: 'the Claude API errored before the agent finished',
  model_error: 'the model errored before the agent finished',
  image_error: 'an image could not be processed before the agent finished',
  malformed_tool_use_exhausted:
    'the agent could not produce a valid tool call after repeated attempts',
  structured_output_retry_exhausted:
    'the agent could not produce valid structured output after repeated attempts',
  turn_setup_failed: 'a turn failed to start before the agent finished',
  tool_deferred_unavailable: 'a required tool was unavailable',
  aborted_streaming: 'the session was aborted mid-response',
  aborted_tools: 'the session was aborted mid-tool-call',
};

// Decides whether a `subtype: 'success'` result actually represents finished
// work, returning the failure message when it does not and `null` when the run
// genuinely completed.
//
// Deliberately an ALLOWLIST of one value (`'completed'`): a `terminal_reason`
// this build has never heard of — a value a future SDK adds — defaults to
// "not complete" rather than silently claiming success. That default is the
// entire point; the alternative is re-introducing this class of bug every
// time the SDK grows a new stop condition.
function reasonForTruncation(message: SDKResultMessage): string | null {
  // Older SDKs (and FakeExecutor fixtures) never set this field at all —
  // absent means "no opinion", so fall back to the subtype-only judgement
  // rather than failing every run.
  const reason = (message as { terminal_reason?: string }).terminal_reason;
  if (reason === undefined || reason === 'completed') return null;
  // Not a truncation: the turn was intentionally handed off rather than cut
  // short. Dispatch enables neither feature, but claiming failure for a
  // deliberate handoff would be its own wrong answer.
  if (reason === 'background_requested' || reason === 'tool_deferred') {
    return null;
  }
  return TRUNCATING_TERMINAL_REASONS[reason] ?? `agent stopped: ${reason}`;
}

// Turns the SDK's terminal `result` message into the ExecutorEvents.onFinish
// shape. Every subtype other than `'success'` (error_max_turns,
// error_max_budget_usd, error_during_execution, ...) is a failed run, with
// `errors` (when present) joined into a single message.
//
// `subtype: 'success'` alone is NOT enough to call a run finished, and reading
// it that way was the "hit the session limit but reported complete" bug: the
// subtype describes the CLI *process* exiting cleanly, not the agent
// accomplishing anything. A run the Claude usage limit cut off mid-task exits
// exactly that cleanly, reporting the real outcome on `terminal_reason`
// (and/or `is_error`) instead — so both are checked here before a run is
// allowed to claim it finished. Turn/cost accounting is preserved either way,
// so reclassifying a run never loses what it already spent.
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
    const truncation = reasonForTruncation(message);
    if (truncation !== null) {
      return { state: 'failed', ...base, error: truncation };
    }
    if (message.is_error) {
      const detail = message.result.trim();
      return {
        state: 'failed',
        ...base,
        error:
          detail.length > 0
            ? detail
            : 'agent reported an error before finishing',
      };
    }
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
 * own docs); every other tool, every tool under `'auto'` (whose own SDK-side
 * classifier already handles the routine cases and only forwards the ones it
 * flagged for a human look), and every tool under any other permission mode,
 * raises the orchestrator's approval flow and waits for `approve()`.
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
    // Tools the user said "always, for this run" about. Session-scoped by construction: this
    // Set lives inside start(), so it dies with the run rather than leaking a permission grant
    // into the next one — which is the property that makes approve-for-session safe to offer
    // at all.
    const sessionAllowed = new Set<string>();

    const canUseTool: CanUseTool = async (toolName, input, callOpts) => {
      if (interrupted) {
        return { behavior: 'deny', message: 'run cancelled' };
      }
      if (
        opts.permissionMode === 'acceptEdits' &&
        (AUTO_ALLOWED_EDIT_TOOLS.has(toolName) || toolName === ASK_USER_TOOL)
      ) {
        return { behavior: 'allow', updatedInput: input };
      }
      if (sessionAllowed.has(toolName)) {
        return { behavior: 'allow', updatedInput: input };
      }
      const { requestId } = callOpts;
      events.onApprovalRequest({ requestId, toolName, input });
      const decision = await new Promise<ApprovalDecision>((resolve) => {
        pendingApprovals.set(requestId, resolve);
      });
      if (decision.allow) {
        if (decision.scope === 'session') sessionAllowed.add(toolName);
        return { behavior: 'allow', updatedInput: input };
      }
      // The reason is passed straight through as the denial message, which is what the SDK
      // surfaces back to the model — so "deny and tell it why" actually tells it why, rather
      // than the agent seeing a bare refusal and guessing.
      return {
        behavior: 'deny',
        message:
          decision.reason !== undefined && decision.reason.trim() !== ''
            ? decision.reason.trim()
            : 'denied by user',
      };
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
        for (const resolve of pendingApprovals.values()) {
          resolve({ allow: false, reason: 'run cancelled' });
        }
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
      approve(requestId: string, decision: ApprovalDecision): void {
        const resolve = pendingApprovals.get(requestId);
        if (resolve !== undefined) {
          pendingApprovals.delete(requestId);
          resolve(decision);
        }
      },
    };
  }
}
