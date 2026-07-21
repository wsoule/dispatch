import { describe, expect, it } from 'bun:test';

import { singleFlight } from '../src/singleFlight.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('singleFlight', () => {
  it('shares one in-flight call across overlapping callers', async () => {
    let calls = 0;
    const guarded = singleFlight(async () => {
      calls++;
      await sleep(20);
      return calls;
    });

    const [a, b, c] = await Promise.all([guarded(), guarded(), guarded()]);
    expect(calls).toBe(1);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(c).toBe(1);
  });

  it('starts a fresh call once the previous one has resolved', async () => {
    let calls = 0;
    const guarded = singleFlight(async () => {
      calls++;
      return calls;
    });

    expect(await guarded()).toBe(1);
    expect(await guarded()).toBe(2);
  });

  it('starts a fresh call once the previous one has rejected', async () => {
    let calls = 0;
    const guarded = singleFlight(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return calls;
    });

    await expect(guarded()).rejects.toThrow('boom');
    expect(await guarded()).toBe(2);
  });

  it('propagates a rejection to every caller sharing the in-flight call', async () => {
    const guarded = singleFlight(async () => {
      await sleep(10);
      throw new Error('shared failure');
    });

    const first = guarded();
    const second = guarded();
    await expect(first).rejects.toThrow('shared failure');
    await expect(second).rejects.toThrow('shared failure');
  });
});
