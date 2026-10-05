import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { rawFetch } from './testAuth.js';

// Presence end to end: a teammate opening the event socket makes them
// present, closing it makes them absent, and everyone else hears about both.

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-presence-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'wyat@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Wyat']);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial']);
  return dir;
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
let ada: string;
const sockets: WebSocket[] = [];
const originalHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initRepo();
  TaskStore.init(root);
  handle = await startServer({ rootDir: root, port: 0, webDistDir: null });
  baseUrl = `http://127.0.0.1:${handle.port}`;
  const res = await rawFetch(`${baseUrl}/api/team/tokens`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${handle.tokens.appToken}`,
    },
    body: JSON.stringify({ email: 'ada@example.com' }),
  });
  ada = ((await res.json()) as { token: string }).token;
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

/** Opens the event socket as `token` and resolves once the server's hello
 *  arrives, i.e. once `open` has run on the server side. */
function connect(token: string): Promise<{ ws: WebSocket; events: string[] }> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${handle.port}/ws?token=${encodeURIComponent(token)}`
  );
  sockets.push(ws);
  const events: string[] = [];
  return new Promise((resolve, reject) => {
    ws.onmessage = (msg) => {
      const type = (JSON.parse(String(msg.data)) as { type: string }).type;
      events.push(type);
      if (type === 'hello') resolve({ ws, events });
    };
    ws.onerror = () => reject(new Error('socket failed'));
  });
}

async function presence(): Promise<{ handle: string; connections: number }[]> {
  const res = await rawFetch(`${baseUrl}/api/presence`, {
    headers: { authorization: `Bearer ${handle.tokens.agentToken}` },
  });
  return (await res.json()) as { handle: string; connections: number }[];
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition never held');
}

it('nobody is present until a client connects', async () => {
  expect(await presence()).toEqual([]);
});

it('a teammate is present while their socket is open', async () => {
  const { ws } = await connect(ada);

  expect((await presence()).map((p) => p.handle)).toEqual(['ada']);

  ws.close();
  await until(async () => (await presence()).length === 0);
});

it('two people on one daemon are two entries, not one', async () => {
  await connect(ada);
  await connect(handle.tokens.appToken);

  // The whole point of tokens naming people: the operator and Ada are not
  // the same caller any more.
  expect((await presence()).map((p) => p.handle).sort()).toEqual([
    'ada',
    'wyat',
  ]);
});

it('everyone else hears someone arrive and leave', async () => {
  const watcher = await connect(handle.tokens.appToken);
  const { ws } = await connect(ada);
  await until(async () => watcher.events.includes('presence.changed'));

  const before = watcher.events.filter((e) => e === 'presence.changed').length;
  ws.close();
  await until(
    async () =>
      watcher.events.filter((e) => e === 'presence.changed').length > before
  );
});

it('says which task each person has open, and forgets it when they leave', async () => {
  const { ws, events } = await connect(ada);
  const focus = (taskId: string | null) =>
    rawFetch(`${baseUrl}/api/presence/focus`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ada}`,
      },
      body: JSON.stringify({ taskId }),
    });

  expect((await focus('t-abc123')).status).toBe(200);
  const viewing = async () =>
    (
      (await presence()) as unknown as {
        handle: string;
        viewing: string | null;
      }[]
    ).find((p) => p.handle === 'ada')?.viewing;
  expect(await viewing()).toBe('t-abc123');
  // Everyone else's stack updates off the same event as a connection.
  await until(async () => events.includes('presence.changed'));

  expect((await focus('../../etc')).status).toBe(400);

  ws.close();
  await until(async () => (await presence()).length === 0);
  await connect(ada);
  expect(await viewing()).toBeNull();
});

it('the team address is decide-tier and empty on loopback', async () => {
  const asAgent = await rawFetch(`${baseUrl}/api/team/address`, {
    headers: { authorization: `Bearer ${handle.tokens.agentToken}` },
  });
  expect(asAgent.status).toBe(403);
  const asOperator = await rawFetch(`${baseUrl}/api/team/address`, {
    headers: { authorization: `Bearer ${handle.tokens.appToken}` },
  });
  expect(await asOperator.json()).toEqual({ shared: false, origins: [] });
});
