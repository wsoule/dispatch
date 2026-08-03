import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

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

  it('materializes a teammate’s change into the working tree, not just the sync worktree', async () => {
    const { origin, a, b } = twoClones();
    const storeB = new TaskStore(b);
    const doc = storeB.create({ title: 'From bob' });
    await syncerFor(b).syncOnce();

    const resultA = await syncerFor(a).syncOnce();
    expect(resultA.state).toBe('idle');
    expect(resultA.pulled).toBe(1);

    const seenByA = new TaskStore(a).get(doc.meta.id);
    expect(seenByA?.meta.title).toBe('From bob');

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });

  it('does not clobber a locally-newer file with an older incoming one, and pushes it on the next sync', async () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    const storeB = new TaskStore(b);
    const doc = storeA.create(
      { title: 'Original' },
      '2026-08-01T00:00:00.000Z'
    );
    await syncerFor(a).syncOnce();
    await syncerFor(b).syncOnce();

    // Bob's edit lands on trunk, with an `updated` that will sit BETWEEN
    // A's own sync worktree's last-known version and the local edit A is
    // about to make — the exact ordering the gate must respect.
    storeB.update(
      doc.meta.id,
      { title: 'From bob' },
      '2026-08-02T00:00:00.000Z'
    );
    await syncerFor(b).syncOnce();

    // Pull bob's commit into A's OWN sync worktree directly (bypassing
    // syncOnce): A hasn't made any local edit yet, so this is a clean
    // fast-forward, not a rebase — no git-level conflict to reason about.
    // This isolates the materialize() gate itself from git's merge
    // mechanics, which are not this task's concern.
    const worktreeA = SyncWorktree.open(a, run);
    if (worktreeA === null) throw new Error('expected a resolvable trunk');
    runGitSync(worktreeA.path, [
      'pull',
      '--rebase',
      'origin',
      worktreeA.trunkRef(),
    ]);
    expect(new TaskStore(worktreeA.path).get(doc.meta.id)?.meta.title).toBe(
      'From bob'
    );

    // Alice edits locally, without syncing yet — this is the unsynced edit
    // that must survive the next materialize() call.
    storeA.update(
      doc.meta.id,
      { title: 'Newer from alice' },
      '2026-08-03T00:00:00.000Z'
    );

    const written = syncerFor(a).materialize();
    expect(written).toBe(0);
    const localCopy = storeA.get(doc.meta.id);
    expect(localCopy?.meta.title).toBe('Newer from alice');

    // The next full sync pushes it: A's worktree is already caught up to
    // bob's commit, so staging A's edit on top is a clean fast-forward.
    const result = await syncerFor(a).syncOnce();
    expect(result.pushed).toBe(1);

    const resultB = await syncerFor(b).syncOnce();
    expect(resultB.pulled).toBe(1);
    const seenByB = storeB.get(doc.meta.id);
    expect(seenByB?.meta.title).toBe('Newer from alice');

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });

  it('removes a task locally after a teammate deletes it', async () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    const doc = storeA.create({ title: 'Will be deleted' });
    await syncerFor(a).syncOnce();
    await syncerFor(b).syncOnce();
    expect(new TaskStore(b).get(doc.meta.id)).not.toBeNull();

    // Task 3's push side never propagates a local deletion (it only ever
    // adds outstanding files), so there is no BoardSyncer-driven way yet to
    // get a removal onto trunk. Simulate one landing there directly, in
    // bob's own sync worktree — the same paths a real deletion would touch.
    const worktreeB = SyncWorktree.open(b, run);
    if (worktreeB === null) throw new Error('expected a resolvable trunk');
    const fileInWorktree = new TaskStore(worktreeB.path).taskFilePath(
      doc.meta.id
    );
    expect(fileInWorktree).not.toBeNull();
    const relPath = join(
      '.dispatch',
      'tasks',
      basename(fileInWorktree as string)
    );
    runGitSync(worktreeB.path, ['rm', relPath]);
    runGitSync(worktreeB.path, ['commit', '-m', 'remove task']);
    runGitSync(worktreeB.path, [
      'push',
      'origin',
      `HEAD:${worktreeB.trunkRef()}`,
    ]);

    const result = await syncerFor(a).syncOnce();
    expect(result.pulled).toBe(1);
    expect(storeA.get(doc.meta.id)).toBeNull();

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });

  it('materializes into .dispatch/ even while the clone sits on a feature branch', async () => {
    const { origin, a, b } = twoClones();
    const storeB = new TaskStore(b);
    const doc = storeB.create({ title: 'From bob on trunk' });
    await syncerFor(b).syncOnce();

    // Switching branches must not stop the board write: syncOnce()'s pull
    // fetches straight from origin inside the private sync worktree, and
    // materialize() writes to the working tree by plain filesystem path,
    // unaffected by whatever ref the user's own checkout is on.
    runGitSync(a, ['checkout', '-b', 'some-feature']);

    const result = await syncerFor(a).syncOnce();
    expect(result.pulled).toBe(1);

    const seenByA = new TaskStore(a).get(doc.meta.id);
    expect(seenByA?.meta.title).toBe('From bob on trunk');
    expect(runGitSync(a, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      'some-feature'
    );
    expect(existsSync(join(a, '.dispatch', 'tasks'))).toBe(true);

    // A direct, already-materialized call is idempotent: nothing new to write.
    expect(syncerFor(a).materialize()).toBe(0);

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });
});
