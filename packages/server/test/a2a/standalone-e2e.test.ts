import { GetTaskRequest, SendMessageRequest, Task } from '@a2a-js/sdk';
import { ClientFactory, RestTransportFactory } from '@a2a-js/sdk/client';
import { startStandalone } from '@dispatch/a2a';
import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth } from '../testAuth.js';
import { approvedClient, freePort, taskIdOf, useSeedBase } from './seed.js';

// A throwaway certificate whose SAN names localhost, so verification passes.
async function localhostCert(
  dir: string
): Promise<{ cert: string; key: string }> {
  const cert = join(dir, 'team.crt');
  const key = join(dir, 'team.key');
  const proc = Bun.spawn(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
    ],
    { stdout: 'ignore', stderr: 'ignore' }
  );
  expect(await proc.exited).toBe(0);
  return { cert, key };
}

let home: string;
let root: string;
let handle: ServerHandle | null = null;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-standalone-home-')));
  process.env.DISPATCH_HOME = home;
  root = initGitRepo('a2a-standalone-');
  TaskStore.init(root);
});
afterEach(async () => {
  await handle?.stop();
  handle = null;
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// P4's exit criterion: an SDK client talks only to the standalone host, which
// reaches the daemon only over its team-local TLS listener with a host token.
it('a standalone host serves an SDK client end to end through a team-local TLS daemon', async () => {
  const { cert, key } = await localhostCert(home);
  const h = await startServer({
    rootDir: root,
    port: 0,
    host: '0.0.0.0',
    tls: { certPath: cert, keyPath: key, port: 0 },
    writeDaemonFile: false,
    webDistDir: null,
  });
  handle = h;
  useTestAuth(h);
  const base = `http://127.0.0.1:${h.port}`;
  useSeedBase(base);
  const json = { 'content-type': 'application/json' };
  await fetch(`${base}/api/a2a/listener/standalone`, {
    method: 'PUT',
    headers: json,
    body: JSON.stringify({ enabled: true }),
  });
  const relayPort = await freePort();
  const { token: hostToken } = (await (
    await fetch(`${base}/api/a2a/hosts`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        name: 'relay',
        publicUrl: `http://127.0.0.1:${relayPort}`,
      }),
    })
  ).json()) as { token: string };
  const { token: clientToken } = await approvedClient('acme');
  const ca = readFileSync(cert, 'utf8');
  // The relay trusts the team certificate as its CA, verifying it as usual.
  const tlsOpts = { ca };
  const daemonFetch = ((input: string | URL, init?: RequestInit) =>
    rawFetch(String(input), {
      ...init,
      tls: tlsOpts,
    } as RequestInit)) as typeof fetch;
  const relay = await startStandalone({
    host: '127.0.0.1',
    port: relayPort,
    publicUrl: null,
    tls: null,
    publicBind: false,
    trustForwardedFor: false,
    daemonUrl: `https://localhost:${h.tlsPort}`,
    hostToken,
    fetchImpl: daemonFetch,
  });
  try {
    const clientFetch = ((
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${clientToken}`);
      headers.set('A2A-Version', '1.0');
      return rawFetch(input, { ...init, headers });
    }) as typeof fetch;
    const card = (await (
      await rawFetch(`${relay.url}/.well-known/agent-card.json`)
    ).json()) as {
      supportedInterfaces: { url: string }[];
      capabilities: { pushNotifications: boolean };
    };
    expect(card.supportedInterfaces[0].url).toBe(`${relay.url}/a2a/v1`);
    expect(card.capabilities.pushNotifications).toBe(false);
    const client = await new ClientFactory({
      transports: [new RestTransportFactory({ fetchImpl: clientFetch })],
    }).createFromUrl(relay.url);
    const sent = await client.sendMessage(
      SendMessageRequest.fromJSON({
        message: {
          messageId: 'c-relay',
          role: 'ROLE_USER',
          parts: [{ text: 'Through the relay?' }],
        },
        configuration: { returnImmediately: true },
      })
    );
    const taskId = taskIdOf(sent);
    expect(
      (
        await fetch(`${base}/api/messages/${taskId}/reply`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ body: 'Yes, through the relay.' }),
        })
      ).status
    ).toBeLessThan(300);
    const task = JSON.stringify(
      Task.toJSON(await client.getTask(GetTaskRequest.fromJSON({ id: taskId })))
    );
    expect(task).toContain('TASK_STATE_COMPLETED');
    expect(task).toContain('Yes, through the relay.');
    // The client's own bearer never works on /api, the port routes included.
    expect(
      (
        await rawFetch(`${base}/api/tasks`, {
          headers: { authorization: `Bearer ${clientToken}` },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await rawFetch(`https://localhost:${h.tlsPort}/api/a2a/port/whoami`, {
          headers: { authorization: `Bearer ${clientToken}` },
          tls: tlsOpts,
        } as RequestInit)
      ).status
    ).toBe(403);
  } finally {
    await relay.stop();
  }
});
