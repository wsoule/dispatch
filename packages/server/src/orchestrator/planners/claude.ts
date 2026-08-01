import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';

import { openClaudeQuery, rewriteMissingCliError } from '../claudeCli.js';
import type { Planner, PlannerTurn, PlanProposal } from '../planner.js';

// The proposal half of the structured output: mirrors PlanProposal/PlannedTask
// in planner.ts field-for-field. Kept as a standalone object so it can be
// nested under `proposal` in the turn schema below — keep the two in sync by
// hand since one is a TS type and the other is data.
const PROPOSAL_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    epic: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['title', 'description'],
      additionalProperties: false,
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          blockedByIndices: { type: 'array', items: { type: 'integer' } },
          priority: {
            type: 'string',
            enum: ['urgent', 'high', 'medium', 'low', 'none'],
          },
        },
        required: [
          'title',
          'description',
          'acceptanceCriteria',
          'blockedByIndices',
          'priority',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
};

// The full JSON Schema handed to the SDK's `outputFormat: { type:
// 'json_schema', schema }` for every turn. A plan is now a conversation, so
// each turn carries BOTH a natural-language `message` (the assistant's reply
// the user reads) and the `proposal` it is working toward — since a
// json_schema output leaves no separate assistant-text stream to read, the two
// have to travel together in one structured object.
const TURN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    proposal: PROPOSAL_JSON_SCHEMA,
  },
  required: ['message', 'proposal'],
  additionalProperties: false,
};

// The `structured_output` shape TURN_JSON_SCHEMA produces.
interface PlannerTurnOutput {
  message: string;
  proposal: PlanProposal;
}

// Shared invariants every turn's `proposal` must honor, restated on both the
// opening and follow-up prompts so a resumed session never drifts from them.
const PROPOSAL_RULES =
  'Every task needs a clear title, a description of what "done" looks like, a ' +
  'list of concrete acceptance criteria, a priority (urgent|high|medium|low|' +
  'none), and a `blockedByIndices` array — 0-based indices into this SAME ' +
  "tasks array (never a real id, which doesn't exist until a human confirms " +
  'this plan) naming which other proposed tasks must land first. Leave ' +
  'blockedByIndices empty for tasks with no dependency on another proposed ' +
  'task. Put a short conversational reply to the user in `message`, and the ' +
  'FULL current plan (not a diff) in `proposal` on every turn.';

// The opening instruction wrapping a user's first planning prompt: asks for a
// breakdown into an (optional) epic plus a set of tasks, and leans on the
// json_schema outputFormat for shape enforcement rather than parsing free text.
function buildPlannerPrompt(userPrompt: string): string {
  return [
    'You are planning work for a git-native task tracker, not implementing ' +
      'it. Do not write, edit, or run anything — you are in read-only ' +
      'planning mode. This is a conversation: the user may follow up to ' +
      'refine the plan across several turns.',
    `Break the following request into either a single epic with its child ` +
      'tasks, or a flat list of tasks with no epic if the request is small ' +
      'enough that an epic wrapper would add no value:',
    userPrompt,
    PROPOSAL_RULES,
  ].join('\n\n');
}

// The instruction wrapping a follow-up user message on an already-open plan.
// The Agent SDK session is resumed (see `resume` below), so the model already
// has the prior turns and working proposal in context — this just delivers the
// new user message and re-states that the whole updated plan must come back.
function buildFollowupPrompt(userMessage: string): string {
  return [
    'The user is refining the plan you are already working on. Apply their ' +
      'feedback and return the updated plan. Stay in read-only planning mode ' +
      '— do not write, edit, or run anything.',
    userMessage,
    PROPOSAL_RULES,
  ].join('\n\n');
}

/**
 * The real planner backend: a read-only Agent SDK planning *conversation* in
 * the main checkout (no worktree — a plan proposes work, it never touches the
 * repo), `permissionMode: 'plan'` so no tool actually executes, and a
 * json_schema `outputFormat` so each turn arrives as structured data instead
 * of free text to parse. Every turn is a discrete `query()` call: the opening
 * turn starts a fresh session; each follow-up passes the prior turn's
 * `session_id` as `resume` so the model retains full context across turns
 * without keeping a process alive between them. CI never constructs this — see
 * FakePlanner.
 */
export class ClaudePlanner implements Planner {
  // Defaults to the real SDK's `query()`; tests can inject a stub that yields a
  // scripted SDKMessage stream instead, mirroring ClaudeExecutor's own
  // `queryFn` seam.
  constructor(
    private readonly rootDir: string,
    private readonly queryFn: typeof query = query
  ) {}

  start(prompt: string, model?: string): Promise<PlannerTurn> {
    return this.runTurn(buildPlannerPrompt(prompt), undefined, model);
  }

  sendMessage(
    sessionId: string | undefined,
    message: string,
    model?: string
  ): Promise<PlannerTurn> {
    return this.runTurn(buildFollowupPrompt(message), sessionId, model);
  }

  // Runs one turn to completion: issues a single `query()` (resuming `resume`
  // when continuing a conversation), then folds the terminal `result` message
  // into a PlannerTurn. The session id is captured from the 'system' init
  // message as a fallback so a turn still reports its session even if the
  // 'result' omits one.
  private async runTurn(
    prompt: string,
    resume: string | undefined,
    model: string | undefined
  ): Promise<PlannerTurn> {
    const options: Options = {
      cwd: this.rootDir,
      permissionMode: 'plan',
      outputFormat: { type: 'json_schema', schema: TURN_JSON_SCHEMA },
      // Same "query() doesn't auto-load what the CLI does" fix as
      // ClaudeExecutor's sdkOptions (executors/claude.ts): without
      // `settingSources: ['project', ...]`, the SDK contract is explicit that
      // CLAUDE.md/AGENTS.md never load at all. This planner runs against the
      // real checkout via `cwd` (this.rootDir), so grounding it in the
      // project's own instruction files the same way a dispatched run is
      // improves the quality of its proposals, not just its executed work.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      ...(resume !== undefined ? { resume } : {}),
      ...(model !== undefined ? { model } : {}),
    };
    // Same CLI-resolution chain (DISPATCH_CLAUDE_BIN -> bundled SDK CLI ->
    // PATH `claude` -> install hint) ClaudeExecutor.openQuery uses — see
    // claudeCli.ts. Without this, a packaged app (no node_modules bundled
    // CLI) surfaced the SDK's raw "Native CLI binary for ... not found"
    // message straight through PlanManager's `plan.changed` broadcast as
    // "planning failed: Native CLI binary ...", even though dispatching a
    // run from the task page already worked (that path goes through
    // ClaudeExecutor, which had this fallback chain and the earlier
    // packaged-desktop-app fix did not extend it here).
    const sdkQuery: Query = openClaudeQuery(this.queryFn, prompt, options);

    try {
      let sessionId: string | undefined;
      for await (const message of sdkQuery) {
        if (message.type === 'system') {
          sessionId = message.session_id;
          continue;
        }
        if (message.type !== 'result') continue;
        if (message.subtype !== 'success') {
          throw new Error(
            `planner failed: ${message.subtype}${
              'errors' in message && message.errors.length > 0
                ? ` — ${message.errors.join('; ')}`
                : ''
            }`
          );
        }
        if (message.structured_output === undefined) {
          throw new Error('planner produced no structured output');
        }
        const output = message.structured_output as PlannerTurnOutput;
        return {
          reply: output.message,
          proposal: output.proposal,
          sessionId: message.session_id ?? sessionId,
        };
      }
      throw new Error('planner produced no result message');
    } catch (err) {
      // The missing-CLI error can also surface lazily on the first
      // iteration (rather than synchronously from openClaudeQuery above) —
      // apply the same install-hint rewrite here too, mirroring
      // ClaudeExecutor's consume() catch block. Any other error (validation
      // failure, no-result, ...) passes through unchanged.
      throw new Error(rewriteMissingCliError((err as Error).message));
    }
  }
}
