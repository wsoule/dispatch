import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { runGitSync } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth } from '../testAuth.js';

let fakeHome: string;
let root: string;
let dist: string;
let handle: ServerHandle;
let baseUrl: string;
let mobileUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-mobile-api-'));
  runGitSync(root, ['init', '-b', 'main']);
  runGitSync(root, ['config', 'user.email', 'test@example.com']);
  runGitSync(root, ['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'README.md'), '# test\n');
  runGitSync(root, ['add', '-A']);
  runGitSync(root, ['commit', '-m', 'init']);
  TaskStore.init(root);
  dist = mkdtempSync(join(tmpdir(), 'dispatch-mobile-dist-'));
  mkdirSync(join(dist, 'm'));
  writeFileSync(join(dist, 'm', 'index.html'), '<html><head></head>m</html>');
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerExecutors: () => {},
    mobile: { port: 0 },
    mobileDistDir: dist,
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
  const listening = handle.mobile.status().listening;
  if (listening === null) throw new Error('mobile listener did not open');
  mobileUrl = `http://127.0.0.1:${listening}`;
  // A cold daemon boot can outrun bun's 5s hook default.
}, 30_000);

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  for (const dir of [fakeHome, root, dist])
    rmSync(dir, { recursive: true, force: true });
});

describe('the mobile listener on a real daemon', () => {
  it('serves the app with no token in it, though the request is from loopback', async () => {
    const res = await rawFetch(`${mobileUrl}/m/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(handle.tokens.agentToken);
    expect(html).not.toContain('__DISPATCH');
  });

  it("refuses the daemon's own tokens: only a paired device gets in", async () => {
    for (const token of [handle.tokens.agentToken, handle.tokens.appToken]) {
      const res = await rawFetch(`${mobileUrl}/api/decisions/open`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(401);
    }
  });

  it('sends no CORS headers to another origin', async () => {
    const res = await rawFetch(`${mobileUrl}/api/runs`, {
      headers: { origin: 'https://evil.test' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

// Pairs a phone the way a person would: the operator offers a code on the
// main listener, the phone redeems it through the mobile listener.
async function pairPhone(): Promise<string> {
  const offer = await fetch(`${baseUrl}/api/pair/offer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tier: 'decide' }),
  });
  expect(offer.ok).toBe(true);
  const { code } = (await offer.json()) as { code: string };
  const paired = await rawFetch(`${mobileUrl}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: 'Test phone' }),
  });
  expect(paired.ok).toBe(true);
  return ((await paired.json()) as { token: string }).token;
}

describe('a paired phone through the mobile listener', () => {
  it('pairs, then reads what is waiting and the runs', async () => {
    const token = await pairPhone();
    const auth = { authorization: `Bearer ${token}` };
    const open = await rawFetch(`${mobileUrl}/api/decisions/open`, {
      headers: auth,
    });
    expect(open.status).toBe(200);
    expect(await open.json()).toEqual({ items: [] });
    const runs = await rawFetch(`${mobileUrl}/api/runs`, { headers: auth });
    expect(runs.status).toBe(200);
  });

  it('is kept off the rest of the API whatever its tier', async () => {
    const token = await pairPhone();
    const res = await rawFetch(`${mobileUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('subscribes to pushes, and loses the subscription when unpaired', async () => {
    const token = await pairPhone();
    const auth = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const key = await rawFetch(`${mobileUrl}/api/mobile/push/key`, {
      headers: auth,
    });
    expect(((await key.json()) as { publicKey: string }).publicKey).toBe(
      handle.mobile.vapid().publicKey
    );
    const sub = await rawFetch(`${mobileUrl}/api/mobile/push/subscriptions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        endpoint: 'https://fcm.googleapis.com/fcm/send/phone',
        keys: {
          p256dh:
            'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
          auth: 'BTBZMqHH6r4Tts7J_aSIgg',
        },
      }),
    });
    expect(sub.status).toBe(201);
    const me = await rawFetch(`${mobileUrl}/api/mobile/me`, { headers: auth });
    const { device, push } = (await me.json()) as {
      device: string;
      push: boolean;
    };
    expect(push).toBe(true);
    const revoked = await fetch(`${baseUrl}/api/devices/${device}`, {
      method: 'DELETE',
    });
    expect(revoked.status).toBe(200);
    const after = await rawFetch(`${mobileUrl}/api/mobile/me`, {
      headers: auth,
    });
    expect(after.status).toBe(401);
  });
});

describe('/api/mobile on the main listener', () => {
  it('reports the listener to the operator', async () => {
    const res = await fetch(`${baseUrl}/api/mobile/settings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { listening: number | null };
    expect(body.listening).toBe(Number(new URL(mobileUrl).port));
  });

  it('keeps the settings from the agent token', async () => {
    const res = await rawFetch(`${baseUrl}/api/mobile/settings`, {
      headers: { authorization: `Bearer ${handle.tokens.agentToken}` },
    });
    expect(res.status).toBe(403);
  });

  it('refuses a public URL a phone could not install from', async () => {
    const res = await fetch(`${baseUrl}/api/mobile/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 4999, publicUrl: 'http://laptop.local' }),
    });
    expect(res.status).toBe(400);
  });

  it('closes the listener when the port is cleared, and saves it', async () => {
    const res = await fetch(`${baseUrl}/api/mobile/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        port: null,
        publicUrl: 'https://laptop.tailnet.ts.net',
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      port: null,
      publicUrl: 'https://laptop.tailnet.ts.net',
      listening: null,
      error: null,
    });
    const after = await rawFetch(`${mobileUrl}/m/`).catch(() => null);
    expect(after).toBeNull();
  });

  it('keeps push subscriptions to paired devices', async () => {
    const res = await fetch(`${baseUrl}/api/mobile/push/subscriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example/x', keys: {} }),
    });
    expect(res.status).toBe(403);
  });
});
