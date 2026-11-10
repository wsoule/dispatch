// The milestone rubric's "Done means…" outcome lives in the milestone's
// description as one line ("Done means: a guest can pay"), which is where
// @dispatch/planning's resolveDoneMeans reads it. These helpers rewrite that
// line in place so editing the outcome never disturbs the rest of the text.

// A line that states the outcome, after any markdown list, quote or heading
// marker: the same lines resolveDoneMeans would read.
const DONE_MEANS_LINE =
  /^\s*(?:(?:[-*+]|\d+[.)])\s+|>\s*|#{1,6}\s+)*[\s*_]*done means\b/i;

/** The outcome a description's "Done means:" line states, or '' for none. */
export function doneMeansOf(description: string): string {
  for (const line of description.split('\n')) {
    if (!DONE_MEANS_LINE.test(line)) continue;
    const outcome = line
      .replace(DONE_MEANS_LINE, '')
      .replace(/^[\s:—–*_-]+/, '')
      .replace(/[*_\s]+$/, '');
    if (outcome !== '') return outcome;
  }
  return '';
}

/**
 * The description with its "Done means:" line set to `outcome`: the first such
 * line replaced in place, or a new line put first when there is none. A blank
 * outcome removes the line (and one blank line after it, so no gap is left).
 */
export function withDoneMeans(description: string, outcome: string): string {
  const text = outcome.replace(/\s+/g, ' ').trim();
  const lines = description.split('\n');
  const at = lines.findIndex((line) => DONE_MEANS_LINE.test(line));
  if (at === -1) {
    if (text === '') return description;
    const rest = description.trim();
    return rest === ''
      ? `Done means: ${text}`
      : `Done means: ${text}\n\n${rest}`;
  }
  if (text !== '') {
    lines[at] = `Done means: ${text}`;
    return lines.join('\n');
  }
  const drop = lines[at + 1]?.trim() === '' ? 2 : 1;
  lines.splice(at, drop);
  return lines.join('\n').trim();
}
