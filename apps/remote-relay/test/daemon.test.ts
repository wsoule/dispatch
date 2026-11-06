import { TaskStore } from '@dispatch-foo/core';
import {
  generateKeyPair,
  type PairingOffer,
  parsePairingUrl,
  type RelaySocket,
  RemoteConnection,
} from '@dispatch/remote';
import type { ServerHandle } from '@dispatch/server/embed';
import { startServer } from '@dispatch/server/embed';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Relay, startRelay } from '../src/relay.js';

// A real daemon, this relay and a phone's RemoteConnection, end to end: the
// operator pairs from the app token, the phone reaches the API and the event
// stream through the relay at the decide tier, and unpairing cuts it off.

const ws = (url: string) => new WebSocket(url) as unknown as RelaySocket;

function git(dir: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd: dir });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

let home: string;
let root: string;
let relay: Relay;
let daemon: ServerHandle;
let base: string;
const connections: RemoteConnection[] = [];
const originalHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-remote-home-'));
  process.env.DISPATCH_HOME = home;
  root = mkdtempSync(join(tmpdir(), 'dispatch-remote-root-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'striker@example.com']);
  git(root, ['config', 'user.name', 'Striker']);
  writeFileSync(join(root, 'README.md'), '# test\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'initial']);
  TaskStore.init(root);
  relay = startRelay({ hostname: '127.0.0.1' });
  daemon = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    hubLink: false,
    remoteAccess: { relay: relay.url },
  });
  base = `http://127.0.0.1:${daemon.port}`;
});

afterEach(async () => {
  for (const c of connections.splice(0)) c.stop();
  await daemon.stop();
  relay.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function api(
  path: string,
  init: RequestInit = {},
  token = daemon.tokens.appToken
) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function pairOffer(): Promise<PairingOffer> {
  const res = await api('/api/remote/pair', { method: 'POST' });
  expect(res.status).toBe(201);
  const { url } = (await res.json()) as { url: string };
  const parsed = parsePairingUrl(url);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.offer;
}

function connect(offer: PairingOffer, pair: boolean, key = generateKeyPair()) {
  const conn = new RemoteConnection({
    relay: offer.relay,
    daemonId: offer.daemonId,
    daemonKey: offer.daemonKey,
    phone: key,
    ...(pair
      ? {
          pairing: {
            offerId: offer.offerId,
            code: offer.code,
            name: 'Test iPhone',
          },
        }
      : {}),
    createWebSocket: ws,
    requestTimeoutMs: 5000,
    maxBackoffMs: 200,
  });
  connections.push(conn);
  conn.start();
  return conn;
}

function ready(conn: RemoteConnection): Promise<void> {
  return new Promise((resolve, reject) => {
    if (conn.current().kind === 'ready') return resolve();
    const timer = setTimeout(
      () => reject(new Error(`not ready: ${JSON.stringify(conn.current())}`)),
      8000
    );
    conn.onStatus((s) => {
      if (s.kind === 'ready') {
        clearTimeout(timer);
        resolve();
      }
      if (s.kind === 'refused') {
        clearTimeout(timer);
        reject(new Error(`refused: ${s.reason}`));
      }
    });
  });
}

describe('a phone paired through the relay', () => {
  test('pairing needs the operator: the agent token is refused', async () => {
    const res = await api(
      '/api/remote/pair',
      { method: 'POST' },
      daemon.tokens.agentToken
    );
    expect(res.status).toBe(403);
    const list = await api('/api/remote', {}, daemon.tokens.agentToken);
    expect(list.status).toBe(403);
  });

  test('the daemon dials out only once there is something to answer', async () => {
    expect(relay.stats().daemons).toBe(0);
    await pairOffer();
    const deadline = Date.now() + 5000;
    while (relay.stats().daemons === 0 && Date.now() < deadline)
      await Bun.sleep(20);
    expect(relay.stats().daemons).toBe(1);
  });

  test('reaches the API and events at the decide tier, and unpairing cuts it off', async () => {
    const key = generateKeyPair();
    const offer = await pairOffer();
    const conn = connect(offer, true, key);
    await ready(conn);

    const health = await conn.fetch('/api/health');
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
    expect((await conn.fetch('/api/runs')).status).toBe(200);
    expect((await conn.fetch('/api/decisions')).status).toBe(200);

    // A phone acts as the operator but cannot reach operator-tier routes,
    // pairing another phone among them.
    const pairFromPhone = await conn.fetch('/api/remote/pair', {
      method: 'POST',
    });
    expect(pairFromPhone.status).toBe(403);

    // The app's own actions are reachable at this tier: each gets past auth
    // and answers that the run does not exist.
    for (const [method, path, body] of [
      ['POST', '/api/runs/no-such-run/cancel', undefined],
      ['POST', '/api/runs/no-such-run/review', '{"action":"discard"}'],
      ['POST', '/api/merge-queue', '{"runId":"no-such-run"}'],
    ] as const) {
      const res = await conn.fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body }),
      });
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }

    const status = (await (await api('/api/remote')).json()) as {
      devices: Array<{ id: string; name: string }>;
      offerExpiresAt: string | null;
    };
    expect(status.devices.map((d) => d.name)).toEqual(['Test iPhone']);
    expect(status.offerExpiresAt).toBeNull();
    // The keys and the paired phone are kept for this machine only.
    const key12 = createHash('sha256').update(root).digest('hex').slice(0, 12);
    const file = join(home, '.dispatch', 'projects', key12, 'remote.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // Events arrive through the tunnel. The stream opens asynchronously on
    // the daemon's side, so write until one lands rather than guess a delay.
    const socket = conn.createSocket('ignored');
    const events: string[] = [];
    socket.addEventListener('message', (e) => events.push(String(e.data)));
    const heard = () => events.some((e) => e.includes('task.changed'));
    for (let attempt = 0; attempt < 10 && !heard(); attempt++) {
      const created = await conn.fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: `From the phone ${attempt}` }),
      });
      expect(created.status).toBe(201);
      const until = Date.now() + 500;
      while (!heard() && Date.now() < until) await Bun.sleep(20);
    }
    expect(heard()).toBe(true);
    socket.close();

    // The same phone comes back later with no code.
    conn.stop();
    const again = connect(offer, false, key);
    await ready(again);
    expect((await again.fetch('/api/health')).status).toBe(200);

    const removed = await api(
      `/api/remote/devices/${status.devices[0]?.id ?? ''}`,
      {
        method: 'DELETE',
      }
    );
    expect(removed.status).toBe(200);
    // Its session ends and it can no longer get in.
    const deadline2 = Date.now() + 5000;
    while (again.current().kind === 'ready' && Date.now() < deadline2)
      await Bun.sleep(20);
    expect(again.current().kind).not.toBe('ready');
  });

  test('answers a question addressed to the operator', async () => {
    const operator =
      daemon.tokens.registry.resolve(daemon.tokens.appToken)?.ref ?? '';
    const sent = await daemon.messaging.engine.send(
      {
        to: [operator],
        kind: 'question',
        body: 'Ship it?',
        blocking: true,
        choices: ['yes', 'no'],
      },
      { address: 'agent:dispatch', canDecide: false }
    );
    const conn = connect(await pairOffer(), true);
    await ready(conn);
    const open = (await (await conn.fetch('/api/decisions/open')).json()) as {
      items: Array<{ id: string }>;
    };
    expect(open.items.map((m) => m.id)).toContain(sent.message.id);
    const reply = await conn.fetch(`/api/messages/${sent.message.id}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'yes', choice: 'yes' }),
    });
    expect(reply.status).toBeLessThan(300);
    const after = (await (await conn.fetch('/api/decisions/open')).json()) as {
      items: Array<{ id: string }>;
    };
    expect(after.items.map((m) => m.id)).not.toContain(sent.message.id);
  });

  test('a used code cannot pair a second phone', async () => {
    const offer = await pairOffer();
    await ready(connect(offer, true));
    const second = connect(offer, true);
    await expect(ready(second)).rejects.toThrow();
  });
});
