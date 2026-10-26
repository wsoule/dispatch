import type { LiveSegment, LiveText } from './api';

/**
 * Live text: what a running turn has streamed and not committed to its record
 * yet, folded from the daemon's delta frames (`overseer.delta`, `run.delta`)
 * and repaired from the `live` snapshot its record's read carries
 * (GET /api/overseer/:id, GET /api/runs/:id).
 *
 * The frames are view-only and may be missed (a dropped socket, a window that
 * opened mid-turn), so each carries the key's `seq`. A frame that does not
 * follow the last one leaves the key *stale*: frames past the gap are held,
 * the caller is asked once to refetch the record, and its snapshot plus the
 * held frames rebuild the text. The reducer is pure; `LiveTextStore` holds the
 * states for `useSyncExternalStore` and runs the repair callbacks.
 */

/** One delta frame as the store reads it: `text` extends segment `segmentId` of turn `turnId`. */
export interface LiveFrame {
  turnId: string;
  seq: number;
  segmentId: string;
  text: string;
  /** Ends segment `segmentId` instead: no row will ever replace it (the model's stream broke off). */
  abandoned?: boolean;
}

/** One key's live text as a client holds it. */
export interface LiveTextState {
  /** The turn `segments` belong to; null until a frame or a snapshot names one. */
  turnId: string | null;
  /** The last frame folded into `segments` (0 before any). */
  seq: number;
  segments: LiveSegment[];
  /** A frame was missed: `segments` lag until a snapshot fills the gap. */
  stale: boolean;
  /** Frames past the gap, oldest first, replayed once a snapshot lands. */
  held: LiveFrame[];
  /** Segments of `turnId` that ended with no row to replace them; absent when none. */
  abandoned?: readonly string[];
}

/** A reducer step: the next state, and whether the caller should refetch the record. */
export interface LiveTextStep {
  state: LiveTextState | undefined;
  repair: boolean;
}

// Frames held while stale. A key nobody is repairing (a conversation open in
// another window only) would otherwise hold every frame of its turn; the
// snapshot that ends the gap covers the oldest ones anyway.
const MAX_HELD = 2000;

const EMPTY: LiveTextState = {
  turnId: null,
  seq: 0,
  segments: [],
  stale: false,
  held: [],
};

// Folds a frame that directly follows `state` into its segments; a frame of a
// new turn starts that turn's segments empty. An abandoning frame removes its
// segment and remembers it as abandoned for the rest of the turn.
function append(state: LiveTextState, frame: LiveFrame): LiveTextState {
  const sameTurn = frame.turnId === state.turnId;
  const segments = sameTurn ? state.segments : [];
  const abandoned = sameTurn ? (state.abandoned ?? []) : [];
  const base = {
    turnId: frame.turnId,
    seq: frame.seq,
    stale: state.stale,
    held: state.held,
  };
  if (frame.abandoned === true) {
    return {
      ...base,
      segments: segments.filter((s) => s.id !== frame.segmentId),
      abandoned: [...abandoned, frame.segmentId],
    };
  }
  const at = segments.findIndex((s) => s.id === frame.segmentId);
  return {
    ...base,
    segments:
      at === -1
        ? [...segments, { id: frame.segmentId, text: frame.text }]
        : segments.map((s, i) =>
            i === at ? { ...s, text: s.text + frame.text } : s
          ),
    ...(abandoned.length > 0 ? { abandoned } : {}),
  };
}

// Adds `frame` to the held frames, in seq order, without duplicates.
function hold(held: LiveFrame[], frame: LiveFrame): LiveFrame[] {
  if (held.some((h) => h.seq === frame.seq)) return held;
  const next = [...held, frame].sort((a, b) => a.seq - b.seq);
  return next.length > MAX_HELD ? next.slice(next.length - MAX_HELD) : next;
}

/**
 * Folds one frame. The next frame (`seq` one past the last) appends, starting
 * a new turn's segments empty; an old or repeated one is ignored. Anything
 * else is a gap: the frame is held and the key goes stale, asking for a repair
 * only on the way in, so a burst of frames past one gap refetches once. A key
 * with no state counts as being at seq 0: only the conversation's very first
 * frame can be placed without a snapshot.
 */
export function applyDelta(
  state: LiveTextState | undefined,
  frame: LiveFrame
): LiveTextStep {
  const current = state ?? EMPTY;
  if (frame.seq <= current.seq) return { state, repair: false };
  if (!current.stale && frame.seq === current.seq + 1) {
    return { state: append(current, frame), repair: false };
  }
  return {
    state: { ...current, stale: true, held: hold(current.held, frame) },
    repair: !current.stale,
  };
}

/**
 * Merges the `live` snapshot of a freshly fetched record. It replaces the
 * local text unless the local text is newer (a frame arrived after the record
 * was read); then the held frames past it replay while they follow on. A gap
 * left over keeps the key stale and asks for one more repair. A record with
 * no `live` (no turn running, or a daemon too old to stream) clears the text.
 */
export function mergeSnapshot(
  state: LiveTextState | undefined,
  live: LiveText | undefined
): LiveTextStep {
  if (live === undefined) {
    const clear =
      state === undefined ||
      (state.segments.length === 0 && !state.stale && state.held.length === 0);
    if (clear) return { state, repair: false };
    return {
      state: { ...state, segments: [], stale: false, held: [] },
      repair: false,
    };
  }
  const current = state ?? EMPTY;
  // The snapshot no longer holds an abandoned segment; the view still needs
  // to know it ended, for as long as its turn runs.
  const abandoned =
    live.turnId === current.turnId ? current.abandoned : undefined;
  let next: LiveTextState =
    current.turnId === null || live.seq >= current.seq
      ? {
          turnId: live.turnId,
          seq: live.seq,
          segments: live.segments.map((s) => ({ ...s })),
          stale: false,
          held: [],
          ...(abandoned === undefined ? {} : { abandoned }),
        }
      : { ...current, held: [] };
  const later = current.held.filter((f) => f.seq > next.seq);
  let replayed = 0;
  while (replayed < later.length && later[replayed].seq === next.seq + 1) {
    next = append(next, later[replayed]);
    replayed += 1;
  }
  const left = later.slice(replayed);
  const stale = left.length > 0;
  return { state: { ...next, stale, held: left }, repair: stale };
}

/**
 * Removes one segment from the key's text, keeping its `seq`: the segment's
 * row has reached the record (a run.log entry naming it as `streamId`), so the
 * store need not keep its text. A no-op when the key has no such segment.
 */
export function dropSegment(
  state: LiveTextState | undefined,
  segmentId: string
): LiveTextStep {
  if (state === undefined || !state.segments.some((s) => s.id === segmentId)) {
    return { state, repair: false };
  }
  return {
    state: {
      ...state,
      segments: state.segments.filter((s) => s.id !== segmentId),
    },
    repair: false,
  };
}

/** The key live text is stored under for an Overseer conversation. */
export function overseerLiveKey(conversationId: string): string {
  return `overseer:${conversationId}`;
}

/** The key live text is stored under for a task run. */
export function runLiveKey(runId: string): string {
  return `run:${runId}`;
}

/**
 * Every key's live text for each daemon (by port), shared by every surface of
 * a window: the websocket handler feeds it, the record queries repair it, and
 * views read it through `subscribe`/`get` (`useSyncExternalStore`). A state
 * object is replaced on every change and kept otherwise, so `get` is a stable
 * snapshot.
 */
export class LiveTextStore {
  private readonly ports = new Map<
    number | undefined,
    Map<string, LiveTextState>
  >();
  private readonly listeners = new Set<() => void>();

  get(port: number | undefined, key: string): LiveTextState | undefined {
    return this.ports.get(port)?.get(key);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Folds one frame; `requestRepair` refetches the key's record when it fell behind. */
  applyDelta(
    port: number | undefined,
    key: string,
    frame: LiveFrame,
    requestRepair: () => void
  ): void {
    this.step(port, key, applyDelta(this.get(port, key), frame), requestRepair);
  }

  /** Merges a fetched record's `live`; `requestRepair` as for applyDelta. */
  mergeSnapshot(
    port: number | undefined,
    key: string,
    live: LiveText | undefined,
    requestRepair: () => void
  ): void {
    this.step(
      port,
      key,
      mergeSnapshot(this.get(port, key), live),
      requestRepair
    );
  }

  /** Drops one segment whose row the record now holds; see dropSegment. */
  drop(port: number | undefined, key: string, segmentId: string): void {
    this.step(port, key, dropSegment(this.get(port, key), segmentId), () => {});
  }

  /**
   * Forgets one key, for a run that ended: it takes no more frames, and its
   * state would otherwise stay until the daemon's next `hello`.
   */
  forget(port: number | undefined, key: string): void {
    if (this.ports.get(port)?.delete(key) === true) this.notify();
  }

  /**
   * Forgets everything held for one daemon. Called on the websocket's
   * `hello`: a daemon that restarted counts `seq` from zero again, so nothing
   * held from before can be placed against its frames.
   */
  reset(port: number | undefined): void {
    if (this.ports.delete(port)) this.notify();
  }

  private step(
    port: number | undefined,
    key: string,
    { state, repair }: LiveTextStep,
    requestRepair: () => void
  ): void {
    const keys = this.ports.get(port) ?? new Map<string, LiveTextState>();
    const before = keys.get(key);
    if (state !== before) {
      if (state === undefined) keys.delete(key);
      else keys.set(key, state);
      this.ports.set(port, keys);
      this.notify();
    }
    if (repair) requestRepair();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The live text store every surface of this window reads. */
export const liveTextStore = new LiveTextStore();

/**
 * Forgets every key's live text for one daemon. The websocket handler calls it
 * on `hello`: the daemon may have restarted, and a restarted daemon counts
 * `seq` from zero, so nothing held from before can be placed against it.
 */
export function resetLiveText(port: number | undefined): void {
  liveTextStore.reset(port);
}
