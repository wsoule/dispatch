import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SyncWorktree } from '../../src/sync/worktree.js';
import { runGitSync } from '../orchestrator/helpers.js';
import {
  cleanupClone,
  resetSyncers,
  run,
  syncerFor,
  twoClones,
} from './helpers.js';

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
  resetSyncers();
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
