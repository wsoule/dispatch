import { type RefObject, useEffect, useState } from 'react';

import type { SelectedLines } from './selectedDiffLines';
import { diffRowsFromRange, linesFromRows } from './selectedDiffLines';
import type { SelectionAnchor } from './SelectionActions';

/** What the reviewer has selected in a diff: the code itself, the lines it was drawn on, and
 * where those lines are on screen. */
export interface SelectedCode {
  text: string;
  /**
   * The lines the rendered rows say this is, or `null` when the range never reached a row — an
   * engine that retargets a shadow-DOM selection to its host, or a selection made entirely on
   * the deleted side, whose numbers are not lines in the new file. The caller decides what to do
   * without them.
   */
  lines: SelectedLines | null;
  /** Where to hang the action bar, or `null` for the same reasons `lines` is. */
  anchor: SelectionAnchor | null;
}

// Walks a node up through shadow-root boundaries to the outermost host element. Pierre renders
// diff content into shadow DOM on some surfaces, and an engine that does not retarget the
// selection hands back a node whose plain `contains` check against a light-DOM container would
// otherwise fail.
function outermostHost(node: Node): Element | null {
  let current: Node = node;
  let host: Element | null =
    current instanceof Element ? current : current.parentElement;
  for (
    let root = current.getRootNode();
    root instanceof ShadowRoot;
    root = current.getRootNode()
  ) {
    host = root.host;
    current = root.host;
  }
  return host;
}

// Whether a selection endpoint lies inside `container`. A selection in the chat below the diff,
// or in a comment thread, must not arm the diff's action bar.
function isInside(container: HTMLElement, node: Node): boolean {
  if (container.contains(node)) return true;
  const host = outermostHost(node);
  return host !== null && container.contains(host);
}

/**
 * Where the crossed rows sit, in the container's own coordinate space.
 *
 * Deliberately measured from the row elements rather than from the selection: an element's
 * `getBoundingClientRect()` is viewport-absolute and reads the same whether it sits inside a
 * shadow root or not, so the whole retargeting problem that made the previous positioning
 * unusable simply does not arise. Both rects are read in the same tick, so the subtraction is
 * correct whatever the scroll position is at that moment.
 */
function anchorFromRows(
  rows: Element[],
  container: HTMLElement
): SelectionAnchor | null {
  const first = rows.at(0);
  const last = rows.at(-1);
  if (first === undefined || last === undefined) return null;
  const box = container.getBoundingClientRect();
  const firstBox = first.getBoundingClientRect();
  const lastBox = last.getBoundingClientRect();
  return {
    top: firstBox.top - box.top,
    bottom: lastBox.bottom - box.top,
    left: firstBox.left - box.left,
    width: box.width,
  };
}

function sameSelection(
  a: SelectedCode | null,
  b: SelectedCode | null
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.text === b.text &&
    a.lines?.startLine === b.lines?.startLine &&
    a.lines?.endLine === b.lines?.endLine &&
    a.anchor?.top === b.anchor?.top &&
    a.anchor?.left === b.anchor?.left
  );
}

/**
 * The code the reviewer has selected with the pointer.
 *
 * This is the signal the selection bar runs on, and it is deliberately *not* Pierre's
 * `onSelectedLinesChange`: that fires only for a drag on the line-number column, and only when
 * the diff opts into `enableLineSelection` (it defaults to `false`, see
 * `InteractionManager.startLineSelectionFromPointerDown`). Dragging across the code itself —
 * the gesture this feature is named after — produces an ordinary DOM text selection and nothing
 * else, which is what this listens for.
 *
 * `selectionchange` fires continuously through a drag, so an unchanged selection returns the
 * same object: callers key effects off this value and must not be re-run per pixel.
 */
export function useSelectedCode(
  containerRef: RefObject<HTMLElement | null>
): SelectedCode | null {
  const [selected, setSelected] = useState<SelectedCode | null>(null);

  useEffect(() => {
    function read() {
      const container = containerRef.current;
      const selection = window.getSelection();
      if (
        container === null ||
        selection === null ||
        selection.isCollapsed ||
        selection.rangeCount === 0
      ) {
        setSelected(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (
        !isInside(container, range.startContainer) &&
        !isInside(container, range.endContainer)
      ) {
        setSelected(null);
        return;
      }
      const text = selection.toString();
      if (text === '') {
        setSelected(null);
        return;
      }
      const rows = diffRowsFromRange(range);
      const next: SelectedCode = {
        text,
        lines: linesFromRows(rows),
        anchor: anchorFromRows(rows, container),
      };
      setSelected((prev) => (sameSelection(prev, next) ? prev : next));
    }

    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
  }, [containerRef]);

  return selected;
}
