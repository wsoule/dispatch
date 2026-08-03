import { ActorContext, TaskStore } from '@dispatch/core';
import type { GitReader } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BoardSyncer } from '../../src/sync/boardSyncer.js';
import type { GitRunner } from '../../src/sync/worktree.js';
import { SyncWorktree } from '../../src/sync/worktree.js';
import { initBareRepo, runGitSync } from '../orchestrator/helpers.js';

// Same shape SyncWorktree's own test uses: real `git`, no stubbing, since
// this whole suite is about actual git behaviour (push/pull refspecs,
// staging discipline, rebase).
const run: GitRunner = (cwd, args) => {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
  };
};

// Mirrors index.ts's own makeGitReader — ActorContext needs a single-value
// config reader, not the {status,stdout,stderr} triple GitRunner returns.
function gitReaderFor(dir: string): GitReader {
  return (args) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: dir });
    return result.exitCode === 0 ? result.stdout.toString().trim() : null;
  };
}

const CONFIG_YML =
  'statuses: [backlog, todo, in-progress, in-review, done, cancelled]\nautoCommit: false\n';

/**
 * A bare origin plus two clones with distinct git identities, standing in
 * for two teammates syncing the same board. Reused by every task in this
 * plan that touches the syncer (materialize, watcher wiring, degradation).
 */
function twoClones(): { origin: string; a: string; b: string } {
  const origin = initBareRepo('dispatch-board-origin-');

  // Seed trunk with a real commit (config.yml) before either clone exists —
  // `git worktree add` and `git clone` both need a ref to point at.
  const seed = mkdtempSync(join(tmpdir(), 'dispatch-board-seed-'));
  runGitSync(seed, ['init', '-b', 'main']);
  runGitSync(seed, ['config', 'user.email', 'seed@example.com']);
  runGitSync(seed, ['config', 'user.name', 'Seed']);
  mkdirSync(join(seed, '.dispatch'), { recursive: true });
  writeFileSync(join(seed, '.dispatch', 'config.yml'), CONFIG_YML);
  writeFileSync(join(seed, 'README.md'), '# test repo\n');
  runGitSync(seed, ['add', '-A']);
  runGitSync(seed, ['commit', '-m', 'initial commit']);
  runGitSync(seed, ['remote', 'add', 'origin', origin]);
  runGitSync(seed, ['push', 'origin', 'main']);
  rmSync(seed, { recursive: true, force: true });

  const cloneOf = (name: string): string => {
    const parent = mkdtempSync(join(tmpdir(), `dispatch-board-${name}-`));
    const dir = join(parent, 'repo');
    runGitSync(parent, ['clone', origin, dir]);
    runGitSync(dir, ['config', 'user.email', `${name}@example.com`]);
    runGitSync(dir, ['config', 'user.name', name]);
    TaskStore.init(dir);
    return dir;
  };

  return { origin, a: cloneOf('alice'), b: cloneOf('bob') };
}

function cleanupClone(dir: string): void {
  rmSync(join(dir, '..'), { recursive: true, force: true });
}

// Cached per clone dir: a real BoardSyncer is long-lived in production (one
// per daemon boot), and ActorContext.resolve() writes team.yml on first call
// — re-resolving on every syncOnce() would make that write land mid-test,
// which is exactly the kind of side effect the "untouched" test below must
// catch happening at the wrong time rather than hide by accident.
const syncers = new Map<string, BoardSyncer>();

function syncerFor(dir: string): BoardSyncer {
  const cached = syncers.get(dir);
  if (cached !== undefined) return cached;
  const worktree = SyncWorktree.open(dir, run);
  if (worktree === null) throw new Error('expected a resolvable trunk');
  const actor = ActorContext.resolve(dir, gitReaderFor(dir));
  const syncer = new BoardSyncer(dir, worktree, actor, run);
  syncers.set(dir, syncer);
  return syncer;
}

let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  syncers.clear();
});

describe('BoardSyncer.syncOnce', () => {
  it('mirrors an edit from clone A into clone B’s sync worktree', async () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    const doc = storeA.create({ title: 'Write the launch email' });

    const resultA = await syncerFor(a).syncOnce();
    expect(resultA.state).toBe('idle');
    expect(resultA.pushed).toBe(1);
    expect(resultA.detail).toBeNull();

    const resultB = await syncerFor(b).syncOnce();
    expect(resultB.state).toBe('idle');

    const worktreeB = SyncWorktree.open(b, run);
    const seenByB = new TaskStore(worktreeB?.path ?? '').get(doc.meta.id);
    expect(seenByB?.meta.title).toBe('Write the launch email');

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });

  it('does not push a task file whose updated moved backwards', async () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    const doc = storeA.create(
      { title: 'Original' },
      '2026-08-01T00:00:00.000Z'
    );
    await syncerFor(a).syncOnce();

    storeA.update(doc.meta.id, { title: 'Newer' }, '2026-08-02T00:00:00.000Z');
    await syncerFor(a).syncOnce();

    const worktreeA = SyncWorktree.open(a, run);
    const beforeHead = runGitSync(worktreeA?.path ?? '', [
      'rev-parse',
      'HEAD',
    ]).trim();

    // Simulate a stale branch checkout: rewrite the working-tree copy with an
    // OLDER `updated` than what the sync worktree already accounted for.
    storeA.update(doc.meta.id, { title: 'Stale' }, '2026-08-01T12:00:00.000Z');
    const result = await syncerFor(a).syncOnce();

    expect(result.pushed).toBe(0);
    const afterHead = runGitSync(worktreeA?.path ?? '', [
      'rev-parse',
      'HEAD',
    ]).trim();
    expect(afterHead).toBe(beforeHead);

    const worktreeCopy = new TaskStore(worktreeA?.path ?? '').get(doc.meta.id);
    expect(worktreeCopy?.meta.title).toBe('Newer');
    expect(worktreeCopy?.meta.updated).toBe('2026-08-02T00:00:00.000Z');

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });

  it('converges concurrent edits to different tasks with no conflict', async () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    const storeB = new TaskStore(b);
    const taskX = storeA.create({ title: 'Task X' });

    // Both clones must know about task X before they can diverge on
    // different tasks: sync it from A to B's sync worktree first, the same
    // way materialize() (Task 4) would eventually land it in B's tree — for
    // now seed B's own copy directly so B's edit to Y is independent of X.
    await syncerFor(a).syncOnce();
    await syncerFor(b).syncOnce();
    const taskY = storeB.create({ title: 'Task Y' });

    storeA.update(taskX.meta.id, { title: 'Task X edited by A' });
    const resultA = await syncerFor(a).syncOnce();
    expect(resultA.state).toBe('idle');

    const resultB = await syncerFor(b).syncOnce();
    expect(resultB.state).toBe('idle');

    const resultA2 = await syncerFor(a).syncOnce();
    expect(resultA2.state).toBe('idle');

    const worktreeA = SyncWorktree.open(a, run);
    const worktreeB = SyncWorktree.open(b, run);
    const xInA = new TaskStore(worktreeA?.path ?? '').get(taskX.meta.id);
    const yInA = new TaskStore(worktreeA?.path ?? '').get(taskY.meta.id);
    const xInB = new TaskStore(worktreeB?.path ?? '').get(taskX.meta.id);
    const yInB = new TaskStore(worktreeB?.path ?? '').get(taskY.meta.id);

    expect(xInA?.meta.title).toBe('Task X edited by A');
    expect(yInA?.meta.title).toBe('Task Y');
    expect(xInB?.meta.title).toBe('Task X edited by A');
    expect(yInB?.meta.title).toBe('Task Y');

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });

  it('commits only paths under .dispatch/', async () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    storeA.create({ title: 'Only dispatch paths' });

    await syncerFor(a).syncOnce();

    const worktreeA = SyncWorktree.open(a, run);
    const stat = runGitSync(worktreeA?.path ?? '', [
      'show',
      '--stat',
      '--format=',
      'HEAD',
    ]);
    // `--stat`'s per-file lines contain '|'; the trailing "N files changed"
    // summary line does not, so filtering on it excludes just that line.
    const paths = stat
      .split('\n')
      .filter((line) => line.includes('|'))
      .map((line) => line.split('|')[0]?.trim())
      .filter((p): p is string => Boolean(p));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith('.dispatch/')).toBe(true);
    }

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });

  it('never touches the user’s working tree, HEAD, or index', async () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    storeA.create({ title: 'Safety property' });

    // Unrelated uncommitted work sitting in the clone, the way a real
    // developer's working tree would have mid-task.
    writeFileSync(join(a, 'scratch.txt'), 'not part of the board\n');
    runGitSync(a, ['add', 'scratch.txt']);
    writeFileSync(join(a, 'untouched.txt'), 'also not part of the board\n');

    // Warm up the syncer (resolving ActorContext writes .dispatch/team.yml
    // on first use) before the snapshot window, so that one-time setup isn't
    // mistaken for something syncOnce() itself touched.
    const syncer = syncerFor(a);

    const headBefore = runGitSync(a, ['rev-parse', 'HEAD']).trim();
    const statusBefore = runGitSync(a, ['status', '--porcelain']);

    await syncer.syncOnce();

    const headAfter = runGitSync(a, ['rev-parse', 'HEAD']).trim();
    const statusAfter = runGitSync(a, ['status', '--porcelain']);

    expect(headAfter).toBe(headBefore);
    expect(statusAfter).toBe(statusBefore);
    expect(statusAfter).toContain('scratch.txt');
    expect(statusAfter).toContain('untouched.txt');

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });
});
