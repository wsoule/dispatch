import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonFilePath, findRunningDaemon } from '../src/commands/daemon.js';
import type { CliContext } from '../src/context.js';
import { CliError } from '../src/context.js';
import { makeProgram } from '../src/program.js';
import { wsUrl } from '../src/watch.js';

const AGENT_TOKEN = 'agent-token-from-the-daemon-file';

let root: string;
let fakeHome: string;
let lines: string[];
let ctx: CliContext;
let server: ReturnType<typeof Bun.serve>;
let received: { path: string; auth: string | null }[];
const originalDispatchHome = process.env.DISPATCH_HOME;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

// A fake dispatchd that answers health openly and everything else only for
// the agent token, so a missing header fails the CLI rather than passing.
function startFakeDaemon(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get('authorization');
      received.push({ path: url.pathname, auth });
      if (url.pathname === '/api/health') return Response.json({ ok: true });
      if (auth !== `Bearer ${AGENT_TOKEN}`) {
        return Response.json(
          { error: 'missing daemon token', code: 'auth_missing_token' },
          { status: 401 }
        );
      }
      return Response.json([]);
    },
  });
}

function writeDaemonFile(extra: Record<string, unknown>): void {
  mkdirSync(join(fakeHome, '.dispatch', 'daemons'), { recursive: true });
  writeFileSync(
    daemonFilePath(root),
    JSON.stringify({
      port: server.port,
      pid: process.pid,
      rootDir: root,
      startedAt: new Date().toISOString(),
      ...extra,
    })
  );
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-token-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-token-'));
  process.env.DISPATCH_HOME = fakeHome;
  lines = [];
  received = [];
  ctx = { cwd: root, log: (l) => lines.push(l) };
  await run('init');
  lines = [];
  server = startFakeDaemon();
});

afterEach(() => {
  void server.stop(true);
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
});

describe('the agent token the CLI reads from the daemon file', () => {
  it('rides on an ordinary command', async () => {
    writeDaemonFile({ agentToken: AGENT_TOKEN });
    await run('runs');
    const listing = received.find((r) => r.path === '/api/runs');
    expect(listing?.auth).toBe(`Bearer ${AGENT_TOKEN}`);
  });

  it('is never sent to the open health probe, which precedes having one', async () => {
    writeDaemonFile({ agentToken: AGENT_TOKEN });
    await run('runs');
    const health = received.find((r) => r.path === '/api/health');
    expect(health?.auth).toBeNull();
  });

  it('fails with a restart instruction when the daemon file has none', async () => {
    writeDaemonFile({});
    await expect(findRunningDaemon(root)).rejects.toThrow(CliError);
    await expect(findRunningDaemon(root)).rejects.toThrow(
      /predates token auth/
    );
  });
});

describe('the CLI websocket URL', () => {
  it('carries the token in the query string', () => {
    expect(wsUrl('http://127.0.0.1:4771', 'agent tok/1')).toBe(
      'ws://127.0.0.1:4771/ws?token=agent%20tok%2F1'
    );
  });

  it('omits it entirely when there is no token', () => {
    expect(wsUrl('http://127.0.0.1:4771')).toBe('ws://127.0.0.1:4771/ws');
  });
});
