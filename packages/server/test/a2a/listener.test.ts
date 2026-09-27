import { openSqliteDb, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
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

  it('lists legacy a2a.* agents that have no clients row', async () => {
    const h = await boot();
    seedAgent(root, 'agent:test/a2a.legacy', 'legacy-token');
    expect(h.a2a.status().legacyClients).toEqual(['agent:test/a2a.legacy']);
  });
});
