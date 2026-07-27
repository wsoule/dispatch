import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import { isPinnedToBottom } from '../lib/scroll';

interface StickToBottom {
  /** Attach to the `overflow-y-auto` element. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to the single child that wraps everything inside the scroller — its height is
   * what gets measured, so the scroller itself can't be used for this. */
  contentRef: React.RefObject<HTMLDivElement | null>;
  /** Forces a scroll to the bottom and re-pins, for moments the user clearly wants to be
   * back at the latest content (e.g. they just sent a message) even if they had scrolled up. */
  scrollToBottom: () => void;
}

/**
 * Keeps a scroll container stuck to its newest content — the run transcript's auto-scroll.
 *
 * The rule is "stick, don't yank": the container follows new content only while the user is
 * already parked at the bottom. Scroll up to read history and auto-scrolling switches off
 * until you come back down, so a chatty agent can't rip the view away mid-sentence.
 *
 * Growth is detected with a `ResizeObserver` on the content element rather than a render
 * effect keyed on message count, because the transcript also gets taller for reasons that
 * aren't new entries: markdown reflowing, a tool card expanding, the window resizing. The
 * scroller itself is observed too, so shrinking the viewport (a growing composer, a smaller
 * window) still lands on the latest content.
 *
 * `resetKey` re-pins and jumps to the bottom whenever it changes — pass the run id, since
 * this view is reused across runs rather than remounted, and a newly selected run should
 * always open at its latest output.
 */
export function useStickToBottom(resetKey: string): StickToBottom {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Not state: nothing renders differently based on it, and the scroll/resize handlers below
  // need to read the current value without re-subscribing on every change.
  const pinnedRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    pinnedRef.current = true;
    const scroller = scrollRef.current;
    if (scroller === null) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, []);

  // Layout effect (not a plain effect) so switching runs paints already scrolled to the
  // bottom instead of flashing the top of the transcript first.
  useLayoutEffect(() => {
    scrollToBottom();
  }, [resetKey, scrollToBottom]);

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (scroller === null || content === null) return;

    function handleScroll() {
      pinnedRef.current = isPinnedToBottom(scroller);
    }

    const observer = new ResizeObserver(() => {
      if (!pinnedRef.current) return;
      scroller.scrollTop = scroller.scrollHeight;
    });

    scroller.addEventListener('scroll', handleScroll, { passive: true });
    observer.observe(content);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', handleScroll);
      observer.disconnect();
    };
  }, []);

  return { scrollRef, contentRef, scrollToBottom };
}
