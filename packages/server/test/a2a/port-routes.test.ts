import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tokenHash } from '../../src/a2a/auth.js';
import { authenticateHost, mintHost } from '../../src/a2a/hosts.js';
import { PortLeases, PortWatches } from '../../src/a2a/portRoutes.js';
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
    leases.hold(admitted.release, 'h-a');
    expect((await f.port.admit(f.caller, 'stream')).ok).toBe(false);
    await Bun.sleep(60);
    expect((await f.port.admit(f.caller, 'stream')).ok).toBe(true);
  });

  it('ending a lease early releases the slot once', () => {
    const leases = new PortLeases();
    let released = 0;
    const id = leases.hold(() => {
      released += 1;
    }, 'h-a');
    expect(leases.end(id, 'h-a')).toBe(true);
    expect(leases.end(id, 'h-a')).toBe(false);
    expect(released).toBe(1);
  });

  it('ends a lease only for the host that holds it, and all of a host’s at once', () => {
    const leases = new PortLeases();
    const released: string[] = [];
    const a1 = leases.hold(() => released.push('a1'), 'h-a');
    leases.hold(() => released.push('a2'), 'h-a');
    const b1 = leases.hold(() => released.push('b1'), 'h-b');
    expect(leases.end(a1, 'h-b')).toBe(false);
    expect(released).toEqual([]);
    leases.endHost('h-a');
    expect(released.sort()).toEqual(['a1', 'a2']);
    expect(leases.end(b1, 'h-b')).toBe(true);
  });

  it('mints a 256-bit token, keeps only its hash, and refuses it once revoked', () => {
    const { row, token } = mintHost(
      f.store,
      'relay',
      'https://relay.example.com',
      'human:wyat'
    );
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

describe('watch streams (unit)', () => {
  const never = () => () => undefined;
  const yes = () => Promise.resolve(true);
  // Reads until the stream ends; false if it is still open after `ms`.
  const endsWithin = async (res: Response, ms: number) => {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const deadline = Date.now() + ms;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(left).then(() => null),
      ]);
      if (next === null) return false;
      if (next.done) return true;
    }
  };
  const limits = { keepaliveMs: 10, maxMs: 60_000, perHost: 2 };

  it('caps the streams one host holds at once', () => {
    const watches = new PortWatches(limits);
    const signal = new AbortController().signal;
    expect(watches.open('h-a', never, yes, signal)).not.toBeNull();
    expect(watches.open('h-a', never, yes, signal)).not.toBeNull();
    expect(watches.open('h-a', never, yes, signal)).toBeNull();
    expect(watches.open('h-b', never, yes, signal)).not.toBeNull();
  });

  it('closes a stream whose host or client no longer checks out at a keepalive', async () => {
    const watches = new PortWatches(limits);
    let ok = true;
    const res = watches.open(
      'h-a',
      never,
      () => Promise.resolve(ok),
      new AbortController().signal
    );
    if (res === null) throw new Error('expected a stream');
    ok = false;
    expect(await endsWithin(res, 500)).toBe(true);
  });

  it('closes a stream after its maximum age', async () => {
    const watches = new PortWatches({ ...limits, maxMs: 30 });
    const res = watches.open('h-a', never, yes, new AbortController().signal);
    if (res === null) throw new Error('expected a stream');
    expect(await endsWithin(res, 500)).toBe(true);
  });

  it('closes every stream of a host at once, and frees its slots', async () => {
    const watches = new PortWatches({ ...limits, keepaliveMs: 60_000 });
    let unwatched = 0;
    const sub = () => () => {
      unwatched += 1;
    };
    const signal = new AbortController().signal;
    const a = watches.open('h-a', sub, yes, signal);
    const b = watches.open('h-b', sub, yes, signal);
    if (a === null || b === null) throw new Error('expected streams');
    watches.closeHost('h-a');
    expect(await endsWithin(a, 200)).toBe(true);
    expect(unwatched).toBe(1);
    expect(watches.open('h-a', sub, yes, signal)).not.toBeNull();
    watches.closeAll();
    expect(await endsWithin(b, 200)).toBe(true);
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

  const RELAY = 'https://relay.example.com';
  const mint = async (name = 'relay', publicUrl: string = RELAY) =>
    (await (
      await fetch(`${base}/api/a2a/hosts`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ name, publicUrl }),
      })
    ).json()) as { id: string; name: string; token: string; publicUrl: string };
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

  it('keeps standalone hosts allowed when a listener write leaves the flag out', async () => {
    await allowStandalone();
    const put = (body: unknown) =>
      fetch(`${base}/api/a2a/listener`, {
        method: 'PUT',
        headers: json,
        body: JSON.stringify(body),
      });
    const standalone = async () =>
      (
        (await (await fetch(`${base}/api/a2a/hosts`)).json()) as {
          standalone: boolean;
        }
      ).standalone;
    expect((await put({ enabled: false })).status).toBe(200);
    expect(await standalone()).toBe(true);
    expect((await put({ enabled: false, standalone: false })).status).toBe(200);
    expect(await standalone()).toBe(false);
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

  it('pins a host’s public URL when it is minted, and refuses a bad one', async () => {
    const post = (body: unknown) =>
      fetch(`${base}/api/a2a/hosts`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify(body),
      });
    expect((await post({ name: 'relay' })).status).toBe(400);
    for (const bad of [
      'javascript:alert(1)',
      'http://evil.example.com',
      'https://relay.example.com/?q=1',
      'https://user:pw@relay.example.com',
    ])
      expect((await post({ name: 'relay', publicUrl: bad })).status).toBe(400);
    const minted = await mint('relay', 'https://relay.example.com/');
    expect(minted.publicUrl).toBe(RELAY);
    const listed = (await (await fetch(`${base}/api/a2a/hosts`)).json()) as {
      hosts: { publicUrl: string }[];
    };
    expect(listed.hosts[0].publicUrl).toBe(RELAY);
  });

  it('builds the card only for the URL the host was minted with', async () => {
    await allowStandalone();
    const { token } = await mint();
    const card = (q: string, auth = `Bearer ${token}`) =>
      rawFetch(`${base}/api/a2a/port/card${q}`, {
        headers: { authorization: auth },
      });
    const at = (url: string) => `?publicUrl=${encodeURIComponent(url)}`;
    const res = await card(at(RELAY));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      publicUrl: RELAY,
      pushNotifications: false,
    });
    expect(await (await card('')).json()).toMatchObject({ publicUrl: RELAY });
    expect((await card(at(RELAY), 'Bearer nope')).status).toBe(401);
    for (const other of [
      'https://other.example.com',
      'javascript:alert(1)',
      'http://127.0.0.1:9',
    ])
      expect((await card(at(other))).status).toBe(403);
  });

  // Opens a task as `clientToken` through `hostToken`, then watches it.
  const hostCall = (
    hostToken: string,
    path: string,
    init: RequestInit & { client?: string } = {}
  ) =>
    rawFetch(`${base}/api/a2a/port${path}`, {
      ...init,
      headers: {
        ...json,
        authorization: `Bearer ${hostToken}`,
        ...(init.client === undefined
          ? {}
          : { 'x-a2a-client-authorization': `Bearer ${init.client}` }),
      },
    });
  const admitStream = async (hostToken: string, client: string) =>
    (await (
      await hostCall(hostToken, '/admit', {
        method: 'POST',
        client,
        body: JSON.stringify({ what: 'stream' }),
      })
    ).json()) as { ok: boolean; lease?: string };
  const openTask = async (hostToken: string, client: string) =>
    (
      (await (
        await hostCall(hostToken, '/open', {
          method: 'POST',
          client,
          body: JSON.stringify({
            clientMessageId: `m-${Math.random()}`,
            contextId: null,
            kind: 'ask',
            to: null,
            replyTo: null,
            body: 'Are you there?',
            refs: [],
          }),
        })
      ).json()) as { taskId: string }
    ).taskId;
  // True once the stream's body ends, false if it is still open after `ms`.
  const endsWithin = async (res: Response, ms: number) => {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const deadline = Date.now() + ms;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(left).then(() => null),
      ]);
      if (next === null) return false;
      if (next.done) return true;
    }
  };

  it('releases a lease with the host token alone, and only for the host that took it', async () => {
    await allowStandalone();
    const a = await mint('relay-a');
    const b = await mint('relay-b');
    const { token: client } = await approvedClient('acme');
    const leases: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const admitted = await admitStream(a.token, client);
      expect(admitted.ok).toBe(true);
      leases.push(admitted.lease ?? '');
    }
    expect((await admitStream(a.token, client)).ok).toBe(false);
    const release = (hostToken: string) =>
      hostCall(hostToken, `/admit/${encodeURIComponent(leases[0])}`, {
        method: 'DELETE',
      });
    expect((await release(b.token)).status).toBe(404);
    expect((await admitStream(a.token, client)).ok).toBe(false);
    expect((await release(a.token)).status).toBe(204);
    expect((await admitStream(a.token, client)).ok).toBe(true);
  });

  it('revoking a host ends its leases and closes its watch streams', async () => {
    await allowStandalone();
    const a = await mint('relay-a');
    const { token: client } = await approvedClient('acme');
    const taskId = await openTask(a.token, client);
    const watch = await hostCall(a.token, `/tasks/${taskId}/watch`, {
      client,
    });
    expect(watch.status).toBe(200);
    for (let i = 0; i < 4; i += 1)
      expect((await admitStream(a.token, client)).ok).toBe(true);
    await fetch(`${base}/api/a2a/hosts/${a.id}`, { method: 'DELETE' });
    expect(await endsWithin(watch, 1000)).toBe(true);
    const b = await mint('relay-b');
    for (let i = 0; i < 5; i += 1)
      expect((await admitStream(b.token, client)).ok).toBe(true);
  });

  it('turning standalone off closes every watch stream', async () => {
    await allowStandalone();
    const a = await mint();
    const { token: client } = await approvedClient('acme');
    const taskId = await openTask(a.token, client);
    const watch = await hostCall(a.token, `/tasks/${taskId}/watch`, {
      client,
    });
    expect(watch.status).toBe(200);
    await fetch(`${base}/api/a2a/listener/standalone`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ enabled: false }),
    });
    expect(await endsWithin(watch, 1000)).toBe(true);
  });

  it('answers malformed open and continue bodies with 400, never a 500', async () => {
    await allowStandalone();
    const a = await mint();
    const { token: client } = await approvedClient('acme');
    const post = (path: string, body: string) =>
      hostCall(a.token, path, { method: 'POST', client, body });
    const ask = {
      clientMessageId: 'm-x',
      contextId: null,
      kind: 'ask',
      to: null,
      replyTo: null,
      body: 'hi',
      refs: [],
    };
    for (const [path, body] of [
      ['/open', 'null'],
      ['/open', '"ask"'],
      ['/open', JSON.stringify({ ...ask, kind: 'x-breaker' })],
      ['/open', JSON.stringify({ ...ask, kind: 'handoff' })],
      ['/open', JSON.stringify({ ...ask, refs: 'nope' })],
      ['/open', JSON.stringify({ ...ask, body: { text: 'hi' } })],
      ['/continue', '[]'],
      ['/continue', JSON.stringify({ clientMessageId: 'm-y', body: 'x' })],
      ['/admit', 'null'],
      ['/cancel', '7'],
    ] as const) {
      const res = await post(path, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { kind: 'messaging', code: 'invalid' },
      });
    }
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
