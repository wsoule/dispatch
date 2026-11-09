import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonFilePath } from '../src/commands/daemon.js';
import { describeOffer } from '../src/commands/pair.js';
import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

// `dispatch pair`: a one-time code for another of your devices, and how that
// device reaches this daemon.

const APP_TOKEN = 'app-token';
let root: string;
let fakeHome: string;
let lines: string[];
let ctx: CliContext;
let server: ReturnType<typeof Bun.serve>;
let seen: {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}[];
let origins: string[];
const originalHome = process.env.DISPATCH_HOME;
const originalToken = process.env.DISPATCH_APP_TOKEN;

const run = (...argv: string[]) =>
  makeProgram(ctx).parseAsync(argv, { from: 'user' });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-pair-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-pair-'));
  process.env.DISPATCH_HOME = fakeHome;
  process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
  lines = [];
  seen = [];
  origins = [];
  ctx = {
    cwd: root,
    log: (l) => lines.push(l),
    confirm: () => Promise.resolve(true),
    readSecret: () => Promise.resolve(''),
    ask: () => Promise.resolve(null),
  };
  await run('init');
  lines = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/health') return Response.json({ ok: true });
      const body = req.method === 'POST' ? await req.json() : null;
      seen.push({
        method: req.method,
        path: url.pathname,
        auth: req.headers.get('authorization'),
        body,
      });
      if (url.pathname === '/api/pair/offer')
        return Response.json({
          code: 'ABCD-EFGH',
          tier: (body as { tier: string }).tier,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          shared: origins.length > 0,
          origins,
        });
      if (url.pathname === '/api/devices')
        return Response.json({
          devices: [
            {
              id: 'd-1234abcd',
              name: 'phone',
              tier: 'decide',
              pairedAt: '2026-10-20T00:00:00.000Z',
              lastUsedAt: null,
            },
          ],
        });
      return Response.json({ ok: true });
    },
  });
  mkdirSync(join(fakeHome, '.dispatch', 'daemons'), { recursive: true });
  writeFileSync(
    daemonFilePath(root),
    JSON.stringify({
      port: server.port,
      pid: process.pid,
      rootDir: root,
      startedAt: new Date().toISOString(),
      agentToken: 'agent',
    })
  );
});

afterEach(() => {
  void server.stop(true);
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  if (originalToken === undefined) delete process.env.DISPATCH_APP_TOKEN;
  else process.env.DISPATCH_APP_TOKEN = originalToken;
});

describe('dispatch pair', () => {
  it('asks with the app token, at operator tier unless told otherwise', async () => {
    await run('pair');
    await run('pair', '--tier', 'decide');
    expect(seen.map((s) => [s.path, s.auth, s.body])).toEqual([
      ['/api/pair/offer', `Bearer ${APP_TOKEN}`, { tier: 'operator' }],
      ['/api/pair/offer', `Bearer ${APP_TOKEN}`, { tier: 'decide' }],
    ]);
  });

  it('on a loopback daemon, prints the code and the SSH forward to reach it', async () => {
    await run('pair');
    const out = lines.join('\n');
    expect(out).toContain('Pairing code: ABCD-EFGH');
    expect(out).toContain(
      `ssh -N -L 127.0.0.1:${server.port}:127.0.0.1:${server.port}`
    );
    expect(out).toContain(
      `dispatch://pair?url=${encodeURIComponent(`http://127.0.0.1:${server.port}`)}&code=ABCD-EFGH`
    );
    expect(out).toContain('Do not expose this port');
  });

  it('refuses an unknown tier before asking the daemon', async () => {
    await expect(run('pair', '--tier', 'admin')).rejects.toThrow(
      'unknown tier'
    );
    expect(seen).toEqual([]);
  });

  it('lists and revokes devices', async () => {
    await run('pair', 'list');
    expect(lines.join('\n')).toContain('d-1234abcd');
    await run('pair', 'revoke', 'd-1234abcd');
    expect(seen.at(-1)).toMatchObject({
      method: 'DELETE',
      path: '/api/devices/d-1234abcd',
    });
  });
});

describe('describeOffer', () => {
  const offer = {
    code: 'ABCD-EFGH',
    tier: 'operator' as const,
    expiresAt: new Date().toISOString(),
    shared: true,
    origins: ['http://192.168.1.5:4771', 'https://devbox.example.com:4772'],
  };

  it('offers only the https origins of a network daemon', () => {
    const out = describeOffer(offer, 4771).join('\n');
    expect(out).toContain('https://devbox.example.com:4772');
    expect(out).not.toContain('192.168.1.5');
    expect(out).not.toContain('ssh -N');
  });

  it('explains TLS when a network daemon has no https origin', () => {
    const out = describeOffer(
      { ...offer, origins: ['http://192.168.1.5:4771'] },
      4771
    ).join('\n');
    expect(out).toContain('--tls-cert');
    expect(out).toContain('ssh -N -L 127.0.0.1:4771:127.0.0.1:4771');
  });
});
