import { openSqliteDb, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { A2AListener } from '../../src/a2a/listener.js';
import {
  DEFAULT_LISTENER,
  listenerSettingsPath,
} from '../../src/a2a/settings.js';
import type { ServerHandle, StartServerOptions } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { runsDir } from '../../src/orchestrator/paths.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { rawFetch } from '../testAuth.js';
import { freePort, seedAgent } from './seed.js';

let home: string;
let root: string;
let handle: ServerHandle | null = null;
const originalHome = process.env.DISPATCH_HOME;

async function boot(
  extra: Partial<StartServerOptions> = {}
): Promise<ServerHandle> {
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
    ...extra,
  });
  return handle;
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-listener-home-')));
  process.env.DISPATCH_HOME = home;
  root = initGitRepo('a2a-listener-');
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

const clientRow = () => ({
  address: 'agent:test/a2a.acme',
  name: 'a2a.acme',
  recipients: [],
  createdBy: 'human:test',
  createdAt: new Date().toISOString(),
});

describe('the A2A listener', () => {
  it('is off by default', async () => {
    const h = await boot();
    expect(h.a2a.status()).toMatchObject({
      enabled: false,
      listening: false,
      error: null,
    });
  });

  it('boots with the listener closed when the settings file is not JSON', async () => {
    const path = listenerSettingsPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"enabled": tru');
    const h = await boot();
    expect(
      (await rawFetch(`http://127.0.0.1:${h.port}/api/health`)).status
    ).toBe(200);
    expect(h.a2a.status()).toMatchObject({
      listening: false,
      error: expect.stringContaining('a2a-listener.json'),
    });
  });

  it('opens from its flags for one boot without writing them to the file', async () => {
    const port = await freePort();
    const h = await boot({ a2a: { port } });
    expect(h.a2a.status()).toMatchObject({
      enabled: true,
      listening: true,
      url: `http://127.0.0.1:${port}`,
    });
    expect(existsSync(listenerSettingsPath(root))).toBe(false);
  });

  it('opens and closes at runtime, serves only A2A routes, and never /api', async () => {
    const h = await boot();
    const port = await freePort();
    expect(
      await h.a2a.applySettings({ ...DEFAULT_LISTENER, enabled: true, port })
    ).toMatchObject({ listening: true, url: `http://127.0.0.1:${port}` });
    expect(
      (await rawFetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`))
        .status
    ).toBe(200);
    expect((await rawFetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(
      404
    );
    expect((await rawFetch(`http://127.0.0.1:${port}/ws`)).status).toBe(404);
    expect(await h.a2a.disable()).toMatchObject({
      enabled: false,
      listening: false,
    });
    await expect(
      rawFetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`)
    ).rejects.toThrow();
  });

  it('applies two quick saves in order, ending on the second', async () => {
    const h = await boot();
    const first = await freePort();
    const second = await freePort();
    await Promise.all([
      h.a2a.applySettings({ ...DEFAULT_LISTENER, enabled: true, port: first }),
      h.a2a.applySettings({ ...DEFAULT_LISTENER, enabled: true, port: second }),
    ]);
    expect(h.a2a.status()).toMatchObject({
      listening: true,
      url: `http://127.0.0.1:${second}`,
      error: null,
    });
  });

  it('refuses a wildcard host without TLS and the daemon’s own port', async () => {
    const h = await boot();
    expect(
      await h.a2a.applySettings({
        ...DEFAULT_LISTENER,
        enabled: true,
        host: '0.0.0.0',
        port: await freePort(),
      })
    ).toMatchObject({
      listening: false,
      error: expect.stringContaining('TLS'),
    });
    expect(
      await h.a2a.applySettings({
        ...DEFAULT_LISTENER,
        enabled: true,
        port: h.port,
      })
    ).toMatchObject({
      listening: false,
      error: expect.stringContaining('port'),
    });
  });

  it('keeps the daemon up and still refuses a client token on /api when a2a.db is from a newer schema', async () => {
    const dbPath = join(runsDir(root), 'a2a.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    const raw = openSqliteDb(dbPath);
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    const h = await boot();
    expect(h.a2a.status().error).toContain('newer schema');
    seedAgent(root, 'agent:test/a2a.acme', 'client-token');
    const res = await rawFetch(`http://127.0.0.1:${h.port}/api/tasks`, {
      headers: { authorization: 'Bearer client-token' },
    });
    expect(res.status).toBe(403);
  });

  it('refuses a client token on /api while a2a.db exists, with its clients row', async () => {
    const h = await boot();
    expect(existsSync(join(runsDir(root), 'a2a.db'))).toBe(true);
    seedAgent(root, 'agent:test/a2a.acme', 'client-token');
    h.a2a.store!.putClient(clientRow());
    const res = await rawFetch(`http://127.0.0.1:${h.port}/api/tasks`, {
      headers: { authorization: 'Bearer client-token' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      'auth_a2a_client'
    );
  });

  it('refuses a client token on /api after a2a.db is deleted under the running daemon', async () => {
    const h = await boot();
    seedAgent(root, 'agent:test/a2a.acme', 'client-token');
    for (const suffix of ['', '-wal', '-shm'])
      rmSync(join(runsDir(root), `a2a.db${suffix}`), { force: true });
    const res = await rawFetch(`http://127.0.0.1:${h.port}/api/tasks`, {
      headers: { authorization: 'Bearer client-token' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      'auth_a2a_client'
    );
  });

  it('answers teammate, run, shared, app and ordinary agent tokens with the unknown token’s 401', async () => {
    const h = await boot();
    const port = await freePort();
    await h.a2a.applySettings({ ...DEFAULT_LISTENER, enabled: true, port });
    seedAgent(root, 'agent:test/claude', 'agent-token-ok');
    const bearers: Record<string, string> = {
      teammate: h.team.teammates.issue('ada', 'decide'),
      run: h.messaging.runTokens.mint('r-00000a'),
      shared: h.tokens.agentToken,
      app: h.tokens.appToken,
      agent: 'agent-token-ok',
      unknown: 'never-issued',
    };
    const bodies = new Set<string>();
    for (const [who, token] of Object.entries(bearers)) {
      const res = await rawFetch(`http://127.0.0.1:${port}/a2a/v1/tasks`, {
        headers: { authorization: `Bearer ${token}`, 'A2A-Version': '1.0' },
      });
      expect({ who, status: res.status }).toEqual({ who, status: 401 });
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
  });

  it('logs one access line per request, with no token, no query and no body', async () => {
    const h = await boot();
    const port = await freePort();
    await h.a2a.applySettings({ ...DEFAULT_LISTENER, enabled: true, port });
    seedAgent(root, 'agent:test/a2a.acme', 'TOKEN-MARKER-7f3a');
    h.a2a.store!.putClient(clientRow());
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      })
    );
    try {
      const sent = await rawFetch(
        `http://127.0.0.1:${port}/a2a/v1/message:send?probe=QUERY-MARKER-55e1`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer TOKEN-MARKER-7f3a',
            'A2A-Version': '1.0',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              messageId: 'c-1',
              role: 'ROLE_USER',
              parts: [{ text: 'BODY-MARKER-91c2' }],
            },
            configuration: { returnImmediately: true },
          }),
        }
      );
      expect(sent.status).toBe(200);
      await sent.text();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const all = lines.join('\n');
    expect(lines.filter((l) => l.includes('/a2a/v1/message:send'))).toEqual([
      expect.stringMatching(
        /^a2a: 127\.0\.0\.1 POST \/a2a\/v1\/message:send 200 \d+ms$/
      ),
    ]);
    expect(all).not.toContain('TOKEN-MARKER-7f3a');
    expect(all).not.toContain('BODY-MARKER-91c2');
    expect(all).not.toContain('QUERY-MARKER-55e1');
  });

  it('reports the settings it opens from, and keeps them through a disable', async () => {
    const h = await boot();
    const tunnel = {
      ...DEFAULT_LISTENER,
      enabled: true,
      port: await freePort(),
      publicUrl: 'https://agent.example.com',
      trustForwardedFor: true,
    };
    expect((await h.a2a.applySettings(tunnel)).settings).toEqual(tunnel);
    expect((await h.a2a.disable()).settings).toEqual({
      ...tunnel,
      enabled: false,
    });
  });

  it('reports a failing listener’s settings, not the defaults', async () => {
    const h = await boot();
    const failing = {
      ...DEFAULT_LISTENER,
      enabled: true,
      host: '0.0.0.0',
      port: await freePort(),
      publicUrl: 'https://agent.example.com',
      tls: { certPath: join(root, 'missing.pem'), keyPath: join(root, 'k') },
    };
    expect(await h.a2a.applySettings(failing)).toMatchObject({
      listening: false,
      error: expect.stringContaining('missing.pem'),
      settings: failing,
    });
  });

  it('reports one-boot flags in its settings', async () => {
    const port = await freePort();
    const h = await boot({ a2a: { port } });
    expect(h.a2a.status().settings).toEqual({
      ...DEFAULT_LISTENER,
      enabled: true,
      port,
    });
  });

  it('proposes a free port while the settings name none, and none once they do', async () => {
    const h = await boot();
    const suggested = h.a2a.status().suggestedPort;
    expect(suggested).toBeGreaterThan(0);
    expect(suggested).not.toBe(h.port);
    const probe = Bun.serve({
      port: suggested ?? 0,
      hostname: '127.0.0.1',
      fetch: () => new Response(''),
    });
    await probe.stop(true);
    const port = await freePort();
    await h.a2a.applySettings({ ...DEFAULT_LISTENER, port });
    expect(h.a2a.status().suggestedPort).toBeNull();
  });

  it('proposes a port nothing holds, not a fixed one', async () => {
    const first = await boot();
    const taken = first.a2a.status().suggestedPort;
    expect(taken).not.toBeNull();
    await first.stop();
    handle = null;
    const holder = Bun.serve({
      port: taken!,
      hostname: '127.0.0.1',
      fetch: () => new Response(''),
    });
    try {
      const next = (await boot()).a2a.status().suggestedPort;
      expect(next).not.toBeNull();
      expect(next).not.toBe(taken);
    } finally {
      await holder.stop(true);
    }
  });

  it('names the daemon’s team-local TLS files, and none without them', async () => {
    const plain = await boot();
    expect(plain.a2a.status().teamTls).toBeNull();
    await plain.stop();
    handle = null;
    const dir = mkdtempSync(join(tmpdir(), 'a2a-team-tls-'));
    const certPath = join(dir, 'cert.pem');
    const keyPath = join(dir, 'key.pem');
    const made = spawnSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=dispatch.test',
    ]);
    expect(made.status).toBe(0);
    try {
      const team = await boot({ host: '0.0.0.0', tls: { certPath, keyPath } });
      expect(team.a2a.status().teamTls).toEqual({ certPath, keyPath });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists approved legacy a2a.* agents that have no clients row, never revoked or pending ones', async () => {
    const h = await boot();
    seedAgent(root, 'agent:test/a2a.legacy', 'legacy-token');
    seedAgent(root, 'agent:test/a2a.gone', 'gone-token', 'revoked');
    seedAgent(root, 'agent:test/a2a.waiting', 'waiting-token', 'pending');
    expect(h.a2a.status().legacyClients).toEqual(['agent:test/a2a.legacy']);
  });

  it('answers on its reported URL when the host is localhost', async () => {
    const h = await boot();
    const port = await freePort();
    const status = await h.a2a.applySettings({
      ...DEFAULT_LISTENER,
      enabled: true,
      host: 'localhost',
      port,
    });
    expect(status).toMatchObject({ listening: true, error: null });
    const card = await rawFetch(`${status.url}/.well-known/agent-card.json`);
    expect(card.status).toBe(200);
  });

  it('answers an unexpected throw with an opaque 500, never a stack or a path', async () => {
    const h = await boot();
    const port = await freePort();
    const listener = new A2AListener({
      port: h.a2a.port!,
      policy: () => {
        throw new Error('policy exploded at /Users/someone/secret.ts');
      },
      log: () => {},
    });
    const logged: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation(
      (...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      }
    );
    try {
      expect(
        listener.open({
          host: '127.0.0.1',
          port,
          publicUrl: `http://127.0.0.1:${port}`,
          tls: null,
          trustForwardedFor: false,
        })
      ).toEqual({ ok: true });
      const res = await rawFetch(`http://127.0.0.1:${port}/a2a/v1/tasks`);
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toEqual({
        error: {
          code: 500,
          status: 'INTERNAL',
          message: 'internal error',
          details: [],
        },
      });
    } finally {
      spy.mockRestore();
      await listener.close();
    }
    expect(logged.join('\n')).toContain('policy exploded');
  });

  it('keeps an idle daemon up while the listener is open, and lets it go once closed', async () => {
    let idled = 0;
    const h = await boot({
      a2a: { port: await freePort() },
      idleTimeoutMs: 200,
      idleCheckIntervalMs: 20,
      onIdle: () => (idled += 1),
    });
    expect(h.a2a.listening()).toBe(true);
    await Bun.sleep(500);
    expect(idled).toBe(0);
    await h.a2a.disable();
    const deadline = Date.now() + 5000;
    while (idled === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(idled).toBe(1);
  });
});
