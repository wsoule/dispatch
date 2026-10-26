import type { TaskListItem } from '@dispatch-foo/core/browser';

// The Issues toolbar's search box, applied on the client before grouping: a
// task matches when every word typed is part of its title, its id, its tracker
// key (the Linear identifier, when the caller knows one) or one of its labels.
// Pure functions over plain data, so the view's test and the helper's own
// agree on what a query finds.

/** The words of a query: lower-cased, split on whitespace, blanks dropped. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Whether one task matches every search word. Words match case-insensitively
 * as substrings of the title, the id, `key` (a tracker identifier such as
 * "ENG-12", when given) and each label; no words matches everything.
 */
export function matchesIssueSearch(
  doc: TaskListItem,
  words: readonly string[],
  key?: string
): boolean {
  if (words.length === 0) return true;
  const { meta } = doc;
  const haystack = [meta.title, meta.id, key ?? '', ...meta.labels].map((s) =>
    s.toLowerCase()
  );
  return words.every((word) => haystack.some((text) => text.includes(word)));
}

/**
 * The tasks a query keeps. The same array comes back for a blank query, so
 * the common path with no query keeps its referential stability (and the
 * memos downstream do not recompute).
 */
export function filterBySearch(
  tasks: TaskListItem[],
  query: string,
  keyOf?: (doc: TaskListItem) => string | undefined
): TaskListItem[] {
  const words = searchWords(query);
  if (words.length === 0) return tasks;
  return tasks.filter((doc) => matchesIssueSearch(doc, words, keyOf?.(doc)));
}
