import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonFilePath } from '../src/commands/daemon.js';
import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

// M2: an invite or recovery code is a secret, so `team join` and `team
// recover` read it from stdin or a prompt, never from argv (shell history,
// ps). The code never appears as an argument.

const APP_TOKEN = 'app-token';
let root: string;
let fakeHome: string;
let lines: string[];
let asked: string[];
let ctx: CliContext;
let server: ReturnType<typeof Bun.serve>;
let posted: { path: string; body: unknown }[];
const originalHome = process.env.DISPATCH_HOME;
const originalToken = process.env.DISPATCH_APP_TOKEN;

const run = (...argv: string[]) =>
  makeProgram(ctx).parseAsync(argv, { from: 'user' });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-secret-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-secret-'));
  process.env.DISPATCH_HOME = fakeHome;
  process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
  lines = [];
  asked = [];
  posted = [];
  ctx = {
    cwd: root,
    log: (l) => lines.push(l),
    readSecret: (prompt) => {
      asked.push(prompt);
      return Promise.resolve('  di1.secret-code \n');
    },
  };
  await run('init');
  lines = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/health') return Response.json({ ok: true });
      posted.push({ path: url.pathname, body: await req.json() });
      return Response.json({ ok: true, fingerprint: 'AAAA-BBBB' });
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

describe('secret codes stay out of argv', () => {
  it('team join reads the invite code from a prompt', async () => {
    await run('team', 'join');
    expect(asked).toHaveLength(1);
    expect(posted).toEqual([
      { path: '/api/team/join', body: { code: 'di1.secret-code' } },
    ]);
  });

  it('team recover reads the recovery code from a prompt', async () => {
    await run('team', 'recover');
    expect(posted).toEqual([
      { path: '/api/team/recover', body: { code: 'di1.secret-code' } },
    ]);
  });

  it('refuses a code given as an argument', async () => {
    let failed = false;
    try {
      await makeProgram(ctx)
        .exitOverride()
        .configureOutput({ writeErr: () => {} })
        .parseAsync(['team', 'join', 'di1.in-argv'], { from: 'user' });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(posted).toEqual([]);
  });
});
