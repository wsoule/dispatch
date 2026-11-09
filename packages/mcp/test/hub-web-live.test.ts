import { hubDir, TaskStore, writeHubFile } from '@dispatch-foo/core';
import type { LinkHttpResponse, LinkProject } from '@dispatch-foo/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { isDaemonHealthy, readDaemonFile } from '../src/daemon.js';
import type { HubHandle } from '../src/hub/server.js';
import { startHub } from '../src/hub/server.js';
import { projectKey } from '../src/hub/web.js';

// The web reaching a project on this machine (phase 4): a stand-in team
// service sends the machine hub `projects` and `http` frames over the team
// link, the hub hands them to a real linked dispatchd, and the daemon answers
// as its operator at the decide tier. The machine's web switch closes it.

let fakeHome: string;
let root: string;
let daemon: Bun.Subprocess<'ignore', 'ignore', 'pipe'>;
let hub: HubHandle;
let team: ReturnType<typeof Bun.serve>;
let socket: Bun.ServerWebSocket<unknown> | null = null;
let next = 1000;
const replies = new Map<
  number,
  (frame: { ok: boolean; result?: unknown; error?: string }) => void
>();
const saved = {
  DISPATCH_HOME: process.env.DISPATCH_HOME,
  DISPATCH_HUB: process.env.DISPATCH_HUB,
};

async function until<T>(
  what: string,
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

// One request from the stand-in team service to the machine.
function call(
  kind: string,
  body: unknown
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const id = next++;
  return new Promise((resolve) => {
    replies.set(id, resolve);
    socket?.send(JSON.stringify({ id, kind, body }));
  });
}

beforeAll(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-web-home-'));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-web-root-')));
  process.env.DISPATCH_HOME = fakeHome;
  process.env.DISPATCH_HUB = '1';
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
    ['commit', '--allow-empty', '-m', 'initial commit'],
  ])
    Bun.spawnSync(['git', ...args], { cwd: root });
  TaskStore.init(root);

  // The team service's end of the link: answers the machine's own requests
  // and keeps the socket to send it the web's.
  team = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      return srv.upgrade(req, { data: undefined })
        ? undefined
        : new Response('no', { status: 400 });
    },
    websocket: {
      open(ws) {
        socket = ws;
      },
      message(ws, text) {
        const frame = JSON.parse(String(text)) as {
          id?: number;
          re?: number;
          ok?: boolean;
          result?: unknown;
          error?: string;
        };
        if (frame.re !== undefined) {
          replies.get(frame.re)?.({
            ok: frame.ok === true,
            result: frame.result,
            ...(frame.error === undefined ? {} : { error: frame.error }),
          });
          replies.delete(frame.re);
        } else if (frame.id !== undefined)
          ws.send(JSON.stringify({ re: frame.id, ok: true, result: {} }));
      },
    },
  });

  hub = await startHub({
    dir: hubDir(),
    token: 'hub-token',
    id: 'hub-id',
    handle: 'test',
    team: {
      server: `http://127.0.0.1:${String(team.port)}`,
      token: 'device-token',
      handle: 'test',
      team: { id: 'team-1', name: 'Team' },
      device: 'dev_test',
    },
  });
  writeHubFile({
    port: hub.port,
    pid: process.pid,
    id: 'hub-id',
    token: 'hub-token',
    version: 'test',
    startedAt: new Date().toISOString(),
  });

  const bin = join(
    dirname(
      createRequire(import.meta.url).resolve('@dispatch/server/package.json')
    ),
    'src',
    'bin.ts'
  );
  daemon = Bun.spawn(['bun', bin, '--root', root, '--port', '0'], {
    env: { ...process.env, DISPATCH_HOME: fakeHome, DISPATCH_HUB: '1' },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  await until('dispatchd', async () => {
    if (daemon.exitCode !== null)
      throw new Error(await new Response(daemon.stderr).text());
    const file = readDaemonFile(root);
    return file !== null && (await isDaemonHealthy(file.port));
  });
  await until('the team link', () => Promise.resolve(socket !== null));
}, 60_000);

afterAll(async () => {
  daemon.kill();
  await hub.close();
  await team.stop(true);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const hubApi = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${String(hub.port)}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer hub-token',
    },
  });

describe('the web reaching this machine', () => {
  it('lists the linked project and forwards a request to it', async () => {
    const key = projectKey(root);
    const listed = await until('the linked project', async () => {
      const answer = await call('projects', {});
      const projects = (answer.result as { projects?: LinkProject[] }).projects;
      return projects?.some((p) => p.key === key) === true ? projects : null;
    });
    expect(listed.find((p) => p.key === key)?.name).toBe(root.split('/').pop());

    const answer = await call('http', {
      project: key,
      method: 'GET',
      path: '/api/whoami',
      headers: { accept: 'application/json' },
      body: '',
    });
    expect(answer.ok).toBe(true);
    const res = answer.result as LinkHttpResponse;
    expect(res.status).toBe(200);
    expect(
      JSON.parse(Buffer.from(res.body, 'base64').toString('utf8'))
    ).toMatchObject({ tier: 'decide' });
  }, 40_000);

  it('answers an unknown project and an unknown kind instead of going quiet', async () => {
    expect(
      await call('http', {
        project: '0000000000000000',
        method: 'GET',
        path: '/api/whoami',
        headers: {},
        body: '',
      })
    ).toMatchObject({ ok: false, error: 'no such project' });
    expect(await call('nonsense', {})).toMatchObject({
      ok: false,
      error: 'unknown frame kind',
    });
  });

  it('closes when the machine turns web access off', async () => {
    expect(await (await hubApi('/api/web-access')).json()).toEqual({
      enabled: true,
    });
    const off = await hubApi('/api/web-access', {
      method: 'PUT',
      body: JSON.stringify({ enabled: false }),
    });
    expect(await off.json()).toEqual({ enabled: false });
    expect(await call('projects', {})).toMatchObject({
      ok: false,
      error: 'web access is off on this machine',
    });
    await hubApi('/api/web-access', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    });
    expect((await call('projects', {})).ok).toBe(true);
  });

  it('keeps the switch to the hub token', async () => {
    const res = await fetch(
      `http://127.0.0.1:${String(hub.port)}/api/web-access`,
      { method: 'PUT', body: JSON.stringify({ enabled: false }) }
    );
    expect(res.status).toBe(401);
    expect(await (await hubApi('/api/web-access')).json()).toEqual({
      enabled: true,
    });
  });
});
