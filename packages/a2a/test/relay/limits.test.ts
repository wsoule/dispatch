import { describe, expect, it } from 'bun:test';

import { TenantLimiter } from '../../src/relay/limits.js';

const LIMITS = {
  inFlight: 2,
  streams: 1,
  requestsPerMinute: 3,
  bytesPerMinute: 100,
};

describe('TenantLimiter', () => {
  it('caps in-flight calls per tenant: the n+1th is refused for that tenant only', () => {
    let now = 0;
    const l = new TenantLimiter(
      () => LIMITS,
      () => now
    );
    const a1 = l.begin('a', 'call');
    const a2 = l.begin('a', 'call');
    expect(a1.ok && a2.ok).toBe(true);
    expect(l.begin('a', 'call').ok).toBe(false);
    expect(l.begin('b', 'call').ok).toBe(true);
    if (a1.ok) a1.done();
    now += 1;
    // Refusals are not counted: a third call fits, a fourth hits the minute cap.
    const a3 = l.begin('a', 'call');
    expect(a3.ok).toBe(true);
    if (a3.ok) a3.done();
    expect(l.begin('a', 'call').ok).toBe(false);
  });

  it('caps streams and requests per minute, and the window slides', () => {
    let now = 0;
    const l = new TenantLimiter(
      () => ({ ...LIMITS, inFlight: 10 }),
      () => now
    );
    const s = l.begin('a', 'stream');
    expect(s.ok).toBe(true);
    expect(l.begin('a', 'stream').ok).toBe(false);
    for (let i = 0; i < 2; i++) {
      const c = l.begin('a', 'call');
      if (c.ok) c.done();
    }
    const refused = l.begin('a', 'call');
    expect(refused).toMatchObject({ ok: false });
    if (!refused.ok) expect(refused.retryAfterSec).toBeGreaterThan(0);
    now += 61_000;
    expect(l.begin('a', 'call').ok).toBe(true);
  });

  it('counts bytes per minute per tenant', () => {
    let now = 0;
    const l = new TenantLimiter(
      () => LIMITS,
      () => now
    );
    expect(l.bytes('a', 60)).toBe(true);
    expect(l.bytes('a', 60)).toBe(false);
    expect(l.bytes('b', 60)).toBe(true);
    now += 61_000;
    expect(l.bytes('a', 60)).toBe(true);
  });
});
