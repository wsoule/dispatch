// When the board is scrolling too fast for real cards: each card costs 1.5-2ms to mount, and
// a fling brings several into every column each frame, so the board draws placeholders
// until the scroll slows, then fills them in.

/** Scroll speed above which a sample counts as fast, px/ms — about 100px a frame. */
const FLING_SPEED = 6;
/** Fast samples in a row before the board is flinging, so one programmatic jump (a j/k
 * scroll-into-view) never counts. */
const FAST_STREAK = 2;
/** How long after the last fast sample real cards come back. */
export const FLING_SETTLE_MS = 120;

export interface FlingSample {
  top: number;
  at: number;
  /** Fast samples in a row, ending with this one. */
  streak: number;
}

export const FLING_REST: FlingSample = {
  top: 0,
  at: Number.NEGATIVE_INFINITY,
  streak: 0,
};

/** One scroll event → the next sample, and whether it keeps (or starts) a fling. */
export function sampleFling(
  prev: FlingSample,
  top: number,
  at: number
): { sample: FlingSample; fast: boolean } {
  const dt = at - prev.at;
  const speed =
    dt > 0 && Number.isFinite(dt) ? Math.abs(top - prev.top) / dt : 0;
  const streak = speed >= FLING_SPEED ? prev.streak + 1 : 0;
  return { sample: { top, at, streak }, fast: streak >= FAST_STREAK };
}

export interface FlingTracker {
  isFlinging: () => boolean;
  /** Called once when the current fling settles; returns an unsubscribe. */
  onSettle: (listener: () => void) => () => void;
}

export const NEVER_FLINGING: FlingTracker = {
  isFlinging: () => false,
  onSettle: () => () => {},
};

/**
 * Watches `element`'s scroll: flinging from the second fast sample in a row until
 * `FLING_SETTLE_MS` pass without one, then every settle listener fires once.
 */
export function trackFling(element: HTMLElement): {
  tracker: FlingTracker;
  dispose: () => void;
} {
  let sample = FLING_REST;
  let flinging = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const settle = () => {
    timer = null;
    flinging = false;
    const waiting = [...listeners];
    listeners.clear();
    for (const listener of waiting) listener();
  };
  const onScroll = () => {
    const next = sampleFling(sample, element.scrollTop, performance.now());
    sample = next.sample;
    if (!next.fast) return;
    flinging = true;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(settle, FLING_SETTLE_MS);
  };
  element.addEventListener('scroll', onScroll, { passive: true });
  return {
    tracker: {
      isFlinging: () => flinging,
      onSettle: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    dispose: () => {
      element.removeEventListener('scroll', onScroll);
      if (timer !== null) clearTimeout(timer);
      listeners.clear();
    },
  };
}
