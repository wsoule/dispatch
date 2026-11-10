/**
 * Splitting a string into highlighted and plain runs, for scrollback search
 * (TerminalCanvas), which knows the substring it matched.
 *
 * The output is runs, not one element per character, so a long line is a
 * handful of DOM nodes rather than a hundred. Quick open's fuzzy positions
 * are drawn by @dispatch/ui's CommandPalette (`highlightRuns`), not here.
 */

export interface HighlightRun {
  text: string;
  hit: boolean;
}

// Appends to the previous run when it carries the same flag, so adjacent
// characters never each get their own element.
function push(runs: HighlightRun[], text: string, hit: boolean): void {
  const last = runs[runs.length - 1];
  if (last !== undefined && last.hit === hit) last.text += text;
  else runs.push({ text, hit });
}

/**
 * Runs from every case-insensitive occurrence of `needle`.
 *
 * An empty needle is one plain run rather than a match on everything — a
 * search box the user has not typed into yet should highlight nothing.
 */
export function runsFromNeedle(text: string, needle: string): HighlightRun[] {
  if (needle === '') return [{ text, hit: false }];
  const runs: HighlightRun[] = [];
  const haystack = text.toLowerCase();
  const lower = needle.toLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(lower, from);
    if (at === -1) break;
    if (at > from) push(runs, text.slice(from, at), false);
    push(runs, text.slice(at, at + needle.length), true);
    from = at + needle.length;
  }
  if (from < text.length) push(runs, text.slice(from), false);
  return runs;
}
