// Text search over mirrored issues, shared by the relation picker's search
// (the planner's searchIssueMirror) and the issue list's `q` filter, so the
// two match text exactly the same way: an identifier exact, prefix or
// containing match, else every word of the query in the accent-folded
// title.

import type { Issue, Snapshot } from './types';

/** Lower case without diacritics ("Résumé" → "resume"). */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** A query prepared once: the folded, trimmed text and its words. */
export interface IssueSearchTerms {
  /** The trimmed query, folded; '' for an empty query. */
  folded: string;
  /** The folded query split on whitespace (no empty words). */
  words: string[];
}

/** Prepares a query for issueSearchScore (fold once, not per issue). */
export function issueSearchTerms(text: string): IssueSearchTerms {
  const folded = foldText(text.trim());
  return {
    folded,
    words: folded.split(/\s+/).filter((word) => word !== ''),
  };
}

// Per snapshot (one per mirror version and viewer scope, so an old one is
// collected with it): every issue's folded title by issue id.
const titleCache = new WeakMap<Snapshot, ReadonlyMap<string, string>>();

/**
 * The folded titles of a snapshot's issues by issue id, computed once per
 * snapshot (a WeakMap keyed by the snapshot), so repeated searches over
 * the same mirror fold each title once.
 */
export function foldedTitles(snapshot: Snapshot): ReadonlyMap<string, string> {
  const cached = titleCache.get(snapshot);
  if (cached !== undefined) return cached;
  const titles = new Map<string, string>();
  for (const issue of snapshot.issues.values()) {
    titles.set(issue.id, foldText(issue.title));
  }
  titleCache.set(snapshot, titles);
  return titles;
}

/**
 * How well an issue matches: 0 identifier exact, 1 identifier prefix, 2
 * identifier contains, 3 every query word in the folded title; null for no
 * match. An empty query matches everything with 3. `identifier: false`
 * skips 0–2 (the issue list, for a query without a digit, so "eng" does
 * not match every ENG issue whatever its title).
 */
export function issueSearchScore(
  issue: Issue,
  terms: IssueSearchTerms,
  foldedTitle: string,
  options: { identifier?: boolean } = {}
): 0 | 1 | 2 | 3 | null {
  if (terms.folded === '') return 3;
  if (options.identifier !== false) {
    const key = issue.identifier.toLowerCase();
    if (key === terms.folded) return 0;
    if (key.startsWith(terms.folded)) return 1;
    if (key.includes(terms.folded)) return 2;
  }
  return terms.words.every((word) => foldedTitle.includes(word)) ? 3 : null;
}
