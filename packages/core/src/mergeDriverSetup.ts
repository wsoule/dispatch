import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Registers dispatch's merge drivers: the .gitattributes lines that route
// task files and the team roster through them, and the local git config
// that points git at `dispatch merge-task` / `dispatch merge-team`. Lives
// in core so both the CLI's own `dispatch init` and server/bin.ts's
// `--init` path (the desktop app's project-init route) can register it —
// `@dispatch/server` cannot depend on `@dispatch/cli` (bin.ts's `--init`
// path lives in server, and cli already depends on server, so the reverse
// edge would be circular), so a package both sides can reach is required.

// The .gitattributes line that routes task files through the merge driver.
// Committed to the repo, so every clone gets it — unlike the git config
// below, which is local-only and must be set up again per clone.
export const GITATTRIBUTES_LINE = '.dispatch/tasks/*.md merge=dispatch-task';

// Same idea as GITATTRIBUTES_LINE, for the team roster's merge driver.
export const TEAM_GITATTRIBUTES_LINE = '.dispatch/team.yml merge=dispatch-team';

// Appends `line` to existing .gitattributes content unless it's already
// present, preserving every other line untouched. Pure so the merge logic
// is testable without touching the filesystem — mirrors mergeMcpConfig.
export function mergeGitAttributes(
  existing: string | undefined,
  line: string = GITATTRIBUTES_LINE
): string {
  const lines = existing !== undefined ? existing.split('\n') : [];
  // split('\n') on text ending in a newline leaves a trailing '' entry —
  // drop it so appending doesn't reintroduce a blank line before the tail.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (!lines.includes(line)) lines.push(line);
  return `${lines.join('\n')}\n`;
}

// Reads (if present), merges in both driver lines, and writes
// `<cwd>/.gitattributes`. Idempotent — safe to call on every init, not just
// the first.
export function writeGitAttributes(cwd: string): void {
  const path = join(cwd, '.gitattributes');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  const withTask = mergeGitAttributes(existing, GITATTRIBUTES_LINE);
  writeFileSync(path, mergeGitAttributes(withTask, TEAM_GITATTRIBUTES_LINE));
}

// Points git at `dispatch merge-task` for task files, in the repo's *local*
// (never committed) git config. A fresh clone gets the committed
// .gitattributes line but not this, which is exactly what
// `checkMergeDriverSetup` below exists to catch. Returns whether both `git
// config` calls actually succeeded, so a caller run before `git init`, or on
// a machine with no `git` on PATH, can report the truth instead of claiming
// success unconditionally.
export function registerMergeDriverGitConfig(cwd: string): boolean {
  const name = spawnSync(
    'git',
    ['config', 'merge.dispatch-task.name', 'Dispatch task file merge'],
    { cwd }
  );
  const driver = spawnSync(
    'git',
    ['config', 'merge.dispatch-task.driver', 'dispatch merge-task %O %A %B'],
    { cwd }
  );
  return name.status === 0 && driver.status === 0;
}

// Same as registerMergeDriverGitConfig, for the team roster's driver.
export function registerTeamMergeDriverGitConfig(cwd: string): boolean {
  const name = spawnSync(
    'git',
    ['config', 'merge.dispatch-team.name', 'Dispatch team roster merge'],
    { cwd }
  );
  const driver = spawnSync(
    'git',
    ['config', 'merge.dispatch-team.driver', 'dispatch merge-team %O %A %B'],
    { cwd }
  );
  return name.status === 0 && driver.status === 0;
}

function gitConfigHasDriver(cwd: string, key: string): boolean {
  const result = spawnSync('git', ['config', '--local', '--get', key], {
    cwd,
    encoding: 'utf8',
  });
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
  return {
    gitattributes,
    gitConfig: gitConfigHasDriver(cwd, 'merge.dispatch-task.driver'),
  };
}

// Same as checkMergeDriverSetup, for the team roster's driver.
export function checkTeamMergeDriverSetup(cwd: string): {
  gitattributes: boolean;
  gitConfig: boolean;
} {
  const attrPath = join(cwd, '.gitattributes');
  const attrText = existsSync(attrPath) ? readFileSync(attrPath, 'utf8') : '';
  const gitattributes = attrText
    .split('\n')
    .some((line) => line.trim() === TEAM_GITATTRIBUTES_LINE);
  return {
    gitattributes,
    gitConfig: gitConfigHasDriver(cwd, 'merge.dispatch-team.driver'),
  };
}
