import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tokenHash } from '../../src/a2a/auth.js';
import { authenticateHost, mintHost } from '../../src/a2a/hosts.js';
import { PortLeases } from '../../src/a2a/portRoutes.js';
import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { useTempProject } from '../messaging/harness.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth } from '../testAuth.js';
import { bridgeFixture } from './fixture.js';
import { approvedClient, useSeedBase } from './seed.js';

describe('leases and host tokens (fixture)', () => {
  const project = useTempProject();
  let f: Awaited<ReturnType<typeof bridgeFixture>>;
  beforeEach(async () => {
    f = await bridgeFixture(project.root());
  });
  afterEach(() => f.close());

  // Review Focus 1, across HTTP.
  it('an unreleased lease frees its slot when it expires', async () => {
    const base = f.deps.policy();
    f.deps.policy = () => ({ ...base, streamsPerClient: 1 });
    const leases = new PortLeases(30);
    const admitted = await f.port.admit(f.caller, 'stream');
    if (!admitted.ok || admitted.release === undefined)
      throw new Error('expected a stream slot');
    leases.hold(admitted.release);
    expect((await f.port.admit(f.caller, 'stream')).ok).toBe(false);
    await Bun.sleep(60);
    expect((await f.port.admit(f.caller, 'stream')).ok).toBe(true);
  });

  it('ending a lease early releases the slot once', () => {
    const leases = new PortLeases();
    let released = 0;
    const id = leases.hold(() => {
      released += 1;
    });
    expect(leases.end(id)).toBe(true);
    expect(leases.end(id)).toBe(false);
    expect(released).toBe(1);
  });

  it('mints a 256-bit token, keeps only its hash, and refuses it once revoked', () => {
    const { row, token } = mintHost(f.store, 'relay', 'human:wyat');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).toBe(tokenHash(token));
    expect(JSON.stringify(f.store.hosts())).not.toContain(token);
    expect(authenticateHost(f.store, token)?.id).toBe(row.id);
    expect(authenticateHost(f.store, `${token}x`)).toBeNull();
    expect(authenticateHost(f.store, '')).toBeNull();
    f.store.revokeHost(row.id, new Date().toISOString());
    expect(authenticateHost(f.store, token)).toBeNull();
  });
});

describe('the /api/a2a/port routes (daemon)', () => {
  let home: string;
  let root: string;
  let handle: ServerHandle;
  let base: string;
  const originalHome = process.env.DISPATCH_HOME;
  const json = { 'content-type': 'application/json' };

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-port-home-')));
    process.env.DISPATCH_HOME = home;
    root = initGitRepo('a2a-port-');
    TaskStore.init(root);
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      webDistDir: null,
    });
    useTestAuth(handle);
    base = `http://127.0.0.1:${handle.port}`;
    useSeedBase(base);
  });
  afterEach(async () => {
    await handle.stop();
    if (originalHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const mint = async (name = 'relay') =>
    (await (
      await fetch(`${base}/api/a2a/hosts`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ name }),
      })
    ).json()) as { id: string; name: string; token: string };
  const allowStandalone = () =>
    fetch(`${base}/api/a2a/listener/standalone`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ enabled: true }),
    });

  it('keeps /api/a2a/port/* dark until the operator allows standalone hosts', async () => {
    const { token } = await mint();
    const whoami = () =>
      rawFetch(`${base}/api/a2a/port/whoami`, {
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await whoami()).status).toBe(404);
    expect((await allowStandalone()).status).toBe(200);
    expect((await whoami()).status).toBe(200);
    expect(
      (
        (await (await fetch(`${base}/api/a2a/hosts`)).json()) as {
          standalone: boolean;
        }
      ).standalone
    ).toBe(true);
  });

  it('needs the operator tier for hosts and the standalone switch', async () => {
    const lead = handle.team.teammates.issue('ada', 'decide');
    const as = (init: RequestInit) => ({
      ...init,
      headers: { ...json, authorization: `Bearer ${lead}` },
    });
    expect(
      (
        await rawFetch(
          `${base}/api/a2a/hosts`,
          as({ method: 'POST', body: JSON.stringify({ name: 'x' }) })
        )
      ).status
    ).toBe(403);
    expect((await rawFetch(`${base}/api/a2a/hosts`, as({}))).status).toBe(403);
    expect(
      (
        await rawFetch(
          `${base}/api/a2a/listener/standalone`,
          as({ method: 'PUT', body: JSON.stringify({ enabled: true }) })
        )
      ).status
    ).toBe(403);
  });

  it('shows a host token once and never lists it or its hash', async () => {
    const minted = await mint();
    const listed = await (await fetch(`${base}/api/a2a/hosts`)).text();
    expect(listed).toContain(minted.id);
    expect(listed).not.toContain(minted.token);
    expect(listed).not.toContain(tokenHash(minted.token));
  });

  it('accepts host tokens only: not the app, agent or teammate token, and not a client bearer', async () => {
    await allowStandalone();
    const minted = await mint();
    const { token: clientToken } = await approvedClient('acme');
    const call = (authorization: string) =>
      rawFetch(`${base}/api/a2a/port/tasks`, {
        headers: {
          authorization,
          'x-a2a-client-authorization': `Bearer ${clientToken}`,
        },
      });
    expect((await call(`Bearer ${minted.token}`)).status).toBe(200);
    expect((await call('Bearer not-a-host')).status).toBe(401);
    expect((await call(`Bearer ${handle.tokens.appToken}`)).status).toBe(401);
    expect((await call(`Bearer ${handle.tokens.agentToken}`)).status).toBe(401);
    const lead = handle.team.teammates.issue('ada', 'operator');
    expect((await call(`Bearer ${lead}`)).status).toBe(401);
    expect((await call(`Bearer ${clientToken}`)).status).toBe(403);
    await fetch(`${base}/api/a2a/hosts/${minted.id}`, { method: 'DELETE' });
    expect((await call(`Bearer ${minted.token}`)).status).toBe(401);
    expect(
      (await fetch(`${base}/api/a2a/hosts/${minted.id}`, { method: 'DELETE' }))
        .status
    ).toBe(404);
  });

  it('builds the card for a host’s public URL only when a host asks, and refuses a bad one', async () => {
    await allowStandalone();
    const { token } = await mint();
    const card = (q: string, auth = `Bearer ${token}`) =>
      rawFetch(`${base}/api/a2a/port/card${q}`, {
        headers: { authorization: auth },
      });
    const relay = `?publicUrl=${encodeURIComponent('https://relay.example.com')}`;
    const res = await card(relay);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      publicUrl: 'https://relay.example.com',
      pushNotifications: false,
    });
    expect((await card(relay, 'Bearer nope')).status).toBe(401);
    for (const bad of ['javascript:alert(1)', 'http://evil.example.com'])
      expect((await card(`?publicUrl=${encodeURIComponent(bad)}`)).status).toBe(
        400
      );
  });

  it('never logs a host token', async () => {
    const logged: string[] = [];
    const spies = (['log', 'error', 'warn'] as const).map((level) =>
      spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      })
    );
    let token = '';
    try {
      await allowStandalone();
      token = (await mint()).token;
      await rawFetch(`${base}/api/a2a/port/whoami`, {
        headers: { authorization: `Bearer ${token}` },
      });
      await rawFetch(`${base}/api/a2a/port/nope`, {
        headers: { authorization: `Bearer ${token}` },
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(logged.join('\n')).not.toContain(token);
  });
});
