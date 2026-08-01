import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from '@dispatch/core';

import type { InboxItem } from './inbox.js';
import { openClaudeQuery } from './orchestrator/claudeCli.js';

/**
 * Groups related inbox items using a model, so "diffs go blank mid-run" and "the review pane is
 * empty while an agent works" land together — the same bug described twice, sharing not one word.
 *
 * This complements rather than replaces the local heuristic in the desktop app
 * (lib/inboxCluster.ts). The two answer different questions and have different costs:
 *
 * - The local pass is free and instant, so it runs on every render as a passive hint. It can only
 *   see shared vocabulary.
 * - This pass costs a call and a couple of seconds, so it is explicitly user-triggered. It sees
 *   meaning.
 *
 * Haiku by default (`config.models.cluster`, see packages/core/src/config.ts's DEFAULT_MODELS).
 * This is a short classification over a handful of one-line strings — the cheapest, fastest model
 * in the family is the right tool, and paying Opus rates to sort a todo list would be
 * indefensible. No tools are granted either: clustering is about the text in front of it, so
 * letting it read the repo would only add latency and a way to go wrong.
 */

export interface InboxClusterGroup {
  /** A title for the epic these items would become. */
  epicTitle: string;
  /** Why these belong together, in one line, for the user to agree or disagree with. */
  reason: string;
  itemIds: string[];
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['epicTitle', 'reason', 'itemIds'],
        properties: {
          epicTitle: { type: 'string' },
          reason: { type: 'string' },
          itemIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

function buildPrompt(items: InboxItem[]): string {
  const list = items.map((i) => `${i.id}: [${i.kind}] ${i.text}`).join('\n');
  return [
    'These are raw one-line notes someone dumped into a capture inbox for a software project. ' +
      'Some of them are really the same piece of work described differently, or facets of one ' +
      'larger job that would be better tracked as a single epic than as loose tasks.',
    list,
    'Group only the items that genuinely belong to one piece of work. Two notes about the same ' +
      'symptom, the same subsystem, or the same underlying cause belong together even when they ' +
      'share no words. Two notes that merely sound similar do not.',
    'Rules: a group needs at least two items. Never put an item in more than one group. Leave ' +
      'anything that does not clearly belong with something else out entirely — returning no ' +
      'groups is the correct answer for an unrelated list, and a wrong grouping costs the user ' +
      'more than a missed one. Give each group a title that would work as an epic name, and one ' +
      'short sentence saying what the items have in common. Use only the ids given above.',
  ].join('\n\n');
}

/** Anything below this and there is nothing to group. */
const MIN_ITEMS = 3;

export class InboxClusterer {
  constructor(
    private readonly rootDir: string,
    // Same injectable seam the planner uses, so this is testable without a live model.
    private readonly queryFn: typeof query = query
  ) {}

  async cluster(items: InboxItem[]): Promise<InboxClusterGroup[]> {
    const open = items.filter((i) => !i.done);
    if (open.length < MIN_ITEMS) return [];

    // Fresh per-call read (same pattern PlanManager and mergeQueue.ts use for their own
    // config.yml-sourced settings), so a settings change takes effect on the next cluster
    // request with no daemon restart.
    const options: Options = {
      cwd: this.rootDir,
      model: loadConfig(this.rootDir).models.cluster,
      permissionMode: 'plan',
      // No tools: this is a judgement about the strings above, not about the repo.
      allowedTools: [],
      outputFormat: { type: 'json_schema', schema: SCHEMA },
    };

    const sdkQuery: Query = openClaudeQuery(
      this.queryFn,
      buildPrompt(open),
      options
    );

    for await (const message of sdkQuery) {
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success') {
        throw new Error(`clustering failed: ${message.subtype}`);
      }
      if (message.structured_output === undefined) {
        throw new Error('clustering returned no structured output');
      }
      const parsed = message.structured_output as {
        groups?: InboxClusterGroup[];
      };
      return sanitize(parsed.groups ?? [], open);
    }
    return [];
  }
}

/**
 * Drops anything the model got wrong before it reaches the user.
 *
 * A model asked for ids will occasionally invent one, reuse one across two groups, or return a
 * group of one. None of those should ever be rendered: the whole value of this feature is that
 * the user can trust a suggested grouping enough to act on it in one click.
 */
export function sanitize(
  groups: InboxClusterGroup[],
  items: InboxItem[]
): InboxClusterGroup[] {
  const known = new Set(items.map((i) => i.id));
  const claimed = new Set<string>();
  const out: InboxClusterGroup[] = [];

  for (const group of groups) {
    const ids = (group.itemIds ?? []).filter(
      (id) => known.has(id) && !claimed.has(id)
    );
    // Dedupe within the group too — a repeated id would inflate the count the UI shows.
    const unique = [...new Set(ids)];
    if (unique.length < 2) continue;
    if (typeof group.epicTitle !== 'string' || group.epicTitle.trim() === '') {
      continue;
    }
    for (const id of unique) claimed.add(id);
    out.push({
      epicTitle: group.epicTitle.trim(),
      reason: typeof group.reason === 'string' ? group.reason.trim() : '',
      itemIds: unique,
    });
  }
  return out;
}
