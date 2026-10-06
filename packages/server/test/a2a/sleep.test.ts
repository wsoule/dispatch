import { expect, it } from 'bun:test';

import { sleep } from '../../src/a2a/sleep.js';

// A signal that counts its abort listeners, which AbortSignal cannot report.
function countingSignal() {
  const listeners = new Set<unknown>();
  const signal = {
    aborted: false,
    addEventListener: (_type: string, fn: unknown) => listeners.add(fn),
    removeEventListener: (_type: string, fn: unknown) => listeners.delete(fn),
  } as unknown as AbortSignal;
  return { signal, listeners };
}

it('leaves no abort listener behind when the timer wins', async () => {
  const { signal, listeners } = countingSignal();
  for (let i = 0; i < 5; i++) await sleep(1, signal);
  expect(listeners.size).toBe(0);
});

it('resolves at once when the signal aborts, clearing its timer', async () => {
  const ac = new AbortController();
  const started = performance.now();
  const waiting = sleep(10_000, ac.signal);
  ac.abort();
  await waiting;
  expect(performance.now() - started).toBeLessThan(1000);
  await sleep(5_000, ac.signal);
  expect(performance.now() - started).toBeLessThan(1000);
});
