import { GetTaskRequest, SendMessageRequest, Task } from '@a2a-js/sdk';
import { ClientFactory, RestTransportFactory } from '@a2a-js/sdk/client';
import { ecThumbprint } from '@dispatch/a2a';
import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeLinkPairedRecords } from '../../src/a2a/pairing.js';
import { DEFAULT_LISTENER } from '../../src/a2a/settings.js';
import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth } from '../testAuth.js';
import { approvedClient, freePort, taskIdOf, useSeedBase } from './seed.js';

// T56 interop: a daemon that holds pairings still serves a plain SDK client
// on its bearer, as before P5.
let home: string;
let root: string;
let handle: ServerHandle;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-interop-home-')));
  process.env.DISPATCH_HOME = home;
  root = initGitRepo('a2a-interop-');
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
  });
  useTestAuth(handle);
  useSeedBase(`http://127.0.0.1:${handle.port}`);
});
afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

it('a plain SDK client asks on its bearer while the daemon holds a pairing', async () => {
  const peers = handle.a2a.peers!;
  const jwk = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  }).publicKey.export({ format: 'jwk' }) as Record<string, string>;
  writeLinkPairedRecords(
    { ...peers.deps, notices: peers.notices, emit: peers.emit },
    {
      alias: 'teammate',
      pairedId: 'PAIRINGIDPAIRINGID0001',
      name: 'teammate',
      peer: { thumbprint: ecThumbprint(jwk) ?? '', jwk },
      creator: 'human:owner',
      creatorTier: 'operator',
    }
  );
  expect(handle.a2a.peerStatus('teammate')).toBe('active');

  const listenerPort = await freePort();
  await handle.a2a.applySettings({
    ...DEFAULT_LISTENER,
    enabled: true,
    port: listenerPort,
  });
  const { token } = await approvedClient('acme');
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    headers.set('A2A-Version', '1.0');
    return rawFetch(input, { ...init, headers });
  }) as typeof fetch;
  const client = await new ClientFactory({
    transports: [new RestTransportFactory({ fetchImpl })],
  }).createFromUrl(`http://127.0.0.1:${listenerPort}`);
  const sent = await client.sendMessage(
    SendMessageRequest.fromJSON({
      message: {
        messageId: 'c-1',
        role: 'ROLE_USER',
        parts: [{ text: 'Still there on a bearer?' }],
      },
      configuration: { returnImmediately: true },
    })
  );
  const taskId = taskIdOf(sent);
  const reply = await fetch(
    `http://127.0.0.1:${handle.port}/api/messages/${taskId}/reply`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Yes.' }),
    }
  );
  expect(reply.status).toBeLessThan(300);
  const task = JSON.stringify(
    Task.toJSON(await client.getTask(GetTaskRequest.fromJSON({ id: taskId })))
  );
  expect(task).toContain('TASK_STATE_COMPLETED');
}, 30_000);
