// Decides when a daemon nobody is using should exit on its own.
//
// `dispatch ui`, `dispatch orchestrate` and every other command that needs a
// daemon spawn one detached, so it outlives the command — and, before this
// existed, everything else too. A leftover daemon keeps its background
// timers running: PR polls, archive reconciliation, and (whenever a client
// reconnects) `git fetch` against origin, which with an SSH agent that gates
// every signature is an unlock prompt for a window nobody has open.
//
// The daemon counts as idle only when BOTH hold for `timeoutMs`:
//  - no HTTP request started or finished, and none is still in flight (a
//    blocking msg_send long-polls for its answer for its whole wait);
//  - `isBusy()` stayed false — the caller's list of long-lived work
//    (connected sockets, live runs, a non-empty merge queue, open terminals).
//
// Idleness is counted in consecutive quiet ticks, not wall-clock time since
// the last request. A laptop that sleeps for an hour fires one late tick on
// wake, not an hour's worth, so a daemon whose desktop client is about to
// reconnect is not shut down the instant the lid opens.
export interface IdleShutdownOptions {
  timeoutMs: number;
  // How often to check. Defaults to a minute, or the timeout itself when
  // that is shorter; tests pass something tiny.
  checkIntervalMs?: number;
  // True while long-lived work the daemon must stay up for is under way.
  isBusy: () => boolean;
  onIdle: () => void;
}

export class IdleShutdown {
  private inFlight = 0;
  // Bumped on every request start and end; a tick that sees a different
  // value than the last one knows something happened in between.
  private activitySeq = 0;
  private seenSeq = 0;
  private quietTicks = 0;
  private readonly ticksNeeded: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private fired = false;

  constructor(private readonly opts: IdleShutdownOptions) {
    const interval = Math.min(opts.checkIntervalMs ?? 60_000, opts.timeoutMs);
    this.ticksNeeded = Math.max(1, Math.ceil(opts.timeoutMs / interval));
    this.timer = setInterval(() => this.tick(), interval);
    // Never the reason the process stays up: stop() and a signal both end
    // the daemon without waiting on this.
    this.timer.unref?.();
  }

  // Wraps one request so it counts as activity for its whole duration.
  async track<T>(work: () => Promise<T>): Promise<T> {
    this.inFlight += 1;
    this.activitySeq += 1;
    try {
      return await work();
    } finally {
      this.inFlight -= 1;
      this.activitySeq += 1;
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private tick(): void {
    if (this.fired) return;
    const active =
      this.inFlight > 0 ||
      this.activitySeq !== this.seenSeq ||
      this.opts.isBusy();
    this.seenSeq = this.activitySeq;
    if (active) {
      this.quietTicks = 0;
      return;
    }
    this.quietTicks += 1;
    if (this.quietTicks < this.ticksNeeded) return;
    this.fired = true;
    this.stop();
    this.opts.onIdle();
  }
}
