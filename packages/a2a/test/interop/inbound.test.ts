import {
  CancelTaskRequest,
  GetTaskRequest,
  ListTasksRequest,
  ListTasksResponse,
  SendMessageRequest,
  StreamResponse,
  SubscribeToTaskRequest,
  Task,
} from '@a2a-js/sdk';
import { ClientFactory, RestTransportFactory } from '@a2a-js/sdk/client';
import { DEFAULT_A2A } from '@dispatch/core';
import { afterAll, beforeAll, expect, it } from 'bun:test';

import { handleA2A } from '../../src/server/handle.js';
import { IpLimiter } from '../../src/server/limits.js';
import { ENVELOPE_URI } from '../../src/uris.js';
import { facts, msg } from '../facts.js';
import { FakePort } from '../fakePort.js';

const port = new FakePort();
let server: ReturnType<typeof Bun.serve>;
let base: string;
const seenExtensions: (string | null)[] = [];

beforeAll(() => {
  const limiter = new IpLimiter();
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) =>
      handleA2A(req, port, {
        basePath: '/a2a/v1',
        policy: { ...DEFAULT_A2A, blockingWaitSec: 1 },
        clientIp: '127.0.0.1',
        limiter,
      }),
  });
  base = `http://127.0.0.1:${server.port}`;
  port.cardInputs = { ...port.cardInputs, publicUrl: base };
});
afterAll(() => server.stop(true));

// Cast, not annotated: bun-types' `typeof fetch` also carries `preconnect`.
const fetchImpl = (async (
  input: string | URL | Request,
  init?: RequestInit
) => {
  const headers = new Headers(init?.headers);
  headers.set('authorization', 'Bearer good');
  headers.set('A2A-Extensions', ENVELOPE_URI);
  const res = await fetch(input, { ...init, headers });
  seenExtensions.push(res.headers.get('A2A-Extensions'));
  return res;
}) as typeof fetch;
const client = () =>
  new ClientFactory({
    transports: [new RestTransportFactory({ fetchImpl })],
  }).createFromUrl(base);
const ask = (messageId: string) =>
  SendMessageRequest.fromJSON({
    message: { messageId, role: 'ROLE_USER', parts: [{ text: 'q?' }] },
    configuration: { returnImmediately: true },
  });

// The SDK returns decoded messages; each check reads their ProtoJSON (toJSON).
it('sends, gets, lists and cancels through the SDK', async () => {
  const c = await client();
  await c.sendMessage(ask('c-1'));
  expect(
    JSON.stringify(
      Task.toJSON(await c.getTask(GetTaskRequest.fromJSON({ id: 'm-root' })))
    )
  ).toContain('TASK_STATE_WORKING');
  expect(
    JSON.stringify(
      ListTasksResponse.toJSON(
        await c.listTasks(ListTasksRequest.fromJSON({ pageSize: 10 }))
      )
    )
  ).toContain('m-root');
  await c.cancelTask(CancelTaskRequest.fromJSON({ id: 'm-root' }));
  expect(port.calls.some((call) => call.method === 'cancel')).toBe(true);
});

it('streams a task to completion and resubscribes', async () => {
  const c = await client();
  setTimeout(
    () =>
      port.change(
        'm-root',
        facts({
          answer: msg({
            id: 'm-ans',
            kind: 'answer',
            replyTo: 'm-root',
            from: 'human:wyat',
            body: 'done',
          }),
        })
      ),
    200
  );
  const events: string[] = [];
  for await (const e of c.sendMessageStream(
    SendMessageRequest.fromJSON({
      message: { messageId: 'c-2', role: 'ROLE_USER', parts: [{ text: 'q?' }] },
    })
  ))
    events.push(JSON.stringify(StreamResponse.toJSON(e)));
  expect(events.at(-1)).toContain('TASK_STATE_COMPLETED');
  port.tasks.set('m-root', facts());
  setTimeout(
    () =>
      port.change(
        'm-root',
        facts({
          answer: msg({
            id: 'm-ans2',
            kind: 'answer',
            replyTo: 'm-root',
            from: 'human:wyat',
          }),
        })
      ),
    200
  );
  const again: string[] = [];
  for await (const e of c.resubscribeTask(
    SubscribeToTaskRequest.fromJSON({ id: 'm-root' })
  ))
    again.push(JSON.stringify(StreamResponse.toJSON(e)));
  expect(again.at(-1)).toContain('TASK_STATE_COMPLETED');
});

it('echoes the active extensions', () => {
  expect(seenExtensions.filter((h) => h !== null)).toContain(ENVELOPE_URI);
});
