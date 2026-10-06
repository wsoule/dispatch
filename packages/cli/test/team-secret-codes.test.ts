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
      if (url.pathname === '/api/team/keys')
        return Response.json({
          machine: {
            replica: 'ada-0000000a',
            handle: 'ada',
            device: 'laptop',
            fingerprint: 'JOIN-7QX2-K9PA-M3TD-0W4R-HB8E',
          },
        });
      posted.push({ path: url.pathname, body: await req.json() });
      if (url.pathname === '/api/team/found')
        return Response.json({
          teamId: 'a'.repeat(32),
          recoveryCode: 'RECOVERY-CODE',
          fingerprint: 'JOIN-7QX2-K9PA-M3TD-0W4R-HB8E',
          pending: true,
        });
      return Response.json({ ok: true, pending: true });
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
    // D, F: the joiner's fingerprint to read to an admin, and the pending note.
    expect(lines.join('\n')).toContain('JOIN-7QX2-K9PA-M3TD-0W4R-HB8E');
    expect(lines.join('\n')).toContain(
      'goes out once a sync reaches the remote'
    );
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

  // F: found prints its pending note beside the recovery code.
  it('team found prints the recovery code and that its sync still runs', async () => {
    await run('team', 'found');
    const text = lines.join('\n');
    expect(text).toContain('RECOVERY-CODE');
    expect(text).toContain('goes out once a sync reaches the remote');
  });

  it('team transport reads the relay registration token from a prompt, and never prints it', async () => {
    await run(
      'team',
      'transport',
      'relay',
      'wss://relay.example',
      '--yes',
      '--registration-token'
    );
    expect(asked).toEqual(['Relay registration token: ']);
    expect(posted).toEqual([
      {
        path: '/api/team/transport',
        body: {
          kind: 'relay',
          url: 'wss://relay.example',
          confirmed: true,
          registrationToken: 'di1.secret-code',
        },
      },
    ]);
    expect(lines.join('\n')).not.toContain('di1.secret-code');
  });

  it('team transport takes a registration token as a value too, and asks nothing before --yes', async () => {
    await run(
      'team',
      'transport',
      'relay',
      'wss://relay.example',
      '--yes',
      '--registration-token',
      'relay-token'
    );
    expect(asked).toEqual([]);
    expect(posted.at(-1)?.body).toMatchObject({
      registrationToken: 'relay-token',
    });
    posted = [];
    let failed = false;
    try {
      await makeProgram(ctx)
        .exitOverride()
        .configureOutput({ writeErr: () => {} })
        .parseAsync(
          [
            'team',
            'transport',
            'relay',
            'wss://relay.example',
            '--registration-token',
          ],
          { from: 'user' }
        );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(asked).toEqual([]);
    expect(posted).toEqual([]);
  });
});
