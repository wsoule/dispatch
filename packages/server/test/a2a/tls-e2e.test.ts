import {
  AgentCard,
  GetTaskRequest,
  SendMessageRequest,
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
import {
  approvedClient,
  freePort,
  selfSigned,
  taskIdOf,
  useSeedBase,
} from './seed.js';

let home: string;
let root: string;
let handle: ServerHandle;
let running: ServerHandle | null = null;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-tls-e2e-home-')));
  process.env.DISPATCH_HOME = home;
  root = initGitRepo('a2a-tls-e2e-');
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

// Opens the listener on every interface with a fresh self-signed certificate.
async function openTlsListener(): Promise<number> {
  const { cert, key } = await selfSigned(home);
  const listenerPort = await freePort();
  const status = await handle.a2a.applySettings({
    ...DEFAULT_LISTENER,
    enabled: true,
    host: '0.0.0.0',
    port: listenerPort,
    publicUrl: `https://localhost:${listenerPort}`,
    tls: { certPath: cert, keyPath: key },
  });
  expect(status).toMatchObject({ listening: true });
  return listenerPort;
}

it('an SDK client asks over TLS on a network listener and gets COMPLETED', async () => {
  const listenerPort = await openTlsListener();
  const { token } = await approvedClient('acme');
  // Bun's fetch takes `tls`; the self-signed cert is the only thing it relaxes.
  // Cast, not annotated: bun-types' `typeof fetch` also carries `preconnect`.
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    headers.set('A2A-Version', '1.0');
    return rawFetch(input, {
      ...init,
      headers,
      tls: { rejectUnauthorized: false },
    });
  }) as typeof fetch;
  const cardRes = await fetchImpl(
    `https://localhost:${listenerPort}/.well-known/agent-card.json`
  );
  expect(cardRes.status).toBe(200);
  const client = await new ClientFactory({
    transports: [new RestTransportFactory({ fetchImpl })],
  }).createFromAgentCard(AgentCard.fromJSON(await cardRes.json()));
  const sent = await client.sendMessage(
    SendMessageRequest.fromJSON({
      message: {
        messageId: 'c-tls',
        role: 'ROLE_USER',
        parts: [{ text: 'Over TLS?' }],
      },
      configuration: { returnImmediately: true },
    })
  );
  const taskId = taskIdOf(sent);
  expect(taskId).toMatch(/^m-/);
  const reply = await fetch(
    `http://127.0.0.1:${handle.port}/api/messages/${taskId}/reply`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Yes, over TLS.' }),
    }
  );
  expect(reply.status).toBeLessThan(300);
  // ProtoJSON, so the state reads by its wire name rather than its number.
  const task = JSON.stringify(
    Task.toJSON(await client.getTask(GetTaskRequest.fromJSON({ id: taskId })))
  );
  expect(task).toContain('TASK_STATE_COMPLETED');
  expect(task).toContain('Yes, over TLS.');
});

it('refuses plain http on the TLS listener', async () => {
  const listenerPort = await openTlsListener();
  await expect(
    rawFetch(`http://127.0.0.1:${listenerPort}/.well-known/agent-card.json`)
  ).rejects.toThrow();
});
