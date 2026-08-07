/** The lines a selection covers, as the diff itself numbers them. */
export interface SelectedLines {
  startLine: number;
  endLine: number;
}

// The nearest rendered diff row at or above `node`, crossing shadow boundaries. `closest` stops
// at a shadow root, so each miss hops to that root's host and keeps going — Pierre renders into
// light DOM on some surfaces and into shadow DOM on others, and this has to work on both.
function closestRow(node: Node): Element | null {
  let current: Element | null =
    node instanceof Element ? node : node.parentElement;
  while (current !== null) {
    const row = current.closest('[data-line]');
    if (row !== null) return row;
    const root = current.getRootNode();
    if (!(root instanceof ShadowRoot)) return null;
    current = root.host;
  }
  return null;
}

// The line number a row stands for. Deletion rows are refused: their number belongs to the base
// file, so quoting one would name a line that does not exist in the code under review.
function lineOfRow(row: Element): number | null {
  if (row.getAttribute('data-line-type') === 'change-deletion') return null;
  const value = Number.parseInt(row.getAttribute('data-line') ?? '', 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * Which lines a DOM range covers, read straight off the row attributes Pierre renders
 * (`data-line`, `data-line-type` — see its own `processLine`/`DiffHunksRenderer`, and the
 * hit-testing in `InteractionManager.resolvePointerTarget` that reads the same ones).
 *
 * This is the answer the rendered diff already knows, so it needs no file fetch, no string
 * search and no round trip — which matters because a selection is a live gesture and anything
 * that can fail (a worktree that has been cleaned up, a file whose bytes have moved on, text the
 * browser joined differently across rows) would otherwise take the whole action bar down with
 * it.
 *
 * `null` means the range did not resolve to rows — an engine that retargets the selection out of
 * the shadow tree hands back the host, and a deletion-side row has no line in the new file. The
 * caller falls back to locating the text in the file's contents.
 */
export function diffLinesFromRange(range: Range): SelectedLines | null {
  const startRow = closestRow(range.startContainer);
  const endRow = closestRow(range.endContainer);
  if (startRow === null || endRow === null) return null;
  const start = lineOfRow(startRow);
  const end = lineOfRow(endRow);
  if (start === null || end === null) return null;
  return {
    startLine: Math.min(start, end),
    endLine: Math.max(start, end),
  };
}
