import type { PlannerMode, PlannerQuestion, PlanProposal } from '../planner.js';

// The proposal half of the structured output: mirrors PlanProposal/PlannedTask
// in planner.ts field-for-field. Kept as a standalone object so it can be
// nested under `proposal` in the turn schema below — keep the two in sync by
// hand since one is a TS type and the other is data.
const PROPOSAL_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    milestone: {
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
export const TURN_JSON_SCHEMA: Record<string, unknown> = {
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
export interface PlannerTurnOutput {
  message: string;
  proposal: PlanProposal | null;
  questions: PlannerQuestion[];
}

// Shared invariants every turn's `proposal` must honor. Stated once, on the
// opening prompt; a resumed session still has them in context.
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
  'genuinely shared ground for several tasks in this plan (a route table, ' +
  'a barrel file, a shared types module), list it in ' +
  'every task that touches it rather than picking one owner — that is what ' +
  'correctly serializes them. `risk` is one of routine (the default; ' +
  'ordinary feature and fix work), elevated (touches shared contracts, ' +
  'auth, concurrency, or data migration), or critical (destructive ' +
  'operations, writes to an external system, or anything that can lose ' +
  'user data) — pick the tier the task itself warrants, not the milestone as a ' +
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
// breakdown into an (optional) milestone plus a set of tasks, and leans on the
// json_schema outputFormat for shape enforcement rather than parsing free text.
function buildPlannerPrompt(userPrompt: string): string {
  return [
    'You are planning work for a git-native task tracker, not implementing ' +
      'it. Do not write, edit, or run anything — you are in read-only ' +
      'planning mode. This is a conversation: the user may follow up to ' +
      'refine the plan across several turns.',
    'Break the following request into tasks: a single milestone with its child ' +
      'tasks, or a flat list with no milestone when a milestone wrapper would add no ' +
      'value. If the request itself asks for a particular shape (one task, ' +
      'no milestone), follow it:',
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
      'questions you asked. Apply their feedback and return the full updated ' +
      'plan, under the same question and proposal rules as before. Stay in ' +
      'read-only planning mode — do not write, edit, or run anything.',
    userMessage,
  ].join('\n\n');
}

// Opening instruction for a single-task draft (startDraft) — buildPlannerPrompt's
// contract scaled to one task and a much tighter question budget.
function buildDraftPrompt(userPrompt: string): string {
  return [
    'You are turning a short request into a single well-formed task for a ' +
      'git-native task tracker, not implementing it. Do not write, edit, or ' +
      'run anything — you are in read-only planning mode.',
    'Produce exactly one task (no milestone) for this request:',
    userPrompt,
    buildQuestionRules(
      'You get at most one round of questions for this single task — ask at ' +
        'most 4 now if truly needed, but once the user has replied (or if ' +
        'nothing is genuinely ambiguous) propose the task from what you know ' +
        'and do not ask again.'
    ),
    PROPOSAL_RULES +
      ' This draft proposes exactly one task, so `proposal.tasks` must have ' +
      'at most one entry and `milestone` must be omitted.',
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

// Shown when two consecutive attempts at a turn both end with no structured
// output; tells the user their answers are kept and to resend.
export const EMPTY_TURN_MESSAGE =
  'The planner ended its turn without a plan or a question, twice in a row. ' +
  'Your answers were kept — send them again, or rephrase if it keeps happening.';

/** The opening instruction for a plan or a single-task draft conversation. */
export function openingPrompt(mode: PlannerMode, prompt: string): string {
  return mode === 'draft'
    ? buildDraftPrompt(prompt)
    : buildPlannerPrompt(prompt);
}

/** The instruction wrapping a follow-up message on an open plan or draft. */
export function followupPrompt(mode: PlannerMode, message: string): string {
  return mode === 'draft'
    ? buildDraftFollowupPrompt(message)
    : buildFollowupPrompt(message);
}

// Codex enforces OpenAI strict structured output, where every property must be
// required: the optional `milestone` becomes required-but-nullable.
const CODEX_PROPOSAL_JSON_SCHEMA: Record<string, unknown> = {
  ...PROPOSAL_JSON_SCHEMA,
  properties: {
    ...(PROPOSAL_JSON_SCHEMA.properties as Record<string, unknown>),
    milestone: {
      anyOf: [
        (PROPOSAL_JSON_SCHEMA.properties as Record<string, unknown>).milestone,
        { type: 'null' },
      ],
    },
  },
  required: ['milestone', 'tasks'],
};

/** TURN_JSON_SCHEMA in the strict form Codex's `outputSchema` accepts. */
export const CODEX_TURN_JSON_SCHEMA: Record<string, unknown> = {
  ...TURN_JSON_SCHEMA,
  properties: {
    ...(TURN_JSON_SCHEMA.properties as Record<string, unknown>),
    proposal: { anyOf: [CODEX_PROPOSAL_JSON_SCHEMA, { type: 'null' }] },
  },
};

// A Codex planner turn's final message as CODEX_TURN_JSON_SCHEMA's JSON, minus
// a null milestone; null when it isn't that shape (the planner retries, as for Claude).
export function parseCodexTurnOutput(text: string): PlannerTurnOutput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const output = parsed as Record<string, unknown>;
  if (typeof output.message !== 'string' || !Array.isArray(output.questions)) {
    return null;
  }
  const questions = output.questions as PlannerQuestion[];
  if (output.proposal === null) {
    return { message: output.message, proposal: null, questions };
  }
  if (typeof output.proposal !== 'object') return null;
  const proposal = { ...(output.proposal as Record<string, unknown>) };
  if (proposal.milestone === null) delete proposal.milestone;
  return {
    message: output.message,
    proposal: proposal as unknown as PlanProposal,
    questions,
  };
}
