import { afterEach, describe, expect, it } from 'bun:test';

import { createTaskApiClient, REQUEST_TIMEOUT_MS } from '../src/apiClient.js';
import { CliError } from '../src/context.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// The 2026-08-23 daemon accepted connections and answered none of them. With
// no signal on the request, fetch waits on that socket forever and every
// `dispatch` command inherits the hang.
describe('CLI daemon request deadline', () => {
  it('attaches a deadline signal to every request', async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    globalThis.fetch = ((_input: string, init?: RequestInit) => {
      signals.push(init?.signal);
      return Promise.resolve(new Response('[]'));
    }) as typeof fetch;

    await createTaskApiClient('http://127.0.0.1:1', 'tok').listTasks();

    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
  });

  it('tells the user the daemon is wedged, not gone, when the deadline fires', async () => {
    globalThis.fetch = ((_input: string, _init?: RequestInit) =>
      Promise.reject(
        new DOMException('The operation timed out.', 'TimeoutError')
      )) as typeof fetch;

    const client = createTaskApiClient('http://127.0.0.1:1', 'tok');
    await expect(client.listTasks()).rejects.toBeInstanceOf(CliError);
    await expect(client.listTasks()).rejects.toThrow(/did not answer within/);
    // Restarting something that is already running is the wrong advice, so the
    // "it has probably just exited" wording must not appear on this path.
    await expect(client.listTasks()).rejects.toThrow(/blocked event loop/);
  });

  it('still reports a dropped connection as an exited daemon', async () => {
    globalThis.fetch = ((_input: string, _init?: RequestInit) =>
      Promise.reject(new TypeError('fetch failed'))) as typeof fetch;

    await expect(
      createTaskApiClient('http://127.0.0.1:1', 'tok').listTasks()
    ).rejects.toThrow(/probably just exited/);
  });

  it('bounds a request generously enough for a local git operation', () => {
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });
});
