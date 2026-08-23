import { dispatchDbPath, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMigrate } from '../src/commands/migrate.js';
import type { CliContext } from '../src/context.js';

// `dispatch migrate` is the opt-in half of the one-time import — the other is
// a daemon booting with DISPATCH_STORE_BACKEND=sqlite. The import itself is
// covered in @dispatch/core; what matters here is the terminal around it: a
// dry run that writes literally nothing, and a real run that records the
// project's new backend only once the rows are actually in.

let root: string;
let fakeHome: string;
let ctx: CliContext;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  // No daemon file can exist under a fresh home, so findRunningDaemon comes
  // back null without this test having to stand a daemon up or tear one down.
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-migrate-cmd-'));
  ctx = { cwd: root, log: () => {} };
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function seedBoard(): void {
  const store = TaskStore.init(root);
  store.create({ title: 'Fix login' });
  store.create({ title: 'Storage spine', kind: 'epic' });
}

function markerBackend(): string | null {
  const path = join(root, '.dispatch', 'storage.json');
  if (!existsSync(path)) return null;
  return (JSON.parse(readFileSync(path, 'utf8')) as { backend: string })
    .backend;
}

describe('dispatch migrate --dry-run', () => {
  // "Nothing was written" has to include the database itself. Creating one
  // here would drop dispatch.db plus its -wal and -shm companions into a repo
  // that only asked what would happen.
  it('creates no database and no marker', async () => {
    seedBoard();
    const out = await runMigrate(ctx, true);
    expect(out).toContain('Dry run — nothing was written');
    expect(out).toContain('Re-run without --dry-run to import');
    expect(existsSync(dispatchDbPath(root))).toBe(false);
    expect(markerBackend()).toBeNull();
  });

  it('still counts what would move', async () => {
    seedBoard();
    const out = await runMigrate(ctx, true);
    expect(out).toMatch(/tasks\s+1\s+1\s+0\s+0/);
    expect(out).toMatch(/epics\s+1\s+1\s+0\s+0/);
  });
});

describe('dispatch migrate', () => {
  it('imports the board and records the project as database-backed', async () => {
    seedBoard();
    const out = await runMigrate(ctx, false);
    expect(out).toContain('Imported into the dispatch database');
    expect(out).toContain('2 record(s) were copied, not moved');
    expect(markerBackend()).toBe('sqlite');
    expect(existsSync(dispatchDbPath(root))).toBe(true);
    // Copied, not moved: the markdown is still readable afterwards.
    expect(new TaskStore(root).list()).toHaveLength(2);
  });

  it('is a no-op the second time', async () => {
    seedBoard();
    await runMigrate(ctx, false);
    const out = await runMigrate(ctx, false);
    expect(out).toMatch(/tasks\s+1\s+0\s+1\s+0/);
  });

  it('says so plainly when there is nothing to import', async () => {
    expect(await runMigrate(ctx, false)).toContain(
      'no .dispatch tasks, findings, or ledger to move'
    );
    expect(existsSync(dispatchDbPath(root))).toBe(false);
  });
});
