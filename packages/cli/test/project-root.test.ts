import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonFilePath, findRunningDaemon } from '../src/commands/daemon.js';
import { projectRootFor } from '../src/projectRoot.js';

// A run's worktree is a linked git worktree of the project, so every case
// below is built on a real repo with `git worktree add` — the same layout
// the executor produces under ~/.dispatch/worktrees/<key>/<run id>.

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

// The git-reported root is a real path (macOS's /var is a symlink to
// /private/var), so the repo is created at its real path up front and every
// expectation compares against that spelling.
function initRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-root-')));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

function addWorktree(root: string): string {
  const worktrees = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-wt-')));
  const worktree = join(worktrees, 'r-0001');
  git(root, 'worktree', 'add', '-q', '--detach', worktree);
  return worktree;
}

const originalProjectRootEnv = process.env.DISPATCH_PROJECT_ROOT;
const originalDispatchHome = process.env.DISPATCH_HOME;
const created: string[] = [];

beforeEach(() => {
  // A test process launched from inside a dispatch run would otherwise
  // resolve every cwd to that run's project.
  delete process.env.DISPATCH_PROJECT_ROOT;
});

afterEach(() => {
  if (originalProjectRootEnv === undefined) {
    delete process.env.DISPATCH_PROJECT_ROOT;
  } else {
    process.env.DISPATCH_PROJECT_ROOT = originalProjectRootEnv;
  }
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('projectRootFor', () => {
  it('resolves a linked worktree to the repository root', () => {
    const root = initRepo();
    const worktree = addWorktree(root);
    created.push(root, worktree);
    expect(projectRootFor(worktree)).toBe(root);
  });

  it('resolves a subdirectory of a linked worktree to the repository root', () => {
    const root = initRepo();
    const worktree = addWorktree(root);
    created.push(root, worktree);
    const nested = join(worktree, 'packages', 'core');
    mkdirSync(nested, { recursive: true });
    expect(projectRootFor(nested)).toBe(root);
  });

  it('resolves a subdirectory of the main checkout to the checkout root', () => {
    const root = initRepo();
    created.push(root);
    const nested = join(root, 'packages', 'core');
    mkdirSync(nested, { recursive: true });
    expect(projectRootFor(nested)).toBe(root);
  });

  it('returns the checkout root in the caller’s own spelling', () => {
    const root = initRepo();
    created.push(root);
    // A symlinked spelling of the root (as a temp dir under /var is on
    // macOS) must key the daemon exactly as it did before the resolver.
    const alias = join(mkdtempSync(join(tmpdir(), 'dispatch-alias-')), 'p');
    created.push(alias);
    execFileSync('ln', ['-s', root, alias]);
    expect(projectRootFor(alias)).toBe(alias);
    expect(projectRootFor(root)).toBe(root);
  });

  it('returns a non-git directory unchanged', () => {
    const plain = mkdtempSync(join(tmpdir(), 'dispatch-plain-'));
    created.push(plain);
    expect(projectRootFor(plain)).toBe(plain);
  });
});

describe('findRunningDaemon from inside a worktree', () => {
  it('finds the daemon written for the repository root', async () => {
    const root = initRepo();
    const worktree = addWorktree(root);
    const home = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
    created.push(root, worktree, home);
    process.env.DISPATCH_HOME = home;

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return new URL(req.url).pathname === '/api/health'
          ? Response.json({ ok: true })
          : Response.json({ error: 'not found' }, { status: 404 });
      },
    });
    try {
      mkdirSync(join(home, '.dispatch', 'daemons'), { recursive: true });
      writeFileSync(
        daemonFilePath(root),
        JSON.stringify({
          port: server.port,
          pid: process.pid,
          rootDir: root,
          startedAt: new Date().toISOString(),
          agentToken: 'agent-token',
        })
      );
      // No daemon file exists for the worktree path itself, so a lookup
      // keyed on the raw cwd would return null here.
      const daemon = await findRunningDaemon(worktree);
      expect(daemon?.port).toBe(server.port);
      expect(daemon?.agentToken).toBe('agent-token');
    } finally {
      await server.stop(true);
    }
  });
});
