import { type RefObject, useEffect, useState } from 'react';

// Walks a node up through shadow-root boundaries to the outermost host element that still
// has layout, i.e. escapes however many `#shadow-root`s the node is nested in. Pierre renders
// diff content inside shadow DOM, so a selection anchored deep inside it needs this walk before
// its geometry means anything relative to the page.
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

/**
 * Tracks the bounding rect of the current text selection, in the coordinate space of
 * `containerRef`. This is the one Pierre-aware piece of the selection feature: everything else
 * (`SelectionActions`) is generic and knows nothing about shadow DOM.
 *
 * `Range.getBoundingClientRect()` is viewport-relative and, in engines with full shadow-DOM
 * selection support, already resolves correctly for a range anchored inside an open shadow
 * root. Where it doesn't (e.g. a range collapsed to zero size because the selection API in the
 * host engine did not retarget into the shadow tree), we fall back to the bounding rect of the
 * outermost shadow host, found by walking `getRootNode()` until it stops returning a
 * `ShadowRoot`. Either way the result is converted into `containerRef`'s coordinate space so the
 * overlay can be positioned with plain `position: absolute` inside that container.
 *
 * Under happy-dom (the unit test environment) selections have no layout, so this returns `null`
 * — callers must treat that as "unpositioned", not "absent".
 */
export function useShadowSelectionRect(
  containerRef: RefObject<HTMLElement | null>
): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    function measure() {
      const selection = window.getSelection();
      if (
        selection === null ||
        selection.isCollapsed ||
        selection.rangeCount === 0
      ) {
        setRect(null);
        return;
      }

      const range = selection.getRangeAt(0);
      let selectionRect = range.getBoundingClientRect();

      if (selectionRect.width === 0 && selectionRect.height === 0) {
        const host = outermostHost(range.startContainer);
        if (host === null) {
          setRect(null);
          return;
        }
        selectionRect = host.getBoundingClientRect();
      }

      if (selectionRect.width === 0 && selectionRect.height === 0) {
        setRect(null);
        return;
      }

      const container = containerRef.current;
      if (container === null) {
        setRect(null);
        return;
      }
      const containerRect = container.getBoundingClientRect();

      setRect(
        new DOMRect(
          selectionRect.left - containerRect.left,
          selectionRect.top - containerRect.top,
          selectionRect.width,
          selectionRect.height
        )
      );
    }

    document.addEventListener('selectionchange', measure);
    return () => document.removeEventListener('selectionchange', measure);
  }, [containerRef]);

  return rect;
}
