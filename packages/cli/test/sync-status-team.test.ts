import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonFilePath } from '../src/commands/daemon.js';
import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

// C: with the app token, `sync status` reads the decide-tier view, so the
// team's problems and the origin warning reach the person through the real
// token path; with only the agent token it shows the shared view.

const APP_TOKEN = 'app-token';
const AGENT_TOKEN = 'agent-token';
let root: string;
let fakeHome: string;
let lines: string[];
let ctx: CliContext;
let server: ReturnType<typeof Bun.serve>;
const originalHome = process.env.DISPATCH_HOME;
const originalToken = process.env.DISPATCH_APP_TOKEN;

const status = {
  enabled: true,
  replica: 'ada-0000000a',
  remote: 'git@example.com:team/board.git',
  branch: 'dispatch-sync',
  lastSyncAt: null,
  lastError: null,
  pending: 0,
  applied: 0,
  problems: [],
  people: 1,
  seats: 3,
  paused: null,
  founded: true,
  teamId: 'a'.repeat(32),
  legacyUntil: null,
  transport: 'git',
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-sync-status-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-sync-status-'));
  process.env.DISPATCH_HOME = fakeHome;
  delete process.env.DISPATCH_APP_TOKEN;
  lines = [];
  ctx = { cwd: root, log: (l) => lines.push(l) };
  await makeProgram(ctx).parseAsync(['init'], { from: 'user' });
  lines = [];
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const app = req.headers.get('authorization') === `Bearer ${APP_TOKEN}`;
      if (url.pathname === '/api/health') return Response.json({ ok: true });
      if (url.pathname === '/api/board-sync')
        return Response.json(
          app
            ? {
                ...status,
                federationProblems: [
                  {
                    subject: 'halt:bob-0000000b',
                    message: "bob's log fails verification",
                    at: 'x',
                  },
                ],
              }
            : status
        );
      if (url.pathname === '/api/team/keys' && app)
        return Response.json({
          originWarning: 'Everyone with access to origin can read it',
        });
      return Response.json({ error: 'not found' }, { status: 404 });
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
      agentToken: AGENT_TOKEN,
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

describe('dispatch sync status', () => {
  it('shows the team problems and origin warning with the app token', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await makeProgram(ctx).parseAsync(['sync', 'status'], { from: 'user' });
    const text = lines.join('\n');
    expect(text).toContain("bob's log fails verification");
    expect(text).toContain('Everyone with access to origin');
  });

  it('shows the shared view with only the agent token', async () => {
    await makeProgram(ctx).parseAsync(['sync', 'status'], { from: 'user' });
    const text = lines.join('\n');
    expect(text).toContain('Team aaaaaaaa');
    expect(text).not.toContain('fails verification');
  });
});
