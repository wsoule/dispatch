import {
  GetTaskRequest,
  SendMessageRequest,
  StreamResponse,
  Task,
} from '@a2a-js/sdk';
import { ClientFactory, RestTransportFactory } from '@a2a-js/sdk/client';
import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_LISTENER } from '../../src/a2a/settings.js';
import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth } from '../testAuth.js';
import { approvedClient, freePort, taskIdOf, useSeedBase } from './seed.js';

let home: string;
let root: string;
let handle: ServerHandle;
let running: ServerHandle | null = null;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-ask-e2e-home-')));
  process.env.DISPATCH_HOME = home;
  root = initGitRepo('a2a-ask-e2e-');
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
  });
  running = handle;
  useTestAuth(handle);
  useSeedBase(`http://127.0.0.1:${handle.port}`);
});
afterEach(async () => {
  await running?.stop();
  running = null;
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// An SDK client on a fresh listener, as an approved client `name`.
async function sdkClientFor(name: string) {
  const listenerPort = await freePort();
  await handle.a2a.applySettings({
    ...DEFAULT_LISTENER,
    enabled: true,
    port: listenerPort,
  });
  const { caller, token } = await approvedClient(name);
  // Cast, not annotated: bun-types' `typeof fetch` also carries `preconnect`.
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    headers.set('A2A-Version', '1.0');
    return rawFetch(input, { ...init, headers });
  }) as typeof fetch;
  const client = await new ClientFactory({
    transports: [new RestTransportFactory({ fetchImpl })],
  }).createFromUrl(`http://127.0.0.1:${listenerPort}`);
  return { client, caller };
}

// The owner answers a question through /api, as the desktop would.
function ownerReply(id: string, body: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle.port}/api/messages/${id}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

it('an SDK client asks over the listener, the owner answers through /api, the client sees COMPLETED', async () => {
  const { client } = await sdkClientFor('acme');
  const sent = await client.sendMessage(
    SendMessageRequest.fromJSON({
      message: {
        messageId: 'c-1',
        role: 'ROLE_USER',
        parts: [{ text: 'Is /sessions final?' }],
      },
      configuration: { returnImmediately: true },
    })
  );
  const taskId = taskIdOf(sent);
  expect(taskId).toMatch(/^m-/);
  expect((await ownerReply(taskId, 'Yes, final.')).status).toBeLessThan(300);
  // ProtoJSON, so the state reads by its wire name rather than its number.
  const task = JSON.stringify(
    Task.toJSON(await client.getTask(GetTaskRequest.fromJSON({ id: taskId })))
  );
  expect(task).toContain('TASK_STATE_COMPLETED');
  expect(task).toContain('Yes, final.');
});

it('a streamed ask completes when the owner answers', async () => {
  const { client, caller } = await sdkClientFor('streamer');
  const events: string[] = [];
  const stream = client.sendMessageStream(
    SendMessageRequest.fromJSON({
      message: {
        messageId: 'c-2',
        role: 'ROLE_USER',
        parts: [{ text: 'Stream me' }],
      },
    })
  );
  const answerLater = (async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const open = handle.a2a
        .store!.tasksOf(caller.address)
        .find((t) => t.state === 'WORKING');
      if (open !== undefined) {
        await ownerReply(open.id, 'Streamed answer');
        return;
      }
      await Bun.sleep(50);
    }
  })();
  for await (const event of stream)
    events.push(JSON.stringify(StreamResponse.toJSON(event)));
  await answerLater;
  expect(events.at(-1)).toContain('TASK_STATE_COMPLETED');
});

it('a client token is refused on /api while the listener serves it', async () => {
  await sdkClientFor('listening');
  const { token } = await approvedClient('acme');
  const res = await rawFetch(`http://127.0.0.1:${handle.port}/api/tasks`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(403);
});
