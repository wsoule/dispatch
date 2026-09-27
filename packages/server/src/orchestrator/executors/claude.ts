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
import { DISPATCH_MESSAGING_TOOLS } from '@dispatch/core';
import type { CartoBinary } from '@dispatch/core/carto';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import { floorCheckForToolInput } from '../../floor.js';
import {
  claudeMemorySettings,
  compareVersions,
  mergeFlagSettings,
} from '../../memory/claudeModes.js';
import { openClaudeQuery, rewriteMissingCliError } from '../claudeCli.js';
import type { StdioServerSpec } from '../dispatchMcp.js';
import { cartoMcpSpec, cartoSpecFor, dispatchMcpSpec } from '../dispatchMcp.js';
import { activeExperiments } from '../experiments.js';
import type { ExperimentName } from '../experiments.js';
import { floorGuard } from '../floorHook.js';
import type { FloorPolicy } from '../floorHook.js';
import type {
  ApprovalDecision,
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
  NormalizedEntry,
} from '../types.js';
import { ClaudeUsageMeter } from './claudeUsage.js';
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

// Auto-allowed with the edit tools under `acceptEdits`: gating them would make
// the user approve a question before seeing it.
const MESSAGING_TOOLS: ReadonlySet<string> = new Set(
  DISPATCH_MESSAGING_TOOLS.map((tool) => `mcp__dispatch__${tool}`)
);

// Read-only memory lookups; gating them would make the human approve a search.
export const MEMORY_TOOLS: ReadonlySet<string> = new Set(
  ['memory_search', 'memory_read'].map((tool) => `mcp__dispatch__${tool}`)
);

// Claude Code tools that cannot do their job inside a dispatched run, removed
// from the agent's tool list. Each was exercised through this executor
// against the bundled CLI (SDK 0.3.207) and its result recorded:
//
// - AskUserQuestion: the answers come from the CLI's interactive picker,
//   which a dispatched run does not have; even after a human approves the
//   call, the agent is told "The user did not answer the questions."
//   `mcp__dispatch__msg_send` is the channel that reaches the human.
// - CronCreate / CronDelete / CronList / ScheduleWakeup: they schedule
//   prompts into a session that outlives the current turn. A dispatched run
//   ends at its result, so a cron job "dies when Claude exits" and a wakeup
//   is refused outright ("Wakeup not scheduled").
// - EnterWorktree / ExitWorktree: the run already lives in the worktree
//   Dispatch created for it. EnterWorktree made a second worktree under the
//   main checkout's `.claude/worktrees/` and moved the session there, so the
//   agent's edits would land outside the branch Dispatch reviews and merges.
//
// Each tool definition is resent on every request, so dropping these also
// removes about 20 KB of tool schema from every turn's prompt prefix.
// `disallowedTools` is honored under every permission mode, including
// `bypassPermissions`.
export const UNUSABLE_IN_DISPATCHED_RUN = [
  'AskUserQuestion',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'EnterWorktree',
  'ExitWorktree',
] as const;

// The `lean-tools` experiment's further exclusions: tools that work in a
// dispatched run but that few runs need, each resent in every request's
// prompt prefix. Kept behind the experiment until run telemetry shows that
// dropping them does not cost completed tasks.
//
// - Workflow: multi-agent orchestration; its own description reserves it for
//   an explicit opt-in a task brief rarely carries. About 21.5 KB of schema,
//   by far the largest tool definition.
// - EnterPlanMode / ExitPlanMode: a plan-then-approve loop; a dispatched run
//   already starts from a brief, and ExitPlanMode parks on a human approval.
// - ReportFindings: the reporting channel of the code-review skill.
// - NotebookEdit: Jupyter notebooks only.
// - ListMcpResourcesTool / ReadMcpResourceTool / ReadMcpResourceDirTool: the
//   dispatch MCP server's one resource is an onboarding brief the task prompt
//   already covers.
export const LEAN_TOOL_EXCLUSIONS = [
  'Workflow',
  'EnterPlanMode',
  'ExitPlanMode',
  'ReportFindings',
  'NotebookEdit',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'ReadMcpResourceDirTool',
] as const;

// The SDK options each active experiment changes. `env` replaces the CLI's
// environment wholesale rather than merging into it (sdk.d.ts), which is why
// it starts from process.env.
function experimentOptions(
  experiments: readonly ExperimentName[]
): Pick<Options, 'disallowedTools' | 'env'> {
  const disallowed: string[] = [...UNUSABLE_IN_DISPATCHED_RUN];
  if (experiments.includes('lean-tools')) {
    disallowed.push(...LEAN_TOOL_EXCLUSIONS);
  }
  return {
    disallowedTools: disallowed,
    ...(experiments.includes('cache-1h')
      ? { env: { ...process.env, ENABLE_PROMPT_CACHING_1H: '1' } }
      : {}),
  };
}

/**
 * What a tool call is refused with once the user has asked this run to stop.
 *
 * A graceful stop's lever against a live Agent SDK session is the gate every
 * tool call passes before it runs: the PreToolUse hook (floorGuard's
 * `refusal`), which fires in every permission mode, and `canUseTool` behind
 * it. Whatever the agent is doing at the moment Stop is pressed has already
 * been through that gate, so it runs to completion untouched; every NEXT tool
 * call is refused with this text, which the SDK hands back to the model as the
 * tool result. The wording is an instruction rather than a bare
 * refusal for the same reason a human denial's `reason` is passed through: the
 * model reads it, writes its closing summary, and ends the turn, which produces
 * an ordinary `result` message and therefore an ordinary `onFinish` — the run
 * finishes rather than being killed, so the orchestrator still auto-commits its
 * work. A model that ignores this and keeps calling tools is caught by
 * Orchestrator.requestStop's escalation timer, not here.
 */
// What a call is refused with once the session's result has arrived: the run
// is over, so nothing still pending can be approved.
const RUN_ENDED_DENIAL =
  'The run ended before a human decided on this call, so it was not run.';

// How long windDown waits for the CLI to confirm it stopped the background
// tasks and took the deny rules, and then lets it take in the answers it was
// just sent, before the query is closed.
const WIND_DOWN_STOP_MS = 5_000;
const WIND_DOWN_FLUSH_MS = 250;

// The deny rules applied once a run has ended. Nothing needs a tool after
// the result, so `*` denies every tool: the CLI glob-matches deny rules
// against tool names, and a named list kept missing tools that only some
// sessions have. Monitor, which runs a shell command and is switched on by a
// server-side feature flag, ran a force-push after the result until `*` was
// here; so did a user-scope MCP server's shell tool. The named rules behind
// it (commands, file changes, new work, every MCP server's tools, and the MCP
// resource tools, which reach any connected server) still hold on a CLI that
// does not glob-match.
const RUN_ENDED_DENY_RULES = [
  '*',
  'Bash',
  'PowerShell',
  'Monitor',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Agent',
  'Task',
  'SendMessage',
  'Skill',
  'Workflow',
  'mcp__*',
  'mcp__dispatch',
  'mcp__carto',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'ReadMcpResourceDirTool',
] as const;

// Resolves when `work` settles or after `ms`, whichever comes first.
function withinMs(ms: number, work: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    work,
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
}

export const STOP_DENIAL_MESSAGE =
  'The user asked this run to stop. Do not start any new tool calls. ' +
  'Summarize what you completed and what is left unfinished, then end your turn.';

// What every tool call is refused with while an export-mode session waits to
// confirm Claude Code loaded Dispatch's MEMORY.md.
const MEMORY_PENDING_DENIAL =
  "memory setup pending: Dispatch is confirming this session's memory loaded. Try the call again.";

// How long the load check waits for the CLI to list the memory files it loaded.
const MEMORY_CHECK_MS = 30_000;

// The `memoryFiles` types of CLAUDE.md files in the bundled CLI (2.1.207). Any
// other type outside the export, such as `AutoMem`, counts as native memory.
const CLAUDE_MD_FILE_TYPES: ReadonlySet<string> = new Set([
  'User',
  'Project',
  'Local',
  'Managed',
]);

// Whether `path` names something inside `dir`.
function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

// The memory files the CLI says it loaded, bounded so a CLI that never answers
// cannot hold every tool of the session forever.
async function loadedMemoryFiles(
  sdkQuery: Query
): Promise<{ path: string; type: string }[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no answer within ${MEMORY_CHECK_MS / 1000}s`));
    }, MEMORY_CHECK_MS);
  });
  try {
    return (await Promise.race([sdkQuery.getContextUsage(), timeout]))
      .memoryFiles;
  } finally {
    clearTimeout(timer);
  }
}

type LoadCheck =
  | { outcome: 'loaded' }
  | { outcome: 'fallback' | 'unloaded'; detail: string };

// Whether a loaded memory file may be native auto memory: outside the export,
// and either of a type other than CLAUDE.md's or named MEMORY.md.
function isNativeMemory(
  file: { path: string; type: string },
  dir: string
): boolean {
  return (
    !isInside(file.path, dir) &&
    (!CLAUDE_MD_FILE_TYPES.has(file.type) ||
      basename(file.path) === 'MEMORY.md')
  );
}

// Export mode's load check: possible native notes, a CLI that cannot list its
// files or one older than the probe restart the session; else loaded or not.
async function checkExportLoaded(
  sdkQuery: Query,
  dir: string,
  probeVersion: string,
  version: string
): Promise<LoadCheck> {
  let files: { path: string; type: string }[];
  try {
    files = await loadedMemoryFiles(sdkQuery);
  } catch (err) {
    return {
      outcome: 'fallback',
      detail: `Claude Code ${version} could not list the memory files it loaded: ${(err as Error).message}`,
    };
  }
  const native = files.find((f) => isNativeMemory(f, dir));
  if (native !== undefined) {
    return {
      outcome: 'fallback',
      detail: `Claude Code ${version} loaded ${native.path} instead of the export`,
    };
  }
  if (compareVersions(version, probeVersion) < 0) {
    return {
      outcome: 'fallback',
      detail: `Claude Code ${version} is older than the probed ${probeVersion}`,
    };
  }
  const exported = resolve(dir, 'MEMORY.md');
  if (!files.some((f) => resolve(f.path) === exported)) {
    return {
      outcome: 'unloaded',
      detail: `Claude Code ${version} loaded no MEMORY.md`,
    };
  }
  return { outcome: 'loaded' };
}

// The fresh prompt-mode session for a failed export check, plus a resumed run's
// own prompt to send next; null when a resume has no fallback prompt.
function fallbackStart(
  opts: ExecutorStartOptions
): { next: ExecutorStartOptions; continuation: string[] } | null {
  const fallbackPrompt = opts.memory?.fallbackPrompt;
  const resumed = opts.resumeSessionId !== undefined;
  if (resumed && fallbackPrompt === undefined) return null;
  const next: ExecutorStartOptions = {
    ...opts,
    prompt: fallbackPrompt ?? opts.prompt,
    memory: { mode: 'prompt' },
  };
  delete next.resumeSessionId;
  return { next, continuation: resumed ? [opts.prompt] : [] };
}

// The file a Read tool call read, from a PostToolUse hook's input.
function readFilePath(input: {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
}): string | null {
  if (input.hook_event_name !== 'PostToolUse' || input.tool_name !== 'Read') {
    return null;
  }
  const toolInput = input.tool_input as
    | { file_path?: unknown }
    | null
    | undefined;
  const path = toolInput?.file_path;
  return typeof path === 'string' ? path : null;
}

// What a session hands the session that replaces it: the follow-ups and notes
// that arrived while its load check ran.
interface CarriedInput {
  sent: string[];
  notes: string[];
}

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
  //
  // `experiments` is read once per run; tests pin it rather than depend on the
  // daemon's DISPATCH_EXPERIMENTS.
  constructor(
    private readonly queryFn: typeof query = query,
    private readonly experiments: () => ExperimentName[] = activeExperiments
  ) {}

  // Opens the SDK query, resolving the Claude Code CLI the SDK spawns
  // robustly via the shared openClaudeQuery() (see claudeCli.ts for the exact
  // fallback chain and doc comment) — the exact failure this guards against
  // used to escape as an opaque 500 and leave a run stuck 'running'. The
  // orchestrator's startAndRegister catches this throw and marks the run
  // failed carrying exactly that text, which the UI surfaces on the run
  // instead of hanging on 'running'.
  private openQuery(prompt: MessageQueue, options: Options): Query {
    return openClaudeQuery(this.queryFn, prompt, options, {
      memory: 'managed',
    });
  }

  // Hands back a handle that follows the run's live session: export mode's
  // load check can replace the first session with a prompt-mode one.
  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    let stopRequested = false;
    const restart = (
      next: ExecutorStartOptions,
      carried: CarriedInput
    ): void => {
      current = this.runSession(next, events, restart);
      for (const text of carried.sent) current.send(text);
      for (const note of carried.notes) current.notify(note);
      if (stopRequested) current.requestStop();
    };
    let current = this.runSession(opts, events, restart);
    return {
      interrupt: () => current.interrupt(),
      requestStop: () => {
        stopRequested = true;
        current.requestStop();
      },
      send: (message) => current.send(message),
      approve: (requestId, decision) => current.approve(requestId, decision),
      notify: (text) => current.notify(text),
    };
  }

  // One Agent SDK session of a run. `restart` replaces it with a prompt-mode
  // session when export mode's load check fails.
  private runSession(
    opts: ExecutorStartOptions,
    events: ExecutorEvents,
    restart: (next: ExecutorStartOptions, carried: CarriedInput) => void
  ): ExecutorRun {
    const pendingApprovals = new Map<string, ApprovalResolver>();
    let interrupted = false;
    // Set before every onFinish call, so notify() drops a note that arrives
    // after the run ended instead of leaving it in pendingNotes forever.
    let finished = false;
    // Set by requestStop(); read by canUseTool and the PreToolUse hook below.
    // See STOP_DENIAL_MESSAGE.
    let stopRequested = false;
    // Set once the session's result has arrived and the run is winding down
    // (see windDown below): nothing may be approved any more.
    let ending = false;
    // Tools the user said "always, for this run" about. Session-scoped by construction: this
    // Set lives inside runSession(), so it dies with the run rather than leaking a permission
    // grant into the next one — which is the property that makes approve-for-session safe to
    // offer at all.
    const sessionAllowed = new Set<string>();
    // Digests waiting for the agent's next tool result (see notify below).
    const pendingNotes: string[] = [];
    const mem = opts.memory;
    const memorySettings = claudeMemorySettings(
      mem?.mode ?? 'native',
      mem?.dir
    );
    // The export directory, in export mode only (claudeMemorySettings refuses
    // export without an absolute one).
    const exportDir = mem?.mode === 'export' ? (mem.dir ?? null) : null;
    // Export mode refuses every tool until Claude confirms it loaded Dispatch's
    // MEMORY.md; the loop reads no message past init until then.
    let memoryPending = exportDir !== null;
    const sentWhilePending: string[] = [];
    const postToolUse: HookCallback = (input) => {
      if (exportDir !== null) {
        const read = readFilePath(input);
        if (read !== null && isInside(read, exportDir)) {
          events.onMemoryRecall?.([read], 'read');
        }
      }
      if (pendingNotes.length === 0) return Promise.resolve({});
      const additionalContext = pendingNotes.splice(0).join('\n');
      return Promise.resolve({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext },
      });
    };

    // Raises the orchestrator's approval flow for one call and waits for
    // approve() — or for interrupt()/requestStop(), which answer every
    // pending request themselves.
    const askHuman = (
      requestId: string,
      toolName: string,
      input: unknown
    ): Promise<ApprovalDecision> => {
      events.onApprovalRequest({ requestId, toolName, input });
      return new Promise<ApprovalDecision>((resolve) => {
        pendingApprovals.set(requestId, resolve);
      });
    };

    // How the PreToolUse hook holds an irreversible call (see floorGuard):
    // through the same approval flow, with no session-wide grant, since each
    // irreversible act gets its own human decision.
    // Floor calls the human already approved in the PreToolUse hook, by
    // tool-use id, with the input they approved. The CLI can still send such a
    // call on to canUseTool (a settings ask rule, one of its safety checks, or
    // another hook's "ask"), which must not ask the human a second time.
    const approvedInHook = new Map<string, string>();

    const holdForHuman: FloorPolicy = async ({
      requestId,
      toolUseId,
      toolName,
      input,
    }) => {
      if (interrupted) return { allow: false, reason: 'run cancelled' };
      if (ending) return { allow: false, reason: RUN_ENDED_DENIAL };
      const decision = await askHuman(requestId, toolName, input);
      if (decision.allow) {
        approvedInHook.set(toolUseId, JSON.stringify(input));
        // Safe to honour: sessionAllowed is never consulted for a floor call.
        if (decision.scope === 'session') sessionAllowed.add(toolName);
      }
      return { allow: decision.allow, reason: decision.reason };
    };

    const canUseTool: CanUseTool = async (toolName, input, callOpts) => {
      if (interrupted) {
        return { behavior: 'deny', message: 'run cancelled' };
      }
      if (ending) {
        return { behavior: 'deny', message: RUN_ENDED_DENIAL };
      }
      // Ahead of every allow branch below, including the `acceptEdits`
      // auto-allow: after a stop, "the agent may edit files without asking"
      // must not become "the agent keeps editing files".
      if (stopRequested) {
        return { behavior: 'deny', message: STOP_DENIAL_MESSAGE };
      }
      if (memoryPending) {
        return { behavior: 'deny', message: MEMORY_PENDING_DENIAL };
      }
      // The irreversibility floor: a force-push, npm publish, or
      // repo-visibility change always raises the approval flow below — ahead
      // of every allow branch, so neither an acceptEdits auto-allow nor an
      // earlier "approve Bash for this session" lets one through. Each
      // irreversible act gets its own human decision, at every policy rung.
      const floorHold = floorCheckForToolInput(input);
      if (
        floorHold !== null &&
        approvedInHook.get(callOpts.toolUseID) === JSON.stringify(input)
      ) {
        approvedInHook.delete(callOpts.toolUseID);
        return { behavior: 'allow', updatedInput: input };
      }
      if (floorHold === null) {
        if (
          opts.permissionMode === 'acceptEdits' &&
          (AUTO_ALLOWED_EDIT_TOOLS.has(toolName) ||
            MESSAGING_TOOLS.has(toolName) ||
            MEMORY_TOOLS.has(toolName))
        ) {
          return { behavior: 'allow', updatedInput: input };
        }
        if (sessionAllowed.has(toolName)) {
          return { behavior: 'allow', updatedInput: input };
        }
      }
      const decision = await askHuman(callOpts.requestId, toolName, input);
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
    const experiments = this.experiments();
    // Only stamped on runs that ran under at least one, so a default run's
    // finish keeps exactly the shape it had before experiments existed.
    const experimentStamp = experiments.length > 0 ? { experiments } : {};
    // Holds every irreversible call for a human in the PreToolUse hook
    // itself, and after a stop denies every call outright. canUseTool alone
    // is not enough: the CLI skips it under bypassPermissions, on a
    // matching settings allow rule, or when the auto-mode classifier
    // approves, and a settings PermissionRequest hook can answer before it
    // — see floorGuard.
    const floor = floorGuard(holdForHuman, () =>
      stopRequested
        ? STOP_DENIAL_MESSAGE
        : ending
          ? RUN_ENDED_DENIAL
          : memoryPending
            ? MEMORY_PENDING_DENIAL
            : null
    );
    const sdkOptions: Options = {
      cwd: opts.cwd,
      permissionMode: opts.permissionMode as PermissionMode,
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      model: opts.model,
      effort: opts.effort,
      resume: opts.resumeSessionId,
      canUseTool,
      // The memory mode's settings sit beside the floor's in the flag layer,
      // both env pins kept.
      settings: mergeFlagSettings(
        floor.settings as Record<string, unknown>,
        memorySettings.settings
      ) as Options['settings'],
      ...(memorySettings.additionalDirectories.length > 0
        ? { additionalDirectories: memorySettings.additionalDirectories }
        : {}),
      // The floor's PreToolUse hook, plus the PostToolUse hook that hands the
      // agent queued notes and reports its reads of exported memory files.
      hooks: { ...floor.hooks, PostToolUse: [{ hooks: [postToolUse] }] },
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
      ...experimentOptions(experiments),
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

    // Makes the session's end final before the query closes. The run ends at
    // its result, but the CLI does not stop there: background sub-agents keep
    // working, and a background task that finishes or is stopped queues a
    // notification that starts a fresh main-agent turn. Once the query is
    // closed nobody can answer the floor hook, and the CLI treats an
    // unanswered hook as no decision, so under bypassPermissions a floor
    // command in any of that later work ran (each case reproduced through this
    // executor against the bundled CLI). So, on every result:
    //
    // - `ending` makes the hook refuse every call while the query is still
    //   attached, and refuse any hold outright;
    // - pending holds are answered with a refusal;
    // - live background tasks are stopped;
    // - flag-layer deny rules for every tool that can run a command or change
    //   files are applied, so the CLI refuses those calls by itself once
    //   nothing can answer it. Deny rules held under bypassPermissions and
    //   over a hook's allow;
    // - the CLI gets a moment to take those answers in.
    //
    // Each step's wait is bounded, so an unresponsive CLI cannot keep the run
    // from finishing. A step that fails is logged with the CLI's version: the
    // run still finishes, but without what that step guarantees, and an older
    // Claude Code (a packaged app runs the `claude` on PATH) that lacks the
    // control request is the likely cause. A step still pending when the query
    // closes fails too; that is logged unless the run was cancelled, since a
    // cancel closes the query on purpose.
    const windDown = async (
      liveTasks: readonly string[],
      cliVersion: string | undefined
    ): Promise<void> => {
      ending = true;
      events.onEnding?.();
      const answeredHolds = pendingApprovals.size > 0;
      for (const resolve of pendingApprovals.values()) {
        resolve({ allow: false, reason: RUN_ENDED_DENIAL });
      }
      pendingApprovals.clear();
      const cli = `Claude Code ${cliVersion ?? '(version unknown)'}`;
      const warn =
        (consequence: string) =>
        (err: unknown): void => {
          if (interrupted) return;
          console.error(
            `dispatchd: run ${opts.runId ?? '(no id)'}: ${cli} did not complete a step of ending the run, so ${consequence}: ${(err as Error).message}`
          );
        };
      // Each SDK call is started inside a promise, so one that throws at
      // once still leaves the others running and the run still finishes.
      await withinMs(
        WIND_DOWN_STOP_MS,
        Promise.allSettled([
          ...liveTasks.map((taskId) =>
            Promise.resolve()
              .then(() => sdkQuery.stopTask(taskId))
              .catch(
                warn(
                  `background task ${taskId} kept running until the CLI exited`
                )
              )
          ),
          Promise.resolve()
            .then(() =>
              sdkQuery.applyFlagSettings({
                permissions: { deny: [...RUN_ENDED_DENY_RULES] },
              })
            )
            .catch(
              warn(
                'tool calls it starts after the result are not refused by a deny rule'
              )
            ),
        ])
      );
      // Awaiting applyFlagSettings confirms the rules; the answers to holds
      // and the stop requests are only written, so give the CLI a moment.
      if (answeredHolds || liveTasks.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, WIND_DOWN_FLUSH_MS));
      }
    };

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
      // The session's live background tasks (background_tasks_changed
      // carries the whole set each time), so windDown can stop them.
      let backgroundTasks: string[] = [];
      // The CLI's version, from the init message, for windDown's warnings.
      let cliVersion: string | undefined;
      // Token usage by billing type — see ClaudeUsageMeter for why it reads
      // both the streamed messages and the terminal result.
      const usageMeter = new ClaudeUsageMeter();
      try {
        for await (const message of sdkQuery) {
          if (interrupted) break;
          if (message.type === 'assistant') {
            sawAssistantOutput = true;
            usageMeter.onAssistant(message);
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
            if (message.subtype === 'background_tasks_changed') {
              backgroundTasks = message.tasks.map((task) => task.task_id);
            } else if (
              message.subtype === 'memory_recall' &&
              exportDir !== null
            ) {
              const paths = message.memories.map((memory) => memory.path);
              const recalled = paths.filter((path) =>
                isInside(path, exportDir)
              );
              if (recalled.length > 0) {
                events.onMemoryRecall?.(recalled, 'claude-recall');
              }
              // A synthesis sentinel or an organization URL names no exported file.
              const unmapped = paths.filter(
                (path) => !isInside(path, exportDir)
              );
              if (unmapped.length > 0) {
                console.error(
                  `dispatchd: run ${opts.runId ?? '(no id)'}: ignored memory_recall paths outside the export: ${unmapped.join(', ')}`
                );
              }
            } else if (message.subtype === 'init') {
              cliVersion = message.claude_code_version;
              if (memoryPending && exportDir !== null) {
                const check = await checkExportLoaded(
                  sdkQuery,
                  exportDir,
                  mem?.probeVersion ?? '0.0.0',
                  message.claude_code_version
                );
                if (interrupted) break;
                if (check.outcome === 'fallback') {
                  // Claude may hold the native notes (its system prompt can
                  // name that directory), so this session ends before any tool.
                  sdkQuery.close();
                  const fresh = fallbackStart(opts);
                  if (fresh === null) {
                    finished = true;
                    events.onFinish({
                      state: 'failed',
                      error: `${check.detail}; the resumed run has no fallback prompt to start a fresh session from`,
                      usage: usageMeter.fromStream(),
                      ...experimentStamp,
                    });
                    return;
                  }
                  events.onMemoryMode?.(
                    'export-fallback',
                    opts.resumeSessionId === undefined
                      ? check.detail
                      : `${check.detail}; the run starts a fresh session instead of continuing ${opts.resumeSessionId}`
                  );
                  restart(fresh.next, {
                    sent: [
                      ...fresh.continuation,
                      ...sentWhilePending.splice(0),
                    ],
                    notes: pendingNotes.splice(0),
                  });
                  return;
                }
                memoryPending = false;
                if (check.outcome === 'unloaded') {
                  const note = mem?.unloadedNote;
                  if (note !== undefined && note !== '') {
                    pendingNotes.push(note);
                  }
                  events.onMemoryMode?.('export-unloaded', check.detail);
                }
              }
            }
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
            await windDown(backgroundTasks, cliVersion);
            if (!interrupted) {
              finished = true;
              events.onFinish({
                ...guardZeroTurnFinish(
                  finishFromResult(message, lastApiError),
                  {
                    sawAssistantOutput,
                    resumed: opts.resumeSessionId !== undefined,
                  }
                ),
                usage: usageMeter.fromResult(message),
                ...experimentStamp,
              });
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
            usage: usageMeter.fromStream(),
            ...experimentStamp,
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
            usage: usageMeter.fromStream(),
            ...experimentStamp,
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
        if (memoryPending) sentWhilePending.push(message);
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
        // Once the result arrived no further tool result can carry a note.
        if (finished || ending) return;
        pendingNotes.push(text);
      },
    };
  }
}
