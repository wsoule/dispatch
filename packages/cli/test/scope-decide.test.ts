import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonFilePath } from '../src/commands/daemon.js';
import type { CliContext } from '../src/context.js';
import { CliError } from '../src/context.js';
import { makeProgram } from '../src/program.js';

const AGENT_TOKEN = 'agent-token-from-the-daemon-file';
const APP_TOKEN = 'app-token-only-a-human-has';

let root: string;
let fakeHome: string;
let lines: string[];
let ctx: CliContext;
let server: ReturnType<typeof Bun.serve>;
// Every request the fake daemon saw, so a test can assert both what was sent
// and — for the never-decide-without-an-app-token guard — what was not.
let received: { path: string; auth: string | null }[];
const originalDispatchHome = process.env.DISPATCH_HOME;
const originalAppToken = process.env.DISPATCH_APP_TOKEN;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

// A fake dispatchd that enforces the real tier split: the agent token reaches
// everything except `/decide`, which needs the app token.
function startFakeDaemon(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get('authorization');
      received.push({ path: url.pathname, auth });
      if (url.pathname === '/api/health') return Response.json({ ok: true });
      if (auth === null) {
        return Response.json(
          { error: 'missing daemon token', code: 'auth_missing_token' },
          { status: 401 }
        );
      }
      const isDecide = url.pathname.endsWith('/decide');
      if (isDecide && auth !== `Bearer ${APP_TOKEN}`) {
        return Response.json(
          { error: 'needs the app token', code: 'auth_insufficient_tier' },
          { status: 403 }
        );
      }
      if (!isDecide && auth !== `Bearer ${AGENT_TOKEN}`) {
        return Response.json(
          { error: 'not recognized', code: 'auth_invalid_token' },
          { status: 401 }
        );
      }
      const body = isDecide
        ? ((await req.json()) as { granted: boolean; reason: string })
        : { granted: null, reason: '' };
      return Response.json({
        id: 'sr-1',
        runId: 'r-1',
        paths: ['packages/core/src/browser.ts'],
        reason: 'needed for the fix',
        requestedAt: '2026-08-02T00:00:00Z',
        granted: isDecide ? body.granted : null,
        decisionReason: isDecide ? body.reason : null,
        decidedAt: isDecide ? '2026-08-02T00:00:01Z' : null,
      });
    },
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-scope-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-scope-'));
  process.env.DISPATCH_HOME = fakeHome;
  delete process.env.DISPATCH_APP_TOKEN;
  lines = [];
  received = [];
  ctx = { cwd: root, log: (l) => lines.push(l) };
  await run('init');
  lines = [];

  server = startFakeDaemon();
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
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  if (originalAppToken === undefined) delete process.env.DISPATCH_APP_TOKEN;
  else process.env.DISPATCH_APP_TOKEN = originalAppToken;
});

describe('dispatch scope decide', () => {
  it('refuses to run without an app token, and points at dispatch serve', async () => {
    await expect(run('scope', 'decide', 'r-1', 'sr-1')).rejects.toThrow(
      CliError
    );
    await expect(run('scope', 'decide', 'r-1', 'sr-1')).rejects.toThrow(
      /dispatch serve/
    );
  });

  it('never falls back to the agent token sitting in the daemon file', async () => {
    await expect(run('scope', 'decide', 'r-1', 'sr-1')).rejects.toThrow(
      CliError
    );
    // The point is not just the throw: no request must reach the daemon at
    // all, since a decide attempt carrying the agent token would be the very
    // silent fallback the tier split exists to prevent.
    expect(received).toEqual([]);
  });

  it('decides with a --token app token', async () => {
    await run('scope', 'decide', 'r-1', 'sr-1', '--token', APP_TOKEN);
    const decide = received.find((r) => r.path.endsWith('/decide'));
    expect(decide?.auth).toBe(`Bearer ${APP_TOKEN}`);
    expect(lines.join('\n')).toContain('sr-1 granted');
  });

  it('decides with DISPATCH_APP_TOKEN', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('scope', 'decide', 'r-1', 'sr-1', '--deny');
    const decide = received.find((r) => r.path.endsWith('/decide'));
    expect(decide?.auth).toBe(`Bearer ${APP_TOKEN}`);
    expect(lines.join('\n')).toContain('sr-1 denied');
  });

  it('surfaces the daemon 403 when the token supplied is only agent-tier', async () => {
    await expect(
      run('scope', 'decide', 'r-1', 'sr-1', '--token', AGENT_TOKEN)
    ).rejects.toThrow(/needs the app token/);
  });
});

describe('dispatch scope show', () => {
  it('reads a scope request with the agent token from the daemon file', async () => {
    await run('scope', 'show', 'r-1', 'sr-1');
    const read = received.find((r) => r.path.endsWith('/scope-requests/sr-1'));
    expect(read?.auth).toBe(`Bearer ${AGENT_TOKEN}`);
    expect(lines.join('\n')).toContain('pending');
  });
});
