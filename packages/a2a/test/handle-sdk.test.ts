import { GetTaskRequest, SendMessageRequest } from '@a2a-js/sdk';
import { ClientFactory, RestTransportFactory } from '@a2a-js/sdk/client';
import { TaskNotFoundError } from '@a2a-js/sdk/errors';
import { DEFAULT_A2A } from '@dispatch-foo/core';
import { afterAll, beforeAll, expect, it } from 'bun:test';

import { handleA2A } from '../src/server/handle.js';
import { IpLimiter } from '../src/server/limits.js';
import { FakePort } from './fakePort.js';

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

// Cast, not annotated: bun-types' `typeof fetch` also carries `preconnect`.
const authed = ((input: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set('authorization', 'Bearer good');
  return fetch(input, { ...init, headers });
}) as typeof fetch;

async function sdkClient() {
  return new ClientFactory({
    transports: [new RestTransportFactory({ fetchImpl: authed })],
  }).createFromUrl(base);
}

it('the SDK REST client reads a 404 as TaskNotFoundError', async () => {
  const client = await sdkClient();
  const err = await client
    .getTask(GetTaskRequest.fromJSON({ id: 'm-missing' }))
    .then(
      () => null,
      (e: unknown) => e
    );
  // The REST transport throws RestTaskNotFoundError, a subclass whose
  // constructor.name differs; instanceof and .name are the stable contract.
  expect(err).toBeInstanceOf(TaskNotFoundError);
  expect((err as Error).name).toBe('TaskNotFoundError');
});

it('the SDK REST client sends an ask the handler decodes', async () => {
  const client = await sdkClient();
  await client.sendMessage(
    SendMessageRequest.fromJSON({
      message: { messageId: 'c-9', role: 'ROLE_USER', parts: [{ text: 'hi' }] },
      configuration: { returnImmediately: true },
    })
  );
  expect(port.calls.find((c) => c.method === 'open')?.args[0]).toMatchObject({
    clientMessageId: 'c-9',
    body: 'hi',
  });
});
