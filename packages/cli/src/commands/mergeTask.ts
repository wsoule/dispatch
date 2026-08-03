import { mergeTaskFile } from '@dispatch/core';
import type { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';

import { type CliContext, CliError } from '../context.js';

// Git merge driver for `.dispatch/tasks/*.md`, invoked by git as
// `dispatch merge-task %O %A %B` (base, ours, theirs — each a path to a temp
// file). Per the git merge-driver contract, the result MUST be written over
// the `%A` (ours) path — git reads the outcome from there — and the exit code
// tells git whether the merge is clean (0) or needs the user's attention
// (non-zero), in which case the conflict-marked text is left in place.
export function registerMergeTaskCommand(
  program: Command,
  ctx: CliContext
): void {
  program
    .command('merge-task')
    .description(
      'Git merge driver for .dispatch/tasks/*.md — not for direct use, see: dispatch init'
    )
    .argument('<base>', 'path to the common ancestor version (%O)')
    .argument('<ours>', 'path to our version; overwritten with the result (%A)')
    .argument('<theirs>', 'path to their version (%B)')
    .action((basePath: string, oursPath: string, theirsPath: string) => {
      const base = readFileSync(basePath, 'utf8');
      const ours = readFileSync(oursPath, 'utf8');
      const theirs = readFileSync(theirsPath, 'utf8');
      const result = mergeTaskFile(base, ours, theirs);
      writeFileSync(oursPath, result.merged);
      if (!result.ok) {
        throw new CliError(`conflict merging ${oursPath} — resolve manually`);
      }
      ctx.log(`merged ${oursPath}`);
    });
}
