import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import type { CommandResult } from '../src/orchestrator/pr.js';
import { defaultCommandRunner } from '../src/orchestrator/pr.js';
import {
  PrWorktreeManager,
  toLandingWorktree,
} from '../src/orchestrator/prWorktree.js';
import { json } from './json.js';
import {
  initBareRepo,
  initGitRepo,
  runGitSync,
} from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

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
});
