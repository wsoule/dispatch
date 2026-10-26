import {
  createSdkMcpServer,
  query,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AnyZodRawShape,
  Options,
  PermissionMode,
  Query,
  SdkMcpToolDefinition,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { agentEnv } from '@dispatch-foo/core';
import { readFileSync, statSync } from 'node:fs';
import type { z } from 'zod';

import { openClaudeQuery, rewriteMissingCliError } from '../claudeCli.js';
import {
  apiMessageId,
  type ClaudeStreamEvent,
  ClaudeTextSegments,
} from '../claudeTextSegments.js';
import { cartoMcpServers } from '../executors/claude.js';
import { floorGuard } from '../floorHook.js';
import type { FloorPolicy } from '../floorHook.js';
import type {
  OverseerBackend,
  OverseerCommand,
  OverseerToolDescriptor,
  OverseerToolset,
  OverseerTurn,
  OverseerTurnAttachment,
  OverseerTurnOptions,
} from '../overseerBackend.js';
import { toolDescriptionForModel } from '../overseerBackend.js';
import { overseerHoldFor } from '../overseerHold.js';
import {
  EMPTY_REPLY_MESSAGE,
  overseerInstructions,
} from '../overseerPrompt.js';

// The in-process MCP server every overseer tool is exposed through, and the
// prefix the model therefore sees on each name (`mcp__<server>__<tool>`).
// Exported because `allowedTools`, the canUseTool gate and the transcript
// filter below all key off it, and the wiring test asserts on it.
const SERVER_NAME = 'overseer';
export const OVERSEER_TOOL_PREFIX = `mcp__${SERVER_NAME}__`;

// The subset of Anthropic content-block fields the transcript needs: an
// assistant message's `tool_use` blocks name the built-in calls the model is
// about to make. Same narrow local shape the executor uses, for the same
// reason (no `@anthropic-ai/sdk` type import for two field names).
interface AssistantContentBlock {
  type: string;
  name?: string;
  input?: unknown;
  text?: unknown;
}

/**
 * Follows the text of one turn's top-level messages, one segment per text
 * block (named by ClaudeTextSegments). Its deltas go to `onTextDelta` as they
 * arrive; its finished text waits as *pending* until the turn shows what it
 * was: a tool call after it makes it narration, and what is still pending at
 * the result is the reply. A block whose stream broke off before it finished
 * never becomes pending: it goes to `onSegmentAbandoned`.
 */
class TurnText {
  private readonly segments = new ClaudeTextSegments((id) =>
    this.opts.onSegmentAbandoned?.(id)
  );
  private readonly pending: { id: string; text: string }[] = [];

  constructor(private readonly opts: OverseerTurnOptions) {}

  // One stream event of a top-level message.
  event(event: ClaudeStreamEvent): void {
    const delta = this.segments.event(event);
    if (delta !== null) this.opts.onTextDelta?.(delta.segmentId, delta.text);
  }

  // A top-level assistant message: its text blocks become pending, and a tool
  // call commits whatever was pending before it.
  finished(message: { id?: unknown; content?: unknown }): void {
    if (!Array.isArray(message.content)) return;
    const apiId = apiMessageId(message);
    for (const block of message.content as AssistantContentBlock[]) {
      if (block.type === 'tool_use') {
        this.commit();
        continue;
      }
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      const segment = this.segments.claim(apiId);
      if (block.text.trim() !== '') {
        this.pending.push({ id: segment, text: block.text });
      }
    }
  }

  // Reports everything pending as narration, oldest first: a tool call follows.
  commit(): void {
    for (const segment of this.pending.splice(0)) {
      this.opts.onNarration?.(segment.id, segment.text);
    }
  }

  // At the result, whose text is the reply. What is pending is the reply's own
  // text, except a segment the reply does not contain: that is committed as
  // narration rather than lost. Returns the reply's segment, when one is.
  settle(reply: string): string | undefined {
    let replySegment: string | undefined;
    for (const segment of this.pending.splice(0)) {
      if (reply.includes(segment.text.trim())) replySegment = segment.id;
      else this.opts.onNarration?.(segment.id, segment.text);
    }
    return replySegment;
  }
}

// A sub-agent's messages (a Task the Overseer started) carry the id of the
// tool call that runs it; its text, tool calls and usage are not the
// Overseer's own. Absent counts as top-level.
function isTopLevel(message: { parent_tool_use_id?: string | null }): boolean {
  return (message.parent_tool_use_id ?? null) === null;
}

// Pulls the zod raw shape out of a tool's input schema for `tool()`, which
// takes the field map rather than the assembled object schema. Falls back to
// an empty shape (a tool with no parameters) rather than throwing: the
// registry re-parses every call against the real schema anyway, so the worst
// case of a schema this can't unwrap is a tool the model must call with no
// arguments, not an unvalidated call.
function rawShapeOf(schema: z.ZodType<unknown>): AnyZodRawShape {
  const candidate = schema as unknown as { shape?: AnyZodRawShape };
  return candidate.shape ?? {};
}

/**
 * Wraps every tool in `toolset` as an SDK tool. Each handler routes straight
 * back through `toolset.call` — which is what keeps the "a mutating call only
 * queues" rule in OverseerManager rather than in here, and is why this is
 * exported: it is the one piece of the real backend a test can drive without a
 * live model.
 */
// The explicit annotation keeps the declaration portable — the inferred type
// reaches into zod internals the lockfile's layout can't name. `AnyZodRawShape`
// is the schema parameter the SDK's own `tools` option takes.
export function overseerSdkTools(
  toolset: OverseerToolset
): SdkMcpToolDefinition<AnyZodRawShape>[] {
  return toolset.tools.map((descriptor) => sdkToolFor(descriptor, toolset));
}

function sdkToolFor(
  descriptor: OverseerToolDescriptor,
  toolset: OverseerToolset
) {
  const description = toolDescriptionForModel(descriptor);
  return tool(
    descriptor.name,
    description,
    rawShapeOf(descriptor.inputSchema),
    async (args: unknown) => {
      const result = await toolset.call(descriptor.name, args);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result.content) },
        ],
        isError: result.isError,
      };
    }
  );
}

/**
 * The real overseer backend: a full Claude Code session over the project
 * checkout (the `claude_code` preset, the project's own CLAUDE.md and
 * settings, every built-in tool), plus the overseer tool registry exposed
 * in-process via `createSdkMcpServer` so a registry call lands in this
 * daemon's own objects rather than going out over a stdio MCP transport.
 *
 * Every turn is a discrete `query()`: the opening turn starts a fresh session,
 * each follow-up passes the prior turn's `session_id` as `resume`, so the model
 * keeps its earlier tool results without a process staying alive in between —
 * the same shape ClaudePlanner and ClaudeExecutor use.
 *
 * Two gates, neither of them decided here. A registry tool is auto-allowed
 * because calling it is safe by construction (status tools read, mutating
 * tools only queue). Every other tool — Bash, Edit, a project MCP server —
 * goes through `OverseerTurnOptions.authorizeTool` and runs only when that
 * resolves `allow`; the manager behind it applies the project's permission
 * policy and parks the rest for a human. With no `authorizeTool` at all the
 * session has no one to ask, so built-in calls are refused outright.
 *
 * CI never constructs this against a live model — see FakeOverseer.
 */
export class ClaudeOverseer implements OverseerBackend {
  // Defaults to the real SDK's `query()`; tests inject a stub that yields a
  // scripted SDKMessage stream, mirroring ClaudePlanner's own `queryFn` seam.
  constructor(
    private readonly rootDir: string,
    private readonly queryFn: typeof query = query
  ) {}

  start(
    prompt: string,
    toolset: OverseerToolset,
    options: OverseerTurnOptions = {}
  ): Promise<OverseerTurn> {
    return this.runTurn(prompt, toolset, undefined, options);
  }

  sendMessage(
    sessionId: string | undefined,
    message: string,
    toolset: OverseerToolset,
    options: OverseerTurnOptions = {}
  ): Promise<OverseerTurn> {
    return this.runTurn(message, toolset, sessionId, options);
  }

  private async runTurn(
    prompt: string,
    toolset: OverseerToolset,
    resume: string | undefined,
    opts: OverseerTurnOptions
  ): Promise<OverseerTurn> {
    const allowedTools = toolset.tools.map(
      (t) => `${OVERSEER_TOOL_PREFIX}${t.name}`
    );
    const allowed = new Set(allowedTools);
    const { authorizeTool } = opts;
    // A tool call commits the text before it as narration. The tool_use block
    // normally does that; the gates and the registry commit too, in case the
    // CLI asks about a call before its message is read.
    const text = new TurnText(opts);
    const tools: OverseerToolset = {
      tools: toolset.tools,
      call: (name, input) => {
        text.commit();
        return toolset.call(name, input);
      },
    };
    // Floor calls the human already approved in the PreToolUse hook, by
    // tool-use id, with the input they approved: the CLI can still send such
    // a call on to canUseTool, which must not ask a second time.
    const approvedInHook = new Map<string, string>();
    const holdForHuman: FloorPolicy | 'deny' =
      authorizeTool === undefined
        ? 'deny'
        : async (request) => {
            text.commit();
            const decision = await authorizeTool(request);
            if (decision.allow) {
              approvedInHook.set(
                request.toolUseId,
                JSON.stringify(request.input)
              );
            }
            return decision;
          };
    // Beyond the floor, the Overseer asks before touching Dispatch itself.
    const floor = floorGuard(holdForHuman, undefined, (toolName, input) =>
      overseerHoldFor(toolName, input, this.rootDir)
    );
    const options: Options = {
      cwd: this.rootDir,
      // Pre-approves the registry's own tools; everything else still reaches
      // canUseTool below (under `auto`, only what the SDK's classifier flags).
      allowedTools,
      canUseTool: async (toolName, input, callOpts) => {
        text.commit();
        if (allowed.has(toolName)) {
          return { behavior: 'allow', updatedInput: input };
        }
        if (approvedInHook.get(callOpts.toolUseID) === JSON.stringify(input)) {
          approvedInHook.delete(callOpts.toolUseID);
          return { behavior: 'allow', updatedInput: input };
        }
        if (opts.authorizeTool === undefined) {
          return {
            behavior: 'deny',
            message: `no one is available to allow ${toolName} in this session`,
          };
        }
        const decision = await opts.authorizeTool({
          requestId: callOpts.requestId,
          toolName,
          input,
        });
        if (decision.allow) {
          return { behavior: 'allow', updatedInput: input };
        }
        // The reason travels as the denial message — what the SDK shows the
        // model — so a refusal reaches it as an explanation, not a bare no.
        const reason = decision.reason?.trim();
        return {
          behavior: 'deny',
          message:
            reason !== undefined && reason !== '' ? reason : 'denied by user',
        };
      },
      // Holds every irreversible call for a human in the PreToolUse hook,
      // through the same authorizeTool gate canUseTool uses, since the CLI can
      // skip canUseTool or let a settings PermissionRequest hook answer first
      // (see floorGuard). With no one to ask, the call is refused, as
      // canUseTool refuses it.
      hooks: floor.hooks,
      settings: floor.settings,
      // No background tasks: a sub-agent or shell that outlives the turn keeps
      // running after the query closes, when nothing can answer the floor
      // hook, and under bypassPermissions a background sub-agent's floor
      // command then ran, held or not (reproduced against the bundled CLI).
      // Sub-agents run inside the turn instead, so a held call keeps the turn
      // open until the human answers. `env` replaces the CLI's environment,
      // so it is the daemon's own, less its tokens.
      env: agentEnv({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }),
      mcpServers: {
        [SERVER_NAME]: createSdkMcpServer({
          name: SERVER_NAME,
          version: '1.0.0',
          tools: overseerSdkTools(tools),
        }),
        ...cartoMcpServers(this.rootDir),
      },
      // The same footing as a dispatched run (see ClaudeExecutor): Claude
      // Code's own system prompt, with the overseer's job appended, and this
      // checkout's CLAUDE.md/AGENTS.md and settings loaded — `'project'` is
      // what loads CLAUDE.md at all. Without both this would be a bare SDK
      // session with none of the project's conventions.
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: overseerInstructions('Claude Code'),
      },
      settingSources: ['user', 'project', 'local'],
      // Stream events only when someone shows the text as it is written.
      ...(opts.onTextDelta !== undefined
        ? { includePartialMessages: true }
        : {}),
      ...(opts.permissionMode !== undefined
        ? { permissionMode: opts.permissionMode as PermissionMode }
        : {}),
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.maxBudgetUsd !== undefined
        ? { maxBudgetUsd: opts.maxBudgetUsd }
        : {}),
      ...(resume !== undefined ? { resume } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(opts.abortController !== undefined
        ? { abortController: opts.abortController }
        : {}),
    };

    // Same CLI-resolution chain (DISPATCH_CLAUDE_BIN -> bundled SDK CLI ->
    // PATH `claude` -> install hint) the executor and planner use.
    // Auto memory stays off: others read an overseer transcript too (the
    // operator, every deciding human through the bus and the live text), so
    // the owner's native Claude notes never load here.
    // Attached images go to the model inline, the way a pasted screenshot does
    // in Claude Code; the input stays open until the turn settles (see
    // promptWithImages), so `turnSettled` must resolve however the turn ends.
    let settleTurn = (): void => {};
    const turnSettled = new Promise<void>((resolve) => {
      settleTurn = resolve;
    });
    const images = inlineImages(opts.attachments ?? []);
    const input =
      images.length === 0
        ? prompt
        : promptWithImages(prompt, images, turnSettled);
    let sdkQuery: Query;
    try {
      sdkQuery = openClaudeQuery(this.queryFn, input, options);
    } catch (err) {
      settleTurn();
      throw err;
    }

    // Asked once per turn, alongside it; any failure only means no suggestions.
    const commands = Promise.resolve()
      .then(() => sdkQuery.supportedCommands())
      .catch(() => undefined);
    try {
      let sessionId: string | undefined;
      let contextTokens: number | undefined;
      for await (const message of sdkQuery) {
        if (message.type === 'system') {
          sessionId = message.session_id;
          continue;
        }
        if (message.type === 'stream_event') {
          if (isTopLevel(message)) {
            text.event(message.event as unknown as ClaudeStreamEvent);
          }
          continue;
        }
        if (message.type === 'assistant') {
          if (!isTopLevel(message)) continue;
          // Narration first, so it lands ahead of the tool rows it led to.
          text.finished(message.message);
          reportToolUses(message.message.content, opts.onToolUse);
          contextTokens = contextOf(message.message.usage) ?? contextTokens;
          continue;
        }
        if (message.type !== 'result') continue;
        if (message.subtype !== 'success') {
          throw new Error(`overseer turn failed: ${message.subtype}`);
        }
        // Signed out or rate limited still reports `success`; the reason is the result text.
        if (message.is_error) {
          const detail = message.result.trim();
          throw new Error(detail === '' ? 'overseer turn failed' : detail);
        }
        const reply = message.result.trim();
        const streamId = text.settle(reply);
        return {
          reply: reply === '' ? EMPTY_REPLY_MESSAGE : reply,
          ...(streamId !== undefined ? { streamId } : {}),
          sessionId: message.session_id ?? sessionId,
          costUsd: message.total_cost_usd,
          ...(contextTokens !== undefined ? { contextTokens } : {}),
          ...withCommands(await commands),
        };
      }
      throw new Error('overseer turn produced no result message');
    } catch (err) {
      // The missing-CLI error can surface lazily on the first iteration rather
      // than synchronously from openClaudeQuery — apply the same install-hint
      // rewrite here too. Any other error passes through unchanged.
      throw new Error(rewriteMissingCliError((err as Error).message));
    } finally {
      settleTurn();
    }
  }
}

// The image types the Messages API accepts inline, and its per-image size cap.
// Anything else (a PDF, a log, an oversized shot) stays a path in the prompt
// for the session's Read tool.
const INLINE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

type InlineImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

interface InlineImage {
  mediaType: InlineImageType;
  base64: string;
}

// Reads the turn's attached images that can go to the model inline. A file
// that has gone missing or is too large is skipped; its path is still in the
// prompt text.
function inlineImages(attachments: OverseerTurnAttachment[]): InlineImage[] {
  const images: InlineImage[] = [];
  for (const a of attachments) {
    if (!INLINE_IMAGE_TYPES.has(a.mimeType)) continue;
    try {
      if (statSync(a.absolutePath).size > INLINE_IMAGE_MAX_BYTES) continue;
      images.push({
        mediaType: a.mimeType as InlineImageType,
        base64: readFileSync(a.absolutePath).toString('base64'),
      });
    } catch {
      // Gone since it was attached; the prompt still names it.
    }
  }
  return images;
}

// The turn's prompt as one streamed user message carrying the images ahead of
// the text. Streaming input is the only way to send content blocks, and the
// stream must not end before the turn does: the session answers permission
// checks and hooks over the same channel, so it waits for `settled`.
async function* promptWithImages(
  text: string,
  images: InlineImage[],
  settled: Promise<void>
): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: [
        ...images.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: img.mediaType,
            data: img.base64,
          },
        })),
        { type: 'text' as const, text },
      ],
    },
    parent_tool_use_id: null,
  };
  await settled;
}

// The session's slash commands, trimmed to what the composer shows.
function withCommands(
  list:
    | { name: string; description: string; argumentHint: string }[]
    | undefined
): { commands?: OverseerCommand[] } {
  if (list === undefined) return {};
  return {
    commands: list.map(({ name, description, argumentHint }) => ({
      name,
      description,
      argumentHint,
    })),
  };
}

// The context one API call read: its fresh input plus whatever came from cache.
function contextOf(usage: unknown): number | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const n = (key: string) => (typeof u[key] === 'number' ? u[key] : 0);
  const total =
    n('input_tokens') +
    n('cache_read_input_tokens') +
    n('cache_creation_input_tokens');
  return total > 0 ? total : undefined;
}

// Hands each built-in tool call in an assistant message to `onToolUse`. The
// registry's own tools are skipped: those record themselves through
// `toolset.call`, and reporting them here too would list every status call
// twice in the transcript.
function reportToolUses(
  content: unknown,
  onToolUse: OverseerTurnOptions['onToolUse']
): void {
  if (onToolUse === undefined || !Array.isArray(content)) return;
  for (const block of content as AssistantContentBlock[]) {
    if (block.type !== 'tool_use' || block.name === undefined) continue;
    if (block.name.startsWith(OVERSEER_TOOL_PREFIX)) continue;
    onToolUse(block.name, block.input);
  }
}
