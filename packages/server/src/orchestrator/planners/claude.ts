import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';

import { openClaudeQuery, rewriteMissingCliError } from '../claudeCli.js';
import type {
  Planner,
  PlannerMode,
  PlannerQuestion,
  PlannerTurn,
  PlanProposal,
} from '../planner.js';

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
          writes: { type: 'array', items: { type: 'string' } },
          risk: {
            type: 'string',
            enum: ['routine', 'elevated', 'critical'],
          },
        },
        required: [
          'title',
          'description',
          'acceptanceCriteria',
          'blockedByIndices',
          'priority',
          'writes',
          'risk',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
};

// One clarifying question in the turn schema — mirrors PlannerQuestion.
const QUESTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'question', 'options'],
  additionalProperties: false,
};

// The JSON Schema for the SDK's `outputFormat: { type: 'json_schema' }` on
// every turn: `message` plus `proposal` (nullable — a turn may only ask) and `questions`.
const TURN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    proposal: { anyOf: [PROPOSAL_JSON_SCHEMA, { type: 'null' }] },
    questions: { type: 'array', items: QUESTION_JSON_SCHEMA },
  },
  required: ['message', 'proposal', 'questions'],
  additionalProperties: false,
};

// The `structured_output` shape TURN_JSON_SCHEMA produces.
interface PlannerTurnOutput {
  message: string;
  proposal: PlanProposal | null;
  questions: PlannerQuestion[];
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
  'FULL current plan (not a diff) in `proposal` once you have one — set ' +
  '`proposal` to null only on a turn where you have nothing worth proposing ' +
  'yet (see the question rules below).\n\n' +
  'Every task also needs `writes` and `risk`, since these drive whether ' +
  'tasks can run concurrently later. `writes` is the list of file paths (or ' +
  '`dir/**` glob prefixes — no other glob syntax) the task will actually ' +
  'modify or create; tasks whose `writes` do not overlap can run in ' +
  'parallel, so over-declaring (listing files you will not really touch) ' +
  'costs concurrency, while under-declaring (missing one you do touch) ' +
  'costs a merge conflict when two tasks collide on a file neither ' +
  'declared. Declare exactly what you expect to touch, and if a file is ' +
  'genuinely shared ground for several tasks in this plan (in this repo, ' +
  'the canonical example is `packages/server/src/api.ts`), list it in ' +
  'every task that touches it rather than picking one owner — that is what ' +
  'correctly serializes them. `risk` is one of routine (the default; ' +
  'ordinary feature and fix work), elevated (touches shared contracts, ' +
  'auth, concurrency, or data migration), or critical (destructive ' +
  'operations, writes to an external system, or anything that can lose ' +
  'user data) — pick the tier the task itself warrants, not the epic as a ' +
  'whole.';

// Shared clarifying-questions instruction for both plan and draft prompts;
// `roundLimit` supplies the caller's own cap so drafts stay tighter than plans.
function buildQuestionRules(roundLimit: string): string {
  return (
    'Before proposing, judge whether you actually have enough information to ' +
    'plan responsibly. If something is genuinely ambiguous and would change ' +
    'the shape of the work, ask about it in `questions` rather than guessing ' +
    '— the kinds of things worth asking about are scope boundaries (what is ' +
    'explicitly in vs. out), existing code or patterns this should build on, ' +
    'the user-facing behaviour expected, how you would know each task is ' +
    'done (acceptance criteria), and explicit non-goals. Each question needs ' +
    'a short stable `id` (e.g. "q1"), the `question` text, and an `options` ' +
    "array of short suggested answers (leave it empty when there isn't a " +
    'good fixed set of answers). ' +
    roundLimit +
    ' Most requests are clear enough to need zero questions — do not ask out ' +
    'of habit, and once you have enough to propose a reasonable plan, stop ' +
    'asking: return an empty `questions` array and propose. When you do ' +
    'still have an open question, propose your best-effort plan under a ' +
    'clearly stated working assumption AND ask, unless the unanswered point ' +
    "would change the plan's shape entirely — only then leave `proposal` " +
    'null instead of guessing.'
  );
}

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
    buildQuestionRules(
      'Ask at most 4 questions in a single turn, picking the ones that would ' +
        'most change the resulting tasks.'
    ),
    PROPOSAL_RULES,
  ].join('\n\n');
}

// The instruction wrapping a follow-up user message on an already-open plan.
// The Agent SDK session is resumed (see `resume` below), so the model already
// has the prior turns and working proposal in context — this just delivers the
// new user message and re-states that the whole updated plan must come back.
function buildFollowupPrompt(userMessage: string): string {
  return [
    'The user is refining the plan you are already working on, or answering ' +
      'questions you asked. Apply their feedback and return the updated plan. ' +
      'Stay in read-only planning mode — do not write, edit, or run anything.',
    userMessage,
    buildQuestionRules(
      'Ask at most 4 questions in a single turn, picking the ones that would ' +
        'most change the resulting tasks.'
    ),
    PROPOSAL_RULES,
  ].join('\n\n');
}

// Opening instruction for a single-task draft (startDraft) — buildPlannerPrompt's
// contract scaled to one task and a much tighter question budget.
function buildDraftPrompt(userPrompt: string): string {
  return [
    'You are turning a short request into a single well-formed task for a ' +
      'git-native task tracker, not implementing it. Do not write, edit, or ' +
      'run anything — you are in read-only planning mode.',
    'Produce exactly one task (no epic) for this request:',
    userPrompt,
    buildQuestionRules(
      'You get at most one round of questions for this single task — ask at ' +
        'most 4 now if truly needed, but once the user has replied (or if ' +
        'nothing is genuinely ambiguous) propose the task from what you know ' +
        'and do not ask again.'
    ),
    PROPOSAL_RULES +
      ' This draft proposes exactly one task, so `proposal.tasks` must have ' +
      'at most one entry and `epic` must be omitted.',
  ].join('\n\n');
}

// Follow-up instruction for a draft conversation — reiterates that the one
// round of questions is used up, so this turn must propose.
function buildDraftFollowupPrompt(userMessage: string): string {
  return [
    'The user is answering the question(s) you asked about this single task. ' +
      'You have used your one round of questions — propose the task now from ' +
      'what you know rather than asking again. Stay in read-only planning ' +
      'mode — do not write, edit, or run anything.',
    userMessage,
    'Return an empty `questions` array and a non-null `proposal` with at ' +
      'most one task.',
    PROPOSAL_RULES,
  ].join('\n\n');
}

// Both `tools` and `allowedTools` set to the same list: the former restricts
// model access, the latter auto-approves in plan mode.
const PLANNER_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];

// Shown when two consecutive attempts at the same turn both ended without the
// SDK's structured output. Says what the user can do, because the conversation
// itself is still intact and re-sending usually works.
export const EMPTY_TURN_MESSAGE =
  'The planner ended its turn without a plan or a question, twice in a row. ' +
  'Your answers were kept — send them again, or rephrase if it keeps happening.';

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

  start(
    prompt: string,
    model?: string,
    mode: PlannerMode = 'plan'
  ): Promise<PlannerTurn> {
    const builder = mode === 'draft' ? buildDraftPrompt : buildPlannerPrompt;
    return this.runTurn(builder(prompt), undefined, model);
  }

  sendMessage(
    sessionId: string | undefined,
    message: string,
    model?: string,
    mode: PlannerMode = 'plan'
  ): Promise<PlannerTurn> {
    const builder =
      mode === 'draft' ? buildDraftFollowupPrompt : buildFollowupPrompt;
    return this.runTurn(builder(message), sessionId, model);
  }

  // Runs one turn, retrying once if the first attempt came back with no
  // structured output. The retry re-issues the same prompt against the same
  // session, which is what the CLI's own structured-output nudge does inside a
  // single attempt; two empty attempts in a row is a real failure.
  private async runTurn(
    prompt: string,
    resume: string | undefined,
    model: string | undefined
  ): Promise<PlannerTurn> {
    const first = await this.attemptTurn(prompt, resume, model);
    if (first !== null) return first;
    const second = await this.attemptTurn(prompt, resume, model);
    if (second !== null) return second;
    throw new Error(EMPTY_TURN_MESSAGE);
  }

  // One attempt at a turn: issues a single `query()` (resuming `resume` when
  // continuing a conversation) and folds the terminal `result` message into a
  // PlannerTurn. Returns null — rather than throwing — when the result is a
  // success carrying no structured output, which is the one failure worth
  // retrying; see runTurn.
  private async attemptTurn(
    prompt: string,
    resume: string | undefined,
    model: string | undefined
  ): Promise<PlannerTurn | null> {
    const options: Options = {
      cwd: this.rootDir,
      permissionMode: 'plan',
      outputFormat: { type: 'json_schema', schema: TURN_JSON_SCHEMA },
      // `'project'` loads CLAUDE.md/AGENTS.md; `'user'` omitted to isolate from
      // operator's personal environment.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project', 'local'],
      tools: PLANNER_TOOLS,
      allowedTools: PLANNER_TOOLS,
      strictMcpConfig: true,
      skills: [],
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
        if (message.structured_output === undefined) return null;
        const output = message.structured_output as PlannerTurnOutput;
        return {
          reply: output.message,
          proposal: output.proposal,
          questions: output.questions,
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
