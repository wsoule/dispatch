import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import type { LiveSegment } from './api';
import { type LiveTextState, liveTextStore } from './liveText';

/** A running turn's text as a view shows it: what it has written and its
 *  record does not hold as a row yet, one entry per segment. */
export interface LiveTextView {
  turnId: string;
  segments: LiveSegment[];
}

// The live text worth showing: none unless the turn is running, and no
// segment the record already holds as a row (`committed`, by stream id).
function visibleLive(
  running: boolean,
  committed: ReadonlySet<string>,
  state: LiveTextState | undefined
): LiveTextView | null {
  if (!running || !state?.turnId) return null;
  return {
    turnId: state.turnId,
    segments: state.segments.filter((s) => !committed.has(s.id)),
  };
}

/**
 * One key's live text (an Overseer conversation's, a run's) as a view shows
 * it, read from the window's live text store: null unless `running`, and
 * without the segments whose rows the record already holds (`committed`, the
 * rows' stream ids; pass a set that keeps its identity while the record does).
 *
 * Minus one blink, too. The refetch that brings a segment's row also brings a
 * `live` snapshot without that segment, but the store takes the snapshot as
 * the fetch lands and the record reaches the view a tick later, so for one
 * render the segment would be in neither: its text would blink out, and a
 * "working" row flash in. A segment shown last render is kept, in place,
 * while its turn runs and the record holds no row for it yet; the server only
 * drops a segment when it commits it, when the turn ends, or when it abandons
 * it (which the store records, so the segment goes at once).
 */
export function useLiveText(
  port: number | undefined,
  key: string | null,
  running: boolean,
  committed: ReadonlySet<string>
): LiveTextView | null {
  const state = useSyncExternalStore(liveTextStore.subscribe, () =>
    key === null ? undefined : liveTextStore.get(port, key)
  );
  const last = useRef<LiveTextView | null>(null);
  const live = useMemo(() => {
    const next = visibleLive(running, committed, state);
    const prev = last.current;
    if (next === null || prev?.turnId !== next.turnId) return next;
    const byId = new Map(next.segments.map((s) => [s.id, s]));
    const ended = new Set(state?.abandoned);
    const kept = prev.segments.flatMap((s) => {
      const now = byId.get(s.id);
      if (now !== undefined) return [now];
      return committed.has(s.id) || ended.has(s.id) ? [] : [s];
    });
    const shownBefore = new Set(prev.segments.map((s) => s.id));
    const segments = [
      ...kept,
      ...next.segments.filter((s) => !shownBefore.has(s.id)),
    ];
    return segments.length === next.segments.length
      ? next
      : { turnId: next.turnId, segments };
  }, [running, committed, state]);
  useEffect(() => {
    last.current = live;
  }, [live]);
  return live;
}
