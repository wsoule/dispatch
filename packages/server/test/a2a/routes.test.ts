import { decideState } from '@dispatch/a2a';
import { openSqliteDb, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { gatherFacts } from '../../src/a2a/facts.js';
import { DEFAULT_LISTENER } from '../../src/a2a/settings.js';
import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { runsDir } from '../../src/orchestrator/paths.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { useTestAuth } from '../testAuth.js';
import { approvedClient, freePort, useSeedBase } from './seed.js';

let home: string;
let root: string;
let handle: ServerHandle;
let running: ServerHandle | null = null;
let base: string;
let decideTierToken: string;
let requestTierToken: string;
const originalHome = process.env.DISPATCH_HOME;
const json = { 'content-type': 'application/json' };

async function boot(): Promise<ServerHandle> {
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
  });
  running = handle;
  useTestAuth(handle); // plain fetch now carries the operator app token
  base = `http://127.0.0.1:${handle.port}`;
  useSeedBase(base);
  decideTierToken = handle.team.teammates.issue('ada', 'decide');
  requestTierToken = handle.tokens.agentToken; // the on-disk request-tier token
  return handle;
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-routes-home-')));
  process.env.DISPATCH_HOME = home;
  root = initGitRepo('a2a-routes-');
  TaskStore.init(root);
});
afterEach(async () => {
  await running?.stop();
  running = null;
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// Adds a client through the route. Addresses come from its responses, because
// `/api/health` does not report the owner.
async function addClient(name: string, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/api/a2a/clients`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ name, ...extra }),
  });
  return {
    res,
    body: (await res.json()) as {
      address: string;
      token: string;
      status: string;
    },
  };
}

describe('/api/a2a/clients', () => {
  beforeEach(boot);

  it('adds a client, shows the token once, and --approve answers the registration gate', async () => {
    const { res, body } = await addClient('Acme Planner', {
      to: ['human:alice'],
      approve: true,
    });
    expect(res.status).toBe(201);
    expect(body.address).toMatch(
      /^agent:[a-z0-9][a-z0-9._-]*\/a2a\.acme-planner$/
    );
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    const list = (await (await fetch(`${base}/api/a2a/clients`)).json()) as {
      clients: { address: string; status: string; recipients: string[] }[];
    };
    expect(list.clients).toEqual([
      expect.objectContaining({
        address: body.address,
        status: 'approved',
        recipients: ['human:alice'],
      }),
    ]);
    expect(JSON.stringify(list)).not.toContain(body.token);
  });

  it('leaves a client added without approve pending on its gate', async () => {
    const { res, body } = await addClient('waiting');
    expect(res.status).toBe(201);
    expect(body.status).toBe('pending');
    expect(await handle.a2a.port!.authenticate(body.token)).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('refuses approve below the decide tier and a to that is not a human', async () => {
    expect(
      (
        await fetch(`${base}/api/a2a/clients`, {
          method: 'POST',
          headers: { ...json, authorization: `Bearer ${requestTierToken}` },
          body: JSON.stringify({ name: 'x', approve: true }),
        })
      ).status
    ).toBe(403);
    const bad = await fetch(`${base}/api/a2a/clients`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: 'x', to: ['channel:ops'] }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { field: string }).field).toBe('to[0]');
  });

  it('refuses an approve that is not a boolean, and adds nothing', async () => {
    const { res, body } = await addClient('quoted', { approve: 'true' });
    expect(res.status).toBe(400);
    expect((body as unknown as { field: string }).field).toBe('approve');
    const clients = (await (await fetch(`${base}/api/a2a/clients`)).json()) as {
      clients: unknown[];
    };
    expect(clients.clients).toEqual([]);
  });

  it('names the field when the name is missing or has no valid characters', async () => {
    for (const body of [{}, { name: '***' }, { name: 'x'.repeat(101) }]) {
      const res = await fetch(`${base}/api/a2a/clients`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { field: string }).field).toBe('name');
    }
  });

  it('refuses to reuse a name, revoked ones included', async () => {
    const first = (await addClient('acme', { approve: true })).body;
    await fetch(
      `${base}/api/agents/${encodeURIComponent(first.address)}/revoke`,
      { method: 'POST' }
    );
    expect((await addClient('acme')).res.status).toBe(409);
  });

  // A crash between the clients row and the agent row is harmless.
  it('lets a retry of the same name proceed after a crash left a clients row and no agent', async () => {
    const probe = (await addClient('probe')).body.address;
    const address = `${probe.slice(0, probe.lastIndexOf('/'))}/a2a.acme`;
    handle.a2a.store!.putClient({
      address,
      name: 'a2a.acme',
      recipients: [],
      createdBy: 'human:test',
      createdAt: new Date().toISOString(),
    });
    // Nothing authenticates as it.
    expect(await handle.a2a.port!.authenticate('anything')).toMatchObject({
      ok: false,
      status: 401,
    });
    const { res, body } = await addClient('acme', {
      to: ['human:alice'],
      approve: true,
    });
    expect(res.status).toBe(201);
    expect(body.address).toBe(address);
    expect(await handle.a2a.port!.authenticate(body.token)).toMatchObject({
      ok: true,
    });
    const list = (await (await fetch(`${base}/api/a2a/clients`)).json()) as {
      clients: { address: string; recipients: string[] }[];
    };
    expect(list.clients.filter((c) => c.address === address)).toEqual([
      expect.objectContaining({ recipients: ['human:alice'] }),
    ]);
  });

  it('rotates a token in place, keeping status', async () => {
    const added = (await addClient('acme', { approve: true })).body;
    const res = await fetch(`${base}/api/a2a/clients/acme/rotate`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const rotated = (await res.json()) as { token: string };
    expect(rotated.token).not.toBe(added.token);
    expect(await handle.a2a.port!.authenticate(added.token)).toMatchObject({
      ok: false,
    });
    expect(await handle.a2a.port!.authenticate(rotated.token)).toMatchObject({
      ok: true,
    });
    const list = (await (await fetch(`${base}/api/a2a/clients`)).json()) as {
      clients: { status: string }[];
    };
    expect(list.clients).toEqual([
      expect.objectContaining({ status: 'approved' }),
    ]);
  });

  it('rotates by the a2a. name too, and refuses an unknown or revoked client', async () => {
    const added = (await addClient('acme', { approve: true })).body;
    expect(
      (
        await fetch(`${base}/api/a2a/clients/a2a.acme/rotate`, {
          method: 'POST',
        })
      ).status
    ).toBe(200);
    expect(
      (await fetch(`${base}/api/a2a/clients/nobody/rotate`, { method: 'POST' }))
        .status
    ).toBe(404);
    await fetch(
      `${base}/api/agents/${encodeURIComponent(added.address)}/revoke`,
      { method: 'POST' }
    );
    expect(
      (await fetch(`${base}/api/a2a/clients/acme/rotate`, { method: 'POST' }))
        .status
    ).toBe(409);
  });

  it('needs the decide tier to rotate', async () => {
    await addClient('acme', { approve: true });
    const res = await fetch(`${base}/api/a2a/clients/acme/rotate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${requestTierToken}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('/api/a2a/listener', () => {
  beforeEach(boot);

  it('reports the listener on the request tier', async () => {
    const res = await fetch(`${base}/api/a2a/listener`, {
      headers: { authorization: `Bearer ${requestTierToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      enabled: false,
      listening: false,
      url: null,
      error: null,
      legacyClients: [],
    });
  });

  it('needs the operator tier to write', async () => {
    const res = await fetch(`${base}/api/a2a/listener`, {
      method: 'PUT',
      headers: { ...json, authorization: `Bearer ${decideTierToken}` },
      body: JSON.stringify({ enabled: true, port: 7451 }),
    });
    expect(res.status).toBe(403);
  });

  it('needs the operator tier to disable', async () => {
    const res = await fetch(`${base}/api/a2a/listener`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${decideTierToken}` },
    });
    expect(res.status).toBe(403);
    // The app token is operator.
    expect(
      (await fetch(`${base}/api/a2a/listener`, { method: 'DELETE' })).status
    ).toBe(200);
  });

  it('opens and closes the listener', async () => {
    const port = await freePort();
    const put = await fetch(`${base}/api/a2a/listener`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ ...DEFAULT_LISTENER, enabled: true, port }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      enabled: true,
      listening: true,
      url: `http://127.0.0.1:${port}`,
    });
    const off = await fetch(`${base}/api/a2a/listener`, { method: 'DELETE' });
    expect(await off.json()).toMatchObject({
      enabled: false,
      listening: false,
    });
  });

  it('names the bad key and writes nothing', async () => {
    const res = await fetch(`${base}/api/a2a/listener`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({
        ...DEFAULT_LISTENER,
        enabled: true,
        host: '0.0.0.0',
        port: 7452,
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { field: string }).field).toBe('tls');
    expect(handle.a2a.status()).toMatchObject({ enabled: false });
    const wrongType = await fetch(`${base}/api/a2a/listener`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(wrongType.status).toBe(400);
    expect(((await wrongType.json()) as { field: string }).field).toBe(
      'enabled'
    );
  });

  it('saves disabled settings without a port', async () => {
    const res = await fetch(`${base}/api/a2a/listener`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ ...DEFAULT_LISTENER, enabled: false }),
    });
    expect(res.status).toBe(200);
  });
});

describe('/api/a2a/card', () => {
  beforeEach(boot);

  it('serves the card on the request tier', async () => {
    const res = await fetch(`${base}/api/a2a/card`, {
      headers: { authorization: `Bearer ${requestTierToken}` },
    });
    expect(res.status).toBe(200);
    const card = (await res.json()) as {
      supportedInterfaces: { protocolBinding: string }[];
      skills: { id: string }[];
    };
    expect(card.supportedInterfaces[0].protocolBinding).toBe('HTTP+JSON');
    expect(card.skills.map((s) => s.id)).toEqual(['ask']);
  });
});

describe('/api/a2a/tasks', () => {
  beforeEach(boot);

  it('lists a client’s tasks on the decide tier only', async () => {
    const { caller } = await approvedClient('acme');
    const other = await approvedClient('other');
    const port = handle.a2a.port!;
    const opened = await port.open(caller, {
      clientMessageId: 'c-1',
      contextId: null,
      kind: 'ask',
      to: null,
      replyTo: null,
      body: 'q1',
      refs: [],
    });
    await port.open(other.caller, {
      clientMessageId: 'c-2',
      contextId: null,
      kind: 'ask',
      to: null,
      replyTo: null,
      body: 'q2',
      refs: [],
    });
    if (opened.kind !== 'task') throw new Error('expected a task');
    const res = await fetch(`${base}/api/a2a/tasks?client=acme`);
    expect(res.status).toBe(200);
    const { tasks } = (await res.json()) as {
      tasks: { id: string; client: string; state: string }[];
    };
    expect(tasks).toEqual([
      expect.objectContaining({
        id: opened.taskId,
        client: caller.address,
        state: 'WORKING',
      }),
    ]);
    const all = (await (await fetch(`${base}/api/a2a/tasks`)).json()) as {
      tasks: unknown[];
    };
    expect(all.tasks).toHaveLength(2);
    expect((await fetch(`${base}/api/a2a/tasks?client=nobody`)).status).toBe(
      404
    );
    expect(
      (
        await fetch(`${base}/api/a2a/tasks`, {
          headers: { authorization: `Bearer ${requestTierToken}` },
        })
      ).status
    ).toBe(403);
  });
});

describe('decline and revocation', () => {
  beforeEach(boot);

  it('declines an ask as the owner (REJECTED) and closes a revoked client’s asks (FAILED)', async () => {
    const { caller } = await approvedClient('acme');
    const port = handle.a2a.port!;
    const one = await port.open(caller, {
      clientMessageId: 'c-1',
      contextId: null,
      kind: 'ask',
      to: null,
      replyTo: null,
      body: 'q1',
      refs: [],
    });
    const two = await port.open(caller, {
      clientMessageId: 'c-2',
      contextId: null,
      kind: 'ask',
      to: null,
      replyTo: null,
      body: 'q2',
      refs: [],
    });
    if (one.kind !== 'task' || two.kind !== 'task')
      throw new Error('expected tasks');
    const declined = await fetch(
      `${base}/api/a2a/tasks/${one.taskId}/decline`,
      {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ reason: 'out of scope' }),
      }
    );
    expect(declined.status).toBe(200);
    expect(await declined.json()).toMatchObject({
      id: one.taskId,
      state: 'REJECTED',
    });
    const facts = await port.facts(caller, one.taskId);
    expect(decideState(facts!)).toMatchObject({ state: 'REJECTED' });
    expect(JSON.stringify(decideState(facts!))).toContain('out of scope');
    await fetch(
      `${base}/api/agents/${encodeURIComponent(caller.address)}/revoke`,
      { method: 'POST' }
    );
    const row = handle.a2a.store!.getTask(two.taskId);
    expect(row).not.toBeNull();
    expect(decideState(gatherFacts(port.deps, row!)).state).toBe('FAILED');
    expect(handle.a2a.store!.getTask(two.taskId)?.state).toBe('FAILED');
  });

  it('refuses to decline a finished ask, an unknown one, and below the decide tier', async () => {
    const { caller } = await approvedClient('acme');
    const opened = await handle.a2a.port!.open(caller, {
      clientMessageId: 'c-1',
      contextId: null,
      kind: 'ask',
      to: null,
      replyTo: null,
      body: 'q1',
      refs: [],
    });
    if (opened.kind !== 'task') throw new Error('expected a task');
    const url = `${base}/api/a2a/tasks/${opened.taskId}/decline`;
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: { ...json, authorization: `Bearer ${requestTierToken}` },
          body: '{}',
        })
      ).status
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/api/a2a/tasks/m-nope/decline`, {
          method: 'POST',
          headers: json,
          body: '{}',
        })
      ).status
    ).toBe(404);
    expect(
      (await fetch(url, { method: 'POST', headers: json, body: '{}' })).status
    ).toBe(200);
    expect(
      (await fetch(url, { method: 'POST', headers: json, body: '{}' })).status
    ).toBe(409);
  });
});

describe('with a2a.db down', () => {
  it('answers 503 on every route but the listener status', async () => {
    const dbPath = join(runsDir(root), 'a2a.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    const raw = openSqliteDb(dbPath);
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    await boot();
    expect((await fetch(`${base}/api/a2a/listener`)).status).toBe(200);
    for (const [method, path] of [
      ['GET', 'card'],
      ['GET', 'clients'],
      ['GET', 'tasks'],
      ['DELETE', 'listener'],
    ] as const) {
      const res = await fetch(`${base}/api/a2a/${path}`, { method });
      expect({ method, path, status: res.status }).toEqual({
        method,
        path,
        status: 503,
      });
      expect(((await res.json()) as { error: string }).error).toContain(
        'newer schema'
      );
    }
    const add = await fetch(`${base}/api/a2a/clients`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: 'acme' }),
    });
    expect(add.status).toBe(503);
  });
});
