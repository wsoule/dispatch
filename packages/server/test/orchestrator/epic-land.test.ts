import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { epicBranchName } from '../../src/orchestrator/epicBranch.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { epicPrsPath } from '../../src/orchestrator/paths.js';
import type { CommandResult } from '../../src/orchestrator/pr.js';
import { PrManager } from '../../src/orchestrator/pr.js';
import { OrchestratorConflictError } from '../../src/orchestrator/types.js';
import { ReviewCommentStore } from '../../src/reviewComments.js';
import { initGitRepo, runGitSync } from './helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-epic-land-');
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

function makeHarness() {
  const store = TaskStore.init(repo);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({
    rootDir: repo,
    store,
    cache,
    events,
  });
  orchestrator.registerExecutor(
    'fake',
    new FakeExecutor({ finish: { state: 'finished' } })
  );
  const reviewComments = new ReviewCommentStore(repo, 'human:test');
  return { rootDir: repo, store, cache, events, orchestrator, reviewComments };
}

type Harness = ReturnType<typeof makeHarness>;

// Dispatches `taskId`, waits for the fake run to finish, and commits one real
// file on its branch — same helper shape as epic-branch.test.ts.
async function dispatchWithWork(
  h: Harness,
  taskId: string,
  file: string,
  content = file
): Promise<string> {
  const meta = await h.orchestrator.dispatch(taskId, 'fake');
  await waitFor(
    () => h.orchestrator.getRun(meta.id)?.meta.state === 'finished'
  );
  const run = h.orchestrator.list().find((r) => r.id === meta.id)!;
  writeFileSync(join(run.worktreePath, file), `${content}\n`);
  runGitSync(run.worktreePath, ['add', '-A']);
  runGitSync(run.worktreePath, ['commit', '-m', `add ${file}`]);
  return meta.id;
}

function fileOnBranch(branch: string, file: string): string | null {
  const result = Bun.spawnSync(['git', 'show', `${branch}:${file}`], {
    cwd: repo,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.exitCode === 0 ? result.stdout.toString('utf8') : null;
}

function branchExists(branch: string): boolean {
  return runGitSync(repo, ['branch', '--list', branch]).trim() !== '';
}

// An epic with two children whose work has already merged onto the epic
// branch — the "finished, ready to land" starting state most tests want.
async function makeFinishedEpic(
  h: Harness
): Promise<{ epicId: string; branch: string }> {
  const epic = h.store.create({ title: 'The epic', kind: 'epic' });
  const a = h.store.create({ title: 'Child A', parent: epic.meta.id });
  const b = h.store.create({ title: 'Child B', parent: epic.meta.id });
  h.cache.rebuild(h.store);
  const runA = await dispatchWithWork(h, a.meta.id, 'a.txt', 'A work');
  h.orchestrator.review(runA, 'merge');
  const runB = await dispatchWithWork(h, b.meta.id, 'b.txt', 'B work');
  h.orchestrator.review(runB, 'merge');
  return { epicId: epic.meta.id, branch: epicBranchName(epic.meta.id) };
}

// The PR-path test double for gh/git — the same seam pr.test.ts's StubRunner
// covers, trimmed to the three commands the epic land path issues.
class EpicStubRunner {
  readonly calls: { cwd: string; cmd: string[] }[] = [];
  pushResult: CommandResult = { ok: true, stdout: '', stderr: '' };
  createResult: CommandResult = {
    ok: true,
    stdout: 'https://github.com/example/repo/pull/7\n',
    stderr: '',
  };
  viewResult: CommandResult = {
    ok: true,
    stdout: JSON.stringify({ state: 'OPEN' }),
    stderr: '',
  };

  run = (cwd: string, cmd: string[]): Promise<CommandResult> => {
    this.calls.push({ cwd, cmd });
    if (cmd[0] === 'git' && cmd[1] === 'push') {
      return Promise.resolve(this.pushResult);
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'create') {
      return Promise.resolve(this.createResult);
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'view') {
      return Promise.resolve(this.viewResult);
    }
    return Promise.resolve({ ok: true, stdout: '', stderr: '' });
  };
}

describe('landing an epic locally', () => {
  it('lands the finished epic branch on main as one two-parent merge commit and closes the epic out', async () => {
    const h = makeHarness();
    const { epicId, branch } = await makeFinishedEpic(h);
    const epicTip = runGitSync(repo, ['rev-parse', branch]).trim();

    const result = h.orchestrator.landEpicLocally(epicId);

    // Both children's files reached main through the one merge commit.
    expect(fileOnBranch('main', 'a.txt')).toBe('A work\n');
    expect(fileOnBranch('main', 'b.txt')).toBe('B work\n');
    expect(result.mergeCommit).toBe(
      runGitSync(repo, ['rev-parse', 'main']).trim()
    );
    // A true merge: main's tip has two parents, the second being the epic tip
    // — that is what makes the epic revertible as a unit.
    const parents = runGitSync(repo, [
      'rev-list',
      '--parents',
      '-n1',
      result.mergeCommit!,
    ])
      .trim()
      .split(' ');
    expect(parents.length).toBe(3);
    expect(parents[2]).toBe(epicTip);
    // Epic closed out like review-merge closes a run.
    expect(h.store.get(epicId)?.meta.status).toBe('landed');
    expect(h.store.get(epicId)?.body).toContain('landed on main');
    expect(branchExists(branch)).toBe(false);
  });

  it('keeps serving the epic diff from the snapshot after the branch is gone', async () => {
    const h = makeHarness();
    const { epicId, branch } = await makeFinishedEpic(h);
    const liveDiff = h.orchestrator.epicDiff(epicId);
    expect(liveDiff.files.map((f) => f.path).sort()).toEqual([
      'a.txt',
      'b.txt',
    ]);

    h.orchestrator.landEpicLocally(epicId);

    expect(branchExists(branch)).toBe(false);
    const snapshot = h.orchestrator.epicDiff(epicId);
    expect(snapshot.files.map((f) => f.path).sort()).toEqual([
      'a.txt',
      'b.txt',
    ]);
    expect(snapshot.patch).toContain('A work');
  });

  it('uses the checkout-free plumbing merge when main is not checked out', async () => {
    const h = makeHarness();
    const { epicId } = await makeFinishedEpic(h);
    // A repo with no remote resolves its default base to the CURRENT branch,
    // so checking out `elsewhere` alone would move the target with it. Pin
    // origin/HEAD at main the way a real clone has it — that is the setup
    // where the not-checked-out case actually occurs.
    runGitSync(repo, ['update-ref', 'refs/remotes/origin/main', 'main']);
    runGitSync(repo, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    ]);
    runGitSync(repo, ['checkout', '-b', 'elsewhere']);
    const elsewhereTip = runGitSync(repo, ['rev-parse', 'HEAD']).trim();

    const result = h.orchestrator.landEpicLocally(epicId);

    // Main moved (and carries the work) without the checkout ever leaving
    // `elsewhere` or its tip moving.
    expect(fileOnBranch('main', 'a.txt')).toBe('A work\n');
    expect(runGitSync(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      'elsewhere'
    );
    expect(runGitSync(repo, ['rev-parse', 'HEAD']).trim()).toBe(elsewhereTip);
    expect(result.mergeCommit).toBe(
      runGitSync(repo, ['rev-parse', 'main']).trim()
    );
    expect(h.store.get(epicId)?.meta.status).toBe('landed');
  });

  it('refuses a partially-done epic with a message naming the pending children', async () => {
    const h = makeHarness();
    const epic = h.store.create({ title: 'The epic', kind: 'epic' });
    const a = h.store.create({ title: 'Child A', parent: epic.meta.id });
    const b = h.store.create({ title: 'Child B', parent: epic.meta.id });
    h.cache.rebuild(h.store);
    const runA = await dispatchWithWork(h, a.meta.id, 'a.txt');
    h.orchestrator.review(runA, 'merge');
    // Child B never dispatched — still `todo`.

    const branch = epicBranchName(epic.meta.id);
    expect(() => h.orchestrator.landEpicLocally(epic.meta.id)).toThrow(
      /partially done — 1 of 2 child task\(s\) still pending/
    );
    expect(() => h.orchestrator.landEpicLocally(epic.meta.id)).toThrow(
      new RegExp(`${b.meta.id}: ready`)
    );
    // Nothing landed, nothing was cleaned up, the epic stays open.
    expect(branchExists(branch)).toBe(true);
    expect(fileOnBranch('main', 'a.txt')).toBeNull();
    expect(h.store.get(epic.meta.id)?.meta.status).not.toBe('landed');
  });

  it('refuses while an in-review child has not merged onto the epic branch yet', async () => {
    const h = makeHarness();
    const epic = h.store.create({ title: 'The epic', kind: 'epic' });
    const a = h.store.create({ title: 'Child A', parent: epic.meta.id });
    h.cache.rebuild(h.store);
    // Finished but never reviewed: the task sits at `in-review`.
    await dispatchWithWork(h, a.meta.id, 'a.txt');

    expect(() => h.orchestrator.landEpicLocally(epic.meta.id)).toThrow(
      /partially done/
    );
  });

  it('refuses when a leftover unreviewed run is still based on the epic branch', async () => {
    const h = makeHarness();
    const epic = h.store.create({ title: 'The epic', kind: 'epic' });
    const a = h.store.create({ title: 'Child A', parent: epic.meta.id });
    h.cache.rebuild(h.store);
    const runA = await dispatchWithWork(h, a.meta.id, 'a.txt');
    // The task gets hand-flipped past review while the run still exists —
    // landing would delete the branch that run's diff/merge are anchored on.
    h.store.update(a.meta.id, { status: 'landed' });
    h.cache.rebuild(h.store);

    expect(() => h.orchestrator.landEpicLocally(epic.meta.id)).toThrow(
      new RegExp(`unreviewed run ${runA}`)
    );
  });

  it('refuses an epic that never grew an integration branch', () => {
    const h = makeHarness();
    const epic = h.store.create({ title: 'The epic', kind: 'epic' });
    h.store.create({ title: 'Child A', parent: epic.meta.id });
    h.cache.rebuild(h.store);

    expect(() => h.orchestrator.landEpicLocally(epic.meta.id)).toThrow(
      /no integration branch to land/
    );
  });

  it('refuses when the default base has no local branch to land onto', async () => {
    const h = makeHarness();
    const { epicId, branch } = await makeFinishedEpic(h);
    // origin/HEAD names a default branch that was never checked out locally —
    // landing must refuse rather than close the epic out with nothing landed.
    runGitSync(repo, ['update-ref', 'refs/remotes/origin/trunk', 'main']);
    runGitSync(repo, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/trunk',
    ]);

    expect(() => h.orchestrator.landEpicLocally(epicId)).toThrow(
      /default base branch trunk does not exist locally/
    );
    expect(branchExists(branch)).toBe(true);
    expect(h.store.get(epicId)?.meta.status).not.toBe('landed');
  });

  it('refuses to land the same epic twice', async () => {
    const h = makeHarness();
    const { epicId } = await makeFinishedEpic(h);
    h.orchestrator.landEpicLocally(epicId);

    expect(() => h.orchestrator.landEpicLocally(epicId)).toThrow(
      /already landed/
    );
  });

  it('closes out an epic whose branch carries no commits without inventing a merge', async () => {
    const h = makeHarness();
    const epic = h.store.create({ title: 'The epic', kind: 'epic' });
    const a = h.store.create({ title: 'Child A', parent: epic.meta.id });
    h.cache.rebuild(h.store);
    // Dispatch and merge with no work committed: the epic branch exists but
    // its tip content equals main's.
    const meta = await h.orchestrator.dispatch(a.meta.id, 'fake');
    await waitFor(
      () => h.orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );
    h.orchestrator.review(meta.id, 'merge');
    const branch = epicBranchName(epic.meta.id);
    const mainTip = runGitSync(repo, ['rev-parse', 'main']).trim();

    const result = h.orchestrator.landEpicLocally(epic.meta.id);

    expect(result.mergeCommit).toBeUndefined();
    expect(h.store.get(epic.meta.id)?.meta.status).toBe('landed');
    expect(branchExists(branch)).toBe(false);
    expect(h.store.get(epic.meta.id)?.body).toContain('no commits to merge');
    // Main gained exactly the epic's own task-file bookkeeping commit —
    // never a content merge.
    expect(
      runGitSync(repo, ['rev-list', '--count', `${mainTip}..main`]).trim()
    ).toBe('1');
    expect(fileOnBranch('main', 'a.txt')).toBeNull();
  });
});

describe('landing an epic via PR', () => {
  it('pushes the epic branch and opens one PR against main, refusing a second', async () => {
    const h = makeHarness();
    const { epicId, branch } = await makeFinishedEpic(h);
    const stub = new EpicStubRunner();
    const pr = new PrManager(h, true, stub.run);

    const url = await pr.openEpicPr(epicId);

    expect(url).toBe('https://github.com/example/repo/pull/7');
    const push = stub.calls.find(
      (c) => c.cmd[0] === 'git' && c.cmd[1] === 'push'
    );
    expect(push?.cmd).toEqual(['git', 'push', '-u', 'origin', branch]);
    const create = stub.calls.find(
      (c) => c.cmd[0] === 'gh' && c.cmd[2] === 'create'
    );
    expect(create?.cmd).toContain('--base');
    expect(create?.cmd).toContain('main');
    expect(create?.cmd).toContain('--head');
    expect(create?.cmd).toContain(branch);
    // Recorded on the epic's Activity and in the persisted ledger; the epic
    // itself stays open until the poller sees the merge.
    expect(h.store.get(epicId)?.body).toContain(`opened landing PR: ${url}`);
    expect(existsSync(epicPrsPath(repo))).toBe(true);
    expect(pr.epicPrUrl(epicId)).toBe(url);
    expect(h.store.get(epicId)?.meta.status).not.toBe('landed');

    await expect(pr.openEpicPr(epicId)).rejects.toThrow(
      /already has an open landing PR/
    );
  });

  it('refuses the PR path for a partially-done epic too', async () => {
    const h = makeHarness();
    const epic = h.store.create({ title: 'The epic', kind: 'epic' });
    const a = h.store.create({ title: 'Child A', parent: epic.meta.id });
    h.store.create({ title: 'Child B', parent: epic.meta.id });
    h.cache.rebuild(h.store);
    const runA = await dispatchWithWork(h, a.meta.id, 'a.txt');
    h.orchestrator.review(runA, 'merge');
    const stub = new EpicStubRunner();
    const pr = new PrManager(h, true, stub.run);

    await expect(pr.openEpicPr(epic.meta.id)).rejects.toThrow(
      OrchestratorConflictError
    );
    // Validation refused before any git/gh command ran.
    expect(stub.calls.length).toBe(0);
  });

  it('closes the epic out when the poller sees the PR merged — across a manager restart', async () => {
    const h = makeHarness();
    const { epicId, branch } = await makeFinishedEpic(h);
    const stub = new EpicStubRunner();
    const pr = new PrManager(h, true, stub.run);
    const url = await pr.openEpicPr(epicId);

    // A fresh PrManager (a daemon restart) reads the persisted ledger.
    const restarted = new PrManager(h, true, stub.run);
    stub.viewResult = {
      ok: true,
      stdout: JSON.stringify({ state: 'MERGED' }),
      stderr: '',
    };
    await restarted.pollOnce();

    expect(h.store.get(epicId)?.meta.status).toBe('landed');
    expect(h.store.get(epicId)?.body).toContain(`landed via PR (${url})`);
    expect(branchExists(branch)).toBe(false);
    // The record is gone, so the next pass has nothing left to poll.
    expect(restarted.epicPrUrl(epicId)).toBeUndefined();
    // The snapshot survives for the review surface.
    const snapshot = h.orchestrator.epicDiff(epicId);
    expect(snapshot.files.map((f) => f.path).sort()).toEqual([
      'a.txt',
      'b.txt',
    ]);
  });

  it('drops the record without closing the epic when the PR is closed unmerged', async () => {
    const h = makeHarness();
    const { epicId, branch } = await makeFinishedEpic(h);
    const stub = new EpicStubRunner();
    const pr = new PrManager(h, true, stub.run);
    const url = await pr.openEpicPr(epicId);

    stub.viewResult = {
      ok: true,
      stdout: JSON.stringify({ state: 'CLOSED' }),
      stderr: '',
    };
    await pr.pollOnce();

    expect(h.store.get(epicId)?.meta.status).not.toBe('landed');
    expect(branchExists(branch)).toBe(true);
    expect(pr.epicPrUrl(epicId)).toBeUndefined();
    expect(h.store.get(epicId)?.body).toContain(
      `landing PR closed without merging (${url})`
    );
  });
});
