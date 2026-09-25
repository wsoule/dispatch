import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from '@dispatch/core';

import { openClaudeQuery } from './orchestrator/claudeCli.js';

/**
 * Turns a sentence typed into the Tasks page's Filter menu ("urgent tasks
 * nobody is on") into ordinary filter clauses, so the result renders and
 * persists exactly like a filter picked by hand. One-shot structured output on
 * the daemon, sanitized against the project's live vocabulary before it leaves.
 */

interface AiFilterClause {
  facet: string;
  op: string;
  values: string[];
  /** Date facets: how many days back the bound sits; resolved to an ISO value by `sanitizeAiFilter`. */
  daysAgo?: number;
}

export interface AiTaskFilterResult {
  clauses: AiFilterClause[];
  join: 'and' | 'or';
}

/** What the project can actually filter on right now — the model may only name these. */
export interface AiFilterVocabulary {
  statuses: string[];
  labels: string[];
  milestones: string[];
  epics: { id: string; title: string }[];
  runStates: string[];
}

export interface AiTaskFilterPort {
  toFilters(
    sentence: string,
    vocab: AiFilterVocabulary
  ): Promise<AiTaskFilterResult>;
}

// The nine facets and five operators are apps/desktop/src/lib/taskFilters.ts's
// FilterFacet/FilterOp verbatim; the desktop's parser is the final gate on what
// the chips render.
const FACETS = [
  'status',
  'priority',
  'assignee',
  'labels',
  'epic',
  'milestone',
  'run',
  'created',
  'updated',
] as const;
const OPS = ['is', 'is not', 'includes', 'before', 'after'] as const;

const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const ASSIGNEES = ['agent', 'human', 'none'];
const NONE = 'none';

const AI_FILTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['clauses', 'join'],
  properties: {
    clauses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['facet', 'op', 'values'],
        properties: {
          facet: { type: 'string', enum: [...FACETS] },
          op: { type: 'string', enum: [...OPS] },
          values: { type: 'array', items: { type: 'string' } },
          daysAgo: { type: 'integer' },
        },
      },
    },
    join: { type: 'string', enum: ['and', 'or'] },
  },
} as const;

export function buildAiFilterPrompt(
  sentence: string,
  vocab: AiFilterVocabulary
): string {
  const list = (values: string[]) =>
    values.length === 0 ? '(none)' : values.join(', ');
  return [
    'Translate the sentence at the end into filter clauses for a task tracker. Each clause ' +
      'names one facet, one operator and the values it matches; the clauses are joined by ' +
      '"and" (every clause must hold) or "or" (any clause holds). Return no clauses when the ' +
      'sentence asks for nothing the facets below can express — a wrong filter costs more ' +
      'than an empty one.',
    "`status`: the task's workflow state. Values are the status ids listed below, exactly as " +
      'written. Operators: "is", "is not".',
    '`priority`: one of none, low, medium, high, urgent. Operators: "is", "is not".',
    '`assignee`: who is on the task — "agent" (an AI run), "human" (a person), or "none" ' +
      '(nobody / unassigned). Operators: "is", "is not".',
    '`labels`: free-form tags. Use "includes" with the label names listed below; a task ' +
      'must carry every value given.',
    '`epic`: the parent epic. Values are the epic ids listed below (never titles), or "none" ' +
      'for tasks with no epic. Operators: "is", "is not".',
    '`milestone`: the milestone name, from the list below, or "none". Operators: "is", "is not".',
    "`run`: the state of the task's live agent run, from the run states listed below, or " +
      '"none" for tasks with no live run ("running" means an agent is working on it now). ' +
      'Operators: "is", "is not".',
    '`created` / `updated`: when the task was created or last changed. Use "before" or ' +
      '"after" with `daysAgo` (a whole number of days back from today) instead of a date, and ' +
      'leave `values` empty — "in the last week" is after, daysAgo 7; "older than a month" is ' +
      'before, daysAgo 30.',
    `Statuses: ${list(vocab.statuses)}`,
    `Labels: ${list(vocab.labels)}`,
    `Milestones: ${list(vocab.milestones)}`,
    `Epics (id — title): ${
      vocab.epics.length === 0
        ? '(none)'
        : vocab.epics.map((e) => `${e.id} — ${e.title}`).join('; ')
    }`,
    `Run states: ${list(vocab.runStates)}`,
    `Sentence: ${sentence.trim()}`,
  ].join('\n\n');
}

/** A hung model call must not pin the Filter menu's spinner open forever. */
const AI_FILTER_TIMEOUT_MS = 30_000;

// The SDK signals an abort as either an AbortError or a fetch-cancellation
// message, so a real cancellation is never read as an unrelated failure.
function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' ||
      err.message.includes('FetchRequestCanceledException'))
  );
}

export class ClaudeAiTaskFilter implements AiTaskFilterPort {
  constructor(
    private readonly rootDir: string,
    // Same injectable seam the planner uses, so this is testable without a live model.
    private readonly queryFn: typeof query = query
  ) {}

  async toFilters(
    sentence: string,
    vocab: AiFilterVocabulary
  ): Promise<AiTaskFilterResult> {
    const abortController = new AbortController();
    const timer = setTimeout(
      () => abortController.abort(),
      AI_FILTER_TIMEOUT_MS
    );
    try {
      const options: Options = {
        cwd: this.rootDir,
        // Read per call, so a settings change applies with no daemon restart. The
        // summarize model is the cheap one-shot slot; a filter needs nothing more.
        model: loadConfig(this.rootDir).models.summarize,
        permissionMode: 'plan',
        // No tools: this is a judgement about the strings in the prompt, not about the repo.
        // `tools: []` drops the built-ins; `strictMcpConfig` keeps the operator's own MCP
        // servers (claude.ai connectors, plugins) off a call that reads untrusted text.
        tools: [],
        strictMcpConfig: true,
        outputFormat: { type: 'json_schema', schema: AI_FILTER_SCHEMA },
        abortController,
      };

      const sdkQuery: Query = openClaudeQuery(
        this.queryFn,
        buildAiFilterPrompt(sentence, vocab),
        options
      );

      for await (const message of sdkQuery) {
        if (message.type !== 'result') continue;
        if (message.subtype !== 'success') {
          throw new Error(`ai filter failed: ${message.subtype}`);
        }
        if (message.structured_output === undefined) {
          throw new Error('ai filter returned no structured output');
        }
        return sanitizeAiFilter(message.structured_output, vocab);
      }
      throw new Error('ai filter returned no result');
    } catch (err) {
      // Only an error the abort itself caused is a timeout — a genuine failure landing
      // at the 30s mark keeps its own message.
      if (isAbortError(err)) {
        throw new Error(
          `ai filter timed out after ${AI_FILTER_TIMEOUT_MS / 1000}s`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function isFacet(value: unknown): value is (typeof FACETS)[number] {
  return (
    typeof value === 'string' && (FACETS as readonly string[]).includes(value)
  );
}

function isOp(value: unknown): value is (typeof OPS)[number] {
  return (
    typeof value === 'string' && (OPS as readonly string[]).includes(value)
  );
}

/** The operators a facet's clause may carry; anything else drops the clause. */
function opsFor(facet: (typeof FACETS)[number]): readonly string[] {
  switch (facet) {
    case 'labels':
      return ['includes', 'is', 'is not'];
    case 'created':
    case 'updated':
      return ['before', 'after'];
    default:
      return ['is', 'is not'];
  }
}

// Midnight UTC `daysAgo` days before `now`, as the ISO value a date clause carries.
function isoDaysAgo(now: Date, daysAgo: number): string {
  const bound = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  bound.setUTCDate(bound.getUTCDate() - daysAgo);
  return bound.toISOString();
}

/**
 * Drops anything the model got wrong before it reaches the chips: an invented
 * facet or operator, a value outside the project's vocabulary, an epic named
 * by title (mapped to its id when it can be), a date clause with no `daysAgo`.
 * Whatever survives is a filter the desktop would have built by hand.
 */
export function sanitizeAiFilter(
  raw: unknown,
  vocab: AiFilterVocabulary,
  now = new Date()
): AiTaskFilterResult {
  const record =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const join = record.join === 'or' ? 'or' : 'and';
  const clauses: AiFilterClause[] = [];
  if (!Array.isArray(record.clauses)) return { clauses, join };

  const epicIds = new Set(vocab.epics.map((e) => e.id));
  const epicIdByTitle = new Map(
    vocab.epics.map((e) => [e.title.trim().toLowerCase(), e.id])
  );
  const allowed = (values: string[], extra: string[] = []) =>
    new Set([...values, ...extra]);
  const keepIn = (set: ReadonlySet<string>) => (value: string) =>
    set.has(value);

  for (const item of record.clauses) {
    if (typeof item !== 'object' || item === null) continue;
    const clause = item as Record<string, unknown>;
    if (!isFacet(clause.facet) || !isOp(clause.op)) continue;
    const facet = clause.facet;
    const op = clause.op;
    if (!opsFor(facet).includes(op)) continue;

    if (facet === 'created' || facet === 'updated') {
      const daysAgo = clause.daysAgo;
      if (!Number.isInteger(daysAgo) || (daysAgo as number) < 0) continue;
      clauses.push({
        facet,
        op,
        values: [isoDaysAgo(now, daysAgo as number)],
      });
      continue;
    }

    const given = Array.isArray(clause.values)
      ? clause.values.filter((v): v is string => typeof v === 'string')
      : [];
    let values: string[];
    switch (facet) {
      case 'status':
        values = given.filter(keepIn(allowed(vocab.statuses)));
        break;
      case 'labels':
        values = given.filter(keepIn(allowed(vocab.labels)));
        break;
      case 'milestone':
        values = given.filter(keepIn(allowed(vocab.milestones, [NONE])));
        break;
      case 'run':
        values = given.filter(keepIn(allowed(vocab.runStates, [NONE])));
        break;
      case 'priority':
        values = given.filter(keepIn(allowed(PRIORITIES)));
        break;
      case 'assignee':
        values = given.filter(keepIn(allowed(ASSIGNEES)));
        break;
      case 'epic':
        values = given.flatMap((v) => {
          if (v === NONE || epicIds.has(v)) return [v];
          const byTitle = epicIdByTitle.get(v.trim().toLowerCase());
          return byTitle === undefined ? [] : [byTitle];
        });
        break;
    }
    const unique = [...new Set(values)];
    if (unique.length === 0) continue;
    clauses.push({ facet, op, values: unique });
  }
  return { clauses, join };
}

/**
 * The `DISPATCH_ENABLE_FAKES` port: a deterministic keyword table over the
 * sentence, so e2e scripts and the desktop's dev toggle exercise the whole
 * round-trip — request, chips, persistence — without a model call.
 */
export class FakeAiTaskFilter implements AiTaskFilterPort {
  async toFilters(
    sentence: string,
    vocab: AiFilterVocabulary
  ): Promise<AiTaskFilterResult> {
    const words = sentence
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter(Boolean);
    const has = (word: string) => words.includes(word);
    const clauses: AiFilterClause[] = [];
    if (has('urgent')) {
      clauses.push({ facet: 'priority', op: 'is', values: ['urgent'] });
    }
    if (has('nobody') || has('unassigned')) {
      clauses.push({ facet: 'assignee', op: 'is', values: [NONE] });
    } else if (has('mine') || has('me')) {
      clauses.push({ facet: 'assignee', op: 'is', values: ['human'] });
    }
    const statuses = vocab.statuses.filter((s) => has(s.toLowerCase()));
    if (statuses.length > 0) {
      clauses.push({ facet: 'status', op: 'is', values: statuses });
    }
    if (has('running') || has('live')) {
      clauses.push({ facet: 'run', op: 'is', values: ['running'] });
    }
    const labels = vocab.labels.filter((l) => has(l.toLowerCase()));
    if (labels.length > 0) {
      clauses.push({ facet: 'labels', op: 'includes', values: labels });
    }
    return { clauses, join: has('or') ? 'or' : 'and' };
  }
}
