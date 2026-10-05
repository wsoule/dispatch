import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_LISTENER } from '../../src/a2a/settings.js';
import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { waitFor } from '../messaging/harness.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { useTestAuth } from '../testAuth.js';
import { mcpCall, SessionExecutor } from './mcp.js';
import { freePort } from './seed.js';

let home: string;
let senderRoot: string;
let receiverRoot: string;
const handles: ServerHandle[] = [];
const originalHome = process.env.DISPATCH_HOME;
const json = { 'content-type': 'application/json' };

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-two-daemons-home-')));
  process.env.DISPATCH_HOME = home;
  senderRoot = initGitRepo('a2a-two-sender-');
  receiverRoot = initGitRepo('a2a-two-receiver-');
  TaskStore.init(senderRoot);
  TaskStore.init(receiverRoot);
});
afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(senderRoot, { recursive: true, force: true });
  rmSync(receiverRoot, { recursive: true, force: true });
});

// Dispatch to Dispatch: one daemon adds the other as a peer, a run asks it
// over MCP, the other's owner answers, and the answer comes back to the run.
it('a run’s MCP question to another Dispatch daemon gets its owner’s answer', async () => {
  const receiver = await startServer({
    rootDir: receiverRoot,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
  });
  handles.push(receiver);
  useTestAuth(receiver);
  const listenerPort = await freePort();
  await receiver.a2a.applySettings({
    ...DEFAULT_LISTENER,
    enabled: true,
    port: listenerPort,
  });
  const client = await fetch(
    `http://127.0.0.1:${receiver.port}/api/a2a/clients`,
    {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: 'sender', approve: true }),
    }
  );
  expect(client.status).toBe(201);
  const { token } = (await client.json()) as { token: string };

  const executor = new SessionExecutor();
  const sender = await startServer({
    rootDir: senderRoot,
    port: 0,
    writeDaemonFile: true,
    webDistDir: null,
    registerExecutors: (o) => o.registerExecutor('session', executor),
  });
  handles.push(sender);
  useTestAuth(sender);
  const base = `http://127.0.0.1:${sender.port}`;
  const added = await fetch(`${base}/api/a2a/peers`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      alias: 'pd',
      cardUrl: `http://127.0.0.1:${listenerPort}/.well-known/agent-card.json`,
      token,
    }),
  });
  expect(added.status).toBe(201);
  const created = (await (
    await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ title: 'ask the other project' }),
    })
  ).json()) as { meta: { id: string } };
  const run = await sender.orchestrator.dispatch(created.meta.id, 'session');
  await waitFor(() => executor.tokenFile !== null, 5000);
  const call = mcpCall(
    senderRoot,
    {
      DISPATCH_HOME: home,
      DISPATCH_RUN_TOKEN_FILE: executor.tokenFile ?? '',
      DISPATCH_RUN_ID: run.id,
    },
    'msg_send',
    {
      to: ['a2a:pd'],
      kind: 'question',
      blocking: true,
      body: 'Is the /sessions shape final?',
    }
  );
  let questionId = '';
  await waitFor(() => {
    const q = receiver.messaging.engine
      .openBlocking()
      .find((m) => m.body === 'Is the /sessions shape final?');
    questionId = q?.id ?? '';
    return q !== undefined;
  }, 10_000);
  // The sender follows the task by stream: the receiver sees it subscribe.
  await waitFor(() => (receiver.a2a.watch?.count() ?? 0) > 0, 10_000);
  const reply = await fetch(
    `http://127.0.0.1:${receiver.port}/api/messages/${questionId}/reply`,
    { method: 'POST', headers: json, body: JSON.stringify({ body: 'Final.' }) }
  );
  expect(reply.status).toBeLessThan(300);
  const result = await call;
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    message: { from: `run:${run.id}`, to: ['a2a:pd'] },
    answer: { from: 'a2a:pd', kind: 'answer' },
  });
  expect(sender.a2a.peerStatus('pd')).toBe('active');
}, 30_000);
