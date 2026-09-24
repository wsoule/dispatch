import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type {
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
} from '../../src/orchestrator/types.js';

/**
 * An executor that starts, reports a session id, and then never finishes —
 * the shape a run has at the instant a daemon restart loses track of it.
 *
 * The session id is load-bearing rather than decorative: a run that never
 * reported one has no agent history to pick back up, and the boot recovery
 * sweep's resumeBlockReason deliberately refuses those. `started` is what a
 * test reads to prove whether a resume actually launched anything.
 */
export class StallingExecutor implements Executor {
  readonly started: ExecutorStartOptions[] = [];
  // Every notify() call any started run received, in order.
  readonly notified: string[] = [];
  // Every send() call any started run received, in order.
  readonly sent: string[] = [];

  // Each start's run token, read from its token file at start (the file is
  // removed when the run ends).
  readonly runTokens: (string | undefined)[] = [];

  // The most recent start's run token, for tests that call the API as that run.
  get lastRunToken(): string | undefined {
    return this.runTokens.at(-1);
  }

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    this.started.push(opts);
    this.runTokens.push(
      opts.runTokenFile === undefined
        ? undefined
        : readFileSync(opts.runTokenFile, 'utf8')
    );
    events.onSession?.(`session-${this.started.length}`);
    return {
      interrupt: () => Promise.resolve(),
      requestStop: () => {},
      send: (message: string) => {
        this.sent.push(message);
      },
      approve: () => {},
      notify: (text: string) => {
        this.notified.push(text);
      },
    };
  }
}

// Runs a git command synchronously and throws with stderr on failure — used
// by tests that need to set up or inspect real repo state (as opposed to the
// orchestrator's own git wrapper, which is exactly what's under test).
export function runGitSync(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.toString('utf8')}`
    );
  }
  return result.stdout.toString('utf8');
}

/**
 * A bare repo with no commits, for use as an `origin`.
 *
 * Using `initGitRepo` as an origin looks right and is not: it makes its own
 * initial commit, so the "remote" already has an unrelated `main`, and pushing
 * to it is a non-fast-forward. That test passed only when both repos' initial
 * commits landed in the same second — same content, author and message mean
 * the same SHA, so the push was a silent no-op and the assertions held for the
 * wrong reason. A second boundary between the two calls (more likely on a busy
 * machine, which is why it failed under full-suite load and never alone) gave
 * two unrelated histories and a rejected push.
 *
 * Bare and empty: the push creates `main` rather than racing an existing one,
 * and it is a real push rather than a no-op.
 */
export function initBareRepo(prefix = 'dispatch-origin-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  runGitSync(dir, ['init', '--bare', '-b', 'main']);
  return dir;
}

// Creates a fresh temp dir, git-inits it on branch `main`, and makes one
// commit so there is a real HEAD to base worktrees/branches on — `git
// worktree add -b <branch> <path> <base>` fails against an empty repo with no
// commits, and every orchestrator test needs a realistic starting point.
export function initGitRepo(prefix = 'dispatch-orch-'): string {
  return initGitRepoAt(mkdtempSync(join(tmpdir(), prefix)));
}

// The same setup against a directory that already exists — for a suite whose
// own fixture root (a temp dir a TaskStore was already initialized in) has to
// become the git repo, rather than the other way round.
export function initGitRepoAt(dir: string): string {
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

/**
 * A unique path for a worktree belonging to `repo`, beside it rather than
 * inside it.
 *
 * Worktrees have to live outside the checkout they belong to, so tests place
 * them next to `repo` — but writing that as `join(repo, '..', 'wt-thing')`
 * resolves to the SHARED system temp root, because `initGitRepo` only
 * randomizes the repo directory itself. Every test using a fixed name therefore
 * competes for one global path, and a directory left behind by a previous run
 * collides with the next one: `git worktree add` refuses a path that already
 * exists, so the suite passes on a clean machine and then fails on every rerun.
 *
 * Prefixing with the repo's own (already unique) directory name makes the path
 * unique per `initGitRepo()` call while keeping it a sibling, so repeated local
 * runs stop interfering with each other.
 */
export function worktreeSiblingPath(repo: string, name: string): string {
  return join(repo, '..', `${basename(repo)}-${name}`);
}

/**
 * Runs `fn` while `repo` is temporarily not a git repository, so every git
 * command the code under test runs against it fails outright. This is how a
 * test injects a "real, unexpected" dispatch failure: WorktreeManager's first
 * git call (resolving the base branch, before any worktree is added) throws a
 * plain Error — exactly what fillQueue's narrow OrchestratorConflictError
 * catch does not tolerate.
 *
 * Not `chmod -R 000 .git`: root ignores permission bits, so in a root shell
 * (containers, some CI runners) that injection is a no-op — git keeps working,
 * the expected failure never comes, and the test times out. Moving `.git`
 * aside fails for every user. The empty `.git` FILE left in its place matters
 * too: with nothing there at all git walks up the parent directories looking
 * for a repository, and would silently operate on whatever checkout the temp
 * dir happens to live under; an invalid gitfile stops discovery at the repo
 * itself ("fatal: invalid gitfile format").
 */
export async function withBrokenRepo<T>(
  repo: string,
  fn: () => Promise<T>
): Promise<T> {
  const gitDir = join(repo, '.git');
  const parked = join(repo, '.git.offline');
  renameSync(gitDir, parked);
  writeFileSync(gitDir, '');
  try {
    return await fn();
  } finally {
    rmSync(gitDir, { force: true });
    renameSync(parked, gitDir);
  }
}
