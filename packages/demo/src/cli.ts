#!/usr/bin/env bun
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

import { writeBoard } from './board.js';
import { git } from './git.js';
import { DEMO, OWNER, TEAMMATE } from './paths.js';
import { runPreflight } from './preflight.js';
import { writeRecords } from './records.js';
import {
  assertNoCredentialsStaged,
  assertSafeToDelete,
  buildRepo,
} from './repo.js';
import { clearRunHistory, writeRuns } from './runs.js';
import { addTask, claim, conflict } from './teammate.js';

function usage(): void {
  console.error(
    [
      'usage: demo <command>',
      '',
      '  reset                              rebuild the demo repo, board, and runs from scratch',
      '  preflight                          check the demo will actually work',
      '  teammate claim <taskId>            claim a task as the teammate',
      '  teammate add-task                  file a new task as the teammate',
      '  teammate conflict <taskId>         move a task to in-progress as the teammate',
    ].join('\n')
  );
}

/**
 * Rebuilds the whole demo from scratch: the storefront repo (pushed to
 * DEMO.remote), the board and records committed on top of it, seeded run
 * history for both clones, and a fresh clone of the remote at
 * DEMO.teammateRoot. Safe to run more than once — buildRepo always deletes
 * and recreates DEMO.root before force-pushing, so a board someone moved
 * mid-demo is simply discarded on the next reset.
 */
function reset(): void {
  console.log(`demo: building ${DEMO.root} and pushing to ${DEMO.remote}`);
  buildRepo({ root: DEMO.root, push: true });

  console.log('demo: writing board and records');
  writeBoard(DEMO.root);
  writeRecords(DEMO.root);
  git(DEMO.root, 'add', '-A');
  assertNoCredentialsStaged(DEMO.root);
  git(DEMO.root, 'commit', '-qm', 'demo: seed board and records');
  git(DEMO.root, 'push', '-q', 'origin', 'main');

  console.log(`demo: cloning ${DEMO.remote} into ${DEMO.teammateRoot}`);
  assertSafeToDelete(DEMO.teammateRoot);
  rmSync(DEMO.teammateRoot, { recursive: true, force: true });
  mkdirSync(dirname(DEMO.teammateRoot), { recursive: true });
  git(
    dirname(DEMO.teammateRoot),
    'clone',
    '-q',
    DEMO.remote,
    DEMO.teammateRoot
  );

  // Clears both DISPATCH_HOMEs' prior run history before reseeding. Without
  // this, writeRuns() only ever overwrites the exact filenames it knows
  // about, so a run killed mid-demo (or any other stray file under the runs
  // dir) would survive every future reset — exactly what leaves the next
  // demo showing a red run the operator already "fixed" with reset.
  console.log('demo: clearing prior run history for both clones');
  clearRunHistory(DEMO.root, DEMO.home);
  clearRunHistory(DEMO.teammateRoot, DEMO.teammateHome);

  // Both clones must already exist on disk before this runs: writeRuns()
  // seeds each run's diff snapshot straight from git (see runs.ts's
  // writeReviewDiffs / repo.ts's computeFixDiff), which needs a real
  // checkout with the BRANCH_FIXES branches already committed — not just a
  // string to hash, which is all the rest of writeRuns() ever needed from
  // `rootDir`.
  console.log('demo: writing run history for both clones');
  writeRuns(DEMO.root, DEMO.home, OWNER.handle);
  writeRuns(DEMO.teammateRoot, DEMO.teammateHome, TEAMMATE.handle);

  console.log('demo: reset complete');
}

function teammateCommand(
  sub: string | undefined,
  arg: string | undefined
): void {
  switch (sub) {
    case 'claim':
      if (arg === undefined) {
        usage();
        process.exitCode = 1;
        return;
      }
      claim(arg);
      return;
    case 'add-task':
      addTask();
      return;
    case 'conflict':
      if (arg === undefined) {
        usage();
        process.exitCode = 1;
        return;
      }
      conflict(arg);
      return;
    default:
      usage();
      process.exitCode = 1;
  }
}

function main(): void {
  const [, , cmd, sub, arg] = process.argv;
  switch (cmd) {
    case 'reset':
      reset();
      return;
    case 'preflight':
      runPreflight();
      return;
    case 'teammate':
      teammateCommand(sub, arg);
      return;
    default:
      usage();
      process.exitCode = 1;
  }
}

if (import.meta.main) {
  main();
}
