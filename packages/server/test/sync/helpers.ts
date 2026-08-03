import { ActorContext, TaskStore, writeGitAttributes } from '@dispatch/core';
import type { GitReader } from '@dispatch/core';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { BoardSyncer } from '../../src/sync/boardSyncer.js';
import type { GitRunner } from '../../src/sync/worktree.js';
import { SyncWorktree } from '../../src/sync/worktree.js';
import { initBareRepo, runGitSync } from '../orchestrator/helpers.js';

// Real `git`, no stubbing — this harness is entirely about actual git
// behaviour (push/pull refspecs, staging discipline, rebase). Mirrors
// worktree.ts's own defaultGitRunner exactly, including the credential-
// prompt lockout and timeout, so a test exercising this harness sees the
// same "never hangs the daemon" behaviour production gets.
export const run: GitRunner = (cwd, args) => {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10',
    },
    timeout: 30_000,
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
  };
};

// Mirrors index.ts's own makeGitReader — ActorContext needs a single-value
// config reader, not GitRunner's {status,stdout,stderr} triple.
export function gitReaderFor(dir: string): GitReader {
  return (args) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: dir });
    return result.exitCode === 0 ? result.stdout.toString().trim() : null;
  };
}

const CONFIG_YML =
  'statuses: [backlog, todo, in-progress, in-review, done, cancelled]\nautoCommit: false\n';

// registerMergeDriverGitConfig() (core's own helper) hardcodes the driver
// command as `dispatch merge-task %O %A %B`, resolved via PATH at merge
// time — on a machine that already has a `dispatch` binary installed
// elsewhere (e.g. the desktop app), that would silently run the WRONG
// build during a test. Point the driver straight at this repo's own CLI
// source instead, the same way merge-team-git-e2e.test.ts does for
// `dispatch merge-team`, so the driver under test is always this checkout's.
const MERGE_TASK_CLI = resolve(import.meta.dirname, '../../../cli/src/cli.ts');

function registerTaskMergeDriverForTest(dir: string): void {
  runGitSync(dir, [
    'config',
    'merge.dispatch-task.name',
    'Dispatch task file merge',
  ]);
  runGitSync(dir, [
    'config',
    'merge.dispatch-task.driver',
    `bun ${MERGE_TASK_CLI} merge-task %O %A %B`,
  ]);
}

/**
 * A bare origin plus two clones with distinct git identities, standing in
 * for two teammates syncing the same board. Reused by every task in this
 * plan that touches the syncer (materialize, watcher wiring, degradation).
 */
export function twoClones(): { origin: string; a: string; b: string } {
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
  // Committed so every clone (and their private sync worktrees, which check
  // out this same trunk commit) route .dispatch/tasks/*.md through the
  // merge driver during a real rebase — matching a real `dispatch init`.
  writeGitAttributes(seed);
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
    // Local config, not part of the commit — every clone (and its sync
    // worktree, which shares this clone's .git/config) needs its own copy,
    // exactly like a real `dispatch init` run per machine.
    registerTaskMergeDriverForTest(dir);
    TaskStore.init(dir);
    return dir;
  };

  return { origin, a: cloneOf('alice'), b: cloneOf('bob') };
}

export function cleanupClone(dir: string): void {
  rmSync(join(dir, '..'), { recursive: true, force: true });
}

// Cached per clone dir: a real BoardSyncer is long-lived in production (one
// per daemon boot). Re-resolving ActorContext on every call would write
// .dispatch/team.yml on every syncOnce() instead of once.
const syncers = new Map<string, BoardSyncer>();

export function syncerFor(dir: string): BoardSyncer {
  const cached = syncers.get(dir);
  if (cached !== undefined) return cached;
  const worktree = SyncWorktree.open(dir, run);
  if (worktree === null) throw new Error('expected a resolvable trunk');
  const actor = ActorContext.resolve(dir, gitReaderFor(dir));
  const syncer = new BoardSyncer(dir, worktree, actor, run);
  syncers.set(dir, syncer);
  return syncer;
}

// Drops every cached syncerFor() entry — call from afterEach so a stale
// BoardSyncer from one test never leaks into the next.
export function resetSyncers(): void {
  syncers.clear();
}
