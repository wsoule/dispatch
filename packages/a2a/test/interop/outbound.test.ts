import { AgentCard, formatSSEEvent, SSE_HEADERS, Task } from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
} from '@a2a-js/sdk/server';
import type { AgentExecutor } from '@a2a-js/sdk/server';
import { DEFAULT_A2A } from '@dispatch-foo/core';
import type { Message } from '@dispatch-foo/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { checkPeerCard, fetchPeerCard } from '../../src/peer/card.js';
import { PeerClient } from '../../src/peer/client.js';
import { peerEventFromTask } from '../../src/peer/events.js';
import { PeerHttpError } from '../../src/peer/http.js';
import { peerOutboundMessage } from '../../src/peer/message.js';
import { handleA2A } from '../../src/server/handle.js';
import { IpLimiter } from '../../src/server/limits.js';
import { facts, msg } from '../facts.js';
import { FakePort } from '../fakePort.js';

const QUESTION: Message = {
  id: 'm-out-1',
  thread: 'm-out-1',
  replyTo: null,
  from: 'run:r-000001',
  to: ['a2a:fixture'],
  kind: 'question',
  body: 'Which colour?',
  refs: [],
  urgent: false,
  blocking: true,
  wake: 'none',
  createdAt: '2026-09-25T10:00:00.000Z',
};
const out = () =>
  peerOutboundMessage(QUESTION, 'fixture', { contextId: null, taskId: null });

describe('an HTTP+JSON peer (handleA2A)', () => {
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
    port.cardInputs = { ...port.cardInputs, publicUrl: base };
  });
  afterAll(() => server.stop(true));

  it('fetches the card, sends, follows the stream and reads the answer', async () => {
    const cardUrl = `${base}/.well-known/agent-card.json`;
    const { json } = await fetchPeerCard(cardUrl, { allowHttp: false });
    const { iface, auth } = checkPeerCard({
      cardUrl,
      card: json,
      allowOrigin: false,
    });
    expect(iface).toEqual({ url: `${base}/a2a/v1`, binding: 'HTTP+JSON' });
    expect(auth).toEqual({ kind: 'bearer' });
    const client = new PeerClient({
      iface,
      card: json,
      headers: { authorization: 'Bearer good' },
    });
    expect(await client.send(out())).toMatchObject({
      kind: 'task',
      task: { id: 'm-root' },
    });
    expect(port.calls.find((c) => c.method === 'open')?.args[0]).toMatchObject({
      clientMessageId: 'm-out-1',
      kind: 'ask',
      body: 'Which colour?',
    });
    setTimeout(
      () =>
        port.change(
          'm-root',
          facts({
            answer: msg({
              id: 'm-ans',
              kind: 'answer',
              replyTo: 'm-root',
              body: 'Blue.',
            }),
          })
        ),
      100
    );
    const ac = new AbortController();
    for await (const _tick of client.changes('m-root', ac.signal)) {
      if (
        (await client.getTask('m-root')).status.state === 'TASK_STATE_COMPLETED'
      )
        break;
    }
    ac.abort();
    expect(peerEventFromTask(await client.getTask('m-root'))).toMatchObject({
      kind: 'task',
      state: 'COMPLETED',
      status: { body: 'Blue.' },
    });
  });

  it('reports the peer’s HTTP status: 401 for a bad credential', async () => {
    const { json } = await fetchPeerCard(
      `${base}/.well-known/agent-card.json`,
      { allowHttp: false }
    );
    const client = new PeerClient({
      iface: { url: `${base}/a2a/v1`, binding: 'HTTP+JSON' },
      card: json,
      headers: { authorization: 'Bearer nope' },
    });
    await expect(client.send(out())).rejects.toMatchObject({ status: 401 });
  });

  it('names a VERSION_NOT_SUPPORTED answer, so the worker can refresh the card', async () => {
    const { json } = await fetchPeerCard(
      `${base}/.well-known/agent-card.json`,
      { allowHttp: false }
    );
    // Cast, not annotated: bun-types' `typeof fetch` also carries `preconnect`.
    const preOne = ((input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('A2A-Version', '0.3'); // as a peer that stopped accepting 1.0 would see us
      return fetch(input, { ...init, headers });
    }) as typeof fetch;
    const client = new PeerClient({
      iface: { url: `${base}/a2a/v1`, binding: 'HTTP+JSON' },
      card: json,
      headers: { authorization: 'Bearer good' },
      fetchImpl: preOne,
    });
    await expect(client.getTask('m-root')).rejects.toMatchObject({
      status: 400,
      reason: 'VERSION_NOT_SUPPORTED',
    });
  });

  it('reads an unreachable peer as a retryable network failure', async () => {
    const { json } = await fetchPeerCard(
      `${base}/.well-known/agent-card.json`,
      { allowHttp: false }
    );
    const client = new PeerClient({
      iface: { url: 'http://127.0.0.1:1/a2a/v1', binding: 'HTTP+JSON' },
      card: json,
      headers: {},
    });
    const err = await client.getTask('m-root').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PeerHttpError);
    expect(err).toMatchObject({ status: null });
  });

  it('times out a getTask body that drips, and refuses one over 1 MiB as final', async () => {
    const { json } = await fetchPeerCard(
      `${base}/.well-known/agent-card.json`,
      { allowHttp: false }
    );
    const answering = (body: () => ReadableStream<Uint8Array>) =>
      (() =>
        Promise.resolve(
          new Response(body(), {
            headers: { 'content-type': 'application/json' },
          })
        )) as unknown as typeof fetch;
    const drip = () => {
      let sent = 0;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent === 100) return controller.close();
          await Bun.sleep(100);
          sent += 1;
          controller.enqueue(new TextEncoder().encode(sent === 1 ? '{' : ' '));
        },
      });
    };
    const huge = () => {
      let sent = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 64) return controller.close();
          sent += 1;
          controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
        },
      });
    };
    const iface = { url: `${base}/a2a/v1`, binding: 'HTTP+JSON' as const };
    const started = Date.now();
    await expect(
      new PeerClient({
        iface,
        card: json,
        headers: {},
        timeoutMs: 200,
        fetchImpl: answering(drip),
      }).getTask('m-root')
    ).rejects.toMatchObject({ status: null });
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(
      new PeerClient({
        iface,
        card: json,
        headers: {},
        fetchImpl: answering(huge),
      }).getTask('m-root')
    ).rejects.toMatchObject({ reason: 'BODY_TOO_LARGE' });
  });

  it('keeps a peer error message short and on one line', async () => {
    const { json } = await fetchPeerCard(
      `${base}/.well-known/agent-card.json`,
      { allowHttp: false }
    );
    // A REST JSON error, which the SDK reads into err.message.
    const noisy = (() =>
      Promise.resolve(
        Response.json(
          {
            error: {
              code: 400,
              status: 'INVALID_ARGUMENT',
              message: `bad\u0000\r\n\u001b[31m${'x'.repeat(5000)}`,
              details: [],
            },
          },
          { status: 400 }
        )
      )) as unknown as typeof fetch;
    const err = await new PeerClient({
      iface: { url: `${base}/a2a/v1`, binding: 'HTTP+JSON' },
      card: json,
      headers: {},
      fetchImpl: noisy,
    })
      .getTask('m-root')
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400 });
    // The message is Dispatch's; the peer's text is kept apart, cut and cleaned.
    expect((err as Error).message).toBe('the peer answered HTTP 400');
    const message = (err as PeerHttpError).peerText ?? '';
    expect(message).toContain('bad');
    expect(message).toContain('xxxx');
    expect(message.length).toBeLessThanOrEqual(300);
    const codes = Array.from({ length: message.length }, (_, i) =>
      message.charCodeAt(i)
    );
    expect(codes.some((c) => c < 0x20 || c === 0x7f)).toBe(false);
  });

  it('with a guard, never connects to an interface that resolves privately', async () => {
    const { json } = await fetchPeerCard(
      `${base}/.well-known/agent-card.json`,
      { allowHttp: false }
    );
    let fetched = false;
    const client = new PeerClient({
      iface: { url: 'https://peer.example.com/a2a/v1', binding: 'HTTP+JSON' },
      card: json,
      headers: {},
      guard: { lookup: () => Promise.resolve(['169.254.169.254']) },
      fetchImpl: (() => {
        fetched = true;
        return Promise.resolve(new Response('{}'));
      }) as unknown as typeof fetch,
    });
    await expect(client.send(out())).rejects.toMatchObject({
      status: null,
      reason: 'ADDRESS_REFUSED',
    });
    expect(fetched).toBe(false);
  });
});

describe('a JSON-RPC peer (the SDK’s own server)', () => {
  let server: ReturnType<typeof Bun.serve>;
  let cardJson: Record<string, never>;
  beforeAll(() => {
    const executor: AgentExecutor = {
      async execute(ctx, bus) {
        bus.publish({
          kind: 'task',
          data: Task.fromJSON({
            id: ctx.taskId,
            contextId: ctx.contextId,
            status: { state: 'TASK_STATE_WORKING' },
          }),
        });
        await Bun.sleep(50);
        bus.publish({
          kind: 'task',
          data: Task.fromJSON({
            id: ctx.taskId,
            contextId: ctx.contextId,
            status: {
              state: 'TASK_STATE_COMPLETED',
              message: {
                messageId: 'fx-1',
                role: 'ROLE_AGENT',
                parts: [{ text: 'Green.' }],
              },
            },
          }),
        });
        bus.finished();
      },
      cancelTask: () => Promise.resolve(),
    };
    let transport: JsonRpcTransportHandler | null = null;
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        if (transport === null)
          return new Response('not ready', { status: 503 });
        const result = await transport.handle(
          await req.text(),
          new ServerCallContext({ requestedVersion: '1.0' })
        );
        if (
          typeof result === 'object' &&
          result !== null &&
          Symbol.asyncIterator in result
        ) {
          const encoder = new TextEncoder();
          const body = new ReadableStream({
            async start(controller) {
              for await (const event of result as AsyncGenerator<unknown>)
                controller.enqueue(encoder.encode(formatSSEEvent(event)));
              controller.close();
            },
          });
          return new Response(body, { headers: SSE_HEADERS });
        }
        return Response.json(result);
      },
    });
    const url = `http://127.0.0.1:${server.port}/rpc`;
    const card = AgentCard.fromJSON({
      name: 'Fixture',
      description: 'A JSON-RPC fixture.',
      version: '1',
      capabilities: { streaming: true },
      supportedInterfaces: [
        { url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      ],
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [],
    });
    transport = new JsonRpcTransportHandler(
      new DefaultRequestHandler(card, new InMemoryTaskStore(), executor)
    );
    cardJson = AgentCard.toJSON(card) as Record<string, never>;
  });
  afterAll(() => server.stop(true));

  it('sends through JSON-RPC and polls the task to COMPLETED', async () => {
    const client = new PeerClient({
      iface: { url: `http://127.0.0.1:${server.port}/rpc`, binding: 'JSONRPC' },
      card: cardJson,
      headers: {},
    });
    const sent = await client.send(out());
    expect(sent.kind).toBe('task');
    const taskId = sent.kind === 'task' ? sent.task.id : '';
    let state = '';
    for (let i = 0; i < 40 && state !== 'TASK_STATE_COMPLETED'; i++) {
      state = (await client.getTask(taskId)).status.state;
      if (state !== 'TASK_STATE_COMPLETED') await Bun.sleep(25);
    }
    expect(peerEventFromTask(await client.getTask(taskId))).toMatchObject({
      state: 'COMPLETED',
      status: { body: 'Green.' },
    });
  });
});
