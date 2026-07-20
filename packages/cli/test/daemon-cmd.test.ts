import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonFileKey, daemonFilePath } from '../src/commands/daemon.js';
import { type CliContext, CliError } from '../src/context.js';
import { makeProgram } from '../src/program.js';

let root: string;
let lines: string[];
let ctx: CliContext;
let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  lines = [];
  ctx = { cwd: root, log: (l) => lines.push(l) };
  await run('init');
  lines = [];
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
});

describe('daemon-file discovery (mirrors packages/server/src/daemonfile.ts)', () => {
  it('matches the documented hash scheme: sha256(rootDir).slice(0, 12)', () => {
    // Fixture computed independently of the code under test — equivalent to
    // `printf '%s' /tmp/dispatch-fixture-root | shasum -a 256`, first 12 hex
    // chars — so this catches drift from the scheme documented in the plan
    // (`~/.dispatch/daemons/<sha256(rootDir).slice(0,12)>.json`), not just
    // agreement between two copies of the same formula.
    const rootDir = '/tmp/dispatch-fixture-root';
    const expectedKey = createHash('sha256')
      .update(rootDir)
      .digest('hex')
      .slice(0, 12);
    expect(expectedKey).toBe('3970f3cf1c5c');
    expect(daemonFileKey(rootDir)).toBe('3970f3cf1c5c');
  });

  it('places the daemon file under $DISPATCH_HOME/.dispatch/daemons/<key>.json', () => {
    const path = daemonFilePath(root);
    expect(path).toBe(
      join(fakeHome, '.dispatch', 'daemons', `${daemonFileKey(root)}.json`)
    );
  });

  it('treats an empty DISPATCH_HOME the same as unset (falls back to homedir())', () => {
    process.env.DISPATCH_HOME = '';
    expect(daemonFilePath(root)).toBe(
      join(homedir(), '.dispatch', 'daemons', `${daemonFileKey(root)}.json`)
    );
  });
});

describe('dispatch serve', () => {
  it('errors when the store is not initialized', async () => {
    const uninitialized = mkdtempSync(join(tmpdir(), 'dispatch-cli-bare-'));
    const bareCtx: CliContext = {
      cwd: uninitialized,
      log: (l) => lines.push(l),
    };
    await expect(
      makeProgram(bareCtx).parseAsync(['serve'], { from: 'user' })
    ).rejects.toThrow(CliError);
    await expect(
      makeProgram(bareCtx).parseAsync(['serve'], { from: 'user' })
    ).rejects.toThrow(/not initialized/);
  });
});

describe('dispatch ui', () => {
  it('errors when the store is not initialized', async () => {
    const uninitialized = mkdtempSync(join(tmpdir(), 'dispatch-cli-bare-'));
    const bareCtx: CliContext = {
      cwd: uninitialized,
      log: (l) => lines.push(l),
    };
    await expect(
      makeProgram(bareCtx).parseAsync(['ui'], { from: 'user' })
    ).rejects.toThrow(CliError);
    await expect(
      makeProgram(bareCtx).parseAsync(['ui'], { from: 'user' })
    ).rejects.toThrow(/not initialized/);
  });

  it('opens the browser at an already-running daemon without spawning a new one', async () => {
    // A minimal stand-in daemon: just enough to answer `/api/health`, which
    // is all `dispatch ui` checks before deciding a real daemon is already
    // up. Using the actual @dispatch/server bin here isn't possible from
    // this package (it's Bun-only and its `exports` map intentionally hides
    // everything but `package.json`, per Slice S1) — a plain Bun.serve
    // stand-in is enough to exercise the health-check + openBrowser path.
    const testServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/health') {
          return Response.json({ ok: true, version: '0.0.1' });
        }
        return new Response('not found', { status: 404 });
      },
    });

    try {
      const daemonsDir = join(fakeHome, '.dispatch', 'daemons');
      mkdirSync(daemonsDir, { recursive: true });
      writeFileSync(
        daemonFilePath(root),
        JSON.stringify({
          port: testServer.port,
          pid: process.pid,
          rootDir: root,
          startedAt: new Date().toISOString(),
        })
      );

      const openedUrls: string[] = [];
      ctx = {
        cwd: root,
        log: (l) => lines.push(l),
        openBrowser: (url) => openedUrls.push(url),
      };

      await run('ui');

      expect(openedUrls).toEqual([`http://127.0.0.1:${testServer.port}`]);
    } finally {
      await testServer.stop(true);
    }
  });
});

describe('--help', () => {
  it('lists the serve and ui commands', () => {
    const help = makeProgram(ctx).helpInformation();
    expect(help).toMatch(/serve/);
    expect(help).toMatch(/ui/);
  });
});
