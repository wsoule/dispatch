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

// Every tree under `root`, crossing into open shadow roots. Pierre renders each file into a
// custom element with its own shadow root on some surfaces, and `querySelectorAll` stops at that
// boundary — so a search that only looks at the light DOM finds no rows at all there.
function treesUnder(root: ParentNode): ParentNode[] {
  const trees = [root];
  for (let index = 0; index < trees.length; index += 1) {
    const tree = trees[index];
    if (tree === undefined) continue;
    for (const element of Array.from(tree.querySelectorAll('*'))) {
      if (element.shadowRoot !== null) trees.push(element.shadowRoot);
    }
  }
  return trees;
}

/**
 * Every rendered code row inside `container`, gutters excluded.
 *
 * The gutter exclusion is not belt-and-braces: gutter items carry `data-line-type` and
 * `data-column-number` but deliberately no `data-line` (Pierre's `createGutterItem`), and they
 * live in their own `[data-gutter]` subtree away from the code. Filtering on the attribute alone
 * already skips them; saying so here keeps a future gutter that *does* carry `data-line` from
 * quietly arming a bar over code the reviewer never selected.
 */
export function diffRowsIn(container: ParentNode): Element[] {
  return treesUnder(container)
    .flatMap((tree) => Array.from(tree.querySelectorAll('[data-line]')))
    .filter((row) => row.closest('[data-gutter]') === null);
}

/**
 * The rendered rows the selection crosses, in document order, restricted to the side that is
 * actually in the code under review. `ranges` are tried in order — a shadow-DOM selection is
 * reported differently by different engines, so the caller offers every reading it can get.
 *
 * Every row the range *crosses* is considered, not just the two it starts and ends on. Those two
 * boundaries are the least reliable part of a selection: a drag released in the gap between rows
 * lands on a container with no row above it, and in a split diff — the default layout — a drag
 * down one column can begin or end in the other.
 *
 * Deletion-side rows are dropped rather than the whole selection refused: a drag down the
 * additions column that clips the deleted column still means the additions it covered. An empty
 * result means the selection was entirely on the deleted side, or reached no row at all — an
 * engine that retargets a shadow-DOM selection hands back the host.
 */
export function rowsCoveredBy(ranges: Range[], rows: Element[]): Element[] {
  for (const range of ranges) {
    const covered = rows.filter((row) => {
      try {
        return overlaps(range, row) && !isDeletionSide(row);
      } catch {
        // Comparing boundary points across two trees throws. That is not a selection that
        // covers this row, and it must not take the rest of the handler down with it.
        return false;
      }
    });
    if (covered.length > 0) return covered;
  }
  return [];
}

/**
 * Which lines those rows are, read straight off the attributes Pierre renders (`data-line`,
 * `data-line-type` — see its own `utils/processLine`, and the hit-testing in
 * `managers/InteractionManager.resolvePointerTarget` that reads the same ones).
 *
 * This is the answer the rendered diff already knows, so it needs no file fetch, no string
 * search and no round trip — which matters because a selection is a live gesture and anything
 * that can fail would otherwise take the whole action bar down with it.
 */
export function linesFromRows(rows: Element[]): SelectedLines | null {
  const lines: number[] = [];
  for (const row of rows) {
    const line = Number.parseInt(row.getAttribute('data-line') ?? '', 10);
    if (Number.isFinite(line)) lines.push(line);
  }
  if (lines.length === 0) return null;
  return {
    startLine: Math.min(...lines),
    endLine: Math.max(...lines),
  };
}
