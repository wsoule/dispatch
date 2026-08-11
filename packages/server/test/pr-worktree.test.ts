import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus } from '../src/events.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { CommandResult, CommandRunner } from '../src/orchestrator/pr.js';
import { defaultCommandRunner, PrManager } from '../src/orchestrator/pr.js';
import {
  PrWorktreeManager,
  toLandingWorktree,
} from '../src/orchestrator/prWorktree.js';
import { ReviewCommentStore } from '../src/reviewComments.js';
import { json } from './json.js';
import {
  initBareRepo,
  initGitRepo,
  runGitSync,
} from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// Wraps defaultCommandRunner, answering `ok:false` for any argv at `failCwd`
// that starts with `failArgvPrefix`, and delegating everything else to the
// real runner — proves CRITICAL 2's fail-closed handling of an unreadable
// `git status`/`git rev-parse HEAD` without faking the whole git surface.
function failingRunner(
  failCwd: string,
  failArgvPrefix: string[]
): CommandRunner {
  return (cwd, cmd, opts) => {
    const matches =
      cwd === failCwd && failArgvPrefix.every((part, i) => cmd[i] === part);
    if (matches) {
      return Promise.resolve({
        ok: false,
        stdout: '',
        stderr: 'simulated failure',
      });
    }
    return defaultCommandRunner(cwd, cmd, opts);
  };
}

const PR_NUMBER = 42;

function prHeadRef(n: number): string {
  return `refs/dispatch/pr/${n}`;
}

// Tracks every path a test creates outside the repos themselves (worktrees
// live as siblings of `rootDir`, not inside it), so afterEach can sweep them
// alongside the repos.
let cleanupPaths: string[] = [];

// A repo plus a bare "origin" and one contributor branch pushed to it, with
// the PR's head ref parked at that branch's current tip — the same starting
// point PrManager.fetchPrHead leaves behind, without needing a real GitHub
// `pull/N/head` remote ref (which a plain bare repo has no concept of).
function setUpRepoWithPrRef(number = PR_NUMBER): {
  repo: string;
  origin: string;
  branch: string;
  headOid: string;
} {
  const origin = initBareRepo();
  const repo = initGitRepo();
  cleanupPaths.push(origin, repo);
  runGitSync(repo, ['remote', 'add', 'origin', origin]);
  runGitSync(repo, ['push', 'origin', 'main']);

  const branch = 'contributor-branch';
  runGitSync(repo, ['checkout', '-b', branch]);
  writeFileSync(join(repo, 'contributor.txt'), 'first pass\n');
  runGitSync(repo, ['add', '-A']);
  runGitSync(repo, ['commit', '-m', 'contributor work']);
  runGitSync(repo, ['push', 'origin', branch]);
  const headOid = runGitSync(repo, ['rev-parse', branch]).trim();
  runGitSync(repo, ['checkout', 'main']);
  runGitSync(repo, ['update-ref', prHeadRef(number), headOid]);

  return { repo, origin, branch, headOid };
}

// A fetchHead closure that mirrors what PrManager.fetchPrHead really does —
// `git fetch --force origin <branch>:refs/dispatch/pr/<n>` — against the
// real bare "origin" set up above, so sync()'s fast-forward path exercises a
// genuine fetch rather than a hand-set ref.
function realFetchHead(
  repo: string,
  branch: string
): (n: number) => Promise<void> {
  return (n) => {
    runGitSync(repo, [
      'fetch',
      '--force',
      'origin',
      `${branch}:${prHeadRef(n)}`,
    ]);
    return Promise.resolve();
  };
}

afterEach(() => {
  for (const path of cleanupPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  cleanupPaths = [];
});

describe('PrWorktreeManager.worktreePathFor', () => {
  it('defaults to a sibling <repo>-worktrees dir, named pr-<n>', () => {
    const repo = initGitRepo();
    cleanupPaths.push(repo);
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: async () => {},
    });
    expect(manager.worktreePathFor(7)).toBe(
      join(dirname(repo), `${basename(repo)}-worktrees`, 'pr-7')
    );
  });

  it('overrides the parent dir via prWorktreeDir, keeping the pr-<n> leaf', () => {
    const repo = initGitRepo();
    const customParent = mkdtempSync(join(tmpdir(), 'dispatch-pr-wt-'));
    cleanupPaths.push(repo, customParent);
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      prWorktreeDir: customParent,
      fetchHead: async () => {},
    });
    expect(manager.worktreePathFor(7)).toBe(join(customParent, 'pr-7'));
  });
});

describe('PrWorktreeManager.create', () => {
  it('cuts a detached worktree at the pr ref’s current head', async () => {
    const { repo, headOid } = setUpRepoWithPrRef();
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: async () => {},
    });

    const state = await manager.create(PR_NUMBER);
    cleanupPaths.push(state.path);

    expect(existsSync(state.path)).toBe(true);
    expect(state.headOid).toBe(headOid);
    expect(state.dirty).toBe(false);
    expect(state.behind).toBe(false);
    expect(existsSync(join(state.path, 'contributor.txt'))).toBe(true);

    // `--abbrev-ref HEAD` prints the literal string "HEAD" for a detached
    // checkout (there's no branch name to abbreviate to); any other output
    // would mean `--detach` didn't take.
    const branch = runGitSync(state.path, [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]).trim();
    expect(branch).toBe('HEAD');
  });
});

describe('PrWorktreeManager.sync', () => {
  it('returns null when no worktree exists for the pr', async () => {
    const { repo } = setUpRepoWithPrRef();
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: async () => {},
    });

    expect(await manager.sync(PR_NUMBER, 'whatever')).toBeNull();
  });

  it('fast-forwards a clean worktree once a new commit lands on the pr ref', async () => {
    const { repo, branch, headOid } = setUpRepoWithPrRef();
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: realFetchHead(repo, branch),
    });
    const created = await manager.create(PR_NUMBER);
    cleanupPaths.push(created.path);
    expect(created.headOid).toBe(headOid);

    // A new commit lands on the PR's branch and is pushed to origin — the pr
    // ref in `repo` still points at the old tip until sync() re-fetches it.
    runGitSync(repo, ['checkout', branch]);
    writeFileSync(join(repo, 'contributor.txt'), 'second pass\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'more contributor work']);
    runGitSync(repo, ['push', 'origin', branch]);
    const newHeadOid = runGitSync(repo, ['rev-parse', branch]).trim();
    runGitSync(repo, ['checkout', 'main']);
    expect(newHeadOid).not.toBe(headOid);

    const state = await manager.sync(PR_NUMBER, newHeadOid);

    expect(state).not.toBeNull();
    expect(state?.headOid).toBe(newHeadOid);
    expect(state?.dirty).toBe(false);
    expect(state?.behind).toBe(false);
    expect(runGitSync(created.path, ['show', 'HEAD:contributor.txt'])).toBe(
      'second pass\n'
    );
  });

  it('leaves a dirty worktree untouched and reports it, never fetching', async () => {
    const { repo, branch, headOid } = setUpRepoWithPrRef();
    let fetchCalled = false;
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: async (n) => {
        fetchCalled = true;
        await realFetchHead(repo, branch)(n);
      },
    });
    const created = await manager.create(PR_NUMBER);
    cleanupPaths.push(created.path);
    writeFileSync(join(created.path, 'scratch.txt'), 'uncommitted work\n');

    // A different headRefOid than the worktree's own — if sync() reset
    // despite being dirty, this would prove it; it must not.
    const state = await manager.sync(PR_NUMBER, `${headOid}deadbeef`);

    expect(fetchCalled).toBe(false);
    expect(state).not.toBeNull();
    expect(state?.dirty).toBe(true);
    expect(state?.headOid).toBe(headOid);
    expect(existsSync(join(created.path, 'scratch.txt'))).toBe(true);
  });

  it('leaves a clean, up-to-date worktree alone', async () => {
    const { repo, headOid } = setUpRepoWithPrRef();
    let fetchCalled = false;
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: () => {
        fetchCalled = true;
        return Promise.resolve();
      },
    });
    const created = await manager.create(PR_NUMBER);
    cleanupPaths.push(created.path);

    const state = await manager.sync(PR_NUMBER, headOid);

    expect(fetchCalled).toBe(false);
    expect(state).toEqual({
      prNumber: PR_NUMBER,
      path: created.path,
      headOid,
      dirty: false,
      behind: false,
    });
  });
});

describe('PrWorktreeManager.removeIfClean', () => {
  it('returns null when no worktree exists for the pr', async () => {
    const { repo } = setUpRepoWithPrRef();
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: async () => {},
    });
    expect(await manager.removeIfClean(PR_NUMBER)).toBeNull();
  });

  it('removes a clean worktree and deletes its pr head ref', async () => {
    const { repo } = setUpRepoWithPrRef();
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: async () => {},
    });
    const created = await manager.create(PR_NUMBER);
    cleanupPaths.push(created.path);

    const result = await manager.removeIfClean(PR_NUMBER);

    expect(result).toBeNull();
    expect(existsSync(created.path)).toBe(false);
    const verify = Bun.spawnSync(
      ['git', 'rev-parse', '--verify', prHeadRef(PR_NUMBER)],
      { cwd: repo, stdout: 'pipe', stderr: 'pipe' }
    );
    expect(verify.exitCode).not.toBe(0);
  });

  it('keeps a dirty worktree and reports it instead of removing it', async () => {
    const { repo } = setUpRepoWithPrRef();
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: async () => {},
    });
    const created = await manager.create(PR_NUMBER);
    cleanupPaths.push(created.path);
    writeFileSync(join(created.path, 'scratch.txt'), 'wip\n');

    const result = await manager.removeIfClean(PR_NUMBER);

    expect(result).not.toBeNull();
    expect(result?.dirty).toBe(true);
    expect(existsSync(created.path)).toBe(true);
    const verify = Bun.spawnSync(
      ['git', 'rev-parse', '--verify', prHeadRef(PR_NUMBER)],
      { cwd: repo, stdout: 'pipe', stderr: 'pipe' }
    );
    expect(verify.exitCode).toBe(0);
  });
});

describe('PrWorktreeManager.list', () => {
  it('lists every pr worktree under the parent dir with live status', async () => {
    const { repo } = setUpRepoWithPrRef();
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: async () => {},
    });
    const created = await manager.create(PR_NUMBER);
    cleanupPaths.push(created.path);

    const listed = await manager.list();

    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual({
      prNumber: PR_NUMBER,
      path: created.path,
      headOid: created.headOid,
      dirty: false,
      behind: false,
    });
  });

  it('reports a dirty listed worktree as dirty', async () => {
    const { repo } = setUpRepoWithPrRef();
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: async () => {},
    });
    const created = await manager.create(PR_NUMBER);
    cleanupPaths.push(created.path);
    writeFileSync(join(created.path, 'scratch.txt'), 'wip\n');

    const listed = await manager.list();

    expect(listed).toHaveLength(1);
    expect(listed[0].dirty).toBe(true);
  });

  it('returns an empty list when nothing has been cut yet', async () => {
    const { repo } = setUpRepoWithPrRef();
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: async () => {},
    });
    expect(await manager.list()).toEqual([]);
  });
});

describe('toLandingWorktree', () => {
  it('maps dirty to dirty-hold, outranking behind', () => {
    const mapped = toLandingWorktree({
      prNumber: 1,
      path: '/x',
      headOid: 'a',
      dirty: true,
      behind: true,
    });
    expect(mapped.syncState).toBe('dirty-hold');
  });

  it('maps clean + behind to behind', () => {
    const mapped = toLandingWorktree({
      prNumber: 1,
      path: '/x',
      headOid: 'a',
      dirty: false,
      behind: true,
    });
    expect(mapped.syncState).toBe('behind');
  });

  it('maps clean + not behind to synced', () => {
    const mapped = toLandingWorktree({
      prNumber: 1,
      path: '/x',
      headOid: 'a',
      dirty: false,
      behind: false,
    });
    expect(mapped.syncState).toBe('synced');
  });

  // Task 7 review, IMPORTANT 3: list()'s own `behind` is always false — a
  // caller (getLandingSnapshot) that has a live headRefOid overrides it.
  it('recomputes behind against a passed currentHeadRefOid, ignoring state.behind', () => {
    const clean = {
      prNumber: 1,
      path: '/x',
      headOid: 'stale-oid',
      dirty: false,
      behind: false, // what list() always reports
    };
    expect(toLandingWorktree(clean, 'current-oid').syncState).toBe('behind');
    expect(toLandingWorktree(clean, 'stale-oid').syncState).toBe('synced');
    // dirty still outranks the recomputed behind.
    expect(
      toLandingWorktree({ ...clean, dirty: true }, 'current-oid').syncState
    ).toBe('dirty-hold');
  });
});

describe('PrWorktreeManager prWorktreeDir resolution', () => {
  // Task 7 review, IMPORTANT 8.
  it('resolves a relative prWorktreeDir against rootDir, not process.cwd()', () => {
    const repo = initGitRepo();
    cleanupPaths.push(repo);
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      prWorktreeDir: '../custom-worktrees',
      fetchHead: async () => {},
    });
    expect(manager.worktreePathFor(9)).toBe(
      join(dirname(repo), 'custom-worktrees', 'pr-9')
    );
  });

  it('refuses a prWorktreeDir that resolves inside rootDir', () => {
    const repo = initGitRepo();
    cleanupPaths.push(repo);
    expect(
      () =>
        new PrWorktreeManager({
          rootDir: repo,
          run: defaultCommandRunner,
          prWorktreeDir: join(repo, 'nested-worktrees'),
          fetchHead: async () => {},
        })
    ).toThrow(/resolves to .* inside the project/);
  });

  it('refuses a prWorktreeDir equal to rootDir itself', () => {
    const repo = initGitRepo();
    cleanupPaths.push(repo);
    expect(
      () =>
        new PrWorktreeManager({
          rootDir: repo,
          run: defaultCommandRunner,
          prWorktreeDir: repo,
          fetchHead: async () => {},
        })
    ).toThrow();
  });
});

// Task 7 review, CRITICAL 1: sync()/removeIfClean() must refuse to touch
// anything at the computed path that this manager didn't itself create —
// otherwise a hand-cut directory (or, with a misconfigured prWorktreeDir,
// the enclosing repo) sitting at the same path gets silently adopted and
// force-reset/deleted.
describe('PrWorktreeManager ownership', () => {
  it('sync() refuses an unregistered plain directory at the computed path', async () => {
    const { repo, branch } = setUpRepoWithPrRef(101);
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: realFetchHead(repo, branch),
    });
    const path = manager.worktreePathFor(101);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'not-ours.txt'), 'hello\n');
    cleanupPaths.push(path);

    const result = await manager.sync(101, 'whatever');

    expect(result).toBeNull();
    // Untouched — proof this never became a worktree or got reset.
    expect(existsSync(join(path, 'not-ours.txt'))).toBe(true);
  });

  it('sync() refuses a registered worktree that is on a branch checkout, not detached', async () => {
    const { repo, branch } = setUpRepoWithPrRef(102);
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: realFetchHead(repo, branch),
    });
    const path = manager.worktreePathFor(102);
    // A real worktree of `repo`, registered with git — but checked out on a
    // branch, never through this manager's create() (which always passes
    // --detach).
    runGitSync(repo, [
      'worktree',
      'add',
      '-b',
      'someones-own-branch',
      path,
      'main',
    ]);
    cleanupPaths.push(path);

    const result = await manager.sync(102, 'whatever');

    expect(result).toBeNull();
    const branchOut = runGitSync(path, [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]).trim();
    expect(branchOut).toBe('someones-own-branch'); // untouched
  });

  it('sync() refuses a detached worktree at the path with no ownership marker', async () => {
    const { repo, branch, headOid } = setUpRepoWithPrRef(103);
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: realFetchHead(repo, branch),
    });
    const path = manager.worktreePathFor(103);
    // Detached AND registered — but hand-cut, not through create(), so it
    // never got the ownership marker.
    runGitSync(repo, ['worktree', 'add', '--detach', path, prHeadRef(103)]);
    cleanupPaths.push(path);
    writeFileSync(join(path, 'not-ours.txt'), 'hello\n');

    const result = await manager.sync(103, `${headOid}-a-different-oid`);

    expect(result).toBeNull();
    expect(existsSync(join(path, 'not-ours.txt'))).toBe(true);
    expect(runGitSync(path, ['rev-parse', 'HEAD']).trim()).toBe(headOid);
  });

  it('removeIfClean() refuses an unregistered plain directory at the computed path', async () => {
    const { repo, branch } = setUpRepoWithPrRef(104);
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: realFetchHead(repo, branch),
    });
    const path = manager.worktreePathFor(104);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'not-ours.txt'), 'hello\n');
    cleanupPaths.push(path);

    const result = await manager.removeIfClean(104);

    expect(result).toBeNull();
    expect(existsSync(path)).toBe(true); // never deleted
  });

  it('removeIfClean() refuses a registered worktree that is on a branch checkout, not detached', async () => {
    const { repo, branch } = setUpRepoWithPrRef(105);
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: realFetchHead(repo, branch),
    });
    const path = manager.worktreePathFor(105);
    runGitSync(repo, [
      'worktree',
      'add',
      '-b',
      'someone-elses-branch',
      path,
      'main',
    ]);
    cleanupPaths.push(path);

    const result = await manager.removeIfClean(105);

    expect(result).toBeNull();
    expect(existsSync(path)).toBe(true);
  });

  it('accepts and syncs a worktree this manager actually created (positive control)', async () => {
    const { repo, branch, headOid } = setUpRepoWithPrRef(106);
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: realFetchHead(repo, branch),
    });
    const created = await manager.create(106);
    cleanupPaths.push(created.path);

    const result = await manager.sync(106, headOid);

    expect(result).not.toBeNull();
    expect(result?.dirty).toBe(false);
  });
});

// Task 7 review, CRITICAL 2: an unreadable `git status`/`git rev-parse HEAD`
// must never be read as "clean" — that's exactly the state that would let a
// `reset --hard` (sync) or a `worktree remove` (removeIfClean) run blind.
describe('PrWorktreeManager status/head failure handling', () => {
  it('sync() treats a failed git status as dirty, never resetting', async () => {
    const { repo, branch, headOid } = setUpRepoWithPrRef(201);
    const setup = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: realFetchHead(repo, branch),
    });
    const created = await setup.create(201);
    cleanupPaths.push(created.path);
    let fetchCalled = false;
    const failing = new PrWorktreeManager({
      rootDir: repo,
      run: failingRunner(created.path, ['git', 'status']),
      fetchHead: async (n) => {
        fetchCalled = true;
        await realFetchHead(repo, branch)(n);
      },
    });

    const result = await failing.sync(201, `${headOid}-a-different-oid`);

    expect(fetchCalled).toBe(false);
    expect(result).not.toBeNull();
    expect(result?.dirty).toBe(true);
  });

  it('sync() aborts (dirty:true) rather than compare when HEAD is unreadable', async () => {
    const { repo, branch } = setUpRepoWithPrRef(202);
    const setup = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: realFetchHead(repo, branch),
    });
    const created = await setup.create(202);
    cleanupPaths.push(created.path);
    let fetchCalled = false;
    const failing = new PrWorktreeManager({
      rootDir: repo,
      run: failingRunner(created.path, ['git', 'rev-parse', 'HEAD']),
      fetchHead: async (n) => {
        fetchCalled = true;
        await realFetchHead(repo, branch)(n);
      },
    });

    // headRefOid is deliberately '' — what an earlier bug would have
    // compared an unreadable HEAD against and read as "not behind".
    const result = await failing.sync(202, '');

    expect(fetchCalled).toBe(false);
    expect(result).not.toBeNull();
    expect(result?.dirty).toBe(true);
    expect(result?.headOid).toBe('');
  });

  it('removeIfClean() treats a failed git status as dirty, never removing', async () => {
    const { repo, branch } = setUpRepoWithPrRef(203);
    const setup = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: realFetchHead(repo, branch),
    });
    const created = await setup.create(203);
    cleanupPaths.push(created.path);
    const failing = new PrWorktreeManager({
      rootDir: repo,
      run: failingRunner(created.path, ['git', 'status']),
      fetchHead: async () => {},
    });

    const result = await failing.removeIfClean(203);

    expect(result).not.toBeNull();
    expect(result?.dirty).toBe(true);
    expect(existsSync(created.path)).toBe(true);
  });
});

describe('PrWorktreeManager.hasIgnoredFiles', () => {
  // Task 7 review, IMPORTANT 5.
  it('reports true when the worktree has git-ignored files', async () => {
    const { repo, branch } = setUpRepoWithPrRef(301);
    // Commit .gitignore on the contributor branch so it's already tracked
    // when the worktree is cut — an untracked .gitignore would itself read
    // as a plain dirty change, defeating the point of this test (proving
    // --ignored catches what plain status doesn't).
    runGitSync(repo, ['checkout', branch]);
    writeFileSync(join(repo, '.gitignore'), 'ignored.env\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'add gitignore']);
    const withGitignoreOid = runGitSync(repo, ['rev-parse', 'HEAD']).trim();
    runGitSync(repo, ['checkout', 'main']);
    runGitSync(repo, ['update-ref', prHeadRef(301), withGitignoreOid]);

    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: realFetchHead(repo, branch),
    });
    const created = await manager.create(301);
    cleanupPaths.push(created.path);
    writeFileSync(join(created.path, 'ignored.env'), 'SECRET=1\n');

    expect(await manager.hasIgnoredFiles(301)).toBe(true);
    // Plain status must NOT already flag this.
    const plain = await defaultCommandRunner(created.path, [
      'git',
      'status',
      '--porcelain',
    ]);
    expect(plain.stdout.trim()).toBe('');
  });

  it('reports false for a genuinely clean worktree', async () => {
    const { repo, branch } = setUpRepoWithPrRef(302);
    const manager = new PrWorktreeManager({
      rootDir: repo,
      run: defaultCommandRunner,
      fetchHead: realFetchHead(repo, branch),
    });
    const created = await manager.create(302);
    cleanupPaths.push(created.path);

    expect(await manager.hasIgnoredFiles(302)).toBe(false);
  });
});

// Task 7 review, IMPORTANT 4/5/6: the poll-driven auto-sync/auto-removal
// path, exercised through a real PrManager + PrWorktreeManager pair (not
// just PrWorktreeManager in isolation) — this is the only place any of that
// wiring actually ran before this review.
describe('PrManager.pollOnce PR worktree lifecycle', () => {
  interface Harness {
    rootDir: string;
    orchestrator: Orchestrator;
    store: TaskStore;
    cache: TaskCache;
    events: EventBus;
    reviewComments: ReviewCommentStore;
  }

  function makeHarness(repoDir: string): Harness {
    const store = TaskStore.init(repoDir);
    const cache = new TaskCache();
    cache.rebuild(store);
    const events = new EventBus();
    const orchestrator = new Orchestrator({
      rootDir: repoDir,
      store,
      cache,
      events,
    });
    const reviewComments = new ReviewCommentStore(repoDir, 'human:test');
    return {
      rootDir: repoDir,
      orchestrator,
      store,
      cache,
      events,
      reviewComments,
    };
  }

  function prListItem(
    number: number,
    headRefOid: string,
    state: 'OPEN' | 'MERGED' | 'CLOSED' = 'OPEN'
  ): Record<string, unknown> {
    return {
      number,
      title: `PR #${number}`,
      url: `https://github.com/example/repo/pull/${number}`,
      headRefName: `feature/${number}`,
      baseRefName: 'main',
      headRefOid,
      author: { login: 'teammate' },
      isDraft: false,
      updatedAt: '2026-08-10T00:00:00Z',
      state,
      isCrossRepository: false,
      headRepositoryOwner: { login: 'example' },
      reviewDecision: null,
      mergeable: 'MERGEABLE',
      statusCheckRollup: [],
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    };
  }

  // Answers `gh pr list`/`gh pr view` from scriptable fields; every other
  // command (git worktree/status/rev-parse/fetch/reset) falls through to
  // the real runner, same idiom as the API-level describe block below.
  class PollRunner {
    calls: string[][] = [];
    listPayload: Record<string, unknown>[];
    listOk = true;
    viewByNumber = new Map<number, CommandResult>();

    constructor(listPayload: Record<string, unknown>[]) {
      this.listPayload = listPayload;
    }

    run: CommandRunner = async (cwd, cmd) => {
      this.calls.push(cmd);
      if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'list') {
        if (cmd.includes('merged')) {
          return { ok: true, stdout: '[]', stderr: '' };
        }
        return this.listOk
          ? { ok: true, stdout: JSON.stringify(this.listPayload), stderr: '' }
          : { ok: false, stdout: '', stderr: 'rate limited' };
      }
      if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'view') {
        const number = Number(cmd[3]);
        return (
          this.viewByNumber.get(number) ?? {
            ok: false,
            stdout: '',
            stderr: 'no such PR',
          }
        );
      }
      return defaultCommandRunner(cwd, cmd);
    };
  }

  it('syncs an open cached PR’s worktree during the poll', async () => {
    const { repo, branch, headOid } = setUpRepoWithPrRef(501);
    const harness = makeHarness(repo);
    const runner = new PollRunner([prListItem(501, headOid)]);
    const worktrees = new PrWorktreeManager({
      rootDir: repo,
      run: runner.run,
      fetchHead: realFetchHead(repo, branch),
    });
    const prManager = new PrManager(
      { ...harness, prWorktrees: worktrees },
      true,
      runner.run
    );
    const created = await worktrees.create(501);
    cleanupPaths.push(created.path);

    // A new commit lands on the pr branch; the "cached" PR's headRefOid
    // moves with it, simulating gh reporting the new head on the next poll.
    runGitSync(repo, ['checkout', branch]);
    writeFileSync(join(repo, 'contributor.txt'), 'second pass\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'more work']);
    runGitSync(repo, ['push', 'origin', branch]);
    const newHeadOid = runGitSync(repo, ['rev-parse', branch]).trim();
    runGitSync(repo, ['checkout', 'main']);
    runner.listPayload = [prListItem(501, newHeadOid)];

    await prManager.pollOnce();

    const listed = await worktrees.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].headOid).toBe(newHeadOid);
  });

  it('removes a worktree once its PR is confirmed merged and absent from the open list', async () => {
    const { repo, headOid } = setUpRepoWithPrRef(502);
    const harness = makeHarness(repo);
    const runner = new PollRunner([]); // PR 502 not in the open list
    runner.viewByNumber.set(502, {
      ok: true,
      stdout: JSON.stringify(prListItem(502, headOid, 'MERGED')),
      stderr: '',
    });
    const worktrees = new PrWorktreeManager({
      rootDir: repo,
      run: runner.run,
      fetchHead: async () => {},
    });
    const prManager = new PrManager(
      { ...harness, prWorktrees: worktrees },
      true,
      runner.run
    );
    const created = await worktrees.create(502);
    cleanupPaths.push(created.path);

    await prManager.pollOnce();

    expect(existsSync(created.path)).toBe(false);
  });

  it('does nothing when no PrWorktreeManager is wired in', async () => {
    const repo = initGitRepo('dispatch-pr-worktree-poll-noop-');
    cleanupPaths.push(repo);
    const harness = makeHarness(repo);
    const runner = new PollRunner([prListItem(503, 'sha-503')]);
    const prManager = new PrManager(harness, true, runner.run);

    await expect(prManager.pollOnce()).resolves.toBeUndefined();
    expect(
      runner.calls.some((c) => c[0] === 'git' && c[1] === 'worktree')
    ).toBe(false);
  });

  it('never removes when the cache has not filled at least once (cacheReady false)', async () => {
    const { repo } = setUpRepoWithPrRef(504);
    const harness = makeHarness(repo);
    const runner = new PollRunner([]);
    runner.listOk = false; // gh pr list always fails -> cache never fills
    const worktrees = new PrWorktreeManager({
      rootDir: repo,
      run: runner.run,
      fetchHead: async () => {},
    });
    const prManager = new PrManager(
      { ...harness, prWorktrees: worktrees },
      true,
      runner.run
    );
    const created = await worktrees.create(504);
    cleanupPaths.push(created.path);

    await prManager.pollOnce();

    expect(existsSync(created.path)).toBe(true);
    expect(
      runner.calls.some(
        (c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'view'
      )
    ).toBe(false);
  });

  // Task 7 review, IMPORTANT 6: a PR beyond the open list's own --limit 50
  // reads exactly like a merged/closed one (absent from the cache) — must
  // not be deleted unless findRepoPr confirms it's really not OPEN.
  it('does not remove a worktree for a PR that fell off the open list’s page but is still OPEN', async () => {
    const { repo, headOid } = setUpRepoWithPrRef(505);
    const harness = makeHarness(repo);
    const runner = new PollRunner([]); // PR 505 not in the (simulated) page
    runner.viewByNumber.set(505, {
      ok: true,
      stdout: JSON.stringify(prListItem(505, headOid, 'OPEN')),
      stderr: '',
    });
    const worktrees = new PrWorktreeManager({
      rootDir: repo,
      run: runner.run,
      fetchHead: async () => {},
    });
    const prManager = new PrManager(
      { ...harness, prWorktrees: worktrees },
      true,
      runner.run
    );
    const created = await worktrees.create(505);
    cleanupPaths.push(created.path);

    await prManager.pollOnce();

    expect(existsSync(created.path)).toBe(true);
  });

  // Task 7 review, IMPORTANT 5: ignored files (.env, build output, …) never
  // show up in a plain `git status --porcelain` clean check — unattended
  // auto-removal must not silently delete them, even once the PR is
  // confirmed closed.
  it('skips auto-removal when the worktree has git-ignored files', async () => {
    const { repo, branch, headOid } = setUpRepoWithPrRef(506);
    // Commit .gitignore on the contributor branch first — see
    // hasIgnoredFiles's own test for why (an untracked .gitignore would
    // itself read as a plain dirty change, defeating the point).
    runGitSync(repo, ['checkout', branch]);
    writeFileSync(join(repo, '.gitignore'), 'ignored.env\n');
    runGitSync(repo, ['add', '-A']);
    runGitSync(repo, ['commit', '-m', 'add gitignore']);
    const withGitignoreOid = runGitSync(repo, ['rev-parse', 'HEAD']).trim();
    runGitSync(repo, ['checkout', 'main']);
    runGitSync(repo, ['update-ref', prHeadRef(506), withGitignoreOid]);

    const harness = makeHarness(repo);
    const runner = new PollRunner([]);
    runner.viewByNumber.set(506, {
      ok: true,
      stdout: JSON.stringify(prListItem(506, headOid, 'CLOSED')),
      stderr: '',
    });
    const worktrees = new PrWorktreeManager({
      rootDir: repo,
      run: runner.run,
      fetchHead: async () => {},
    });
    const prManager = new PrManager(
      { ...harness, prWorktrees: worktrees },
      true,
      runner.run
    );
    const created = await worktrees.create(506);
    cleanupPaths.push(created.path);
    writeFileSync(join(created.path, 'ignored.env'), 'SECRET=1\n');

    await prManager.pollOnce();

    expect(existsSync(created.path)).toBe(true);
  });
});

// End-to-end route coverage: the API layer's fork gate + create/remove
// wiring, over a real HTTP server and a real repo (gh itself is stubbed —
// same idiom as prs-api.test.ts's stubRunner).
describe('POST/DELETE /api/prs/:number/worktree', () => {
  let root: string;
  let fakeHome: string;
  let handle: ServerHandle;
  let baseUrl: string;
  const originalDispatchHome = process.env.DISPATCH_HOME;

  const REPO_PR = {
    number: PR_NUMBER,
    title: 'Add a feature',
    url: `https://github.com/example/repo/pull/${PR_NUMBER}`,
    headRefName: 'contributor-branch',
    baseRefName: 'main',
    headRefOid: '',
    author: { login: 'someone' },
    isDraft: false,
    updatedAt: '2026-08-10T00:00:00Z',
    state: 'OPEN',
    isCrossRepository: false,
    headRepositoryOwner: { login: 'example' },
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    statusCheckRollup: [],
    additions: 1,
    deletions: 0,
    changedFiles: 1,
  };

  function stubRunner(headOid: string) {
    return async (_cwd: string, cmd: string[]): Promise<CommandResult> => {
      if (cmd[0] === 'gh' && cmd[1] === '--version') {
        return { ok: true, stdout: 'gh version 2.0.0', stderr: '' };
      }
      if (
        cmd[0] === 'git' &&
        cmd[1] === 'remote' &&
        cmd[2] === 'get-url' &&
        cmd[3] === 'origin'
      ) {
        return {
          ok: true,
          stdout: 'https://github.com/example/repo.git',
          stderr: '',
        };
      }
      if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'list') {
        // getLandingSnapshot's separate `--state merged` call — empty, so it
        // doesn't also count this same PR as landed history.
        if (cmd.includes('merged')) {
          return { ok: true, stdout: '[]', stderr: '' };
        }
        return {
          ok: true,
          stdout: JSON.stringify([{ ...REPO_PR, headRefOid: headOid }]),
          stderr: '',
        };
      }
      // fetchPrHead's own fetch — the stub answers ok without touching the
      // repo; the test creates the ref itself (mirrors prs-api.test.ts).
      if (cmd[0] === 'git' && cmd[1] === 'fetch') {
        return { ok: true, stdout: '', stderr: '' };
      }
      if (cmd[0] === 'git' && cmd[1] === 'merge-base') {
        return { ok: true, stdout: `${headOid}\n`, stderr: '' };
      }
      // Everything else — `git worktree add/remove/list`, `git status`,
      // `git rev-parse`, `git update-ref -d` (deletePrHeadRef) — is
      // PrWorktreeManager's own real work against `root`, a real repo.
      // Falling through to the real runner (rather than failing) is what
      // lets these tests assert real filesystem/git state.
      return defaultCommandRunner(_cwd, cmd);
    };
  }

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
    process.env.DISPATCH_HOME = fakeHome;
    root = initGitRepo();
    TaskStore.init(root);
  });

  afterEach(async () => {
    if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalDispatchHome;
    await handle.stop();
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a worktree at the expected path and the DELETE route removes it', async () => {
    const headOid = runGitSync(root, ['rev-parse', 'HEAD']).trim();
    runGitSync(root, ['update-ref', prHeadRef(PR_NUMBER), headOid]);

    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner(headOid),
      registerExecutors: (o) => {
        o.registerExecutor(
          'fake',
          new FakeExecutor({ finish: { state: 'finished' } })
        );
      },
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
    // Populates PrManager.cachedPrs() deterministically — GET /api/landing's
    // `pr` rows read from there, not from a fresh `gh pr list` per request.
    await handle.prManager.pollOnce();

    const createRes = await fetch(`${baseUrl}/api/prs/${PR_NUMBER}/worktree`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(createRes.status).toBe(200);
    const created = await json(createRes);
    expect(created.path).toBe(handle.prWorktrees.worktreePathFor(PR_NUMBER));
    expect(created.headOid).toBe(headOid);
    expect(existsSync(created.path)).toBe(true);

    const landingRes = await fetch(`${baseUrl}/api/landing`);
    expect(landingRes.status).toBe(200);
    const landing = await json(landingRes);
    const row = landing.rows.find(
      (r: { id: string }) => r.id === `pr-${PR_NUMBER}`
    );
    expect(row?.worktree?.syncState).toBe('synced');
    expect(row?.worktree?.path).toBe(created.path);

    const deleteRes = await fetch(`${baseUrl}/api/prs/${PR_NUMBER}/worktree`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
    expect(existsSync(created.path)).toBe(false);
  });

  it('409s with the kept state when the worktree is dirty', async () => {
    const headOid = runGitSync(root, ['rev-parse', 'HEAD']).trim();
    runGitSync(root, ['update-ref', prHeadRef(PR_NUMBER), headOid]);

    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner(headOid),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const createRes = await fetch(`${baseUrl}/api/prs/${PR_NUMBER}/worktree`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    const created = await json(createRes);
    writeFileSync(join(created.path, 'scratch.txt'), 'wip\n');

    const deleteRes = await fetch(`${baseUrl}/api/prs/${PR_NUMBER}/worktree`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(409);
    const body = await json(deleteRes);
    expect(body.dirty).toBe(true);
    expect(existsSync(created.path)).toBe(true);
  });

  // Task 7 review, IMPORTANT 9: resolveRepoPrByNumber resolves a closed PR
  // too (findRepoPr's `gh pr view` fallback) — creating a worktree for one
  // is refused up front rather than left for the next poll pass to delete.
  it('409s creating a worktree for a closed PR, naming the state', async () => {
    const headOid = runGitSync(root, ['rev-parse', 'HEAD']).trim();
    const closedNumber = PR_NUMBER + 1;
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: async (cwd, cmd) => {
        if (
          cmd[0] === 'gh' &&
          cmd[1] === 'pr' &&
          cmd[2] === 'view' &&
          cmd[3] === String(closedNumber)
        ) {
          return {
            ok: true,
            stdout: JSON.stringify({
              ...REPO_PR,
              number: closedNumber,
              state: 'CLOSED',
            }),
            stderr: '',
          };
        }
        return stubRunner(headOid)(cwd, cmd);
      },
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/${closedNumber}/worktree`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error).toContain('closed');
    expect(existsSync(handle.prWorktrees.worktreePathFor(closedNumber))).toBe(
      false
    );
  });
});
