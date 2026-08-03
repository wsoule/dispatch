import { mergeTeamFile } from '@dispatch/core';
import type { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';

import { type CliContext, CliError } from '../context.js';

// Git merge driver for `.dispatch/team.yml`, invoked by git as
// `dispatch merge-team %O %A %B` (base, ours, theirs — each a path to a temp
// file). Same contract as merge-task: the result MUST be written over the
// `%A` (ours) path, and the exit code tells git whether the merge is clean
// (0) or needs the user's attention (non-zero), conflict-marked text left
// in place.
export function registerMergeTeamCommand(
  program: Command,
  ctx: CliContext
): void {
  program
    .command('merge-team')
    .description(
      'Git merge driver for .dispatch/team.yml — not for direct use, see: dispatch init'
    )
    .argument('<base>', 'path to the common ancestor version (%O)')
    .argument('<ours>', 'path to our version; overwritten with the result (%A)')
    .argument('<theirs>', 'path to their version (%B)')
    .action((basePath: string, oursPath: string, theirsPath: string) => {
      const base = readFileSync(basePath, 'utf8');
      const ours = readFileSync(oursPath, 'utf8');
      const theirs = readFileSync(theirsPath, 'utf8');
      const result = mergeTeamFile(base, ours, theirs);
      writeFileSync(oursPath, result.merged);
      if (!result.ok) {
        throw new CliError(`conflict merging ${oursPath} — resolve manually`);
      }
      ctx.log(`merged ${oursPath}`);
    });
}
