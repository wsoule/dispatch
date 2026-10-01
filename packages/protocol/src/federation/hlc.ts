// The largest counter an op's clock may carry: nine digits, far below 2^53,
// so counters compare exactly. OpClock ticks into the next ms at the bound.
export const MAX_HLC_COUNTER = 999_999_999;

// `<ms>.<counter>.<replica>`, compared numerically, since the counter can
// outgrow its four-digit padding; nine digits at most, per MAX_HLC_COUNTER.
const HLC = /^(\d{13})\.(\d{4,9})\.(.+)$/;

export interface ParsedHlc {
  ms: number;
  counter: number;
  replica: string;
}

export function parseOpHlc(hlc: string): ParsedHlc | null {
  const m = HLC.exec(hlc);
  if (m === null) return null;
  return { ms: Number(m[1]), counter: Number(m[2]), replica: m[3] ?? '' };
}

export function compareHlc(a: ParsedHlc, b: ParsedHlc): number {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return 0;
}

// FW-R21: how far ahead of the local wall clock a reading may be and still be
// adopted; an op stamped further ahead waits until the clock catches up.
export const MAX_CLOCK_LEAD_MS = 10 * 60 * 1000;

/** Whether a reading's wall time is past the bound for the wall time `nowMs`. */
export function aheadOfClock(hlc: string, nowMs: number): boolean {
  const clock = readClamped(hlc);
  return clock !== null && clock.ms > nowMs + MAX_CLOCK_LEAD_MS;
}

export function hlcWallMs(hlc: string): number | null {
  return parseOpHlc(hlc)?.ms ?? null;
}

// Any `<ms>.<counter>.` reading, v1's unbounded counters included, with the
// counter clamped to MAX_HLC_COUNTER so a clock can adopt it and stay parseable.
function readClamped(hlc: string): { ms: number; counter: number } | null {
  const m = /^(\d{13})\.(\d{4,})\./.exec(hlc);
  if (m === null) return null;
  return {
    ms: Number(m[1]),
    counter: Math.min(Number(m[2]), MAX_HLC_COUNTER),
  };
}

// The hybrid logical clock that stamps ops. Its counter never passes
// MAX_HLC_COUNTER: at the bound a tick moves into the next ms instead.
export class OpClock {
  private ms: number;
  private counter: number;

  constructor(
    private readonly replica: string,
    last: string | null = null,
    private readonly now: () => number = Date.now
  ) {
    const start = last === null ? null : readClamped(last);
    this.ms = start?.ms ?? 0;
    this.counter = start?.counter ?? 0;
  }

  /** A reading for a change made now, after every reading seen so far. */
  tick(): string {
    const wall = this.now();
    if (wall > this.ms) {
      this.ms = wall;
      this.counter = 0;
    } else if (this.counter < MAX_HLC_COUNTER) {
      this.counter += 1;
    } else {
      this.ms += 1;
      this.counter = 0;
    }
    return this.last;
  }

  /** Moves past a reading from elsewhere, so the next tick sorts after it,
   *  unless it is past the bound (FW-R21); false when it refused. */
  observe(remote: string): boolean {
    const clock = readClamped(remote);
    if (clock === null) return true;
    if (clock.ms > this.now() + MAX_CLOCK_LEAD_MS) return false;
    if (
      clock.ms > this.ms ||
      (clock.ms === this.ms && clock.counter > this.counter)
    ) {
      this.ms = clock.ms;
      this.counter = clock.counter;
    }
    return true;
  }

  /** The latest reading, for persisting across restarts. */
  get last(): string {
    return `${String(this.ms).padStart(13, '0')}.${String(this.counter).padStart(4, '0')}.${this.replica}`;
  }
}
