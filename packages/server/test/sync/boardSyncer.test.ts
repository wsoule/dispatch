import { ActorContext, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { BoardSyncer } from '../../src/sync/boardSyncer.js';
import { defaultGitRunner, SyncWorktree } from '../../src/sync/worktree.js';
import { runGitSync } from '../orchestrator/helpers.js';
import {
  cleanupClone,
  gitReaderFor,
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

// Deterministic push rejection, independent of filesystem permissions (which
// behave differently across platforms and under a root test runner): a
// pre-receive hook that always rejects the push, the way a protected trunk
// or missing write access would.
function installRejectingHook(bareRepo: string): void {
  const hooksDir = join(bareRepo, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'pre-receive');
  writeFileSync(hookPath, '#!/bin/sh\nexit 1\n');
  chmodSync(hookPath, 0o755);
}

function removeRejectingHook(bareRepo: string): void {
  rmSync(join(bareRepo, 'hooks', 'pre-receive'), { force: true });
}

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
    const beforeSha = runGitSync(worktreeA.path, ['rev-parse', 'HEAD']).trim();
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

    // materialize() no longer remembers a "last materialized" boundary on
    // its own (that in-memory state was itself a resurrection bug across a
    // daemon restart) — the caller supplies the range explicitly, here the
    // worktree's HEAD from just before the manual pull above.
    const written = syncerFor(a).materialize(beforeSha);
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

    // A bare call (no `before` supplied) is always a no-op — there is no
    // persisted "last materialized" pointer to fall back on.
    expect(syncerFor(a).materialize()).toBe(0);

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });

  it('a task deleted locally stays deleted across repeated syncs', async () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    const doc = storeA.create({ title: 'Local only, then deleted' });
    await syncerFor(a).syncOnce();

    // The push side never issues a `git rm` for a file that vanished
    // locally (a known, separate gap) — so this deletion never reaches the
    // sync worktree. A directory-scan materialize() can't tell "never seen"
    // apart from "deleted on purpose" and resurrects it; a diff-driven one
    // simply never revisits a path the pull didn't touch.
    const localFile = storeA.taskFilePath(doc.meta.id);
    expect(localFile).not.toBeNull();
    rmSync(localFile as string);
    expect(storeA.get(doc.meta.id)).toBeNull();

    await syncerFor(a).syncOnce();
    expect(storeA.get(doc.meta.id)).toBeNull();

    await syncerFor(a).syncOnce();
    expect(storeA.get(doc.meta.id)).toBeNull();

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });

  it('a task deleted locally stays deleted across a daemon restart', async () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    const doc = storeA.create({
      title: 'Local only, then deleted, then restarted',
    });
    await syncerFor(a).syncOnce();

    const localFile = storeA.taskFilePath(doc.meta.id);
    expect(localFile).not.toBeNull();
    rmSync(localFile as string);
    expect(storeA.get(doc.meta.id)).toBeNull();

    await syncerFor(a).syncOnce();
    expect(storeA.get(doc.meta.id)).toBeNull();

    // Simulate a daemon restart: drop the cached syncer and construct a
    // brand-new BoardSyncer for the same rootDir. Any in-memory-only
    // "last materialized" bookkeeping is gone with it — the fix must not
    // depend on it surviving.
    resetSyncers();
    await syncerFor(a).syncOnce();
    expect(storeA.get(doc.meta.id)).toBeNull();

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });

  it('a brand-new, never-synced local task survives a real, diff-driven materialize() call', async () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    const storeB = new TaskStore(b);
    const doc = storeA.create({ title: 'Not yet synced' });

    // An unrelated task from bob lands on trunk, so the diff materialize()
    // is about to apply is real and non-empty — this must not be a bare,
    // trivially-a-no-op call (that's covered separately, at the "no
    // persisted pointer" assertion below).
    storeB.create({ title: 'From bob' });
    await syncerFor(b).syncOnce();

    const worktreeA = SyncWorktree.open(a, run);
    if (worktreeA === null) throw new Error('expected a resolvable trunk');
    worktreeA.ensure();
    const beforeSha = runGitSync(worktreeA.path, ['rev-parse', 'HEAD']).trim();
    runGitSync(worktreeA.path, [
      'pull',
      '--rebase',
      'origin',
      worktreeA.trunkRef(),
    ]);

    // materialize() called with no prior syncOnce() on A at all — the
    // staging loop that would normally mirror A's own new task into the
    // worktree first never ran. A diff-driven materialize() has no opinion
    // about a task the sync worktree has never mentioned, so even given a
    // real, non-empty range it must not touch it.
    const written = syncerFor(a).materialize(beforeSha);
    expect(written).toBe(1);
    expect(storeA.get(doc.meta.id)?.meta.title).toBe('Not yet synced');

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });

  it('a bare materialize() call with no `before` is always a no-op', () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    const doc = storeA.create({ title: 'Not yet synced' });

    // No persisted "last materialized" pointer exists (round 2 removed it),
    // so a call with nothing to diff from must not guess — it must do
    // nothing rather than fall back to some default range.
    const written = syncerFor(a).materialize();
    expect(written).toBe(0);
    expect(storeA.get(doc.meta.id)?.meta.title).toBe('Not yet synced');

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });
});

describe('BoardSyncer degradation', () => {
  it('a push rejected by the remote is local-only, keeps the commit, and recovers once unblocked', async () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    const doc = storeA.create({ title: 'Blocked by a protected trunk' });

    installRejectingHook(origin);
    const result = await syncerFor(a).syncOnce();

    expect(result.state).toBe('local-only');
    expect(result.pushed).toBe(0);
    expect(result.detail).not.toBeNull();

    // The commit is not lost — it sits in the private sync worktree waiting
    // for the next successful push, not discarded or retried destructively.
    const worktreeA = SyncWorktree.open(a, run);
    if (worktreeA === null) throw new Error('expected a resolvable trunk');
    const log = runGitSync(worktreeA.path, ['log', '--oneline']);
    expect(log).toContain('sync 1 task');

    // Repair: the hook goes away, exactly as a protected-branch rule being
    // lifted or write access being restored would look from the syncer's
    // side. No other state changes — recovery must be automatic.
    removeRejectingHook(origin);
    const recovered = await syncerFor(a).syncOnce();
    expect(recovered.state).toBe('idle');
    expect(recovered.detail).toBeNull();

    const resultB = await syncerFor(b).syncOnce();
    expect(resultB.state).toBe('idle');
    expect(new TaskStore(b).get(doc.meta.id)?.meta.title).toBe(
      'Blocked by a protected trunk'
    );

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });

  it('an unreachable origin during pull is local-only (not blocked), and recovers once reachable', async () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    const doc = storeA.create({ title: 'Queued while offline' });

    const badUrl = join(mkdtempSync(join(tmpdir(), 'dispatch-gone-')), 'nope');
    runGitSync(a, ['remote', 'set-url', 'origin', badUrl]);

    const result = await syncerFor(a).syncOnce();
    expect(result.state).toBe('local-only');
    expect(result.pushed).toBe(0);
    expect(result.detail).not.toBeNull();

    const worktreeA = SyncWorktree.open(a, run);
    if (worktreeA === null) throw new Error('expected a resolvable trunk');
    const log = runGitSync(worktreeA.path, ['log', '--oneline']);
    expect(log).toContain('sync 1 task');

    // Repair: the network/remote comes back — pointing origin at the real
    // bare repo again.
    runGitSync(a, ['remote', 'set-url', 'origin', origin]);
    const recovered = await syncerFor(a).syncOnce();
    expect(recovered.state).toBe('idle');

    await syncerFor(b).syncOnce();
    expect(new TaskStore(b).get(doc.meta.id)?.meta.title).toBe(
      'Queued while offline'
    );

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });

  // Explicit timeout: a real conflict still routes through the merge driver
  // first (git tries it before falling back to conflict markers), and that
  // driver spawns a `bun cli.ts merge-task` subprocess — bun's 5000ms default
  // is occasionally too tight for that spawn, which made this test flaky.
  it('a genuine rebase conflict is blocked, surfaces the conflicting path, leaves the worktree usable, and self-heals on the next sync', async () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    const storeB = new TaskStore(b);
    const doc = storeA.create(
      { title: 'Original title' },
      '2026-08-01T00:00:00.000Z'
    );
    await syncerFor(a).syncOnce();
    await syncerFor(b).syncOnce();

    // Bob edits and pushes the very same field first.
    storeB.update(
      doc.meta.id,
      { title: 'Title from bob' },
      '2026-08-02T00:00:00.000Z'
    );
    const resultB = await syncerFor(b).syncOnce();
    expect(resultB.state).toBe('idle');

    // Alice edits the same field independently, unaware of bob's push — a
    // real one-line collision, not something git can silently merge.
    storeA.update(
      doc.meta.id,
      { title: 'Title from alice' },
      '2026-08-03T00:00:00.000Z'
    );
    const result = await syncerFor(a).syncOnce();

    expect(result.state).toBe('blocked');
    expect(result.detail).not.toBeNull();
    expect(result.detail).toContain(doc.meta.id);

    const worktreeA = SyncWorktree.open(a, run);
    if (worktreeA === null) throw new Error('expected a resolvable trunk');
    // Not left mid-rebase: status is clean and REBASE_HEAD no longer exists.
    const status = runGitSync(worktreeA.path, ['status', '--porcelain']);
    expect(status.trim()).toBe('');
    const rebaseHead = run(worktreeA.path, [
      'rev-parse',
      '--verify',
      '--quiet',
      'REBASE_HEAD',
    ]);
    expect(rebaseHead.status).not.toBe(0);

    // Alice's own working tree is untouched — the board keeps serving the
    // last good state, and her edit was never lost.
    expect(storeA.get(doc.meta.id)?.meta.title).toBe('Title from alice');

    // Recovery: nothing manual, just sync again — the same last-write-wins
    // rule the push side already applies (isOutstanding) re-derives a fresh
    // commit straight from Alice's current file, on top of trunk.
    const recovered = await syncerFor(a).syncOnce();
    expect(recovered.state).toBe('idle');
    expect(recovered.pushed).toBe(1);

    await syncerFor(b).syncOnce();
    expect(new TaskStore(b).get(doc.meta.id)?.meta.title).toBe(
      'Title from alice'
    );

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  }, 20_000);

  // Same reason as above: this also drives a real conflicting rebase, so it
  // pays the merge driver's subprocess cost.
  it('a conflict on one task does not withhold a teammate’s unrelated task from the working tree', async () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    const storeB = new TaskStore(b);
    const taskX = storeA.create(
      { title: 'X original' },
      '2026-08-01T00:00:00.000Z'
    );
    await syncerFor(a).syncOnce();
    await syncerFor(b).syncOnce();

    // Bob touches two things: X (the same field Alice is about to collide
    // on) and Y, a brand-new task Alice has never seen — a bystander with
    // nothing to do with the conflict.
    storeB.update(
      taskX.meta.id,
      { title: 'X from bob' },
      '2026-08-02T00:00:00.000Z'
    );
    const taskY = storeB.create(
      { title: 'Y from bob' },
      '2026-08-02T00:00:00.000Z'
    );
    const resultB = await syncerFor(b).syncOnce();
    expect(resultB.state).toBe('idle');

    // Alice edits only X, independently — a real same-field collision.
    storeA.update(
      taskX.meta.id,
      { title: 'X from alice' },
      '2026-08-03T00:00:00.000Z'
    );
    const result = await syncerFor(a).syncOnce();

    expect(result.state).toBe('blocked');
    // Y was never in conflict — it must still reach Alice's working tree in
    // this same blocked cycle, not be withheld until some future sync that
    // (per the reset-to-trunk recovery) will never diff over it again.
    expect(result.pulled).toBe(1);
    expect(storeA.get(taskY.meta.id)?.meta.title).toBe('Y from bob');
    // Alice's own conflicting edit to X is untouched — the board keeps
    // serving the last good state for the file that actually collided.
    expect(storeA.get(taskX.meta.id)?.meta.title).toBe('X from alice');

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  }, 20_000);

  // Regression for the data-loss bug: beforePull included this cycle's own
  // staged commit, so after the post-conflict `reset --hard origin/<trunk>`,
  // materialize()'s D-filter diff saw the syncer's own brand-new task as
  // "deleted" (relative to trunk, which never had it) and rmSync'd it from
  // the working tree — with no push, no reflog entry, and no way back.
  it('a brand-new unpushed task survives a conflict on a different task', async () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    const storeB = new TaskStore(b);
    const taskU = storeA.create(
      { title: 'U original' },
      '2026-08-01T00:00:00.000Z'
    );
    await syncerFor(a).syncOnce();
    await syncerFor(b).syncOnce();

    // Bob pushes an edit to U first.
    storeB.update(
      taskU.meta.id,
      { title: 'U from bob' },
      '2026-08-02T00:00:00.000Z'
    );
    const resultB = await syncerFor(b).syncOnce();
    expect(resultB.state).toBe('idle');

    // In the same debounce burst, Alice creates a brand-new task T and edits
    // U (the same field bob just changed) — both get staged into one commit.
    const taskT = storeA.create(
      { title: 'Brand new from alice' },
      '2026-08-03T00:00:00.000Z'
    );
    storeA.update(
      taskU.meta.id,
      { title: 'U from alice' },
      '2026-08-03T00:00:00.000Z'
    );
    const result = await syncerFor(a).syncOnce();

    expect(result.state).toBe('blocked');

    // T was never pushed anywhere — it must still exist locally.
    expect(storeA.get(taskT.meta.id)?.meta.title).toBe('Brand new from alice');
    const fileT = storeA.taskFilePath(taskT.meta.id);
    expect(fileT).not.toBeNull();
    expect(existsSync(fileT as string)).toBe(true);

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  }, 20_000);

  it('a remote requiring a credential prompt fails fast instead of hanging the daemon', async () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    storeA.create({ title: 'Should not hang the daemon' });

    // A stub HTTP server that looks like a git-http-backend demanding
    // credentials: without GIT_TERMINAL_PROMPT=0, `git fetch` against this
    // sits on "Username for ...:" indefinitely (git pty prompt) — since
    // syncOnce() is fully synchronous, that freezes the daemon's entire
    // event loop, not just this one sync. Run as its own OS process, not an
    // in-process Bun.serve(): syncOnce()'s git call is itself a synchronous
    // spawnSync on THIS test's thread, so an in-process server would never
    // get to run its own event loop to answer the request while blocked —
    // it would just look like an even longer hang, for the wrong reason.
    const serverScript = `
      const server = Bun.serve({
        port: 0,
        fetch() {
          return new Response('auth required', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="git"' },
          });
        },
      });
      console.log(server.port);
    `;
    const serverProc = Bun.spawn(['bun', '-e', serverScript], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const reader = serverProc.stdout.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      const port = new TextDecoder().decode(value).trim();

      runGitSync(a, [
        'remote',
        'set-url',
        'origin',
        `http://127.0.0.1:${port}/repo.git`,
      ]);

      // The real production GitRunner, not the test harness's mirror of it
      // — this proves worktree.ts's own defaultGitRunner is hardened, not
      // just its test-only copy.
      const worktree = SyncWorktree.open(a, defaultGitRunner);
      if (worktree === null) throw new Error('expected a resolvable trunk');
      const actor = ActorContext.resolve(a, gitReaderFor(a));
      const syncer = new BoardSyncer(a, worktree, actor, defaultGitRunner);

      const startedAt = Date.now();
      const result = await syncer.syncOnce();
      const elapsedMs = Date.now() - startedAt;

      expect(result.state).toBe('local-only');
      // Comfortably below both the 30s spawnSync backstop and where an
      // unprotected hang would sit forever — proves GIT_TERMINAL_PROMPT
      // actually fired, not that the backstop eventually rescued it.
      expect(elapsedMs).toBeLessThan(10_000);
    } finally {
      serverProc.kill();
      rmSync(origin, { recursive: true, force: true });
      cleanupClone(a);
      cleanupClone(b);
    }
  });
});

describe('BoardSyncer with the real merge driver', () => {
  // Explicit timeout: even a clean 3-way merge spawns the same
  // `bun cli.ts merge-task` subprocess as the conflict tests above.
  it('two teammates editing different fields on the same task merge cleanly and stay idle', async () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    const storeB = new TaskStore(b);
    const doc = storeA.create(
      { title: 'Shared task', status: 'todo' },
      '2026-08-01T00:00:00.000Z'
    );
    await syncerFor(a).syncOnce();
    await syncerFor(b).syncOnce();

    // Bob changes status; Alice changes title — different fields in the
    // same file, which the field-aware merge driver (registered by
    // twoClones()'s cloneOf(), same as a real `dispatch init`) reconciles
    // without either side losing anything.
    storeB.update(
      doc.meta.id,
      { status: 'in-progress' },
      '2026-08-02T00:00:00.000Z'
    );
    const resultB = await syncerFor(b).syncOnce();
    expect(resultB.state).toBe('idle');

    storeA.update(
      doc.meta.id,
      { title: 'Retitled by alice' },
      '2026-08-03T00:00:00.000Z'
    );
    const result = await syncerFor(a).syncOnce();

    // A clean 3-way field merge, not a conflict: this never enters the
    // REBASE_HEAD-detected branch at all.
    expect(result.state).toBe('idle');
    expect(result.detail).toBeNull();

    const resultB2 = await syncerFor(b).syncOnce();
    expect(resultB2.state).toBe('idle');
    const seenByB = storeB.get(doc.meta.id);
    expect(seenByB?.meta.title).toBe('Retitled by alice');
    expect(seenByB?.meta.status).toBe('in-progress');

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  }, 20_000);
});

describe('BoardSyncer.pendingCounts', () => {
  it('reports nothing pending right after a clean sync', async () => {
    const { origin, a, b } = twoClones();
    new TaskStore(a).create({ title: 'Synced' });
    await syncerFor(a).syncOnce();

    expect(syncerFor(a).pendingCounts()).toEqual({ outgoing: 0, incoming: 0 });

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });

  it('counts an unsynced local edit as pending outgoing', async () => {
    const { origin, a, b } = twoClones();
    await syncerFor(a).syncOnce();
    new TaskStore(a).create({ title: 'Not yet synced' });

    expect(syncerFor(a).pendingCounts()).toEqual({ outgoing: 1, incoming: 0 });

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });

  it('counts content already fetched into the sync worktree but not yet materialized as pending incoming', async () => {
    const { origin, a, b } = twoClones();
    const storeA = new TaskStore(a);
    await syncerFor(a).syncOnce();

    const doc = new TaskStore(b).create({ title: 'From bob' });
    await syncerFor(b).syncOnce();

    // Advances Alice's own private sync worktree straight via git, bypassing
    // BoardSyncer.syncOnce() (which would also materialize in the same
    // call) — stands in for the sync worktree already holding content a
    // restart-time pendingCounts() call must still be able to see.
    const worktreeA = SyncWorktree.open(a, run);
    if (worktreeA === null) throw new Error('expected a resolvable trunk');
    worktreeA.ensure();
    run(worktreeA.path, ['pull', '--rebase', 'origin', worktreeA.trunkRef()]);

    expect(syncerFor(a).pendingCounts()).toEqual({ outgoing: 0, incoming: 1 });
    // Confirms it really wasn't materialized yet — pendingCounts is read-only.
    expect(storeA.get(doc.meta.id)).toBeNull();

    rmSync(origin, { recursive: true, force: true });
    cleanupClone(a);
    cleanupClone(b);
  });
});
