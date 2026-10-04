import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { ParkingExecutor, waitFor } from '../messaging/harness.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { useTestAuth } from '../testAuth.js';
import { FixturePeer } from './fixturePeer.js';
import { mcpCall, SessionExecutor } from './mcp.js';

let home: string;
let root: string;
let handle: ServerHandle | null = null;
let peer: FixturePeer;
const originalHome = process.env.DISPATCH_HOME;
const json = { 'content-type': 'application/json' };

async function boot(): Promise<ServerHandle> {
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
    registerExecutors: (o) => o.registerExecutor('park', new ParkingExecutor()),
  });
  useTestAuth(handle);
  return handle;
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-outbound-home-')));
  process.env.DISPATCH_HOME = home;
  root = initGitRepo('a2a-outbound-');
  TaskStore.init(root);
  peer = new FixturePeer().start();
});
afterEach(async () => {
  await handle?.stop();
  handle = null;
  await peer.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

it('a run’s blocking question to a peer gets the peer’s answer across a daemon restart', async () => {
  let h = await boot();
  const base = () => `http://127.0.0.1:${h.port}`;
  expect(
    (
      await fetch(`${base()}/api/a2a/peers`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          alias: 'fixture',
          cardUrl: peer.cardUrl(),
          token: 'peer-token',
        }),
      })
    ).status
  ).toBe(201);
  const created = (await (
    await fetch(`${base()}/api/tasks`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ title: 'ask the peer' }),
    })
  ).json()) as { meta: { id: string } };
  const run = await h.orchestrator.dispatch(created.meta.id, 'park');
  const { message: q } = await h.messaging.engine.send(
    {
      to: ['a2a:fixture'],
      kind: 'question',
      blocking: true,
      body: 'Which colour?',
    },
    { address: `run:${run.id}`, canDecide: false }
  );
  await waitFor(
    () => h.a2a.store?.getOutbound(q.id, 'fixture')?.state === 'open',
    5000
  );
  await h.stop();
  handle = null;

  h = await boot();
  peer.answer(peer.latest(), 'Blue.');
  await waitFor(() => h.messaging.engine.answerOf(q.id) !== null, 10_000);
  expect(h.messaging.engine.answerOf(q.id)).toMatchObject({
    from: 'a2a:fixture',
    kind: 'answer',
    body: 'Blue.',
  });
  expect(peer.opened).toHaveLength(1);
});

it('relays a delivery the first boot held but never sent', async () => {
  let h = await boot();
  const base = () => `http://127.0.0.1:${h.port}`;
  await fetch(`${base()}/api/a2a/peers`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      alias: 'fixture',
      cardUrl: peer.cardUrl(),
      token: 'peer-token',
    }),
  });
  peer.status = 503;
  const { message: q } = await h.messaging.engine.send(
    { to: ['a2a:fixture'], kind: 'message', body: 'FYI' },
    { address: 'human:test', canDecide: true }
  );
  await waitFor(
    () => (h.a2a.store?.getOutbound(q.id, 'fixture')?.attempts ?? 0) === 1,
    5000
  );
  await h.stop();
  handle = null;

  peer.status = 200;
  h = await boot();
  // The row's next attempt is 30 s out; the restarted worker honours it.
  expect(h.a2a.store?.getOutbound(q.id, 'fixture')?.state).toBe('queued');
  expect(peer.opened).toHaveLength(0);
});

it('a run’s MCP msg_send question to a peer returns the answer and reaches the run’s session', async () => {
  const executor = new SessionExecutor();
  const h = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: true,
    webDistDir: null,
    registerExecutors: (o) => o.registerExecutor('session', executor),
  });
  handle = h;
  useTestAuth(h);
  const base = `http://127.0.0.1:${h.port}`;
  await fetch(`${base}/api/a2a/peers`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      alias: 'fixture',
      cardUrl: peer.cardUrl(),
      token: 'peer-token',
    }),
  });
  const created = (await (
    await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ title: 'ask the peer over MCP' }),
    })
  ).json()) as { meta: { id: string } };
  const run = await h.orchestrator.dispatch(created.meta.id, 'session');
  await waitFor(() => executor.tokenFile !== null, 5000);
  const call = mcpCall(
    root,
    {
      DISPATCH_HOME: home,
      DISPATCH_RUN_TOKEN_FILE: executor.tokenFile ?? '',
      DISPATCH_RUN_ID: run.id,
    },
    'msg_send',
    {
      to: ['a2a:fixture'],
      kind: 'question',
      blocking: true,
      body: 'Which colour?',
    }
  );
  await waitFor(() => peer.opened.length === 1, 10_000);
  peer.answer(peer.latest(), 'Blue.');
  const result = await call;
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    message: { from: `run:${run.id}`, to: ['a2a:fixture'] },
    answer: { from: 'a2a:fixture', body: 'Blue.' },
  });
  await waitFor(
    () => executor.received.some((text) => text.includes('Blue.')),
    5000
  );
});
