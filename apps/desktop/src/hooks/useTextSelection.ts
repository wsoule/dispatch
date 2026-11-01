import { type RefObject, useEffect, useState } from 'react';

/** A text selection inside a container: what was selected and where it sits
 * on screen (viewport coordinates). */
export type TextSelection = { text: string; rect: DOMRect };

/**
 * The document's selection when it is a non-collapsed range wholly inside
 * `container`, else null (no selection, a bare caret, or a selection that
 * starts or ends outside it). Read synchronously, so a host can check the
 * settled selection on pointerup without waiting for `selectionchange`.
 */
export function selectionWithin(
  container: HTMLElement | null
): TextSelection | null {
  const selection = document.getSelection();
  if (
    container === null ||
    selection === null ||
    selection.isCollapsed ||
    selection.rangeCount === 0
  ) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const text = selection.toString();
  if (text.trim() === '') return null;
  return { text, rect: range.getBoundingClientRect() };
}

/**
 * Follows the document selection scoped to `ref`'s subtree through the
 * `selectionchange` event: the current selection inside it, or null when
 * there is none there. A new value on every change, so a host's effect can
 * react to each new selection.
 */
export function useTextSelection(
  ref: RefObject<HTMLElement | null>
): TextSelection | null {
  const [selection, setSelection] = useState<TextSelection | null>(null);
  useEffect(() => {
    const onChange = (): void => {
      const next = selectionWithin(ref.current);
      // Stay on the same null while nothing is selected here, so selecting
      // text elsewhere on the page does not redraw the host.
      setSelection((current) =>
        next === null && current === null ? current : next
      );
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, [ref]);
  return selection;
}
