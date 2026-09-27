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

const DRY_RUN_TEXT = 'outcome: dry-run\nledger rows read      330';
const MISMATCH_TEXT = 'outcome: MISMATCH — memory rows 3 → 4, expected 5';

let root: string;
let fakeHome: string;
let lines: string[];
let ctx: CliContext;
let server: ReturnType<typeof Bun.serve>;
// Every request the fake daemon saw, so a test can assert what was not sent too.
let received: { path: string; method: string; auth: string | null }[];
let queries: string[];
let outcome: 'dry-run' | 'ok' | 'MISMATCH';
const originalDispatchHome = process.env.DISPATCH_HOME;
const originalAppToken = process.env.DISPATCH_APP_TOKEN;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

// A fake dispatchd whose import route, like the real one, needs a human's app token.
function startFakeDaemon(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get('authorization');
      received.push({ path: url.pathname, method: req.method, auth });
      if (url.pathname === '/api/health') return Response.json({ ok: true });
      if (auth !== `Bearer ${APP_TOKEN}`) {
        return Response.json(
          {
            error: 'the ledger import needs the decide tier',
            code: 'forbidden',
          },
          { status: 403 }
        );
      }
      if (
        url.pathname === '/api/memory/import/ledger' &&
        req.method === 'POST'
      ) {
        queries.push(url.search);
        return Response.json({
          report: { outcome, read: 330 },
          text: outcome === 'MISMATCH' ? MISMATCH_TEXT : DRY_RUN_TEXT,
        });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-memory-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-memory-'));
  process.env.DISPATCH_HOME = fakeHome;
  delete process.env.DISPATCH_APP_TOKEN;
  lines = [];
  received = [];
  queries = [];
  outcome = 'dry-run';
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

describe('dispatch memory import-ledger', () => {
  it('posts a dry run with the app token and prints the report text', async () => {
    await run('memory', 'import-ledger', '--dry-run', '--token', APP_TOKEN);
    const post = received.find((r) => r.path === '/api/memory/import/ledger');
    expect(post).toEqual({
      path: '/api/memory/import/ledger',
      method: 'POST',
      auth: `Bearer ${APP_TOKEN}`,
    });
    expect(queries).toEqual(['?dryRun=1']);
    expect(lines.join('\n')).toContain('ledger rows read');
  });

  it('imports for real without --dry-run, reading DISPATCH_APP_TOKEN', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    outcome = 'ok';
    await run('memory', 'import-ledger');
    expect(queries).toEqual(['']);
  });

  it('prints the report as JSON with --json', async () => {
    await run(
      'memory',
      'import-ledger',
      '--dry-run',
      '--json',
      '--token',
      APP_TOKEN
    );
    expect(JSON.parse(lines.join('\n'))).toEqual({
      outcome: 'dry-run',
      read: 330,
    });
  });

  it('prints a MISMATCH report and then fails', async () => {
    outcome = 'MISMATCH';
    await expect(
      run('memory', 'import-ledger', '--token', APP_TOKEN)
    ).rejects.toThrow(/MISMATCH: nothing was written/);
    expect(lines).toEqual([MISMATCH_TEXT]);
  });

  it('refuses without an app token and says why', async () => {
    await expect(run('memory', 'import-ledger', '--dry-run')).rejects.toThrow(
      CliError
    );
    await expect(run('memory', 'import-ledger', '--dry-run')).rejects.toThrow(
      /needs the daemon app token/
    );
    expect(received.some((r) => r.path.startsWith('/api/memory'))).toBe(false);
  });

  it('surfaces the daemon 403 when the token supplied is only agent-tier', async () => {
    await expect(
      run('memory', 'import-ledger', '--dry-run', '--token', AGENT_TOKEN)
    ).rejects.toThrow(/needs the decide tier/);
  });
});
