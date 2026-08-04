import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// One git invocation: `cwd` to run it in, `args` after `git`. Injected rather
// than shelled out internally so tests can point every command at a real
// temp repo without mocking git itself.
export type GitRunner = (
  cwd: string,
  args: string[]
) => { status: number; stdout: string; stderr: string };

// DISPATCH_HOME before homedir() — the sixth copy of this exact scheme; see
// daemonfile.ts's `daemonHome()` comment for the full enumeration (also
// mirrors linear/state.ts's stateHome(), which predates that enumeration).
// Kept as its own copy rather than an import so this module has no
// dependency on the daemon-file module; update all six together if the rule
// ever changes.
function dispatchHome(): string {
  const home = process.env.DISPATCH_HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

// syncOnce() is fully synchronous, so a git process that blocks on a
// credential/passphrase/host-key prompt freezes the daemon's single event
// loop entirely — HTTP and WebSocket included, not just sync. These env
// vars make git fail fast instead of prompting (an expired HTTPS token, a
// passphrase-protected SSH key with no agent, first contact with a new
// host); `timeout` below is the last-resort backstop for anything they
// don't cover. Any process this turns away becomes a normal `local-only`
// result, not a wedged daemon.
const NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10',
};

// Production GitRunner: shells out for real. Mirrors the test harness's own
// `run` in test/sync/helpers.ts exactly, kept separate so src/ has no
// dependency on test code.
export const defaultGitRunner: GitRunner = (cwd, args) => {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...NO_PROMPT_ENV },
    timeout: 30_000,
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
  };
};

// Same hash-of-rootDir key as linear/state.ts's linearStatePath and
// daemonfile.ts's daemonFileKey, so this worktree's location never collides
// across projects sharing one DISPATCH_HOME.
function rootHash(rootDir: string): string {
  return createHash('sha256').update(rootDir).digest('hex').slice(0, 12);
}

// Trunk, in priority order: the remote's default branch, then a local main,
// then a local master. Returns null rather than guessing further, so a repo
// with none of the three gets no syncer instead of a broken one.
function resolveTrunk(rootDir: string, run: GitRunner): string | null {
  const originHead = run(rootDir, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (originHead.status === 0) {
    const ref = originHead.stdout.trim();
    const prefix = 'refs/remotes/origin/';
    if (ref.startsWith(prefix)) {
      const name = ref.slice(prefix.length);
      // `symbolic-ref` only confirms the symref FILE exists, not that its
      // target still does — a remote's default branch being renamed or
      // deleted leaves a stale local symref pointing at nothing. Verify the
      // target actually resolves before trusting it, so a ghost branch
      // falls through to the local fallbacks instead of producing a syncer
      // that can never check anything out.
      const verify = run(rootDir, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/remotes/origin/${name}`,
      ]);
      if (verify.status === 0) return name;
    }
  }
  for (const candidate of ['main', 'master']) {
    const verify = run(rootDir, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${candidate}`,
    ]);
    if (verify.status === 0) return candidate;
  }
  return null;
}

/**
 * The board syncer's private worktree: pinned to trunk, living outside the
 * user's repo under DISPATCH_HOME. Automatic commit-and-push only ever
 * touches this tree, never the user's own checkout, index or HEAD.
 *
 * It holds no state beyond `path` and `trunk`, both derived deterministically
 * from `rootDir` — nothing here needs to survive a crash, since `ensure()`
 * can always rebuild it from git alone.
 */
export class SyncWorktree {
  readonly path: string;

  private constructor(
    private readonly rootDir: string,
    private readonly run: GitRunner,
    private readonly trunk: string
  ) {
    this.path = join(
      dispatchHome(),
      '.dispatch',
      'worktrees',
      rootHash(rootDir),
      'board'
    );
  }

  // Null when `rootDir` has no trunk to pin to (no origin/HEAD, no local
  // main or master) — the caller gets no syncer rather than one with nothing
  // safe to check out.
  static open(rootDir: string, run: GitRunner): SyncWorktree | null {
    const trunk = resolveTrunk(rootDir, run);
    if (trunk === null) return null;
    return new SyncWorktree(rootDir, run, trunk);
  }

  trunkRef(): string {
    return this.trunk;
  }

  // Read-only: whether the worktree is already present and registered,
  // without creating or repairing it — lets a caller like
  // BoardSyncer.pendingCounts() skip a synchronous checkout it doesn't need.
  exists(): boolean {
    return this.isRegisteredAndPresent();
  }

  // The commit-ish to check out: the local branch when it exists, else the
  // remote-tracking one — covers the origin/HEAD case where a fresh clone
  // hasn't created a local branch of that name yet.
  private checkoutRef(): string {
    const local = this.run(this.rootDir, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${this.trunk}`,
    ]);
    return local.status === 0 ? this.trunk : `origin/${this.trunk}`;
  }

  // Whether `this.path` is both present on disk and known to `git worktree
  // list` in the main repo — the two ways it can go stale independently (a
  // deleted directory git still thinks exists, or a directory git lost track
  // of after external cleanup). Paths are compared via realpath since git
  // resolves symlinks in worktree paths (e.g. /tmp -> /private/tmp on
  // macOS) that a raw string compare would miss.
  private isRegisteredAndPresent(): boolean {
    if (!existsSync(this.path)) return false;
    const list = this.run(this.rootDir, ['worktree', 'list', '--porcelain']);
    if (list.status !== 0) return false;
    const target = realpathSync(this.path);
    return list.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .some((line) => {
        const candidate = line.slice('worktree '.length).trim();
        try {
          return realpathSync(candidate) === target;
        } catch {
          return false;
        }
      });
  }

  // Detached at trunk rather than checked out on its branch: the trunk
  // branch itself is very often already checked out in the user's own main
  // worktree, and git refuses to check out the same branch twice.
  //
  // Sparse (cone-mode, restricted to .dispatch/): this worktree only ever
  // reads and writes .dispatch/tasks, so there's no reason to materialize a
  // full duplicate of trunk on disk for every project that has this worktree
  // created — `--no-checkout` skips populating files at `add` time, and the
  // final bare `checkout` (HEAD is already detached at the right commit, so
  // this doesn't move it or touch a branch) populates only what the sparse
  // patterns allow. Cone mode always includes top-level files (e.g.
  // README.md, .gitattributes) alongside the explicitly-set directory.
  private addWorktree(): { status: number; stderr: string } {
    const add = this.run(this.rootDir, [
      'worktree',
      'add',
      '--no-checkout',
      '--detach',
      this.path,
      this.checkoutRef(),
    ]);
    if (add.status !== 0) return add;

    const init = this.run(this.path, ['sparse-checkout', 'init', '--cone']);
    if (init.status !== 0) return init;
    const set = this.run(this.path, ['sparse-checkout', 'set', '.dispatch']);
    if (set.status !== 0) return set;
    return this.run(this.path, ['checkout']);
  }

  // Create-or-repair, idempotent: a no-op when the worktree already exists
  // and git knows about it, otherwise prunes stale metadata and (re)creates
  // it from trunk. No state survives a repair beyond what's already in git,
  // so recreating from scratch is always safe. Mirrors WorktreeManager.add's
  // prune-then-retry shape for the one-off case where the first attempt
  // fails against metadata the prune above didn't catch.
  ensure(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    if (this.isRegisteredAndPresent()) return;

    this.run(this.rootDir, ['worktree', 'prune']);
    rmSync(this.path, { recursive: true, force: true });
    const first = this.addWorktree();
    if (first.status === 0) return;

    this.run(this.rootDir, ['worktree', 'prune']);
    rmSync(this.path, { recursive: true, force: true });
    const retry = this.addWorktree();
    if (retry.status !== 0) {
      throw new Error(`git worktree add failed: ${retry.stderr.trim()}`);
    }
  }

  // Deregisters the worktree and prunes its metadata. Errors are swallowed
  // the way WorktreeManager.remove's are: the caller's goal — no worktree —
  // is already satisfied if it was missing to begin with.
  remove(): void {
    this.run(this.rootDir, ['worktree', 'remove', '--force', this.path]);
    this.run(this.rootDir, ['worktree', 'prune']);
  }
}
