// A per-key fixed-window rate limiter: caps how many times one key (a
// visitor's IP) may pass in a rolling window, so a single address can't spin
// up sessions fast enough to exhaust SessionManager's cap for everyone else.
export interface RateLimiterOptions {
  limit?: number;
  windowMs?: number;
}

interface Window {
  count: number;
  start: number;
}

const DEFAULT_WINDOW_MS = 60_000;
// Evicts windows nobody has touched in a while so a long-lived process
// doesn't accumulate one Map entry per distinct visitor forever.
const SWEEP_INTERVAL_MS = 5 * 60_000;

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly sweepInterval: ReturnType<typeof setInterval>;

  constructor(opts: RateLimiterOptions = {}) {
    this.limit = opts.limit ?? 6;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.sweepInterval = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepInterval.unref?.();
  }

  /** True (and counted toward the window) if `key` hasn't hit the cap yet. */
  allow(key: string): boolean {
    const now = Date.now();
    const w = this.windows.get(key);
    if (w === undefined || now - w.start >= this.windowMs) {
      this.windows.set(key, { count: 1, start: now });
      return true;
    }
    if (w.count >= this.limit) return false;
    w.count += 1;
    return true;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, w] of this.windows) {
      if (now - w.start >= this.windowMs) this.windows.delete(key);
    }
  }

  stop(): void {
    clearInterval(this.sweepInterval);
  }
}
