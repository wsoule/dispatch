import { checkMergeDriverSetup, readRegistry } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  daemonFilePath,
  openDesktopOrBrowser,
} from '../src/commands/daemon.js';
import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

let root: string;
let lines: string[];
let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-bare-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  lines = [];
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
});

describe('bare `dispatch` in an uninitialized directory', () => {
  it('initializes .dispatch, upserts the registry, and opens the app or browser', async () => {
    // A minimal stand-in daemon (same trick as daemon-cmd.test.ts's `dispatch
    // ui` coverage): just enough to answer /api/health, so `ensureDaemon`
    // treats it as already-running instead of trying to spawn a real bun
    // process (which would need a build/install this test shouldn't depend
    // on).
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

      const openedApps: string[] = [];
      const openedUrls: string[] = [];
      const ctx: CliContext = {
        cwd: root,
        log: (l) => lines.push(l),
        openApp: (r) => openedApps.push(r),
        openBrowser: (url) => openedUrls.push(url),
      };

      await makeProgram(ctx).parseAsync([], { from: 'user' });

      // init-if-missing ran.
      expect(existsSync(join(root, '.dispatch/tasks'))).toBe(true);
      expect(lines.join('\n')).toContain('Initialized');

      // the project was registered.
      const registered = readRegistry();
      expect(registered).toHaveLength(1);
      expect(registered[0].path).toBe(root);

      // exactly one opener fired, and it points at this project — which one
      // depends on whether the desktop app happens to be resolvable on the
      // machine running the test, so accept either.
      expect(openedApps.length + openedUrls.length).toBe(1);
      if (openedApps.length === 1) {
        expect(openedApps[0]).toBe(root);
      } else {
        expect(openedUrls[0]).toBe(`http://127.0.0.1:${testServer.port}`);
      }
    } finally {
      await testServer.stop(true);
    }
  });

  it('is idempotent: a second bare run does not re-initialize', async () => {
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

      const ctx: CliContext = {
        cwd: root,
        log: (l) => lines.push(l),
        openApp: () => {},
        openBrowser: () => {},
      };

      await makeProgram(ctx).parseAsync([], { from: 'user' });
      lines = [];
      await makeProgram(ctx).parseAsync([], { from: 'user' });

      expect(lines.join('\n')).not.toContain('Initialized');
      expect(readRegistry()).toHaveLength(1);
    } finally {
      await testServer.stop(true);
    }
  });

  // Regression: writeGitAttributes + registerMergeDriverGitConfig used to
  // run only from the explicit `dispatch init` subcommand, so a desktop-first
  // user (who only ever hits this bare-command path) never got the merge
  // driver registered at all.
  it('registers the task-file merge driver on first init', async () => {
    spawnSync('git', ['init', '-q'], { cwd: root });

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

      const ctx: CliContext = {
        cwd: root,
        log: (l) => lines.push(l),
        openApp: () => {},
        openBrowser: () => {},
      };

      await makeProgram(ctx).parseAsync([], { from: 'user' });

      expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toContain(
        '.dispatch/tasks/*.md merge=dispatch-task'
      );
      expect(checkMergeDriverSetup(root)).toEqual({
        gitattributes: true,
        gitConfig: true,
      });
    } finally {
      await testServer.stop(true);
    }
  });

  // Regression: initIfMissing used to skip driver registration entirely once
  // `.dispatch/tasks` already existed, so a project scaffolded before the
  // drivers shipped (or that lost its local git config) was never repaired
  // by the bare `dispatch` command — only an explicit `dispatch init` did.
  it('repairs the merge drivers on an already-initialized project', async () => {
    spawnSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(join(root, '.dispatch', 'tasks'), { recursive: true });
    expect(checkMergeDriverSetup(root)).toEqual({
      gitattributes: false,
      gitConfig: false,
    });

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

      const ctx: CliContext = {
        cwd: root,
        log: (l) => lines.push(l),
        openApp: () => {},
        openBrowser: () => {},
      };

      await makeProgram(ctx).parseAsync([], { from: 'user' });

      // Driver registration ran even though .dispatch/tasks already existed
      // — initIfMissing returned false, but still repaired the drivers.
      expect(lines.join('\n')).not.toContain('Initialized');
      expect(checkMergeDriverSetup(root)).toEqual({
        gitattributes: true,
        gitConfig: true,
      });
    } finally {
      await testServer.stop(true);
    }
  });
});

describe('openDesktopOrBrowser', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('falls back to the browser on non-darwin platforms without probing for the app', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });

    const openedApps: string[] = [];
    const openedUrls: string[] = [];
    const ctx: CliContext = {
      cwd: '/some/project',
      log: () => {},
      openApp: (r) => openedApps.push(r),
      openBrowser: (url) => openedUrls.push(url),
    };

    openDesktopOrBrowser(ctx, 4321);

    expect(openedApps).toEqual([]);
    expect(openedUrls).toEqual(['http://127.0.0.1:4321']);
  });
});
