import { relative, resolve, sep } from 'node:path';

import type { CommandResult, CommandRunner } from '../orchestrator/pr.js';
import { defaultCommandRunner } from '../orchestrator/pr.js';
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  parseBranchLines,
  parseLogLines,
  parsePorcelainV2,
  parseStashList,
  STASH_FORMAT,
} from './parse.js';
import type { GitBranch, GitLogEntry, GitStash, GitStatus } from './parse.js';

// Every read/mutation below resolves to this instead of throwing on a
// non-zero git exit; `T` carries whatever extra fields a success returns.
export type GitOutcome<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; stderr: string };

const PATH_ESCAPE_ERROR = 'path escapes the repository root';
const INVALID_REF_ERROR = 'invalid ref: must not start with "-"';
const INVALID_REMOTE_ERROR = 'invalid remote: expected a plain remote name';
const CONFIRM_REQUIRED_ERROR =
  'this operation is destructive and requires confirm: true';

// A plain remote name only — never a URL or transport spec (see fetch() below).
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

// Prefers stderr, falling back to stdout — git prints some failures
// (e.g. "nothing to commit") to stdout instead.
function commandErrorText(result: CommandResult): string {
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? stderr : result.stdout.trim();
}

// Refuses a ref/branch/commit argument starting with '-' — git would
// otherwise parse it as a flag (e.g. `--upload-pack=...`).
function isSafeRef(name: string): boolean {
  return name.trim() !== '' && !name.startsWith('-');
}

// Every git operation the Git page needs against one repo checkout, via the
// injected async `CommandRunner` — distinct from `WorktreeManager`'s dispatch-worktree lifecycle.
export class GitRepo {
  constructor(
    private readonly cwd: string,
    private readonly run: CommandRunner = defaultCommandRunner
  ) {}

  // `--literal-pathspecs` disables git's pathspec magic, so a caller-supplied
  // path is always a literal file, never a pattern like `*`.
  private async runGit(args: string[]): Promise<CommandResult> {
    return this.run(this.cwd, ['git', '--literal-pathspecs', ...args]);
  }

  // Refuses a path that resolves outside the repo root or starts with '-';
  // returns the original relative string so git resolves it the same way.
  private safePath(rawPath: string): string | null {
    if (rawPath === '' || rawPath.startsWith('-')) return null;
    const root = resolve(this.cwd);
    const resolved = resolve(this.cwd, rawPath);
    const rel = relative(root, resolved);
    if (rel === '..' || rel.startsWith(`..${sep}`)) return null;
    return rawPath;
  }

  private safePaths(paths: string[]): string[] | null {
    const safe: string[] = [];
    for (const path of paths) {
      const checked = this.safePath(path);
      if (checked === null) return null;
      safe.push(checked);
    }
    return safe;
  }

  // `-z` NUL-delimits every record, so a path containing a literal newline
  // can't be mistaken for a record boundary — see parsePorcelainV2.
  async status(): Promise<GitOutcome<GitStatus>> {
    const result = await this.runGit([
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all',
      '-z',
    ]);
    if (!result.ok) return { ok: false, stderr: commandErrorText(result) };
    return { ok: true, ...parsePorcelainV2(result.stdout) };
  }

  async log(
    opts: { ref?: string; limit?: number; skip?: number } = {}
  ): Promise<GitOutcome<{ commits: GitLogEntry[] }>> {
    if (opts.ref !== undefined && !isSafeRef(opts.ref)) {
      return { ok: false, stderr: INVALID_REF_ERROR };
    }
    const args = [
      'log',
      `--format=${LOG_FORMAT}`,
      '-n',
      String(opts.limit ?? 50),
    ];
    if (opts.skip !== undefined) args.push(`--skip=${opts.skip}`);
    if (opts.ref !== undefined) args.push(opts.ref);
    const result = await this.runGit(args);
    if (!result.ok) return { ok: false, stderr: commandErrorText(result) };
    return { ok: true, commits: parseLogLines(result.stdout) };
  }

  async branches(): Promise<GitOutcome<{ branches: GitBranch[] }>> {
    const result = await this.runGit([
      'for-each-ref',
      `--format=${BRANCH_FORMAT}`,
      'refs/heads',
      'refs/remotes',
    ]);
    if (!result.ok) return { ok: false, stderr: commandErrorText(result) };
    return { ok: true, branches: parseBranchLines(result.stdout) };
  }

  async diff(
    opts: { staged?: boolean; path?: string } = {}
  ): Promise<GitOutcome<{ patch: string }>> {
    const args = ['diff'];
    if (opts.staged === true) args.push('--cached');
    if (opts.path !== undefined) {
      const safePath = this.safePath(opts.path);
      if (safePath === null) return { ok: false, stderr: PATH_ESCAPE_ERROR };
      args.push('--', safePath);
    }
    const result = await this.runGit(args);
    if (!result.ok) return { ok: false, stderr: commandErrorText(result) };
    return { ok: true, patch: result.stdout };
  }

  async diffCommit(sha: string): Promise<GitOutcome<{ patch: string }>> {
    if (!isSafeRef(sha)) return { ok: false, stderr: INVALID_REF_ERROR };
    const result = await this.runGit(['show', sha]);
    if (!result.ok) return { ok: false, stderr: commandErrorText(result) };
    return { ok: true, patch: result.stdout };
  }

  async stage(paths: string[]): Promise<GitOutcome> {
    const safe = this.safePaths(paths);
    if (safe === null) return { ok: false, stderr: PATH_ESCAPE_ERROR };
    const result = await this.runGit(['add', '--', ...safe]);
    return result.ok
      ? { ok: true }
      : { ok: false, stderr: commandErrorText(result) };
  }

  // `git reset` rather than `git restore --staged`: the latter fails on an
  // unborn branch, which a repo's very first staged file is in.
  async unstage(paths: string[]): Promise<GitOutcome> {
    const safe = this.safePaths(paths);
    if (safe === null) return { ok: false, stderr: PATH_ESCAPE_ERROR };
    const result = await this.runGit(['reset', 'HEAD', '--', ...safe]);
    return result.ok
      ? { ok: true }
      : { ok: false, stderr: commandErrorText(result) };
  }

  // Bypasses `this.run` on purpose — see the class doc comment. `-` as the
  // last argument tells `git apply` to read the patch from stdin.
  private async applyPatch(
    args: string[],
    patch: string
  ): Promise<CommandResult> {
    try {
      const proc = Bun.spawn(['git', '--literal-pathspecs', ...args, '-'], {
        cwd: this.cwd,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.stdin.write(patch);
      await proc.stdin.end();
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { ok: exitCode === 0, stdout, stderr };
    } catch (err) {
      return { ok: false, stdout: '', stderr: (err as Error).message };
    }
  }

  async stageHunk(patch: string): Promise<GitOutcome> {
    const result = await this.applyPatch(['apply', '--cached'], patch);
    return result.ok
      ? { ok: true }
      : { ok: false, stderr: commandErrorText(result) };
  }

  async unstageHunk(patch: string): Promise<GitOutcome> {
    const result = await this.applyPatch(
      ['apply', '--cached', '--reverse'],
      patch
    );
    return result.ok
      ? { ok: true }
      : { ok: false, stderr: commandErrorText(result) };
  }

  // Removes untracked paths first, then restores tracked ones — via
  // `ls-files` rather than pattern-matching checkout's (locale-dependent) error text.
  async discard(paths: string[], confirm: boolean): Promise<GitOutcome> {
    if (!confirm) return { ok: false, stderr: CONFIRM_REQUIRED_ERROR };
    const safe = this.safePaths(paths);
    if (safe === null) return { ok: false, stderr: PATH_ESCAPE_ERROR };
    const clean = await this.runGit(['clean', '-f', '-d', '--', ...safe]);
    if (!clean.ok) return { ok: false, stderr: commandErrorText(clean) };
    const tracked = await this.runGit(['ls-files', '-z', '--', ...safe]);
    if (!tracked.ok) return { ok: false, stderr: commandErrorText(tracked) };
    const trackedPaths = tracked.stdout.split('\0').filter((p) => p !== '');
    if (trackedPaths.length === 0) return { ok: true };
    const checkout = await this.runGit(['checkout', '--', ...trackedPaths]);
    if (!checkout.ok) return { ok: false, stderr: commandErrorText(checkout) };
    return { ok: true };
  }

  async commit(opts: {
    message: string;
    amend?: boolean;
  }): Promise<GitOutcome<{ sha: string }>> {
    const args = ['commit'];
    if (opts.amend === true) args.push('--amend');
    args.push('-m', opts.message);
    const result = await this.runGit(args);
    if (!result.ok) return { ok: false, stderr: commandErrorText(result) };
    const head = await this.runGit(['rev-parse', 'HEAD']);
    if (!head.ok) {
      return {
        ok: false,
        stderr: `commit succeeded but could not resolve its sha: ${commandErrorText(head)}`,
      };
    }
    return { ok: true, sha: head.stdout.trim() };
  }

  // `--` disambiguates a branch from a pathspec — without it, an invalid ref
  // silently falls back to restoring paths under that name instead.
  async checkout(branch: string): Promise<GitOutcome> {
    if (!isSafeRef(branch)) return { ok: false, stderr: INVALID_REF_ERROR };
    const result = await this.runGit(['checkout', branch, '--']);
    return result.ok
      ? { ok: true }
      : { ok: false, stderr: commandErrorText(result) };
  }

  async createBranch(name: string, from?: string): Promise<GitOutcome> {
    if (!isSafeRef(name) || (from !== undefined && !isSafeRef(from))) {
      return { ok: false, stderr: INVALID_REF_ERROR };
    }
    const args = from !== undefined ? ['branch', name, from] : ['branch', name];
    const result = await this.runGit(args);
    return result.ok
      ? { ok: true }
      : { ok: false, stderr: commandErrorText(result) };
  }

  // `force` selects `-D` over `-d`; `confirm` gates `-D` independently of the
  // HTTP route, so an in-process caller can't reach it by accident.
  async deleteBranch(
    name: string,
    force: boolean,
    confirm = false
  ): Promise<GitOutcome> {
    if (!isSafeRef(name)) return { ok: false, stderr: INVALID_REF_ERROR };
    if (force && !confirm) return { ok: false, stderr: CONFIRM_REQUIRED_ERROR };
    const result = await this.runGit(['branch', force ? '-D' : '-d', name]);
    return result.ok
      ? { ok: true }
      : { ok: false, stderr: commandErrorText(result) };
  }

  async stashPush(message?: string): Promise<GitOutcome> {
    const args = ['stash', 'push'];
    if (message !== undefined && message !== '') args.push('-m', message);
    const result = await this.runGit(args);
    return result.ok
      ? { ok: true }
      : { ok: false, stderr: commandErrorText(result) };
  }

  async stashList(): Promise<GitOutcome<{ stashes: GitStash[] }>> {
    const result = await this.runGit([
      'stash',
      'list',
      `--format=${STASH_FORMAT}`,
    ]);
    if (!result.ok) return { ok: false, stderr: commandErrorText(result) };
    return { ok: true, stashes: parseStashList(result.stdout) };
  }

  async stashPop(index: number): Promise<GitOutcome> {
    if (!Number.isInteger(index) || index < 0) {
      return { ok: false, stderr: 'invalid stash index' };
    }
    const result = await this.runGit(['stash', 'pop', `stash@{${index}}`]);
    return result.ok
      ? { ok: true }
      : { ok: false, stderr: commandErrorText(result) };
  }

  async stashDrop(index: number, confirm: boolean): Promise<GitOutcome> {
    if (!confirm) return { ok: false, stderr: CONFIRM_REQUIRED_ERROR };
    if (!Number.isInteger(index) || index < 0) {
      return { ok: false, stderr: 'invalid stash index' };
    }
    const result = await this.runGit(['stash', 'drop', `stash@{${index}}`]);
    return result.ok
      ? { ok: true }
      : { ok: false, stderr: commandErrorText(result) };
  }

  // `git fetch <repository>` accepts a URL or transport spec too — rejecting
  // anything but a plain name keeps this from reaching an attacker's host.
  async fetch(remote?: string): Promise<GitOutcome> {
    if (remote !== undefined && !REMOTE_NAME_PATTERN.test(remote)) {
      return { ok: false, stderr: INVALID_REMOTE_ERROR };
    }
    const args = remote !== undefined ? ['fetch', remote] : ['fetch'];
    const result = await this.runGit(args);
    return result.ok
      ? { ok: true }
      : { ok: false, stderr: commandErrorText(result) };
  }

  async pull(): Promise<GitOutcome> {
    const result = await this.runGit(['pull']);
    return result.ok
      ? { ok: true }
      : { ok: false, stderr: commandErrorText(result) };
  }

  // `setUpstream` records the tracking relationship; never force-pushes.
  async push(opts: { setUpstream?: boolean } = {}): Promise<GitOutcome> {
    const args =
      opts.setUpstream === true ? ['push', '-u', 'origin', 'HEAD'] : ['push'];
    const result = await this.runGit(args);
    return result.ok
      ? { ok: true }
      : { ok: false, stderr: commandErrorText(result) };
  }

  async cherryPick(sha: string): Promise<GitOutcome> {
    if (!isSafeRef(sha)) return { ok: false, stderr: INVALID_REF_ERROR };
    const result = await this.runGit(['cherry-pick', sha]);
    return result.ok
      ? { ok: true }
      : { ok: false, stderr: commandErrorText(result) };
  }

  async revert(sha: string): Promise<GitOutcome> {
    if (!isSafeRef(sha)) return { ok: false, stderr: INVALID_REF_ERROR };
    const result = await this.runGit(['revert', '--no-edit', sha]);
    return result.ok
      ? { ok: true }
      : { ok: false, stderr: commandErrorText(result) };
  }
}
