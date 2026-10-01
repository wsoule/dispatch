const MINUTE_MS = 60_000;
const PRUNE_ABOVE = 4096;

// Per-IP limits for requests that carry no valid client bearer: card fetches
// per minute, and a lockout after repeated auth failures.
export class IpLimiter {
  private readonly cardHits = new Map<string, number[]>();
  private readonly failures = new Map<string, number[]>();
  private readonly locks = new Map<string, number>();

  constructor(
    private readonly opts: {
      now?: () => number;
      cardPerMinute?: number;
      failuresPerMinute?: number;
      lockMs?: number;
    } = {}
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  // Records a hit; returns seconds until the window frees up when it is full.
  private hit(
    map: Map<string, number[]>,
    key: string,
    limit: number
  ): number | null {
    const now = this.now();
    if (map.size > PRUNE_ABOVE) {
      for (const [k, times] of map)
        if (times.every((t) => t <= now - MINUTE_MS)) map.delete(k);
    }
    const recent = (map.get(key) ?? []).filter((t) => t > now - MINUTE_MS);
    if (recent.length >= limit) {
      map.set(key, recent);
      return Math.max(1, Math.ceil((recent[0] + MINUTE_MS - now) / 1000));
    }
    recent.push(now);
    map.set(key, recent);
    return null;
  }

  allowCard(ip: string | null): number | null {
    return this.hit(
      this.cardHits,
      ip ?? 'unknown',
      this.opts.cardPerMinute ?? 60
    );
  }

  lockedFor(ip: string | null): number | null {
    const until = this.locks.get(ip ?? 'unknown');
    const now = this.now();
    return until === undefined || until <= now
      ? null
      : Math.ceil((until - now) / 1000);
  }

  authFailed(ip: string | null): void {
    const key = ip ?? 'unknown';
    const now = this.now();
    if (this.locks.size > PRUNE_ABOVE) {
      for (const [k, until] of this.locks)
        if (until <= now) this.locks.delete(k);
    }
    if (
      this.hit(this.failures, key, this.opts.failuresPerMinute ?? 10) !== null
    ) {
      this.locks.set(key, now + (this.opts.lockMs ?? 10 * MINUTE_MS));
    }
  }
}
