import type { Virtualizer } from '@tanstack/react-virtual';
import { flushSync } from 'react-dom';

type OffsetListener = (offset: number, isScrolling: boolean) => void;

// One per scroller its tracks share: the tracks listening, and how to stop.
interface Hub {
  tracks: Set<OffsetListener>;
  detach: () => void;
}

const hubs = new WeakMap<HTMLElement, Hub>();

function hubFor(element: HTMLElement, win: Window, resetDelay: number): Hub {
  const existing = hubs.get(element);
  if (existing !== undefined) return existing;
  const tracks = new Set<OffsetListener>();
  let settleTimer: number | null = null;
  // The stock observer's end of a scroll: every track hears `isScrolling` go false.
  const settle = () => {
    settleTimer = null;
    for (const track of tracks) track(element.scrollTop, false);
  };
  const onScroll = () => {
    if (settleTimer !== null) win.clearTimeout(settleTimer);
    settleTimer = win.setTimeout(settle, resetDelay);
    const offset = element.scrollTop;
    flushSync(() => {
      for (const track of tracks) track(offset, true);
    });
  };
  element.addEventListener('scroll', onScroll, { passive: true });
  const hub: Hub = {
    tracks,
    detach: () => {
      element.removeEventListener('scroll', onScroll);
      if (settleTimer !== null) win.clearTimeout(settleTimer);
      hubs.delete(element);
    },
  };
  hubs.set(element, hub);
  return hub;
}

/**
 * `observeElementOffset` for vertical tracks sharing one scroller (the board's columns).
 * One scroll listener per scroller tells every track inside a single `flushSync`, so a
 * scroll re-renders them all in one commit before the frame paints: not one commit and
 * layout per track (each track's own flushSync), nor one render a frame late (none),
 * which paints the columns' new rows missing on a scroll past the overscan. Tracks using
 * it must set `useFlushSync: false`, or each would still commit on its own.
 */
export function observeSharedOffset(
  instance: Virtualizer<HTMLElement, HTMLDivElement>,
  listener: OffsetListener
): (() => void) | undefined {
  const element = instance.scrollElement;
  const win = instance.targetWindow;
  if (element === null || win === null) return undefined;
  const hub = hubFor(element, win, instance.options.isScrollingResetDelay);
  hub.tracks.add(listener);
  return () => {
    if (hub.tracks.delete(listener) && hub.tracks.size === 0) hub.detach();
  };
}
