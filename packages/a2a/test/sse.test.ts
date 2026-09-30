import { DEFAULT_A2A } from '@dispatch/core';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { handleA2A } from '../src/server/handle.js';
import { IpLimiter } from '../src/server/limits.js';
import { taskEventStream } from '../src/server/sse.js';
import type { ExtensionUri } from '../src/uris.js';
import { ENVELOPE_URI, GATE_URI } from '../src/uris.js';
import { CLIENT, facts, msg } from './facts.js';
import { FakePort } from './fakePort.js';

const caller = { address: CLIENT, name: 'a2a.acme' };
const view = {
  client: CLIENT,
  extensions: new Set<never>(),
  textMediaType: 'text/markdown' as const,
  historyLength: null,
  includeArtifacts: true,
};

// Reads SSE frames until `count` data events arrive or the stream ends. A read
// that outlasts one 50 ms poll is kept for the next, so no chunk is dropped.
async function events(
  res: Response,
  count: number,
  timeoutMs = 3000
): Promise<{
  data: Record<string, unknown>[];
  keepalives: number;
  ended: boolean;
}> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const data: Record<string, unknown>[] = [];
  let keepalives = 0;
  let buffer = '';
  let pending: ReturnType<typeof reader.read> | null = null;
  const deadline = Date.now() + timeoutMs;
  while (data.length < count && Date.now() < deadline) {
    pending ??= reader.read();
    const result = await Promise.race([
      pending,
      new Promise<null>((r) => setTimeout(() => r(null), 50)),
    ]);
    if (result === null) continue;
    pending = null;
    const { value, done } = result;
    if (done) return { data, keepalives, ended: true };
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (frame.startsWith(':')) keepalives += 1;
      else if (frame.startsWith('data: '))
        data.push(JSON.parse(frame.slice(6)) as Record<string, unknown>);
    }
  }
  await reader.cancel();
  return { data, keepalives, ended: false };
}

function open(
  port: FakePort,
  over: Partial<Parameters<typeof taskEventStream>[0]> = {}
) {
  let released = 0;
  const res = taskEventStream({
    port,
    caller,
    bearer: 'good',
    taskId: 'm-root',
    view,
    release: () => {
      released += 1;
    },
    signal: new AbortController().signal,
    tickMs: 10,
    keepaliveMs: 30,
    ...over,
  });
  return { res, released: () => released };
}

describe('taskEventStream', () => {
  it('sends the task first, then a status update, and closes on the terminal event', async () => {
    const port = new FakePort();
    const { res, released } = open(port);
    setTimeout(
      () =>
        port.change(
          'm-root',
          facts({
            answer: msg({ id: 'm-ans', kind: 'answer', replyTo: 'm-root' }),
          })
        ),
      40
    );
    const got = await events(res, 5);
    expect(Object.keys(got.data[0])).toEqual(['task']);
    expect(got.data.map((e) => Object.keys(e)[0])).toEqual([
      'task',
      'artifactUpdate',
      'statusUpdate',
    ]);
    expect(got.ended).toBe(true);
    expect(released()).toBe(1);
  });

  it('closes on INPUT_REQUIRED and stays open through AUTH_REQUIRED', async () => {
    const port = new FakePort();
    port.tasks.set(
      'm-root',
      facts({
        skill: 'handoff',
        task: {
          id: 't-1',
          title: 'x',
          status: 'draft',
          phase: 'draft',
          approved: false,
        },
        openGates: [
          {
            id: 'm-g',
            type: 'task-proposal',
            openedAt: '2026-09-25T10:00:00.000Z',
          },
        ],
      })
    );
    const { res } = open(port);
    setTimeout(
      () =>
        port.change(
          'm-root',
          facts({
            openQuestions: [
              msg({
                id: 'm-q',
                kind: 'question',
                blocking: true,
                replyTo: 'm-root',
              }),
            ],
          })
        ),
      60
    );
    const got = await events(res, 3);
    expect(got.data.map((e) => Object.keys(e)[0])).toEqual([
      'task',
      'statusUpdate',
    ]);
    expect(got.ended).toBe(true);
  });

  // SubscribeToTask ends only at a terminal state (§3.1.6; TCK STREAM-SUB-002).
  it('runs through INPUT_REQUIRED to the terminal event when untilTerminal', async () => {
    const port = new FakePort();
    const question = msg({
      id: 'm-q',
      kind: 'question',
      blocking: true,
      replyTo: 'm-root',
    });
    port.tasks.set('m-root', facts({ openQuestions: [question] }));
    const { res, released } = open(port, { untilTerminal: true });
    setTimeout(
      () =>
        port.change(
          'm-root',
          facts({
            answer: msg({ id: 'm-ans', kind: 'answer', replyTo: 'm-root' }),
          })
        ),
      60
    );
    const got = await events(res, 5);
    expect(got.data.map((e) => Object.keys(e)[0])).toEqual([
      'task',
      'artifactUpdate',
      'statusUpdate',
    ]);
    expect(JSON.stringify(got.data[0])).toContain('TASK_STATE_INPUT_REQUIRED');
    expect(JSON.stringify(got.data.at(-1))).toContain('TASK_STATE_COMPLETED');
    expect(got.ended).toBe(true);
    expect(released()).toBe(1);
  });

  it('sends keepalive comments', async () => {
    const got = await events(open(new FakePort()).res, 99, 200);
    expect(got.keepalives).toBeGreaterThan(0);
  });

  it('closes within a tick when the bearer stops authenticating', async () => {
    const port = new FakePort();
    const { res, released } = open(port);
    setTimeout(() => port.tokens.delete('good'), 30);
    const got = await events(res, 99, 1000);
    expect(got.ended).toBe(true);
    expect(released()).toBe(1);
  });

  it('closes and releases when a client that never reads overflows the buffer', async () => {
    const port = new FakePort();
    const { released } = open(port, { bufferLimit: 3 });
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(15);
      port.change(
        'm-root',
        facts({
          scope: [
            facts().root,
            msg({ id: `m-x${i}`, replyTo: 'm-root', from: 'human:wyat' }),
          ],
        })
      );
    }
    await Bun.sleep(50);
    expect(released()).toBe(1);
  });

  it('closes after maxMs', async () => {
    const { res } = open(new FakePort(), { maxMs: 50 });
    expect((await events(res, 99, 500)).ended).toBe(true);
  });

  // Egress (spec:1999-2000): no SSE event or artifact carries a GateData payload.
  it('never writes a gate payload or a gate body into any stream event', async () => {
    const port = new FakePort();
    const gate = msg({
      id: 'm-gate',
      replyTo: 'm-root',
      from: 'agent:dispatch',
      kind: 'question',
      blocking: true,
      body: 'Run `SECRET_INPUT`?',
      data: {
        type: 'tool-approval',
        requestId: 'q-1',
        runId: 'r-00000a',
        tool: 'Bash',
        input: { command: 'SECRET_INPUT' },
      },
    });
    const { res } = open(port, {
      view: {
        ...view,
        extensions: new Set<ExtensionUri>([ENVELOPE_URI, GATE_URI]),
      },
    });
    setTimeout(
      () =>
        port.change(
          'm-root',
          facts({
            scope: [facts().root, gate],
            openGates: [
              {
                id: 'm-gate',
                type: 'tool-approval',
                openedAt: '2026-09-25T10:00:00.000Z',
              },
            ],
          })
        ),
      30
    );
    setTimeout(
      () =>
        port.change(
          'm-root',
          facts({
            scope: [facts().root, gate],
            answer: msg({ id: 'm-ans', kind: 'answer', replyTo: 'm-root' }),
          })
        ),
      90
    );
    const got = await events(res, 6);
    expect(got.ended).toBe(true);
    const wire = JSON.stringify(got.data);
    expect(wire).not.toContain('SECRET_INPUT');
    expect(wire).not.toContain('"requestId"');
    expect(wire).not.toContain('"input"');
  });
});

describe('streams over HTTP', () => {
  const port = new FakePort();
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  beforeAll(() => {
    const limiter = new IpLimiter();
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) =>
        handleA2A(req, port, {
          basePath: '/a2a/v1',
          policy: DEFAULT_A2A,
          clientIp: '127.0.0.1',
          limiter,
        }),
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop(true));
  const headers = {
    'A2A-Version': '1.0',
    authorization: 'Bearer good',
    'content-type': 'application/json',
  };

  it('subscribes with GET and with POST', async () => {
    for (const method of ['GET', 'POST']) {
      const aborter = new AbortController();
      const res = await fetch(`${base}/a2a/v1/tasks/m-root:subscribe`, {
        method,
        headers,
        signal: aborter.signal,
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect((await events(res, 1)).data[0]).toHaveProperty('task');
      aborter.abort();
    }
  });

  it('keeps a subscription open through INPUT_REQUIRED until the task is terminal', async () => {
    const question = msg({
      id: 'm-q',
      kind: 'question',
      blocking: true,
      replyTo: 'm-root',
    });
    port.tasks.set('m-iq', facts({ id: 'm-iq', openQuestions: [question] }));
    const res = await fetch(`${base}/a2a/v1/tasks/m-iq:subscribe`, {
      headers,
    });
    setTimeout(
      () =>
        port.change(
          'm-iq',
          facts({
            id: 'm-iq',
            answer: msg({ id: 'm-ans', kind: 'answer', replyTo: 'm-root' }),
          })
        ),
      100
    );
    const got = await events(res, 5);
    expect(JSON.stringify(got.data[0])).toContain('TASK_STATE_INPUT_REQUIRED');
    expect(JSON.stringify(got.data.at(-1))).toContain('TASK_STATE_COMPLETED');
    expect(got.ended).toBe(true);
  });

  it('ends a streamed send at INPUT_REQUIRED, where the client must answer', async () => {
    const question = msg({
      id: 'm-q',
      kind: 'question',
      blocking: true,
      replyTo: 'm-root',
    });
    port.tasks.set('m-iq2', facts({ id: 'm-iq2', openQuestions: [question] }));
    port.onOpen = () => ({ kind: 'task', taskId: 'm-iq2' });
    const res = await fetch(`${base}/a2a/v1/message:stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: {
          messageId: 'c-iq2',
          role: 'ROLE_USER',
          parts: [{ text: 'q?' }],
        },
      }),
    });
    port.onOpen = () => ({ kind: 'task', taskId: 'm-root' });
    const got = await events(res, 5);
    expect(got.data.map((e) => Object.keys(e)[0])).toEqual(['task']);
    expect(got.ended).toBe(true);
  });

  it('refuses to subscribe to a terminal task', async () => {
    port.tasks.set(
      'm-done',
      facts({ id: 'm-done', canceledAt: '2026-09-25T11:00:00.000Z' })
    );
    const res = await fetch(`${base}/a2a/v1/tasks/m-done:subscribe`, {
      headers,
    });
    expect(res.status).toBe(400);
  });

  // Review Focus 1.
  it('releases the stream slot when the client disconnects', async () => {
    for (let i = 0; i < port.streamLimit + 2; i++) {
      const aborter = new AbortController();
      const res = await fetch(`${base}/a2a/v1/tasks/m-root:subscribe`, {
        headers,
        signal: aborter.signal,
      });
      expect(res.status).toBe(200);
      aborter.abort();
      const deadline = Date.now() + 2000;
      while (port.openStreams > 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(port.openStreams).toBe(0);
    }
  });

  it('refuses a stream over the per-client limit with 429', async () => {
    port.streamLimit = 0;
    const res = await fetch(`${base}/a2a/v1/tasks/m-root:subscribe`, {
      headers,
    });
    expect(res.status).toBe(429);
    port.streamLimit = 5;
  });

  const streamSend = (message: Record<string, unknown>, signal?: AbortSignal) =>
    fetch(`${base}/a2a/v1/message:stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: { role: 'ROLE_USER', parts: [{ text: 'q?' }], ...message },
      }),
      ...(signal === undefined ? {} : { signal }),
    });

  it('streams a send as its task and frees the slot when the client leaves', async () => {
    const aborter = new AbortController();
    const res = await streamSend({ messageId: 'c-s1' }, aborter.signal);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect((await events(res, 1)).data[0]).toHaveProperty('task');
    aborter.abort();
    const deadline = Date.now() + 2000;
    while (port.openStreams > 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(port.openStreams).toBe(0);
  });

  it('streams a plain message as one message event and frees its slot', async () => {
    port.onOpen = () => ({ kind: 'reply', text: 'Delivered.' });
    const got = await events(await streamSend({ messageId: 'c-s2' }), 2);
    port.onOpen = () => ({ kind: 'task', taskId: 'm-root' });
    expect(got.data.map((e) => Object.keys(e)[0])).toEqual(['message']);
    expect(got.ended).toBe(true);
    expect(port.openStreams).toBe(0);
  });

  it('sends nothing on a refused stream and frees the slot of a failed one', async () => {
    port.streamLimit = 0;
    const opens = port.calls.filter((c) => c.method === 'open').length;
    expect((await streamSend({ messageId: 'c-s3' })).status).toBe(429);
    expect(port.calls.filter((c) => c.method === 'open')).toHaveLength(opens);
    port.streamLimit = 5;
    port.tasks.set(
      'm-done',
      facts({ id: 'm-done', canceledAt: '2026-09-25T11:00:00.000Z' })
    );
    const finished = await streamSend({ messageId: 'c-s4', taskId: 'm-done' });
    expect(finished.status).toBe(400);
    expect(port.openStreams).toBe(0);
  });
});
