import { describe, expect, test } from 'bun:test';

import { RateLimiter } from '../src/rateLimit.js';

describe('RateLimiter', () => {
  test('allows up to the limit within a window, then rejects', () => {
    const limiter = new RateLimiter({ limit: 3 });
    try {
      expect(limiter.allow('1.2.3.4')).toBe(true);
      expect(limiter.allow('1.2.3.4')).toBe(true);
      expect(limiter.allow('1.2.3.4')).toBe(true);
      expect(limiter.allow('1.2.3.4')).toBe(false);
    } finally {
      limiter.stop();
    }
  });

  test('tracks separate keys independently', () => {
    const limiter = new RateLimiter({ limit: 1 });
    try {
      expect(limiter.allow('a')).toBe(true);
      expect(limiter.allow('b')).toBe(true);
      expect(limiter.allow('a')).toBe(false);
      expect(limiter.allow('b')).toBe(false);
    } finally {
      limiter.stop();
    }
  });

  test('resets once the window elapses', async () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 10 });
    try {
      expect(limiter.allow('a')).toBe(true);
      expect(limiter.allow('a')).toBe(false);
      await new Promise((r) => setTimeout(r, 20));
      expect(limiter.allow('a')).toBe(true);
    } finally {
      limiter.stop();
    }
  });
});
