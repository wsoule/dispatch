import { childEnv } from '@dispatch-foo/core';
import type { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

import type { CliContext } from '../context.js';
import { CliError } from '../context.js';

/**
 * `dispatch worktree` — cut, list and remove git worktrees.
 *
 * Deliberately local: this shells out to git in the project directory rather
 * than going through the daemon. A worktree is a git operation, not
 * orchestration state, and making it a daemon route would mean `dispatch
 * worktree list` failed on a project whose daemon happens not to be running —
 * which is exactly when someone is most likely to be setting one up by hand.
 *
 * The worktrees the orchestrator cuts for runs show up in `list` alongside
 * hand-made ones, because git is the single source of truth for both.
 */

export interface WorktreeRow {
  path: string;
  branch: string | null;
  head: string | null;
  /** A worktree checked out with no branch, which git calls detached. */
  detached: boolean;
  /** True for the repository's own working copy. */
  main: boolean;
}

// A path with its symlinks resolved, so it compares equal to the one git
// reports: git prints real paths, and on macOS `/tmp` and `/var` are symlinks
// into `/private`. A path that no longer exists is only normalized.
function canonicalPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: childEnv(),
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    const detail =
      stderr === undefined ? (err as Error).message : String(stderr).trim();
    throw new CliError(`git ${args[0] ?? ''} failed: ${detail}`);
  }
}

/**
 * Parses `git worktree list --porcelain`.
 *
 * The porcelain form rather than the human one: paths with spaces in them are
 * unambiguous here, and the field names are a stable interface where the
 * columns of the default output are not. Records are separated by a blank
 * line, and the first record is always the main working copy.
 */
export function parseWorktreeList(porcelain: string): WorktreeRow[] {
  const rows: WorktreeRow[] = [];
  let current: Partial<WorktreeRow> = {};
  const flush = (): void => {
    if (typeof current.path === 'string') {
      rows.push({
        path: current.path,
        branch: current.branch ?? null,
        head: current.head ?? null,
        detached: current.detached === true,
        main: rows.length === 0,
      });
    }
    current = {};
  };

  for (const line of porcelain.split('\n')) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (key === 'worktree') current.path = value;
    else if (key === 'HEAD') current.head = value;
    else if (key === 'branch')
      current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') current.detached = true;
  }
  flush();
  return rows;
}

/**
 * Where a new worktree goes when the caller names no path.
 *
 * A sibling of the repository rather than a directory inside it: a worktree
 * nested in its own repo shows up as untracked content in every `git status`
 * and is easy to commit by accident.
 */
export function defaultWorktreePath(rootDir: string, branch: string): string {
  const safe = branch.replace(/[^A-Za-z0-9._-]+/g, '-');
  return resolve(rootDir, '..', `${basename(rootDir)}-${safe}`);
}

export function registerWorktreeCommands(
  program: Command,
  ctx: CliContext
): void {
  const worktree = program
    .command('worktree')
    .description('Create, list and remove git worktrees for this project');

  worktree
    .command('list')
    .description('Every worktree git knows about, runs included')
    .option('--json')
    .action((opts: { json?: boolean }) => {
      const rows = parseWorktreeList(
        git(ctx.cwd, ['worktree', 'list', '--porcelain'])
      );
      if (opts.json === true) {
        ctx.log(JSON.stringify(rows, null, 2));
        return;
      }
      for (const row of rows) {
        const label = row.detached
          ? `(detached ${row.head?.slice(0, 8) ?? '?'})`
          : (row.branch ?? '(no branch)');
        ctx.log(`${row.path}  ${label}${row.main ? '  [main]' : ''}`);
      }
    });

  worktree
    .command('create <branch> [path]')
    .description('Cut a worktree, creating the branch if it does not exist')
    .option('--base <ref>', 'what to branch from (default: current HEAD)')
    .option('--json')
    .action(
      (
        branch: string,
        path: string | undefined,
        opts: { base?: string; json?: boolean }
      ) => {
        const target =
          path === undefined
            ? defaultWorktreePath(ctx.cwd, branch)
            : isAbsolute(path)
              ? path
              : join(ctx.cwd, path);
        if (existsSync(target)) {
          throw new CliError(`${target} already exists`);
        }

        // `git worktree add -b` fails when the branch is already there, and
        // reusing an existing branch is the ordinary case when picking work
        // back up — so which form to use depends on whether it exists.
        const exists =
          git(ctx.cwd, ['branch', '--list', branch]).trim() !== '' ||
          git(ctx.cwd, [
            'branch',
            '--list',
            '-r',
            `origin/${branch}`,
          ]).trim() !== '';
        const args = exists
          ? ['worktree', 'add', target, branch]
          : [
              'worktree',
              'add',
              '-b',
              branch,
              target,
              ...(opts.base === undefined ? [] : [opts.base]),
            ];
        git(ctx.cwd, args);

        const row = { path: target, branch, created: !exists };
        ctx.log(
          opts.json === true
            ? JSON.stringify(row, null, 2)
            : `${target}  ${branch}${exists ? '' : '  (new branch)'}`
        );
      }
    );

  worktree
    .command('remove <path>')
    .description('Remove a worktree')
    .option('--force', 'remove it even with uncommitted changes')
    .option('--delete-branch', 'also delete the branch it had checked out')
    .action(
      (path: string, opts: { force?: boolean; deleteBranch?: boolean }) => {
        const target = isAbsolute(path) ? path : join(ctx.cwd, path);
        const row = parseWorktreeList(
          git(ctx.cwd, ['worktree', 'list', '--porcelain'])
        ).find((entry) => canonicalPath(entry.path) === canonicalPath(target));
        if (row === undefined) throw new CliError(`no worktree at ${target}`);
        if (row.main) {
          throw new CliError(
            'refusing to remove the project’s own working copy'
          );
        }

        git(ctx.cwd, [
          'worktree',
          'remove',
          ...(opts.force === true ? ['--force'] : []),
          target,
        ]);
        // Only after the worktree is gone: git refuses to delete a branch that
        // is still checked out somewhere.
        if (opts.deleteBranch === true && row.branch !== null) {
          git(ctx.cwd, ['branch', '-D', row.branch]);
        }
        ctx.log(`removed ${target}`);
      }
    );
}
