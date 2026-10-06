import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonFilePath } from '../src/commands/daemon.js';
import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

// Team setup from the CLI: start, invite, join, status, and a help that
// reads as those five, with the older commands under host and advanced.

const APP_TOKEN = 'app-token';
let root: string;
let fakeHome: string;
let lines: string[];
let asked: string[];
let ctx: CliContext;
let server: ReturnType<typeof Bun.serve>;
let posted: { path: string; body: unknown }[];
let syncOn = true;
const originalHome = process.env.DISPATCH_HOME;
const originalToken = process.env.DISPATCH_APP_TOKEN;

const run = (...argv: string[]) =>
  makeProgram(ctx).parseAsync(argv, { from: 'user' });

const STATUS = {
  state: 'member',
  line: "Team 'acme' · 2 of 3 seats · syncing via relay.dispatch.foo · last sync 4s ago",
  team: { id: 'a'.repeat(32), name: 'acme' },
  role: 'admin',
  seats: { used: 2, total: 3 },
  sync: { kind: 'relay', where: 'relay.dispatch.foo', lastSyncAt: null },
  teammates: [
    { handle: 'ada', device: 'laptop', role: 'admin', you: true, check: null },
    {
      handle: 'bob',
      device: 'desk',
      role: 'member',
      you: false,
      check: '123 456',
    },
  ],
  check: null,
  problems: [
    { message: 'Can’t reach relay.dispatch.foo.', fix: 'dispatch sync now' },
  ],
};

// What each POST answers, by path.
const ANSWERS: Record<string, unknown> = {
  '/api/team/start': {
    teamId: 'a'.repeat(32),
    name: 'acme',
    recoveryCode: 'RECOVERY-CODE',
    fingerprint: 'FP',
    transport: { kind: 'relay', url: 'wss://relay.dispatch.foo' },
    notice: null,
  },
  '/api/team/invite': {
    code: 'di1.x',
    expires: '2026-10-13T00:00:00.000Z',
    handle: 'bob',
    link: 'dispatch-team:LINK',
    url: 'https://dispatch.foo/join#LINK',
  },
  '/api/team/join': {
    ok: true,
    team: { id: 'a'.repeat(32), name: 'acme' },
    by: 'ada',
    check: '123 456',
  },
  '/api/team/found': {
    teamId: 'a'.repeat(32),
    recoveryCode: 'RECOVERY-CODE',
    fingerprint: 'FP',
  },
  '/api/team/tokens': {
    handle: 'bob',
    tier: 'request',
    token: 'tok',
    expiresAt: null,
  },
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-team-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-team-'));
  process.env.DISPATCH_HOME = fakeHome;
  process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
  lines = [];
  asked = [];
  posted = [];
  syncOn = true;
  ctx = {
    cwd: root,
    log: (l) => lines.push(l),
    confirm: (question) => {
      asked.push(question);
      return Promise.resolve(true);
    },
    readSecret: (prompt) => {
      asked.push(prompt);
      return Promise.resolve('  dispatch-team:LINK \n');
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
        return Response.json({ relayDisclosure: 'The relay can read X.' });
      if (url.pathname === '/api/team/status') return Response.json(STATUS);
      if (url.pathname === '/api/board-sync')
        return Response.json({ enabled: syncOn });
      posted.push({ path: url.pathname, body: await req.json() });
      // Sync off: the first start or join turns it on and restarts.
      if (
        !syncOn &&
        (url.pathname === '/api/team/start' ||
          url.pathname === '/api/team/join')
      ) {
        syncOn = true;
        return Response.json(
          { restarting: true, code: 'restarting' },
          { status: 202 }
        );
      }
      return Response.json(ANSWERS[url.pathname] ?? { ok: true });
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

describe('team setup from the CLI', () => {
  it('start shows the disclosure, asks once, and prints the recovery code', async () => {
    await run('team', 'start', '--name', 'acme');
    expect(asked).toEqual(['Sync this team through relay.dispatch.foo?']);
    expect(posted).toEqual([
      { path: '/api/team/start', body: { name: 'acme', confirmed: true } },
    ]);
    const text = lines.join('\n');
    expect(text).toContain('The relay can read X.');
    expect(text).toContain('Registering with relay.dispatch.foo…');
    expect(text).toContain(
      "Started team 'acme', syncing via relay.dispatch.foo."
    );
    expect(text).toContain('RECOVERY-CODE');
  });

  it('start --git asks nothing', async () => {
    await run('team', 'start', '--git');
    expect(asked).toEqual([]);
    expect(posted).toEqual([{ path: '/api/team/start', body: { git: true } }]);
  });

  it('invite prints one link, for an email or a handle', async () => {
    await run('team', 'invite', 'bob@example.com');
    expect(posted).toEqual([
      { path: '/api/team/invite', body: { email: 'bob@example.com' } },
    ]);
    expect(lines).toContain('  dispatch-team:LINK');
  });

  it('invite with the old token options issues a shared-host token', async () => {
    await run('team', 'invite', 'bob', '--tier', 'request');
    expect(posted.map((p) => p.path)).toEqual(['/api/team/tokens']);
  });

  it('join reads the link from a prompt and prints the optional check', async () => {
    await run('team', 'join');
    expect(asked).toEqual(['Invite link: ']);
    expect(posted).toEqual([
      { path: '/api/team/join', body: { code: 'dispatch-team:LINK' } },
    ]);
    const text = lines.join('\n');
    expect(text).toContain("Joined team 'acme'");
    expect(text).toContain('123 456');
  });

  it('status prints the line, teammates with their checks, and each fix', async () => {
    await run('team', 'status');
    expect(lines[0]).toBe(STATUS.line);
    const text = lines.join('\n');
    expect(text).toContain('bob (desk) · member · check 123 456');
    expect(text).toContain('fix: dispatch sync now');
  });

  it('help lists start, invite, join, status and leave, and hides the old names', () => {
    const team = makeProgram(ctx).commands.find((c) => c.name() === 'team');
    const help = team?.helpInformation() ?? '';
    for (const name of [
      'start',
      'invite',
      'join',
      'status',
      'leave',
      'host',
      'advanced',
    ])
      expect(help).toMatch(new RegExp(`^  ${name}\\b`, 'm'));
    for (const name of [
      'found',
      'keys',
      'tokens',
      'close-legacy',
      'dismiss',
      'trust',
    ])
      expect(help).not.toMatch(new RegExp(`^  ${name}\\b`, 'm'));
  });

  it('keeps the old names working, hidden, beside team advanced', async () => {
    await run('team', 'found');
    await run('team', 'advanced', 'found');
    expect(posted.map((p) => p.path)).toEqual([
      '/api/team/found',
      '/api/team/found',
    ]);
  });

  it('join with sync off waits out the restart and joins, in one command', async () => {
    syncOn = false;
    await run('team', 'join');
    expect(posted.map((p) => p.path)).toEqual([
      '/api/team/join',
      '/api/team/join',
    ]);
    expect(lines.join('\n')).toContain("Joined team 'acme'");
  });
});
