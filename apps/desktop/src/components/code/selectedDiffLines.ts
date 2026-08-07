/** The lines a selection covers, as the diff itself numbers them. */
export interface SelectedLines {
  startLine: number;
  endLine: number;
}

/**
 * Which side of a split diff a rendered row belongs to — Pierre's own rule, from
 * `InteractionManager.getAnnotationSide`: a changed line says so in its type, and a context line
 * (which exists on both sides, carrying a *different* line number in each) is placed by which of
 * the two `[data-code]` columns it sits in. Unified renders one column with neither attribute,
 * where every row's number is already the new file's.
 */
function isDeletionSide(row: Element): boolean {
  const type = row.getAttribute('data-line-type');
  if (type === 'change-deletion') return true;
  if (type === 'change-addition') return false;
  return row.closest('[data-code]')?.hasAttribute('data-deletions') === true;
}

// Whether `range` covers any of `row`'s content, as opposed to merely touching its edge. A drag
// released just past the end of a row ends at offset 0 of the next one, and that next row is not
// part of what the reviewer highlighted.
function overlaps(range: Range, row: Element): boolean {
  const rowRange = row.ownerDocument.createRange();
  rowRange.selectNodeContents(row);
  return (
    range.compareBoundaryPoints(Range.END_TO_START, rowRange) < 0 &&
    range.compareBoundaryPoints(Range.START_TO_END, rowRange) > 0
  );
}

// The subtree to look for rows in: the range's common ancestor, plus that ancestor itself when
// the whole selection sits inside one row (`querySelectorAll` never returns its own root).
function rowsUnder(range: Range): Element[] {
  const ancestor = range.commonAncestorContainer;
  const element =
    ancestor instanceof Element ? ancestor : ancestor.parentElement;
  if (element === null) return [];
  const own = element.closest('[data-line]');
  return [
    ...(own === null ? [] : [own]),
    ...Array.from(element.querySelectorAll('[data-line]')),
  ];
}

/**
 * Which lines a DOM range covers, read straight off the row attributes Pierre renders
 * (`data-line`, `data-line-type` — see its own `utils/processLine`, and the hit-testing in
 * `managers/InteractionManager.resolvePointerTarget` that reads the same ones).
 *
 * This is the answer the rendered diff already knows, so it needs no file fetch, no string
 * search and no round trip — which matters because a selection is a live gesture and anything
 * that can fail would otherwise take the whole action bar down with it.
 *
 * Every row the range *crosses* is considered, not just the two it starts and ends on. Those two
 * boundaries are the least reliable part of a selection: a drag released in the gap between rows
 * lands on a container with no row above it, and in a split diff — the default layout — a drag
 * down one column can begin or end in the other. Judging by what the range crosses means the
 * lines are the ones the reviewer highlighted, wherever the pointer happened to come to rest.
 *
 * Deletion-side rows are dropped rather than refused: a drag down the additions column that
 * clips the deleted column still means the additions the reviewer highlighted. Only a selection
 * that is *entirely* on the deleted side comes back `null`, because it has no line in the code
 * under review to name at all.
 */
export function diffLinesFromRange(range: Range): SelectedLines | null {
  const lines: number[] = [];
  for (const row of rowsUnder(range)) {
    if (!overlaps(range, row) || isDeletionSide(row)) continue;
    const line = Number.parseInt(row.getAttribute('data-line') ?? '', 10);
    if (Number.isFinite(line)) lines.push(line);
  }
  if (lines.length === 0) return null;
  return {
    startLine: Math.min(...lines),
    endLine: Math.max(...lines),
  };
}
