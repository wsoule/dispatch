import type { InboxItem } from '@dispatch/client';

/**
 * Notices when several captured items are really about one thing.
 *
 * The argument the panel makes is a real one — three loose tasks about worktrees would make a
 * better epic than three tasks — but a hint that fires on every coincidence is worse than no
 * hint, because it stops being read. So the bar is deliberately high, and the failure mode is
 * silence.
 *
 * Local and cheap on purpose: no model call. Capture must never block, and a suggestion that
 * costs a round trip is a suggestion that shows up after you have already moved on.
 */

/** Words too common in this domain to indicate two items are about the same thing. */
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'is',
  'are',
  'was',
  'be',
  'been',
  'it',
  'its',
  'this',
  'that',
  'when',
  'should',
  'would',
  'could',
  'need',
  'needs',
  'want',
  'make',
  'add',
  'fix',
  'from',
  'into',
  'per',
  'not',
  'no',
  'if',
  'then',
  'than',
  'so',
  'do',
  'does',
  // Domain words that appear in nearly everything here and so distinguish nothing.
  'task',
  'tasks',
  'agent',
  'agents',
  'run',
  'runs',
  'dispatch',
]);

/**
 * Content words, lowercased, short ones dropped, and crudely singularised.
 *
 * The stemming matters more than it looks: people write "worktrees are eating disk" and "prune
 * the worktree" in the same inbox, and without folding the plural those two never match — which
 * is exactly the cluster the feature exists to catch. A trailing-s strip is wrong for a handful
 * of words ("status" -> "statu") but consistently wrong, which is all a grouping key needs.
 */
function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w))
      .map((w) => (w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
      .filter((w) => w.length > 3 && !STOPWORDS.has(w))
  );
}

export interface InboxCluster {
  /** The items that look related. */
  ids: string[];
  /** The shared terms, for naming the cluster in the hint. */
  theme: string[];
}

/** At least this many items must share a term before it is worth mentioning. */
const MIN_CLUSTER = 3;

/**
 * The single strongest cluster, or `null` when nothing is worth saying.
 *
 * One cluster rather than all of them: the panel is a nudge, and offering four competing
 * groupings turns a nudge into another triage problem.
 */
export function findCluster(items: InboxItem[]): InboxCluster | null {
  const open = items.filter((i) => !i.done);
  if (open.length < MIN_CLUSTER) return null;

  // term -> the items mentioning it
  const byTerm = new Map<string, string[]>();
  for (const item of open) {
    for (const term of terms(item.text)) {
      const bucket = byTerm.get(term);
      if (bucket === undefined) byTerm.set(term, [item.id]);
      else bucket.push(item.id);
    }
  }

  let best: { term: string; ids: string[] } | null = null;
  for (const [term, ids] of byTerm) {
    if (ids.length < MIN_CLUSTER) continue;
    if (best === null || ids.length > best.ids.length) best = { term, ids };
  }
  if (best === null) return null;

  // Every other term the whole cluster also shares — what actually names the theme.
  const members = new Set(best.ids);
  const theme = [...byTerm.entries()]
    .filter(
      ([, ids]) =>
        ids.length >= members.size && ids.every((id) => members.has(id))
    )
    .map(([term]) => term)
    .sort();

  return { ids: best.ids, theme: theme.length > 0 ? theme : [best.term] };
}

/** The hint's sentence. Names the shared theme, because "3 items look related" is not a reason. */
export function describeCluster(cluster: InboxCluster): string {
  const theme = cluster.theme.slice(0, 3).join(', ');
  return `${cluster.ids.length} items here are all about ${theme}. They would make a better epic than ${cluster.ids.length} loose tasks.`;
}
