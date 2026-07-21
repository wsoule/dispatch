import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';

import type { Planner, PlanProposal } from '../planner.js';

// The exact JSON Schema handed to the SDK's `outputFormat: { type:
// 'json_schema', schema }` (verified against the installed SDK's
// `JsonSchemaOutputFormat`/`SDKResultSuccess.structured_output` types in
// sdk.d.ts — the schema itself is a plain JSON Schema object, no SDK-specific
// wrapper). Mirrors PlanProposal/PlannedTask in planner.ts field-for-field;
// keep the two in sync by hand since one is a TS type and the other is data.
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

// The one-shot instruction wrapping a user's raw planning prompt: asks for a
// breakdown into an (optional) epic plus a set of tasks, explains the
// index-based blockedByIndices convention (real ids don't exist yet — spec
// §5's confirm-before-write rule), and leans on outputFormat/json_schema to
// do the actual shape enforcement rather than parsing free text.
function buildPlannerPrompt(userPrompt: string): string {
  return [
    'You are planning work for a git-native task tracker, not implementing ' +
      'it. Do not write, edit, or run anything — you are in read-only ' +
      'planning mode.',
    `Break the following request into either a single epic with its child ` +
      'tasks, or a flat list of tasks with no epic if the request is small ' +
      'enough that an epic wrapper would add no value:',
    userPrompt,
    'Every task needs a clear title, a description of what "done" looks ' +
      'like, a list of concrete acceptance criteria, a priority ' +
      '(urgent|high|medium|low|none), and a `blockedByIndices` array — ' +
      '0-based indices into this SAME tasks array (never a real id, which ' +
      "doesn't exist until a human confirms this plan) naming which other " +
      'proposed tasks must land first. Leave blockedByIndices empty for ' +
      'tasks with no dependency on another proposed task.',
  ].join('\n\n');
}

/**
 * The real planner backend: one-shot, read-only Agent SDK call in the main
 * checkout (no worktree — a plan proposes work, it never touches the repo),
 * `permissionMode: 'plan'` so no tool actually executes, and a json_schema
 * `outputFormat` so the result arrives as structured data instead of free
 * text to parse. CI never constructs this — see FakePlanner.
 */
export class ClaudePlanner implements Planner {
  // Defaults to the real SDK's `query()`; tests can inject a stub that
  // yields a scripted SDKMessage stream instead, mirroring ClaudeExecutor's
  // own `queryFn` seam.
  constructor(
    private readonly rootDir: string,
    private readonly queryFn: typeof query = query
  ) {}

  async plan(prompt: string): Promise<PlanProposal> {
    const options: Options = {
      cwd: this.rootDir,
      permissionMode: 'plan',
      outputFormat: { type: 'json_schema', schema: PROPOSAL_JSON_SCHEMA },
    };
    const sdkQuery: Query = this.queryFn({
      prompt: buildPlannerPrompt(prompt),
      options,
    });

    for await (const message of sdkQuery) {
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
      return message.structured_output as PlanProposal;
    }
    throw new Error('planner produced no result message');
  }
}
