import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

import { writeBoard } from './board.js';
import { git } from './git.js';
import { writeMessages } from './messages.js';
import { DEMO, OWNER, TEAMMATE } from './paths.js';
import { writeRecords } from './records.js';
import {
  assertNoCredentialsStaged,
  assertSafeToDelete,
  buildRepo,
} from './repo.js';
import { clearRunHistory, writeRuns } from './runs.js';

type ResetPaths = Record<
  'root' | 'home' | 'teammateRoot' | 'teammateHome' | 'remote',
  string
>;

/**
 * Rebuilds the whole demo from scratch: the storefront repo (pushed to
 * `paths.remote` unless `push` is false), the board and records committed on
 * top of it, seeded run history for both clones, and a fresh teammate clone —
 * of the remote, or with `push: false` of the local repo, so fixtures build
 * offline. Safe to run more than once — buildRepo always deletes and
 * recreates the root, so a board someone moved mid-demo is discarded.
 */
export function resetDemo(opts: {
  push: boolean;
  paths?: ResetPaths;
  log?: (line: string) => void;
}): void {
  const paths = opts.paths ?? DEMO;
  const log = opts.log ?? ((line: string) => console.log(line));
  log(
    opts.push
      ? `demo: building ${paths.root} and pushing to ${paths.remote}`
      : `demo: building ${paths.root} offline (no push)`
  );
  buildRepo({ root: paths.root, push: opts.push, remote: paths.remote });

  log('demo: writing board and records');
  writeBoard(paths.root);
  writeRecords(paths.root);
  git(paths.root, 'add', '-A');
  assertNoCredentialsStaged(paths.root);
  git(paths.root, 'commit', '-qm', 'demo: seed board and records');
  if (opts.push) git(paths.root, 'push', '-q', 'origin', 'main');

  const source = opts.push ? paths.remote : paths.root;
  log(`demo: cloning ${source} into ${paths.teammateRoot}`);
  assertSafeToDelete(paths.teammateRoot);
  rmSync(paths.teammateRoot, { recursive: true, force: true });
  mkdirSync(dirname(paths.teammateRoot), { recursive: true });
  git(dirname(paths.teammateRoot), 'clone', '-q', source, paths.teammateRoot);

  // Clears both DISPATCH_HOMEs' prior run history before reseeding: writeRuns()
  // only overwrites the filenames it knows, so a stray run would survive.
  log('demo: clearing prior run history for both clones');
  clearRunHistory(paths.root, paths.home);
  clearRunHistory(paths.teammateRoot, paths.teammateHome);

  // Both clones must exist first: writeRuns() seeds each run's diff snapshot
  // from git, which needs the BRANCH_FIXES branches already committed.
  log('demo: writing run history for both clones');
  writeRuns(paths.root, paths.home, OWNER.handle);
  // Threads only for the owner's clone: every seeded ask is addressed to them.
  writeMessages(paths.root, paths.home, OWNER.handle);
  writeRuns(paths.teammateRoot, paths.teammateHome, TEAMMATE.handle);

  log('demo: reset complete');
}
