import { type RefObject, useEffect, useState } from 'react';

import { outermostHost } from './useShadowSelectionRect';

// Whether a selection endpoint lies inside `container`, following shadow hosts. A selection in
// the chat below the diff, or in a comment thread, must not arm the diff's action bar.
function isInside(container: HTMLElement, node: Node): boolean {
  if (container.contains(node)) return true;
  const host = outermostHost(node);
  return host !== null && container.contains(host);
}

/**
 * The code the reviewer has selected with the pointer, as text.
 *
 * This is the signal the selection bar runs on, and it is deliberately *not* Pierre's
 * `onSelectedLinesChange`: that fires only for a drag on the line-number column, and only when
 * the diff opts into `enableLineSelection` (it defaults to `false`, see
 * `InteractionManager.startLineSelectionFromPointerDown`). Dragging across the code itself —
 * the gesture this feature is named after — produces an ordinary DOM text selection and nothing
 * else, which is what this hook listens for.
 *
 * The text comes back verbatim, including indentation and the newlines between rows, because
 * that is what the caller matches against the file's own contents to learn which lines it is.
 */
export function useSelectedCodeText(
  containerRef: RefObject<HTMLElement | null>
): string | null {
  const [text, setText] = useState<string | null>(null);

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
        setText(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (
        !isInside(container, range.startContainer) &&
        !isInside(container, range.endContainer)
      ) {
        setText(null);
        return;
      }
      const selected = selection.toString();
      setText(selected === '' ? null : selected);
    }

    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
  }, [containerRef]);

  return text;
}
