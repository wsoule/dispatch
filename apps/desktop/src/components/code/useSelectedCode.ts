import { type RefObject, useEffect, useState } from 'react';

import type { SelectedLines } from './selectedDiffLines';
import { diffLinesFromRange } from './selectedDiffLines';
import { outermostHost } from './useShadowSelectionRect';

/** What the reviewer has selected in a diff: the code itself, and the lines it was drawn on. */
export interface SelectedCode {
  text: string;
  /**
   * The lines the rendered rows say this is, or `null` when the range never reached a row — an
   * engine that retargets a shadow-DOM selection to its host, or a deletion-side row whose
   * number is not a line in the new file. The caller decides what to do without them.
   */
  lines: SelectedLines | null;
}

// Whether a selection endpoint lies inside `container`, following shadow hosts. A selection in
// the chat below the diff, or in a comment thread, must not arm the diff's action bar. The host
// walk is for the surfaces where Pierre renders into shadow DOM; where it renders into light DOM
// the plain `contains` already answers.
function isInside(container: HTMLElement, node: Node): boolean {
  if (container.contains(node)) return true;
  const host = outermostHost(node);
  return host !== null && container.contains(host);
}

function sameSelection(
  a: SelectedCode | null,
  b: SelectedCode | null
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.text === b.text &&
    a.lines?.startLine === b.lines?.startLine &&
    a.lines?.endLine === b.lines?.endLine
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
      const next =
        text === '' ? null : { text, lines: diffLinesFromRange(range) };
      setSelected((prev) => (sameSelection(prev, next) ? prev : next));
    }

    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
  }, [containerRef]);

  return selected;
}
