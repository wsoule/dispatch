import { DEFAULT_A2A } from '@dispatch/core';
import { describe, expect, it } from 'bun:test';

import { handleA2A } from '../src/server/handle.js';
import { IpLimiter } from '../src/server/limits.js';
import { waitForSettled } from '../src/server/wait.js';
import { CLIENT, facts, msg } from './facts.js';
import { FakePort } from './fakePort.js';

const caller = { address: CLIENT, name: 'a2a.acme' };
const answer = msg({
  id: 'm-ans',
  kind: 'answer',
  replyTo: 'm-root',
  from: 'human:wyat',
});

describe('waitForSettled', () => {
  it('returns as soon as the task is answered', async () => {
    const port = new FakePort();
    const waiting = waitForSettled(port, caller, 'm-root', { maxMs: 5000 });
    setTimeout(() => port.change('m-root', facts({ answer })), 20);
    expect((await waiting)?.answer?.id).toBe('m-ans');
    expect(port.activeWatchers).toBe(0);
  });

  // Review Focus (also pinned): watcher leaks.
  it('leaves no watcher behind after timeouts and aborts', async () => {
    const port = new FakePort();
    await Promise.all(
      Array.from({ length: 50 }, () =>
        waitForSettled(port, caller, 'm-root', { maxMs: 5 })
      )
    );
    const aborter = new AbortController();
    const aborted = waitForSettled(port, caller, 'm-root', {
      maxMs: 60_000,
      signal: aborter.signal,
    });
    aborter.abort();
    await aborted;
    expect(port.activeWatchers).toBe(0);
  });

  it('rejects with the watch error and leaves no timer to fire later', async () => {
    const port = new FakePort();
    port.watchError = new Error('a2a.db is locked');
    await expect(
      waitForSettled(port, caller, 'm-root', { maxMs: 10 })
    ).rejects.toThrow('a2a.db is locked');
    // A timer left armed would throw from its callback once maxMs passes.
    await Bun.sleep(40);
  });
});

it('a blocking send returns WORKING after blockingWaitSec (the documented MUST deviation, §3.2.2)', async () => {
  const port = new FakePort();
  const timeouts: number[] = [];
  const started = performance.now();
  const res = await handleA2A(
    new Request('http://agent.test/a2a/v1/message:send', {
      method: 'POST',
      headers: {
        'A2A-Version': '1.0',
        authorization: 'Bearer good',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          messageId: 'c-1',
          role: 'ROLE_USER',
          parts: [{ text: 'q?' }],
        },
      }),
    }),
    port,
    {
      basePath: '/a2a/v1',
      policy: { ...DEFAULT_A2A, blockingWaitSec: 1 },
      clientIp: null,
      limiter: new IpLimiter(),
      setRequestTimeout: (s) => timeouts.push(s),
    }
  );
  const elapsed = performance.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(900);
  expect(elapsed).toBeLessThan(3000);
  expect(
    ((await res.json()) as { task: { status: { state: string } } }).task.status
      .state
  ).toBe('TASK_STATE_WORKING');
  expect(timeouts).toEqual([6]);
  expect(port.activeWatchers).toBe(0);
});
