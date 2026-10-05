// Per-tenant caps on the relay, each tenant counted on its own, so one
// tenant's load never spends another's budget.

export interface TenantLimits {
  inFlight: number;
  streams: number;
  requestsPerMinute: number;
  bytesPerMinute: number;
}

export const DEFAULT_TENANT_LIMITS: TenantLimits = {
  inFlight: 32,
  streams: 16,
  requestsPerMinute: 600,
  bytesPerMinute: 32 * 1024 * 1024,
};

const MINUTE_MS = 60_000;

interface Counters {
  inFlight: number;
  streams: number;
  requests: number[];
  bytes: { at: number; n: number }[];
}

export type Admission =
  | { ok: true; done: () => void }
  | { ok: false; retryAfterSec: number };

export class TenantLimiter {
  private readonly tenants = new Map<string, Counters>();
  constructor(
    private readonly limitsOf: (tenant: string) => TenantLimits,
    private readonly now: () => number = Date.now
  ) {}

  private counters(tenant: string): Counters {
    let c = this.tenants.get(tenant);
    if (c === undefined) {
      c = { inFlight: 0, streams: 0, requests: [], bytes: [] };
      this.tenants.set(tenant, c);
    }
    const since = this.now() - MINUTE_MS;
    c.requests = c.requests.filter((t) => t > since);
    c.bytes = c.bytes.filter((b) => b.at > since);
    return c;
  }

  /** A call or stream for `tenant`, or the wait before one fits. */
  begin(tenant: string, kind: 'call' | 'stream'): Admission {
    const limits = this.limitsOf(tenant);
    const c = this.counters(tenant);
    if (c.requests.length >= limits.requestsPerMinute) {
      const wait = c.requests[0] + MINUTE_MS - this.now();
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(wait / 1000)) };
    }
    if (
      kind === 'call'
        ? c.inFlight >= limits.inFlight
        : c.streams >= limits.streams
    )
      return { ok: false, retryAfterSec: 1 };
    c.requests.push(this.now());
    if (kind === 'call') c.inFlight++;
    else c.streams++;
    let done = false;
    return {
      ok: true,
      done: () => {
        if (done) return;
        done = true;
        if (kind === 'call') c.inFlight--;
        else c.streams--;
      },
    };
  }

  /** Counts `n` bytes for `tenant`; false once its minute's budget is spent. */
  bytes(tenant: string, n: number): boolean {
    const c = this.counters(tenant);
    const used = c.bytes.reduce((sum, b) => sum + b.n, 0);
    if (used + n > this.limitsOf(tenant).bytesPerMinute) return false;
    c.bytes.push({ at: this.now(), n });
    return true;
  }

  forget(tenant: string): void {
    this.tenants.delete(tenant);
  }
}
