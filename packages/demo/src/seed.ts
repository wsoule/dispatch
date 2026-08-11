import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeBoard } from './board.js';
import { git } from './git.js';
import type { DemoActor } from './paths.js';
import { writeRecords } from './records.js';
import {
  assertNoCredentialsStaged,
  buildRepo,
  ensureRunBranchesExist,
} from './repo.js';
import { clearRunHistory, listSeededBranches, writeRuns } from './runs.js';

export interface SessionPaths {
  dir: string;
  origin: string;
  root: string;
  home: string;
  teammateRoot: string;
}

/** The anonymous web visitor's identity — on the roster, owns the seeded run history. */
export const VISITOR: DemoActor = {
  handle: 'demo',
  email: 'demo@example.com',
  displayName: 'You (demo)',
};

export function sessionPaths(dir: string): SessionPaths {
  return {
    dir,
    origin: join(dir, 'origin.git'),
    root: join(dir, 'storefront'),
    home: join(dir, 'home'),
    teammateRoot: join(dir, 'teammate', 'storefront'),
  };
}

/**
 * Seeds one visitor sandbox: bare origin standing in for GitHub, an owner
 * clone (the daemon root) with board/records/run history, and a teammate
 * clone the puppet pushes from. `dir` must be under tmpdir() — the demo
 * package's delete guard enforces it.
 */
export function seedSession(dir: string): SessionPaths {
  const paths = sessionPaths(dir);

  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '--bare', '-b', 'main', paths.origin);

  buildRepo({ root: paths.root, push: true, remote: paths.origin });
  // Non-empty verifySteps shadows verifyCommand in the merge queue and,
  // unlike verifyCommand, is never PATCH-editable — so a visitor can't turn
  // this hermetic step into arbitrary shell (see mergeQueue.ts's verify()).
  writeBoard(paths.root, {
    extraActors: [VISITOR],
    linearEnabled: false,
    cartoEnabled: false,
    verifySteps: [{ name: 'verify', command: 'bun --version' }],
  });
  writeRecords(paths.root);
  git(paths.root, 'add', '-A');
  assertNoCredentialsStaged(paths.root);
  git(paths.root, 'commit', '-qm', 'demo: seed board and records');
  git(paths.root, 'push', '-q', 'origin', 'main');

  mkdirSync(dirname(paths.teammateRoot), { recursive: true });
  git(
    dirname(paths.teammateRoot),
    'clone',
    '-q',
    paths.origin,
    paths.teammateRoot
  );

  clearRunHistory(paths.root, paths.home);
  writeRuns(paths.root, paths.home, VISITOR.handle);
  // A visitor can dispatch any todo task, including one blocked on an
  // in-review task — the orchestrator then bases the new worktree on that
  // blocker's most recent run branch (see ensureRunBranchesExist's doc
  // comment). Only the sandbox needs this: cli.ts's local `writeRuns` calls
  // never reach here, so DEMO.root's real GitHub remote is untouched.
  ensureRunBranchesExist(
    paths.root,
    listSeededBranches(paths.root, paths.home)
  );
  // Pushing alone never creates refs/remotes/origin/*, and the board syncer's
  // first cycle reads refs/remotes/origin/<trunk> to rescue a pulled commit.
  git(paths.root, 'fetch', '-q', 'origin');

  return paths;
}
