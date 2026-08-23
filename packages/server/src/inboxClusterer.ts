import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from '@dispatch/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { InboxItem } from './inbox.js';
import { openClaudeQuery } from './orchestrator/claudeCli.js';

/**
 * Groups related inbox items with a model, so one piece of work described two
 * ways lands together — past what lib/inboxCluster.ts's local pass can match.
 *
 * Takes whatever items its caller hands it; it does no reading of its own. The inbox is
 * partitioned one file per actor, so the caller passes `InboxStore.listAll()` rather than
 * `list()` here — clustering has to see the whole team's captures, not just one actor's file,
 * or two people describing the same work in their own inboxes would never group.
 */

export interface InboxClusterGroup {
  /** A title for the epic these items would become. */
  epicTitle: string;
  /** Why these belong together, in one line, for the user to agree or disagree with. */
  reason: string;
  itemIds: string[];
}

/** The last clustering pass, persisted so a page load renders what the model
 * already said instead of billing a fresh call per visit. */
export interface InboxClusterSnapshot {
  groups: InboxClusterGroup[];
  /** The open local item ids the pass covered — a consumer judges staleness
   * against these rather than re-running on sight. */
  itemIds: string[];
  updatedAt: string;
}

/** One JSON file under `.dispatch/`, overwritten per pass — the model's last
 * answer is a cache, not a log. */
export class InboxClusterSnapshotStore {
  private readonly file: string;

  constructor(rootDir: string) {
    this.file = join(rootDir, '.dispatch', 'inbox-clusters.json');
  }

  load(): InboxClusterSnapshot | null {
    if (!existsSync(this.file)) return null;
    try {
      const parsed = JSON.parse(
        readFileSync(this.file, 'utf8')
      ) as InboxClusterSnapshot;
      if (!Array.isArray(parsed.groups) || !Array.isArray(parsed.itemIds)) {
        return null;
      }
      return parsed;
    } catch {
      // A hand-corrupted cache costs itself, not the page.
      return null;
    }
  }

  save(snapshot: InboxClusterSnapshot): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(snapshot, null, 2)}\n`);
  }
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

/** A hung model call must not pin the request open forever now that clustering runs
 * automatically, with nothing watching a spinner to cancel it by hand. */
const CLUSTER_TIMEOUT_MS = 60_000;

// The SDK signals an abort as either an AbortError or a fetch-cancellation
// message, so a real cancellation is never read as an unrelated failure.
function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' ||
      err.message.includes('FetchRequestCanceledException'))
  );
}

export class InboxClusterer {
  constructor(
    private readonly rootDir: string,
    // Same injectable seam the planner uses, so this is testable without a live model.
    private readonly queryFn: typeof query = query
  ) {}

  async cluster(items: InboxItem[]): Promise<InboxClusterGroup[]> {
    const open = items.filter((i) => !i.done);
    if (open.length < MIN_ITEMS) return [];

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), CLUSTER_TIMEOUT_MS);
    try {
      const options: Options = {
        cwd: this.rootDir,
        // Read per call, so a settings change applies with no daemon restart.
        model: loadConfig(this.rootDir).models.cluster,
        permissionMode: 'plan',
        // No tools: this is a judgement about the strings above, not about the repo.
        allowedTools: [],
        outputFormat: { type: 'json_schema', schema: SCHEMA },
        abortController,
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
    } catch (err) {
      // Checking the signal alone would mislabel a genuine failure that happens to land right
      // at the 60s mark — only an error the abort itself caused is a timeout.
      if (isAbortError(err)) {
        throw new Error(
          `clustering timed out after ${CLUSTER_TIMEOUT_MS / 1000}s`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Narrows cluster groups down to items in `localIds` — the caller's own actor file — dropping any
 * group left with fewer than two local items.
 *
 * `cluster()` is handed every teammate's items (see the caller in api.ts, which passes
 * `InboxStore.listAll()`) so the model can group work described across different people's
 * inboxes. But display and convert both resolve ids against the local actor's own file only, so a
 * group carrying another actor's item id would overstate its count, seed a selection the UI can't
 * resolve, and fail convert outright — this is what keeps the HTTP response itself local-only.
 */
export function filterGroupsToLocalItems(
  groups: InboxClusterGroup[],
  localIds: Set<string>
): InboxClusterGroup[] {
  return groups
    .map((g) => ({
      ...g,
      itemIds: g.itemIds.filter((id) => localIds.has(id)),
    }))
    .filter((g) => g.itemIds.length >= 2);
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
