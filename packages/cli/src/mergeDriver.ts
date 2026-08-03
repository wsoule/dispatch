import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The .gitattributes line that routes task files through the merge driver.
// Committed to the repo, so every clone gets it — unlike the git config
// below, which is local-only and must be set up again per clone.
export const GITATTRIBUTES_LINE = '.dispatch/tasks/*.md merge=dispatch-task';

// Appends GITATTRIBUTES_LINE to existing .gitattributes content unless it's
// already present, preserving every other line untouched. Pure so the merge
// logic is testable without touching the filesystem — mirrors mergeMcpConfig.
export function mergeGitAttributes(existing: string | undefined): string {
  const lines = existing !== undefined ? existing.split('\n') : [];
  // split('\n') on text ending in a newline leaves a trailing '' entry —
  // drop it so appending doesn't reintroduce a blank line before the tail.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (!lines.includes(GITATTRIBUTES_LINE)) lines.push(GITATTRIBUTES_LINE);
  return `${lines.join('\n')}\n`;
}

// Reads (if present), merges, and writes `<cwd>/.gitattributes` — called
// from `dispatch init`.
export function writeGitAttributes(cwd: string): void {
  const path = join(cwd, '.gitattributes');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  writeFileSync(path, mergeGitAttributes(existing));
}

// Points git at `dispatch merge-task` for task files, in the repo's *local*
// (never committed) git config — called from `dispatch init`. A fresh clone
// gets the committed .gitattributes line but not this, which is exactly what
// `checkMergeDriverSetup` below exists to catch.
export function registerMergeDriverGitConfig(cwd: string): void {
  spawnSync(
    'git',
    ['config', 'merge.dispatch-task.name', 'Dispatch task file merge'],
    { cwd }
  );
  spawnSync(
    'git',
    ['config', 'merge.dispatch-task.driver', 'dispatch merge-task %O %A %B'],
    { cwd }
  );
}

function gitConfigHasDriver(cwd: string): boolean {
  const result = spawnSync(
    'git',
    ['config', '--local', '--get', 'merge.dispatch-task.driver'],
    { cwd, encoding: 'utf8' }
  );
  return result.status === 0;
}

// What `dispatch doctor` needs to know: whether the .gitattributes line and
// the local git config entry are both in place. They can disagree — a fresh
// clone inherits the committed .gitattributes but not the local config —
// and without the driver git falls back to ordinary line-based conflicts.
export function checkMergeDriverSetup(cwd: string): {
  gitattributes: boolean;
  gitConfig: boolean;
} {
  const attrPath = join(cwd, '.gitattributes');
  const attrText = existsSync(attrPath) ? readFileSync(attrPath, 'utf8') : '';
  const gitattributes = attrText
    .split('\n')
    .some((line) => line.trim() === GITATTRIBUTES_LINE);
  return { gitattributes, gitConfig: gitConfigHasDriver(cwd) };
}
