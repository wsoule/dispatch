/** One tree-row decoration. `@pierre/trees` renders a single text-or-icon
 *  value per row, so everything worth saying composes into one token. */
export interface RowDecoration {
  text: string;
  title: string;
}

/**
 * The decoration for one file row: its unresolved comment count and its viewed
 * tick. Returns null for a file with neither, so an untouched tree stays clean
 * rather than carrying a column of empty markers.
 */
export function composeRowDecoration(input: {
  viewed: boolean;
  comments: number;
}): RowDecoration | null {
  const parts: string[] = [];
  const titles: string[] = [];
  if (input.comments > 0) {
    parts.push(String(input.comments));
    titles.push(
      `${input.comments} unresolved comment${input.comments === 1 ? '' : 's'}`
    );
  }
  if (input.viewed) {
    parts.push('✓');
    titles.push('Viewed');
  }
  if (parts.length === 0) return null;
  return { text: parts.join(' '), title: titles.join(' · ') };
}
