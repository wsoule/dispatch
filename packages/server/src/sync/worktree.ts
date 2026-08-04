import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

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

// Prefers stderr, falling back to stdout — mirrors boardSyncer.ts's own copy
// of this exact helper (kept separate to avoid a needless cross-import).
function errorText(result: { stdout: string; stderr: string }): string {
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? stderr : result.stdout.trim();
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

// `git sparse-checkout init --cone` writes `extensions.worktreeConfig = true`
// into the repo's SHARED `.git/config` as a side effect — this reads that
// flag back, `--local` only (never global/system), matching exactly what
// `sparse-checkout` itself reads and writes.
function worktreeConfigExtensionEnabled(
  rootDir: string,
  run: GitRunner
): boolean {
  const result = run(rootDir, [
    'config',
    '--local',
    '--get',
    'extensions.worktreeConfig',
  ]);
  return result.status === 0 && result.stdout.trim() === 'true';
}

// `rev-parse --git-common-dir` is the shared `.git` directory every worktree
// (main and linked) points back to — resolved to an absolute path since git
// may print it relative to `cwd`. Null when `rootDir` isn't a git repo at all
// (shouldn't happen here, but callers must have a safe "don't know" case).
function gitCommonDir(rootDir: string, run: GitRunner): string | null {
  const result = run(rootDir, ['rev-parse', '--git-common-dir']);
  if (result.status !== 0) return null;
  const raw = result.stdout.trim();
  return isAbsolute(raw) ? raw : join(rootDir, raw);
}

// Whether ANY worktree other than the one we just removed still has its own
// worktree-scoped config — the main worktree's lives at `<common>/config.worktree`,
// every linked worktree's at `<common>/worktrees/<id>/config.worktree`. If one
// exists, git migrated real settings into it (see the module doc comment on
// SyncWorktree), and unsetting `extensions.worktreeConfig` would make git
// silently stop reading that file for a worktree that has nothing to do with
// us. `git worktree remove` deletes our own admin dir immediately, so by the
// time this runs only OTHER worktrees can appear here.
function anyOtherWorktreeHasScopedConfig(commonDir: string): boolean {
  if (existsSync(join(commonDir, 'config.worktree'))) return true;
  const worktreesDir = join(commonDir, 'worktrees');
  if (!existsSync(worktreesDir)) return false;
  return readdirSync(worktreesDir).some((entry) =>
    existsSync(join(worktreesDir, entry, 'config.worktree'))
  );
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
 * `path` and `trunk` are derived deterministically from `rootDir` — nothing
 * there needs to survive a crash, since `ensure()` can always rebuild it
 * from git alone. The one exception is `extensionMarkerPath`: whether this
 * instance is the one that flipped the user's shared
 * `extensions.worktreeConfig` on, which must outlive both process restarts
 * and `path` being deleted/rebuilt, so `remove()` can still find it.
 */
export class SyncWorktree {
  readonly path: string;
  private readonly extensionMarkerPath: string;
  // Set once the sparse-checkout fallback below has logged — an ensure()
  // that later recreates the worktree (self-healing after external cleanup)
  // must not spam the log every time.
  private sparseCheckoutUnavailableLogged = false;

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
    // Sibling of `path`, not inside it — see the class doc comment.
    this.extensionMarkerPath = join(
      dirname(this.path),
      'extensions-worktree-config-owned'
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

    // `git sparse-checkout init --cone` writes `extensions.worktreeConfig =
    // true` into the repo's SHARED `.git/config` as an undisclosed side
    // effect (confirmed on git 2.55) — captured before we touch anything so
    // we can tell afterward whether WE flipped it on, as opposed to it
    // already being on (many `git worktree` users hit this via other paths;
    // if so, it is not ours to ever unset — see `remove()`).
    const extensionAlreadyEnabled = worktreeConfigExtensionEnabled(
      this.rootDir,
      this.run
    );

    // `sparse-checkout` needs git 2.25+; on anything older the subcommand is
    // simply unrecognized. That's an optimization failing, not a fatal one —
    // fall back to a full (unsparse, just larger) checkout and carry on
    // rather than bubbling a failure out of ensure() (and, via its retry,
    // out of syncOnceSync() as an unhandled rejection).
    const init = this.run(this.path, ['sparse-checkout', 'init', '--cone']);
    const sparse =
      init.status === 0
        ? this.run(this.path, ['sparse-checkout', 'set', '.dispatch'])
        : init;
    if (sparse.status !== 0) {
      if (!this.sparseCheckoutUnavailableLogged) {
        this.sparseCheckoutUnavailableLogged = true;
        console.error(
          `board sync: git sparse-checkout unavailable for ${this.path} ` +
            `(${errorText(sparse)}); falling back to a full checkout`
        );
      }
      // `init` may have partially enabled sparse-checkout before `set`
      // failed — disable it explicitly so the checkout below always
      // materializes all of trunk. Ignored if it also fails: on git with no
      // sparse-checkout support at all, it was never enabled to begin with.
      // Note: `disable` does NOT unset `extensions.worktreeConfig` once
      // `init` has set it (confirmed empirically) — the marker below still
      // applies in this fallback path.
      this.run(this.path, ['sparse-checkout', 'disable']);
    }

    // Only record ownership on the false -> true transition, and never
    // overwrite an existing marker: if the extension was already on before
    // this call, or a marker from an earlier run already exists, this
    // instance either isn't responsible or that responsibility was already
    // captured — leave it alone either way.
    if (
      !extensionAlreadyEnabled &&
      !existsSync(this.extensionMarkerPath) &&
      worktreeConfigExtensionEnabled(this.rootDir, this.run)
    ) {
      writeFileSync(this.extensionMarkerPath, '');
    }

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
    this.disownWorktreeConfigExtensionIfSafe();
  }

  // Unsets `extensions.worktreeConfig` on the user's shared `.git/config`,
  // but ONLY when this instance is the one that turned it on (per the marker
  // `addWorktree` wrote) AND no other worktree in the repo has been left
  // depending on it. When in doubt — no marker, extension already off, can't
  // verify the common git dir, or any other worktree has its own
  // `config.worktree` — this leaves the flag exactly as it found it. See the
  // module-level comment on `anyOtherWorktreeHasScopedConfig` for why
  // unsetting blindly is worse than leaving a stray flag behind.
  private disownWorktreeConfigExtensionIfSafe(): void {
    if (!existsSync(this.extensionMarkerPath)) return;

    if (!worktreeConfigExtensionEnabled(this.rootDir, this.run)) {
      // Nothing left to clean up (someone/something already unset it).
      rmSync(this.extensionMarkerPath, { force: true });
      return;
    }

    const commonDir = gitCommonDir(this.rootDir, this.run);
    // Can't verify no one else depends on it — leave the flag and the
    // marker in place so a later remove() can retry.
    if (commonDir === null) return;
    if (anyOtherWorktreeHasScopedConfig(commonDir)) return;

    this.run(this.rootDir, [
      'config',
      '--local',
      '--unset',
      'extensions.worktreeConfig',
    ]);
    rmSync(this.extensionMarkerPath, { force: true });
  }
}
