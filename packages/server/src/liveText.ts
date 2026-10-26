import { randomBytes } from 'node:crypto';

/** One stretch of model text a running turn has not committed yet: one Claude
 *  text block, one Codex agentMessage item. */
export interface LiveSegment {
  id: string;
  text: string;
}

/**
 * The text a running turn has streamed but not committed to its record — the
 * `live` field GET /api/overseer/:id (and GET /api/runs/:id) answers with
 * while a turn runs, so a window that opens or reconnects mid-turn starts
 * from what was already said. A run has one turn, for its whole life.
 */
export interface LiveText {
  /** Per conversation (or run), monotonic for the daemon's life: never resets between turns. */
  seq: number;
  /** New for every turn. */
  turnId: string;
  /** The running turn's uncommitted segments, in the order they started. */
  segments: LiveSegment[];
}

interface LiveState extends LiveText {
  running: boolean;
}

/**
 * Live text per key (an Overseer conversation id, or a run id), in memory
 * only: nothing here is ever persisted, and a daemon restart starts every
 * `seq` over (the websocket's `hello` tells clients to drop what they hold).
 *
 * Every write names the turn it belongs to, so a backend that keeps talking
 * after its turn ended (Stop settles the turn before the model stops) changes
 * nothing: a stale turn id is ignored.
 */
export class LiveTextBuffer {
  private readonly states = new Map<string, LiveState>();

  /** Starts a turn on `key` with no segments, keeping its `seq`; returns the new turn id. */
  begin(key: string): string {
    const turnId = `turn-${randomBytes(4).toString('hex')}`;
    const seq = this.states.get(key)?.seq ?? 0;
    this.states.set(key, { seq, turnId, segments: [], running: true });
    return turnId;
  }

  /** Whether `turnId` is the turn running on `key`. */
  isRunning(key: string, turnId: string): boolean {
    const state = this.states.get(key);
    return state?.running === true && state.turnId === turnId;
  }

  /**
   * Appends `text` to segment `segmentId` of the running turn (opening the
   * segment if it is new) and returns the frame's `seq`, or undefined when
   * `turnId` is not running on `key`.
   */
  append(
    key: string,
    turnId: string,
    segmentId: string,
    text: string
  ): number | undefined {
    const state = this.states.get(key);
    if (state === undefined || !this.isRunning(key, turnId)) return undefined;
    const segment = state.segments.find((s) => s.id === segmentId);
    if (segment === undefined) state.segments.push({ id: segmentId, text });
    else segment.text += text;
    state.seq += 1;
    return state.seq;
  }

  /**
   * Drops a segment of the running turn that will never be committed (its
   * stream broke off) and returns the `seq` of the frame that says so, or
   * undefined when there is no such segment.
   */
  abandon(key: string, turnId: string, segmentId: string): number | undefined {
    const state = this.states.get(key);
    if (state === undefined || !this.isRunning(key, turnId)) return undefined;
    if (!state.segments.some((s) => s.id === segmentId)) return undefined;
    state.segments = state.segments.filter((s) => s.id !== segmentId);
    state.seq += 1;
    return state.seq;
  }

  /** Drops one segment of the running turn: its text is on the record now. */
  drop(key: string, turnId: string, segmentId: string): void {
    const state = this.states.get(key);
    if (state === undefined || !this.isRunning(key, turnId)) return;
    state.segments = state.segments.filter((s) => s.id !== segmentId);
  }

  /**
   * Ends the turn, however it ended, and returns the segments it never
   * committed, in order. `seq` carries on into the next turn. Ending a turn
   * that is not the running one returns nothing.
   */
  end(key: string, turnId: string): LiveSegment[] {
    const state = this.states.get(key);
    if (state === undefined || !this.isRunning(key, turnId)) return [];
    const left = state.segments;
    state.segments = [];
    state.running = false;
    return left;
  }

  /**
   * Forgets `key` for good, its `seq` too, ending a turn still running. For
   * a key that takes no more turns (a run that ended), so the buffer does
   * not keep one entry per run for the daemon's life.
   */
  forget(key: string): void {
    this.states.delete(key);
  }

  /** A copy of `key`'s running turn, or undefined when none runs. */
  snapshot(key: string): LiveText | undefined {
    const state = this.states.get(key);
    if (state === undefined || !state.running) return undefined;
    return {
      seq: state.seq,
      turnId: state.turnId,
      segments: state.segments.map((s) => ({ ...s })),
    };
  }
}
