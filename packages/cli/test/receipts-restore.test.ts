import {
  DOCS_LIMITS,
  initProjectStores,
  materializeReceipts,
  openProjectStores,
  readProjectBackend,
} from '@dispatch/core';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { daemonFileKey } from '../src/commands/daemon.js';
import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';
import { projectRoot } from '../src/projectRoot.js';

// The disaster-recovery half of the receipt log: a machine that pushed its log
// is gone, and a fresh checkout rebuilds the board from what it pushed.

const dirs: string[] = [];
const originalHome = process.env.DISPATCH_HOME;

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync({ cmd: ['git', ...args], cwd });
  if (res.exitCode !== 0)
    throw new Error(`git ${args.join(' ')}: ${res.stderr.toString()}`);
}

beforeEach(() => {
  process.env.DISPATCH_HOME = temp('dispatch-home-');
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A receipt log for a board with two tasks, pushed to a bare remote the way
 *  the daemon's exporter pushes it. `extra` adds files to the log first. */
function pushedLog(extra?: (log: string) => void): {
  remote: string;
  ids: string[];
} {
  const source = temp('dispatch-source-');
  const stores = initProjectStores({ rootDir: source, backend: 'sqlite' });
  const ids = [
    stores.tasks.create({ title: 'Fix the login redirect' }).meta.id,
    stores.tasks.create({ title: 'Write the release notes' }).meta.id,
  ];
  const log = temp('dispatch-log-');
  git(log, 'init', '-q', '-b', 'main');
  materializeReceipts(stores, log);
  stores.close();
  extra?.(log);
  git(log, 'add', '-A');
  git(
    log,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '-m',
    'receipts'
  );
  const remote = temp('dispatch-remote-');
  git(remote, 'init', '-q', '--bare');
  git(log, 'push', '-q', remote, 'HEAD:dispatch-receipts');
  return { remote, ids };
}

test('a fresh checkout rebuilds the board from a pushed receipt log', async () => {
  const { remote, ids } = pushedLog();
  const fresh = temp('dispatch-fresh-');
  git(fresh, 'init', '-q', '-b', 'main');
  const lines: string[] = [];
  const ctx: CliContext = { cwd: fresh, log: (l) => lines.push(l) };

  await makeProgram(ctx).parseAsync(['receipts', 'restore', '--from', remote], {
    from: 'user',
  });

  const stores = openProjectStores({ rootDir: fresh, backend: 'sqlite' });
  try {
    expect(stores.tasks.get(ids[0])?.meta.title).toBe('Fix the login redirect');
    expect(stores.tasks.get(ids[1])?.meta.title).toBe(
      'Write the release notes'
    );
  } finally {
    stores.close();
  }
  // Marked, so the CLI and the next daemon read this board from the database.
  expect(readProjectBackend(fresh)).toBe('sqlite');
  expect(lines.join('\n')).toContain('Restored.');
});

test('--from reads a path from where you typed it, and a remote’s relative URL from the project', async () => {
  // The clone runs in a temp dir, so a relative location has to be made
  // absolute first — against the shell's directory for a path typed on the
  // command line, against the project for a URL stored on one of its remotes.
  const { remote, ids } = pushedLog();
  const fresh = temp('dispatch-fresh-');
  git(fresh, 'init', '-q', '-b', 'main');
  const ctx: CliContext = { cwd: fresh, log: () => {} };
  await makeProgram(ctx).parseAsync(
    ['receipts', 'restore', '--from', join('..', basename(remote))],
    { from: 'user' }
  );
  let stores = openProjectStores({ rootDir: fresh, backend: 'sqlite' });
  try {
    expect(stores.tasks.get(ids[0])?.meta.title).toBe('Fix the login redirect');
  } finally {
    stores.close();
  }

  const other = temp('dispatch-fresh-');
  git(other, 'init', '-q', '-b', 'main');
  git(other, 'remote', 'add', 'origin', join('..', basename(remote)));
  await makeProgram({ cwd: other, log: () => {} }).parseAsync(
    ['receipts', 'restore', '--from', 'origin'],
    { from: 'user' }
  );
  stores = openProjectStores({ rootDir: other, backend: 'sqlite' });
  try {
    expect(stores.tasks.get(ids[1])?.meta.title).toBe(
      'Write the release notes'
    );
  } finally {
    stores.close();
  }
});

test('a branch that is not there fails with where it looked', async () => {
  const { remote } = pushedLog();
  const fresh = temp('dispatch-fresh-');
  git(fresh, 'init', '-q', '-b', 'main');
  const ctx: CliContext = { cwd: fresh, log: () => {} };
  await expect(
    makeProgram(ctx).parseAsync(
      ['receipts', 'restore', '--from', remote, '--branch', 'nope'],
      { from: 'user' }
    )
  ).rejects.toThrow('could not fetch nope');
});

test('team docs in the log are staged for the daemon to restore', async () => {
  const { remote } = pushedLog((log) => {
    mkdirSync(join(log, '.dispatch', 'docs'), { recursive: true });
    writeFileSync(join(log, '.dispatch', 'docs', 'a.md'), 'a doc\n');
  });
  const fresh = temp('dispatch-fresh-');
  git(fresh, 'init', '-q', '-b', 'main');
  const lines: string[] = [];
  await makeProgram({ cwd: fresh, log: (l) => lines.push(l) }).parseAsync(
    ['receipts', 'restore', '--from', remote],
    { from: 'user' }
  );
  const staging = join(
    process.env.DISPATCH_HOME ?? '',
    '.dispatch',
    'runs',
    daemonFileKey(projectRoot(fresh)),
    'docs-restore'
  );
  expect(readFileSync(join(staging, 'a.md'), 'utf8')).toBe('a doc\n');
  expect(statSync(staging).mode & 0o777).toBe(0o700);
  expect(lines).toContain('staged 1 doc(s) for the daemon to restore');
});

test('a log without team docs stages nothing', async () => {
  const { remote } = pushedLog();
  const fresh = temp('dispatch-fresh-');
  git(fresh, 'init', '-q', '-b', 'main');
  const lines: string[] = [];
  await makeProgram({ cwd: fresh, log: (l) => lines.push(l) }).parseAsync(
    ['receipts', 'restore', '--from', remote],
    { from: 'user' }
  );
  const staging = join(
    process.env.DISPATCH_HOME ?? '',
    '.dispatch',
    'runs',
    daemonFileKey(projectRoot(fresh)),
    'docs-restore'
  );
  expect(existsSync(staging)).toBe(false);
  expect(lines.some((l) => l.includes('staged'))).toBe(false);
});

// The staging directory `receipts restore` copies team docs into for `fresh`.
function stagingFor(fresh: string): string {
  return join(
    process.env.DISPATCH_HOME ?? '',
    '.dispatch',
    'runs',
    daemonFileKey(projectRoot(fresh)),
    'docs-restore'
  );
}

// Restores `remote` into a fresh checkout; returns it and what the CLI printed.
async function restoreFresh(
  remote: string
): Promise<{ fresh: string; lines: string[] }> {
  const fresh = temp('dispatch-fresh-');
  git(fresh, 'init', '-q', '-b', 'main');
  const lines: string[] = [];
  await makeProgram({ cwd: fresh, log: (l) => lines.push(l) }).parseAsync(
    ['receipts', 'restore', '--from', remote],
    { from: 'user' }
  );
  return { fresh, lines };
}

test('a symlinked doc file in the log is not staged', async () => {
  const secret = join(temp('dispatch-secret-'), 'secret.md');
  writeFileSync(secret, 'not a doc\n');
  const { remote } = pushedLog((log) => {
    mkdirSync(join(log, '.dispatch', 'docs'), { recursive: true });
    writeFileSync(join(log, '.dispatch', 'docs', 'a.md'), 'a doc\n');
    symlinkSync(secret, join(log, '.dispatch', 'docs', 'leak.md'));
  });
  const { fresh, lines } = await restoreFresh(remote);
  expect(existsSync(join(stagingFor(fresh), 'leak.md'))).toBe(false);
  expect(readFileSync(join(stagingFor(fresh), 'a.md'), 'utf8')).toBe('a doc\n');
  expect(lines).toContain('staged 1 doc(s) for the daemon to restore');
  expect(lines.some((l) => l.includes('leak.md'))).toBe(true);
});

test('a symlinked .dispatch/docs stages nothing', async () => {
  const outside = temp('dispatch-outside-');
  writeFileSync(join(outside, 'a.md'), 'not from the log\n');
  const { remote } = pushedLog((log) => {
    mkdirSync(join(log, '.dispatch'), { recursive: true });
    symlinkSync(outside, join(log, '.dispatch', 'docs'));
  });
  const { fresh, lines } = await restoreFresh(remote);
  expect(existsSync(stagingFor(fresh))).toBe(false);
  expect(lines.some((l) => l.includes('symlink'))).toBe(true);
});

test('a doc file over the receipt file limit is not staged, and is reported', async () => {
  const { remote } = pushedLog((log) => {
    mkdirSync(join(log, '.dispatch', 'docs'), { recursive: true });
    writeFileSync(
      join(log, '.dispatch', 'docs', 'huge.md'),
      'x'.repeat(DOCS_LIMITS.receiptFileBytes + 1)
    );
    writeFileSync(join(log, '.dispatch', 'docs', 'a.md'), 'a doc\n');
  });
  const { fresh, lines } = await restoreFresh(remote);
  expect(existsSync(join(stagingFor(fresh), 'huge.md'))).toBe(false);
  expect(lines).toContain('staged 1 doc(s) for the daemon to restore');
  expect(lines.some((l) => l.includes('huge.md') && l.includes('over'))).toBe(
    true
  );
});
