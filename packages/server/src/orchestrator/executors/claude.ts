import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  HookCallback,
  McpServerConfig,
  Options,
  PermissionMode,
  Query,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { CartoBinary } from '@dispatch/core/carto';

import { floorCheckForToolInput } from '../../floor.js';
import { openClaudeQuery, rewriteMissingCliError } from '../claudeCli.js';
import type { StdioServerSpec } from '../dispatchMcp.js';
import { cartoMcpSpec, cartoSpecFor, dispatchMcpSpec } from '../dispatchMcp.js';
import type {
  ApprovalDecision,
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
  NormalizedEntry,
} from '../types.js';
import { isSubagentSpawn, SubagentTracker } from './subagentTracker.js';

// The Agent SDK's shape of one provider-neutral stdio server spec (see
// ../dispatchMcp.ts for what each server is and why its env is an allowlist).
function toSdkMcp(spec: StdioServerSpec): McpServerConfig {
  return {
    type: 'stdio',
    command: spec.command,
    args: spec.args,
    env: spec.env,
    ...(spec.timeoutMs !== undefined ? { timeout: spec.timeoutMs } : {}),
  };
}

// Kept as the SDK-shaped entry points the overseer and tests use.
export function buildCartoMcpServerConfig(
  projectRoot: string,
  binary: CartoBinary
): McpServerConfig {
  return toSdkMcp(cartoSpecFor(projectRoot, binary));
}

export function cartoMcpServers(
  projectRoot: string
): Record<string, McpServerConfig> {
  const spec = cartoMcpSpec(projectRoot);
  return spec === null ? {} : { carto: toSdkMcp(spec) };
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

/**
 * What a tool call is refused with once the user has asked this run to stop.
 *
 * A graceful stop has exactly one lever against a live Agent SDK session: the
 * `canUseTool` gate. Whatever the agent is doing at the moment Stop is pressed
 * has already been through that gate, so it runs to completion untouched; every
 * NEXT tool call is refused with this text, which the SDK hands back to the
 * model as the tool result. The wording is an instruction rather than a bare
 * refusal for the same reason a human denial's `reason` is passed through: the
 * model reads it, writes its closing summary, and ends the turn, which produces
 * an ordinary `result` message and therefore an ordinary `onFinish` — the run
 * finishes rather than being killed, so the orchestrator still auto-commits its
 * work. A model that ignores this and keeps calling tools is caught by
 * Orchestrator.requestStop's escalation timer, not here.
 */
export const STOP_DENIAL_MESSAGE =
  'The user asked this run to stop. Do not start any new tool calls. ' +
  'Summarize what you completed and what is left unfinished, then end your turn.';

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
  id?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
}

// The one block kind read off a `user`-typed SDK message: a tool's result,
// keyed back to its tool_use. Only sub-agent spawns are looked up today (see
// SubagentTracker.onToolResult); every other tool result is still skipped.
interface UserContentBlock {
  type: string;
  tool_use_id?: string;
  is_error?: boolean;
}

// Maps one assistant turn's content blocks to the NormalizedEntry lines the
// orchestrator logs and broadcasts. Every other content-block kind (server
// tool use, citations, etc.) is silently skipped — NormalizedEntry has no
// slot for them, and the plan only asks for assistant text/tool_use/
// thinking, matching FakeExecutor's own log shape.
//
// `parentToolUseId` is set when the message came from inside a sub-agent (the
// SDK forwards a sub-agent's tool calls with `parent_tool_use_id` naming the
// spawn), and every entry made here carries it so the transcript can tell the
// agent's own work from its sub-agents'. A `Task`/`Agent` tool_use is the
// agent spawning a sub-agent and is logged through `tracker` as an `agent`
// entry instead of a plain tool entry.
function entriesForAssistantContent(
  content: unknown,
  ts: string,
  tracker: SubagentTracker,
  parentToolUseId: string | undefined
): NormalizedEntry[] {
  const blocks = content as AssistantContentBlock[];
  const entries: NormalizedEntry[] = [];
  const parent =
    parentToolUseId !== undefined ? { parentToolUseId } : ({} as const);
  for (const block of blocks) {
    if (block.type === 'text' && block.text !== undefined) {
      entries.push({ ts, kind: 'assistant', text: block.text, ...parent });
    } else if (block.type === 'thinking' && block.thinking !== undefined) {
      entries.push({ ts, kind: 'thinking', text: block.thinking, ...parent });
    } else if (block.type === 'tool_use' && block.name !== undefined) {
      if (isSubagentSpawn(block.name)) {
        const spawn = tracker.onSpawn(
          { id: block.id, name: block.name, input: block.input },
          ts,
          parentToolUseId
        );
        if (spawn !== null) {
          entries.push(spawn);
          continue;
        }
      }
      // TODO(M7): every tool entry is logged as `status: 'running'` and
      // never resolved to 'done'/'error'. Doing that cheaply would need (a)
      // a stable id to update — NormalizedEntry/the transcript's append-only
      // JSONL have neither; the transcript would need a new line kind that
      // *patches* a prior entry by tool_use_id rather than only ever
      // appending, and every reader (getRun's replay, the web UI's log view)
      // would need to apply that patch when folding entries — and (b)
      // reading the SDK's own tool_result content blocks, which arrive on a
      // *user*-typed message this loop only reads for sub-agent results
      // (entriesForUserContent). Neither half is cheap, so this stays
      // 'running' until that transcript-patching seam exists.
      entries.push({
        ts,
        kind: 'tool',
        toolName: block.name,
        toolInput: block.input,
        status: 'running',
        ...(block.id !== undefined ? { toolUseId: block.id } : {}),
        ...parent,
      });
    }
  }
  return entries;
}

// The `agent` entries a `user`-typed SDK message amounts to: one finished
// entry per tool_result that answers a sub-agent spawn. Everything else on
// these messages (ordinary tool results, the prompts this executor sends) is
// still ignored — see the TODO(M7) above.
function entriesForUserContent(
  message: { message: { content: unknown }; tool_use_result?: unknown },
  ts: string,
  tracker: SubagentTracker
): NormalizedEntry[] {
  const content = message.message.content;
  if (!Array.isArray(content)) return [];
  const entries: NormalizedEntry[] = [];
  for (const block of content as UserContentBlock[]) {
    if (block.type !== 'tool_result') continue;
    const finished = tracker.onToolResult(block, message.tool_use_result, ts);
    if (finished !== null) entries.push(finished);
  }
  return entries;
}

const USAGE_LIMIT_MESSAGE =
  'Claude usage limit reached before the agent finished — resume this run once your limit resets';

// The same stop reached through `api_error`, where the SDK's own explanation
// follows in parentheses. This lead deliberately offers no remedy: the two
// limits differ ("resets 10pm" vs "you're out of usage credits, switch model
// or top up") and guessing produced a message that contradicted the SDK's.
const USAGE_LIMIT_LEAD = 'Claude usage limit reached before the agent finished';

// Human-readable explanations for the `terminal_reason` values that mean the
// agent was CUT OFF rather than finishing its work. Only `'completed'` means
// genuinely done, so this map exists purely to give the common truncation
// causes a message a human can act on; anything absent from it still fails
// (see reasonForTruncation) carrying the raw reason string.
//
// The budget-cap failure message, exported so floor.ts's isBudgetCapFailure
// recognizes exactly the text this executor writes — the two must not drift,
// or a budget-exhausted run stops registering on the irreversibility floor.
export const BUDGET_EXHAUSTED_MESSAGE =
  'run hit its cost budget before the agent finished';

// The load-bearing entry is `'blocking_limit'` — the Claude usage/session
// limit. See the doc comment on finishFromResult for why that one silently
// looked like success.
const TRUNCATING_TERMINAL_REASONS: Record<string, string> = {
  blocking_limit: USAGE_LIMIT_MESSAGE,
  rapid_refill_breaker:
    'Claude rate limiter stopped the session before the agent finished — resume this run shortly',
  budget_exhausted: BUDGET_EXHAUSTED_MESSAGE,
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

// The SDK's synthetic assistant message explaining an API-side stop — e.g.
// `error: 'rate_limit'` carrying "You've hit your session limit · resets
// 10pm". It arrives BEFORE the terminal `result`, whose `terminal_reason` is
// then only `'api_error'`; without remembering it, a usage-limit stop is
// recorded as "the Claude API errored" and the real reason lives only in the
// transcript (2026-09-04: seven runs, all diagnosed by hand).
interface ApiErrorNote {
  kind: string;
  text: string;
}

// Per-kind explanations for the API errors that end a run. A kind absent here
// keeps the generic terminal-reason message, with the SDK's own text appended.
const API_ERROR_MESSAGES: Record<string, string> = {
  rate_limit: USAGE_LIMIT_LEAD,
  overloaded: 'the Claude API is overloaded — resume this run shortly',
  billing_error:
    'a Claude billing problem stopped the agent before it finished',
  authentication_failed:
    'Claude authentication failed before the agent finished — sign in again and resume this run',
};

// The plain text of an assistant message — where the SDK's synthetic
// API-error messages carry their human-readable explanation.
function assistantText(content: unknown): string {
  return (content as AssistantContentBlock[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();
}

// Replaces the generic API/model-error truncation message with the specific
// reason the SDK's last API-error assistant message reported, when there was one.
function withApiErrorDetail(
  truncation: string,
  message: SDKResultMessage,
  apiError: ApiErrorNote | undefined
): string {
  const reason = (message as { terminal_reason?: string }).terminal_reason;
  if (
    apiError === undefined ||
    (reason !== 'api_error' && reason !== 'model_error')
  ) {
    return truncation;
  }
  const lead = API_ERROR_MESSAGES[apiError.kind] ?? truncation;
  return apiError.text === '' ? lead : `${lead} (${apiError.text})`;
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
function finishFromResult(
  message: SDKResultMessage,
  apiError?: ApiErrorNote
): {
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
      return {
        state: 'failed',
        ...base,
        error: withApiErrorDetail(truncation, message, apiError),
      };
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

// The last of finishFromResult's sibling guards: downgrades a `finished`
// result that did no work at all to `failed`. A resume onto an expired or
// terminal session id makes the CLI start, find nothing to continue, and exit
// *cleanly* — `subtype: 'success'`, `terminal_reason: 'completed'`,
// `num_turns: 0`, zero assistant messages — so every check above passes and
// the run read as a successful finish while the requested work was silently
// never started (t-ed735b: runs r-297e7b, r-3b5a48; both resumed sessions
// predating a daemon restart). Two independent signals, either one fails the
// run: an explicit zero turn count, and the stream having carried no
// assistant output at all (which also covers a hypothetical resumed session
// reporting *cumulative* turns). An absent `num_turns` is "no opinion" —
// same back-compat convention as reasonForTruncation's absent
// `terminal_reason`. Accounting and sessionId are preserved, so a failed
// no-op resume can simply be re-driven with another follow-up message.
function guardZeroTurnFinish(
  finish: ReturnType<typeof finishFromResult>,
  info: { sawAssistantOutput: boolean; resumed: boolean }
): ReturnType<typeof finishFromResult> {
  if (finish.state !== 'finished') return finish;
  const zeroTurns = finish.turns === 0;
  if (!zeroTurns && info.sawAssistantOutput) return finish;
  return {
    ...finish,
    state: 'failed',
    error: info.resumed
      ? 'agent session ended without executing a turn — the resumed session ' +
        'was not continued (it may have expired or predate a daemon ' +
        'restart), so the requested work was not done; send the follow-up ' +
        'again to retry on a fresh resume'
      : 'agent session ended without executing a turn — no work was done',
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
    // Set before every onFinish call, so notify() drops a note that arrives
    // after the run ended instead of leaving it in pendingNotes forever.
    let finished = false;
    // Set by requestStop(); read by canUseTool below. See STOP_DENIAL_MESSAGE.
    let stopRequested = false;
    // Tools the user said "always, for this run" about. Session-scoped by construction: this
    // Set lives inside start(), so it dies with the run rather than leaking a permission grant
    // into the next one — which is the property that makes approve-for-session safe to offer
    // at all.
    const sessionAllowed = new Set<string>();
    // Digests waiting for the agent's next tool result (see notify below).
    const pendingNotes: string[] = [];
    const postToolUse: HookCallback = async () => {
      if (pendingNotes.length === 0) return {};
      const additionalContext = pendingNotes.splice(0).join('\n');
      return {
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext },
      };
    };

    const canUseTool: CanUseTool = async (toolName, input, callOpts) => {
      if (interrupted) {
        return { behavior: 'deny', message: 'run cancelled' };
      }
      // Ahead of every allow branch below, including the `acceptEdits`
      // auto-allow: after a stop, "the agent may edit files without asking"
      // must not become "the agent keeps editing files".
      if (stopRequested) {
        return { behavior: 'deny', message: STOP_DENIAL_MESSAGE };
      }
      // The irreversibility floor: a force-push, npm publish, or
      // repo-visibility change always raises the approval flow below — ahead
      // of every allow branch, so neither an acceptEdits auto-allow nor an
      // earlier "approve Bash for this session" lets one through. Each
      // irreversible act gets its own human decision, at every policy rung.
      const floorHold = floorCheckForToolInput(input);
      if (floorHold === null) {
        if (
          opts.permissionMode === 'acceptEdits' &&
          (AUTO_ALLOWED_EDIT_TOOLS.has(toolName) || toolName === ASK_USER_TOOL)
        ) {
          return { behavior: 'allow', updatedInput: input };
        }
        if (sessionAllowed.has(toolName)) {
          return { behavior: 'allow', updatedInput: input };
        }
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
      hooks: { PostToolUse: [{ hooks: [postToolUse] }] },
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
        dispatch: toSdkMcp(
          dispatchMcpSpec(
            opts.cwd,
            opts.projectRoot ?? opts.cwd,
            opts.runId ?? '',
            opts.runTokenFile
          )
        ),
        ...cartoMcpServers(opts.projectRoot ?? opts.cwd),
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
      // The latest SDK assistant message that carried an API error (`error:
      // 'rate_limit'` and friends), so the terminal result can name the real
      // reason the run stopped — see withApiErrorDetail.
      let lastApiError: ApiErrorNote | undefined;
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
      // Whether ANY assistant message arrived on this run's own stream —
      // one input to guardZeroTurnFinish's did-anything-actually-happen
      // check when the terminal result claims success.
      let sawAssistantOutput = false;
      // Correlates the SDK's sub-agent signals (spawn tool calls, task
      // lifecycle messages, tool results) into `agent` entries — see the
      // tracker's own doc comment for why one object has to see all three.
      const subagents = new SubagentTracker();
      try {
        for await (const message of sdkQuery) {
          if (interrupted) break;
          if (message.type === 'assistant') {
            sawAssistantOutput = true;
            if (message.error !== undefined) {
              lastApiError = {
                kind: message.error,
                text: assistantText(message.message.content),
              };
            }
            const ts = new Date().toISOString();
            for (const entry of entriesForAssistantContent(
              message.message.content,
              ts,
              subagents,
              message.parent_tool_use_id ?? undefined
            )) {
              events.onEntry(entry);
            }
          } else if (message.type === 'user') {
            const ts = new Date().toISOString();
            for (const entry of entriesForUserContent(message, ts, subagents)) {
              events.onEntry(entry);
            }
          } else if (message.type === 'system') {
            const lifecycle = subagents.onSystem(
              message,
              new Date().toISOString()
            );
            if (lifecycle !== null) events.onEntry(lifecycle);
            if (message.session_id !== sessionId) {
              // A resume that did not reattach: the SDK keeps a plain
              // `resume` on the SAME session id (only `forkSession` mints a
              // new one), so a different id here means the agent underneath
              // this run has none of the conversation the run continues.
              // Failed loudly, before a single entry of the stray session
              // is streamed as this run's work and before its id is ever
              // reported as this run's handle — recording it would make the
              // next resume continue the wrong conversation.
              if (
                sessionId === undefined &&
                opts.resumeSessionId !== undefined &&
                message.session_id !== opts.resumeSessionId
              ) {
                gotResult = true;
                finished = true;
                events.onFinish({
                  state: 'failed',
                  error: `resume could not reattach session ${opts.resumeSessionId}: the agent opened a different session (${message.session_id}), so it has none of the conversation this run continues`,
                });
                break;
              }
              sessionId = message.session_id;
              // Handed up now, not just carried to onFinish below — a daemon
              // that dies mid-run never reaches a finish.
              events.onSession?.(sessionId);
            }
          } else if (message.type === 'result') {
            gotResult = true;
            if (!interrupted) {
              finished = true;
              events.onFinish(
                guardZeroTurnFinish(finishFromResult(message, lastApiError), {
                  sawAssistantOutput,
                  resumed: opts.resumeSessionId !== undefined,
                })
              );
            }
            break;
          }
        }
        if (!gotResult && !interrupted) {
          finished = true;
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
          finished = true;
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
      requestStop(): void {
        stopRequested = true;
        // A run parked on an approval request is waiting on a human who has
        // just answered "stop" instead. Resolving it as a denial carrying the
        // wind-down instruction both unblocks the session and tells the model
        // why, in the one channel the SDK gives us. The session is deliberately
        // NOT interrupted and the input queue is left open — the agent still
        // owes us a closing turn and its `result` message.
        for (const resolve of pendingApprovals.values()) {
          resolve({ allow: false, reason: STOP_DENIAL_MESSAGE });
        }
        pendingApprovals.clear();
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
      notify(text: string): void {
        if (finished) return;
        pendingNotes.push(text);
      },
    };
  }
}
