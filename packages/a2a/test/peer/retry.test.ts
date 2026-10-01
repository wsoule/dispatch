import { describe, expect, it } from 'bun:test';

import { pollDelayMs, retrySchedule } from '../../src/peer/retry.js';

const FIRST = '2026-09-25T10:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(FIRST) + ms);
const delayOf = (d: ReturnType<typeof retrySchedule>, now: Date) =>
  d.kind === 'retry' ? Date.parse(d.at) - now.getTime() : null;

describe('retrySchedule', () => {
  it('backs off 30 s, doubling, capped at 1 h, for network errors, 5xx, 408 and 429', () => {
    const now = at(60_000);
    expect(delayOf(retrySchedule(1, FIRST, now, { status: null }), now)).toBe(
      30_000
    );
    expect(delayOf(retrySchedule(3, FIRST, now, { status: 503 }), now)).toBe(
      120_000
    );
    expect(delayOf(retrySchedule(20, FIRST, now, { status: 408 }), now)).toBe(
      3_600_000
    );
    expect(
      delayOf(
        retrySchedule(1, FIRST, now, { status: 429, retryAfterSec: 90 }),
        now
      )
    ).toBe(90_000);
    expect(
      delayOf(
        retrySchedule(1, FIRST, now, { status: 429, retryAfterSec: 7200 }),
        now
      )
    ).toBe(3_600_000);
  });

  it('never retries sooner than the backoff, whatever Retry-After says', () => {
    const now = at(0);
    expect(
      delayOf(
        retrySchedule(1, FIRST, now, { status: 503, retryAfterSec: 0 }),
        now
      )
    ).toBe(30_000);
    expect(
      delayOf(
        retrySchedule(4, FIRST, now, { status: 429, retryAfterSec: 5 }),
        now
      )
    ).toBe(240_000);
  });

  it('gives up when the first attempt time cannot be read', () => {
    expect(retrySchedule(1, 'not a time', at(0), { status: null })).toEqual({
      kind: 'give-up',
      reason: 'the first attempt time is not a valid time',
    });
  });

  it('gives up at once on any other 4xx and after 24 h of failures', () => {
    expect(retrySchedule(1, FIRST, at(1000), { status: 404 })).toEqual({
      kind: 'give-up',
      reason: 'the peer answered HTTP 404',
    });
    expect(retrySchedule(1, FIRST, at(1000), { status: 302 })).toMatchObject({
      kind: 'give-up',
    });
    expect(
      retrySchedule(40, FIRST, at(24 * 3_600_000), { status: null })
    ).toEqual({ kind: 'give-up', reason: 'unreachable for 24 h' });
  });
});

it('polls every 5 s, doubling to 60 s', () => {
  expect([0, 1, 2, 3, 4, 9, 2000].map(pollDelayMs)).toEqual([
    5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000,
  ]);
});
