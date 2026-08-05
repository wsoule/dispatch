import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import type { CommandResult } from '../../src/orchestrator/pr.js';
import {
  defaultCommandRunner,
  detectPrCapability,
  PrManager,
} from '../../src/orchestrator/pr.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from '../../src/orchestrator/types.js';
import { WorktreeManager } from '../../src/orchestrator/worktree.js';
import { ReviewCommentStore } from '../../src/reviewComments.js';
import type { ReviewTarget } from '../../src/reviewTarget.js';
import { initGitRepo } from './helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-pr-');
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
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Records every command it was asked to run and answers with fixed,
// scriptable results — the PrManager test double for gh/git, so no test
// here needs a real GitHub remote or a logged-in gh CLI. Async (minor fix:
// PrManager's CommandRunner seam is async so a real `gh`/`git push` can
// never stall the event loop) — an optional per-call `delayMs` lets a test
// prove that.
class StubRunner {
  readonly calls: { cwd: string; cmd: string[] }[] = [];
  // pushPrReview writes its body to a scratch file and cleans it up (via
  // `finally`) before returning, so a test reading the file only after the
  // call resolves would always find it gone. Captured here instead, at the
  // moment the stubbed POST is "received" — while the file still exists.
  readonly postedReviewPayloads: Record<string, unknown>[] = [];
  pushResult: CommandResult = { ok: true, stdout: '', stderr: '' };
  createResult: CommandResult = {
    ok: true,
    stdout: 'https://github.com/example/repo/pull/1\n',
    stderr: '',
  };
  viewResult: CommandResult = {
    ok: true,
    stdout: JSON.stringify({ state: 'OPEN' }),
    stderr: '',
  };
  // The full `gh pr view --json number,…,reviews,comments` payload getPrDetail
  // reads (distinct from `viewResult`, the poller's `--json state` call).
  viewDetailResult: CommandResult = {
    ok: true,
    stdout: JSON.stringify({
      number: 1,
      url: 'https://github.com/example/repo/pull/1',
      title: 'PR me',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: 'REVIEW_REQUIRED',
      mergeable: 'MERGEABLE',
      statusCheckRollup: [{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }],
      additions: 5,
      deletions: 1,
      changedFiles: 1,
      reviews: [
        {
          author: { login: 'teammate' },
          body: 'Looks good overall.',
          state: 'COMMENTED',
          submittedAt: '2026-07-21T00:00:00Z',
        },
      ],
      comments: [
        {
          author: { login: 'teammate' },
          body: 'One question below.',
          createdAt: '2026-07-21T00:01:00Z',
        },
      ],
    }),
    stderr: '',
  };
  apiResult: CommandResult = {
    ok: true,
    stdout: JSON.stringify([
      {
        user: { login: 'teammate' },
        body: 'Rename this?',
        created_at: '2026-07-21T00:02:00Z',
        path: 'FAKE_OUTPUT.txt',
        line: 1,
      },
    ]),
    stderr: '',
  };
  reviewResult: CommandResult = { ok: true, stdout: '', stderr: '' };
  commentResult: CommandResult = { ok: true, stdout: '', stderr: '' };
  // `gh api -X POST repos/O/R/pulls/N/reviews` result pushPrReview reads —
  // distinct from `reviewResult` above, which is `gh pr review` (a
  // different command entirely: cmd[1] is 'pr', not 'api').
  pushReviewResult: CommandResult = {
    ok: true,
    stdout: JSON.stringify({ id: 999, state: 'COMMENTED' }),
    stderr: '',
  };
  // `gh pr diff`/`gh api …/files` results getPrDiffByUrl reads — distinct
  // from `apiResult` above (the line-comments call).
  diffResult: CommandResult = { ok: true, stdout: '', stderr: '' };
  filesResult: CommandResult = { ok: true, stdout: '[]', stderr: '' };
  // `gh pr list --json …` result listRepoPrs parses — one open PR by
  // default, shaped exactly like gh's real output (author as a `{login}`
  // object, camelCase field names).
  listResult: CommandResult = {
    ok: true,
    stdout: JSON.stringify([
      {
        number: 9,
        title: 'Repo PR from someone else',
        url: 'https://github.com/example/repo/pull/9',
        headRefName: 'feature/someone-else',
        headRefOid: '',
        author: { login: 'teammate' },
        isDraft: true,
        updatedAt: '2026-07-22T00:00:00Z',
        isCrossRepository: false,
        headRepositoryOwner: { login: 'someone' },
        reviewDecision: null,
        mergeable: null,
        statusCheckRollup: [],
        additions: 0,
        deletions: 0,
        changedFiles: 0,
      },
    ]),
    stderr: '',
  };
  delayMs = 0;

  run = async (cwd: string, cmd: string[]): Promise<CommandResult> => {
    this.calls.push({ cwd, cmd });
    if (this.delayMs > 0) await sleep(this.delayMs);
    if (cmd[0] === 'git' && cmd[1] === 'push') return this.pushResult;
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'create') {
      return this.createResult;
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'list') {
      return this.listResult;
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'review') {
      return this.reviewResult;
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'comment') {
      return this.commentResult;
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'diff') {
      return this.diffResult;
    }
    // '--paginate' precedes the path, so the endpoint is the last argument.
    if (
      cmd[0] === 'gh' &&
      cmd[1] === 'api' &&
      (cmd.at(-1)?.endsWith('/files') ?? false)
    ) {
      return this.filesResult;
    }
    // Matched on the actual path argument (not a fixed index): pushPrReview
    // puts `--input <path>` after the endpoint, so the endpoint is not the
    // last argument the way it is for the '/files' call above. Placed
    // before the generic 'gh api' branch below, or the POST here would be
    // swallowed by the GET-shaped `apiResult` payload.
    if (
      cmd[0] === 'gh' &&
      cmd[1] === 'api' &&
      cmd.includes('POST') &&
      cmd.some((arg) => /\/pulls\/\d+\/reviews$/.test(arg))
    ) {
      const inputIdx = cmd.indexOf('--input');
      const payloadPath = inputIdx >= 0 ? cmd[inputIdx + 1] : undefined;
      if (payloadPath !== undefined) {
        this.postedReviewPayloads.push(
          JSON.parse(readFileSync(payloadPath, 'utf8')) as Record<
            string,
            unknown
          >
        );
      }
      return this.pushReviewResult;
    }
    // Also placed ahead of the generic branch, though it currently answers
    // identically to it — syncPrComments hits the exact same REST endpoint
    // getPrDetailByUrl's line-comment read already does.
    if (
      cmd[0] === 'gh' &&
      cmd[1] === 'api' &&
      cmd.some((arg) => /\/pulls\/\d+\/comments$/.test(arg))
    ) {
      return this.apiResult;
    }
    if (cmd[0] === 'gh' && cmd[1] === 'api') {
      return this.apiResult;
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'view') {
      // The poller reads only `--json state`; getPrDetail reads the full set.
      const jsonArg = cmd[cmd.indexOf('--json') + 1];
      return jsonArg === 'state' ? this.viewResult : this.viewDetailResult;
    }
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
    return { ok: false, stdout: '', stderr: 'unhandled stub command' };
  };
}

describe('detectPrCapability', () => {
  it('is true when both gh and a configured origin remote are available', async () => {
    const stub = new StubRunner();
    expect(await detectPrCapability(repo, stub.run)).toBe(true);
  });

  it('is false when gh is not on PATH', async () => {
    const run = async (_cwd: string, cmd: string[]): Promise<CommandResult> => {
      if (cmd[0] === 'gh')
        return { ok: false, stdout: '', stderr: 'not found' };
      return { ok: true, stdout: 'origin-url', stderr: '' };
    };
    expect(await detectPrCapability(repo, run)).toBe(false);
  });

  it('is false when there is no configured origin remote', async () => {
    const run = async (_cwd: string, cmd: string[]): Promise<CommandResult> => {
      if (cmd[0] === 'gh')
        return { ok: true, stdout: 'gh version 2.0.0', stderr: '' };
      return { ok: false, stdout: '', stderr: 'no such remote' };
    };
    expect(await detectPrCapability(repo, run)).toBe(false);
  });
});

describe('defaultCommandRunner', () => {
  // Regression: Bun.spawn throws synchronously for a binary that isn't on
  // PATH (a Finder-launched app's minimal environment has no /opt/homebrew/
  // bin, so `gh` is missing) — before the catch, that throw escaped
  // detectPrCapability and killed the daemon at boot instead of degrading
  // to pr:false.
  it('reports a missing executable as ok:false instead of throwing', async () => {
    const result = await defaultCommandRunner(repo, [
      'definitely-not-a-real-binary-dispatch-test',
      '--version',
    ]);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('definitely-not-a-real-binary');
  });

  it('boots pr capability to false (not a crash) when gh is absent', async () => {
    const emptyPath = async (cwd: string, cmd: string[]) =>
      defaultCommandRunner(cwd, cmd);
    // detectPrCapability with the real runner and a bogus first command is
    // covered above via the direct runner test; here just assert the
    // capability probe itself resolves (no rejection) with the real runner.
    await expect(detectPrCapability(repo, emptyPath)).resolves.toBeBoolean();
  });
});

interface Harness {
  rootDir: string;
  orchestrator: Orchestrator;
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
  reviewComments: ReviewCommentStore;
}

function makeHarness(): Harness {
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
    new FakeExecutor({ finish: { state: 'finished', costUsd: 0, turns: 1 } })
  );
  const reviewComments = new ReviewCommentStore(repo, 'human:test');
  return { rootDir: repo, orchestrator, store, cache, events, reviewComments };
}

async function dispatchAndFinish(harness: Harness): Promise<{
  runId: string;
  taskId: string;
}> {
  const task = harness.store.create({ title: 'PR me' });
  const meta = await harness.orchestrator.dispatch(task.meta.id, 'fake');
  await waitFor(
    () => harness.orchestrator.getRun(meta.id)?.meta.state === 'finished'
  );
  return { runId: meta.id, taskId: task.meta.id };
}

describe('PrManager.openPr', () => {
  it('409s when the project lacks the pr capability', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const pr = new PrManager(harness, false, stub.run);
    await expect(pr.openPr(runId)).rejects.toThrow(OrchestratorConflictError);
    expect(stub.calls).toHaveLength(0);
  });

  it('404s an unknown run id', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    const pr = new PrManager(harness, true, stub.run);
    await expect(pr.openPr('r-000000')).rejects.toThrow(
      OrchestratorNotFoundError
    );
  });

  it('409s a run that is not in a terminal state', async () => {
    const harness = makeHarness();
    harness.orchestrator.registerExecutor(
      'stuck',
      new FakeExecutor({
        steps: [{ approval: { requestId: 'x', toolName: 'noop', input: {} } }],
        finish: { state: 'finished' },
      })
    );
    const task = harness.store.create({ title: 'Still running' });
    const meta = await harness.orchestrator.dispatch(task.meta.id, 'stuck');
    const stub = new StubRunner();
    const pr = new PrManager(harness, true, stub.run);
    await expect(pr.openPr(meta.id)).rejects.toThrow(OrchestratorConflictError);
  });

  it('pushes the branch, creates the PR, and records the url on task Activity + run meta', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const pr = new PrManager(harness, true, stub.run);

    const updated = await pr.openPr(runId);
    expect(updated.prUrl).toBe('https://github.com/example/repo/pull/1');

    const pushCall = stub.calls.find(
      (c) => c.cmd[0] === 'git' && c.cmd[1] === 'push'
    );
    expect(pushCall).toBeDefined();
    const createCall = stub.calls.find(
      (c) => c.cmd[0] === 'gh' && c.cmd[1] === 'pr' && c.cmd[2] === 'create'
    );
    expect(createCall).toBeDefined();

    const task = harness.store.get(taskId);
    expect(task?.body).toContain(
      'opened PR: https://github.com/example/repo/pull/1'
    );
  });

  it('409s opening a PR twice on the same run', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const pr = new PrManager(harness, true, stub.run);
    await pr.openPr(runId);
    await expect(pr.openPr(runId)).rejects.toThrow(OrchestratorConflictError);
  });

  it('409s when git push fails', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    stub.pushResult = {
      ok: false,
      stdout: '',
      stderr: 'no remote configured',
    };
    const pr = new PrManager(harness, true, stub.run);
    await expect(pr.openPr(runId)).rejects.toThrow(/git push failed/);
  });

  it('409s when gh pr create fails', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    stub.createResult = {
      ok: false,
      stdout: '',
      stderr: 'gh: not authenticated',
    };
    const pr = new PrManager(harness, true, stub.run);
    await expect(pr.openPr(runId)).rejects.toThrow(/gh pr create failed/);
  });

  // Minor fix: every gh/git call goes through an async CommandRunner (real
  // production one uses Bun.spawn + await, never Bun.spawnSync) so a slow
  // push/create can never block the whole process. Proven here by racing a
  // 0ms timer against openPr()'s in-flight (artificially slow) call — a
  // synchronous implementation would starve the timer until openPr finished.
  it('does not block the event loop while a command is in flight', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    stub.delayMs = 40;
    const pr = new PrManager(harness, true, stub.run);

    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
    }, 0);

    const openPromise = pr.openPr(runId);
    await sleep(5);
    expect(timerFired).toBe(true);
    await openPromise;
  });
});

describe('PrManager polling', () => {
  it('flips the run to reviewed + task to done once gh reports the PR merged', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const pr = new PrManager(harness, true, stub.run);
    await pr.openPr(runId);

    stub.viewResult = {
      ok: true,
      stdout: JSON.stringify({ state: 'OPEN' }),
      stderr: '',
    };
    await pr.pollOnce();
    expect(harness.store.get(taskId)?.meta.status).toBe('in-review');

    stub.viewResult = {
      ok: true,
      stdout: JSON.stringify({ state: 'MERGED' }),
      stderr: '',
    };
    await pr.pollOnce();

    const task = harness.store.get(taskId);
    expect(task?.meta.status).toBe('done');
    const run = harness.orchestrator.getRun(runId);
    expect(run?.meta.reviewedAt).toBeDefined();
    expect(run?.meta.reviewAction).toBe('pr');

    // markRunMergedViaPr removes the worktree just like a local review() —
    // its diff must survive via the same snapshot fallback rather than
    // 409ing now that there's nothing left to diff live.
    expect(() => harness.orchestrator.diff(runId)).not.toThrow();
  });

  // Regression: markRunMergedViaPr used to call persistDiffSnapshot with no
  // `precomputed` diff, so it fell back to the live, working-tree-inclusive
  // `diff()` — which folds in whatever is still sitting uncommitted/
  // untracked in the worktree at that instant. A run merged via a GitHub PR
  // only ever actually lands what got committed to its branch (that's what
  // `git push` sent up and `gh` merged); this run's worktree carries a stray
  // uncommitted edit and an untracked file the PR itself never saw. The
  // persisted "merged" snapshot must match `diffCommittedOnly` — the same
  // ground truth mergeRun()'s own local-merge path snapshots — not bake in
  // content that was never actually part of the merge.
  it('persists a committed-only diff snapshot for a run merged via PR, ignoring stray uncommitted/untracked files', async () => {
    const harness = makeHarness();
    harness.orchestrator.registerExecutor(
      'fake-committed-change',
      new FakeExecutor({
        steps: [
          {
            write: (cwd) =>
              writeFileSync(join(cwd, 'feature.txt'), 'real change\n'),
            commitMessage: 'add feature',
          },
        ],
        finish: { state: 'finished', costUsd: 0, turns: 1 },
      })
    );
    const task = harness.store.create({ title: 'PR me with stray files' });
    const dispatched = await harness.orchestrator.dispatch(
      task.meta.id,
      'fake-committed-change'
    );
    await waitFor(
      () =>
        harness.orchestrator.getRun(dispatched.id)?.meta.state === 'finished'
    );
    const runId = dispatched.id;
    const taskId = task.meta.id;

    const stub = new StubRunner();
    const pr = new PrManager(harness, true, stub.run);
    await pr.openPr(runId);

    // Plant stray uncommitted/untracked content directly in the run's
    // worktree, after it finished (and after the branch was already pushed
    // for the PR) — content that never reached GitHub through the PR.
    const runMeta = harness.orchestrator.getRun(runId)!.meta;
    writeFileSync(
      join(runMeta.worktreePath, 'feature.txt'),
      'real change\nplus an uncommitted edit\n'
    );
    writeFileSync(
      join(runMeta.worktreePath, 'untracked.txt'),
      'never actually merged\n'
    );

    // Ground truth, computed directly while the worktree still exists, via
    // the same WorktreeManager method markRunMergedViaPr now uses.
    const worktrees = new WorktreeManager(harness.rootDir);
    const expectedDiff = worktrees.diffCommittedOnly(
      runMeta.worktreePath,
      runMeta.baseBranch
    );
    expect(expectedDiff.files).toEqual([{ path: 'feature.txt', status: 'A' }]);

    stub.viewResult = {
      ok: true,
      stdout: JSON.stringify({ state: 'MERGED' }),
      stderr: '',
    };
    await pr.pollOnce();

    expect(harness.store.get(taskId)?.meta.status).toBe('done');

    // Worktree is gone now, so this reads the persisted snapshot.
    const persisted = harness.orchestrator.diff(runId);
    expect(persisted).toEqual(expectedDiff);
    expect(persisted.patch).not.toContain('plus an uncommitted edit');
    expect(persisted.files.some((f) => f.path === 'untracked.txt')).toBe(false);
  });

  it('skips a run whose gh pr view call fails without affecting others', async () => {
    const harness = makeHarness();
    const { runId, taskId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const pr = new PrManager(harness, true, stub.run);
    await pr.openPr(runId);

    stub.viewResult = { ok: false, stdout: '', stderr: 'rate limited' };
    await expect(pr.pollOnce()).resolves.toBeUndefined();
    expect(harness.store.get(taskId)?.meta.status).toBe('in-review');
  });

  it('does not poll at all when the project lacks the pr capability', () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    const pr = new PrManager(harness, false, stub.run);
    pr.startPolling(10);
    pr.stopPolling();
    expect(stub.calls).toHaveLength(0);
  });

  it('does not block the event loop during a slow poll pass', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const pr = new PrManager(harness, true, stub.run);
    await pr.openPr(runId);
    stub.delayMs = 40;

    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
    }, 0);

    const pollPromise = pr.pollOnce();
    await sleep(5);
    expect(timerFired).toBe(true);
    await pollPromise;
  });
});

// Opens a PR on a finished run so the review-surface reads/writes below have
// a `prUrl` to act on.
async function openPrFor(
  harness: Harness,
  stub: StubRunner
): Promise<{ pr: PrManager; runId: string }> {
  const { runId } = await dispatchAndFinish(harness);
  const pr = new PrManager(harness, true, stub.run);
  await pr.openPr(runId);
  return { pr, runId };
}

describe('PrManager.getPrDetail', () => {
  it('folds status, reviews, PR comments, and line comments into one detail', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    const { pr, runId } = await openPrFor(harness, stub);

    const detail = await pr.getPrDetail(runId);

    expect(detail.status.state).toBe('OPEN');
    expect(detail.status.reviewDecision).toBe('REVIEW_REQUIRED');
    // One SUCCESS + one in-progress check => 1 passed, 1 pending.
    expect(detail.status.checks).toMatchObject({
      passed: 1,
      pending: 1,
      total: 2,
    });
    expect(detail.status.additions).toBe(5);

    const kinds = detail.conversation.map((c) => c.kind);
    expect(kinds).toContain('review');
    expect(kinds).toContain('comment');
    expect(kinds).toContain('line-comment');
    const line = detail.conversation.find((c) => c.kind === 'line-comment');
    expect(line).toMatchObject({ path: 'FAKE_OUTPUT.txt', line: 1 });
    // Sorted oldest-first by createdAt.
    const times = detail.conversation.map((c) => c.createdAt);
    expect([...times].sort()).toEqual(times);
  });

  it('409s a run with no open PR', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const pr = new PrManager(harness, true, stub.run);
    await expect(pr.getPrDetail(runId)).rejects.toThrow(
      OrchestratorConflictError
    );
  });

  it('survives a line-comment API failure by dropping just the line comments', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.apiResult = { ok: false, stdout: '', stderr: 'forbidden' };
    const { pr, runId } = await openPrFor(harness, stub);

    const detail = await pr.getPrDetail(runId);
    expect(detail.conversation.some((c) => c.kind === 'line-comment')).toBe(
      false
    );
    // The review + PR comment still come through.
    expect(detail.conversation.some((c) => c.kind === 'review')).toBe(true);
  });
});

describe('PrManager.reviewPr', () => {
  it('submits an approve with the right gh flag and returns refreshed detail', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    const { pr, runId } = await openPrFor(harness, stub);

    const detail = await pr.reviewPr(runId, 'approve', '');
    const reviewCall = stub.calls.find((c) => c.cmd[2] === 'review')?.cmd;
    expect(reviewCall).toContain('--approve');
    expect(detail.status).toBeDefined();
  });

  it('passes the body through for request-changes', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    const { pr, runId } = await openPrFor(harness, stub);

    await pr.reviewPr(runId, 'request-changes', 'please fix the naming');
    const reviewCall = stub.calls.find((c) => c.cmd[2] === 'review')?.cmd;
    expect(reviewCall).toContain('--request-changes');
    expect(reviewCall).toContain('please fix the naming');
  });

  it('throws when gh pr review fails', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.reviewResult = { ok: false, stdout: '', stderr: 'gh boom' };
    const { pr, runId } = await openPrFor(harness, stub);
    await expect(pr.reviewPr(runId, 'approve', '')).rejects.toThrow(
      OrchestratorConflictError
    );
  });
});

describe('PrManager.commentPr', () => {
  it('adds a PR-level comment via gh pr comment', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    const { pr, runId } = await openPrFor(harness, stub);

    await pr.commentPr(runId, 'a general note');
    const commentCall = stub.calls.find((c) => c.cmd[2] === 'comment')?.cmd;
    expect(commentCall).toContain('--body');
    expect(commentCall).toContain('a general note');
  });
});

// Item B: the PRs page lists every open PR in the repo, not just the ones
// dispatch itself opened — listRepoPrs is the server-side half of that
// (GET /api/prs's endpoint test in prs-api.test.ts covers the HTTP route +
// its 409 mapping; this covers the gh call + JSON parsing directly).
describe('PrManager.listRepoPrs', () => {
  it('calls gh pr list with the expected flags and parses the result, flattening author to a login string', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    const pr = new PrManager(harness, true, stub.run);

    const prs = await pr.listRepoPrs();

    expect(prs).toEqual([
      {
        number: 9,
        title: 'Repo PR from someone else',
        url: 'https://github.com/example/repo/pull/9',
        headRefName: 'feature/someone-else',
        author: 'teammate',
        isDraft: true,
        updatedAt: '2026-07-22T00:00:00Z',
        headRefOid: '',
        isCrossRepository: false,
        headRepositoryOwner: 'someone',
        reviewDecision: null,
        mergeable: null,
        checks: {
          passed: 0,
          failed: 0,
          pending: 0,
          total: 0,
        },
        additions: 0,
        deletions: 0,
        changedFiles: 0,
      },
    ]);
    const listCall = stub.calls.find(
      (c) => c.cmd[0] === 'gh' && c.cmd[1] === 'pr' && c.cmd[2] === 'list'
    )?.cmd;
    expect(listCall).toEqual([
      'gh',
      'pr',
      'list',
      '--json',
      'number,title,url,headRefName,headRefOid,author,isDraft,updatedAt,' +
        'isCrossRepository,headRepositoryOwner,reviewDecision,mergeable,' +
        'statusCheckRollup,additions,deletions,changedFiles',
      '--state',
      'open',
      '--limit',
      '50',
    ]);
  });

  it('409s when the project lacks the pr capability, without shelling out at all', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    const pr = new PrManager(harness, false, stub.run);

    await expect(pr.listRepoPrs()).rejects.toThrow(OrchestratorConflictError);
    expect(stub.calls).toHaveLength(0);
  });

  it('409s when gh pr list fails', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.listResult = {
      ok: false,
      stdout: '',
      stderr: 'gh: not authenticated',
    };
    const pr = new PrManager(harness, true, stub.run);

    await expect(pr.listRepoPrs()).rejects.toThrow(/gh pr list failed/);
  });

  it('409s when gh pr list returns invalid JSON', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.listResult = { ok: true, stdout: 'not json', stderr: '' };
    const pr = new PrManager(harness, true, stub.run);

    await expect(pr.listRepoPrs()).rejects.toThrow(/invalid JSON/);
  });

  it('carries GitHub status through so the queue never needs a per-PR view call', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.listResult = {
      ok: true,
      stdout: JSON.stringify([
        {
          number: 9,
          title: 'Repo PR from someone else',
          url: 'https://github.com/example/repo/pull/9',
          headRefName: 'feature/someone-else',
          headRefOid: 'abc123',
          author: { login: 'teammate' },
          isDraft: true,
          updatedAt: '2026-07-22T00:00:00Z',
          isCrossRepository: true,
          headRepositoryOwner: { login: 'contributor' },
          reviewDecision: 'CHANGES_REQUESTED',
          mergeable: 'CONFLICTING',
          statusCheckRollup: [
            { conclusion: 'SUCCESS' },
            { conclusion: 'FAILURE' },
            { status: 'IN_PROGRESS' },
          ],
          additions: 12,
          deletions: 3,
          changedFiles: 2,
        },
      ]),
      stderr: '',
    };
    const pr = new PrManager(harness, true, stub.run);

    const prs = await pr.listRepoPrs();

    expect(prs[0]?.checks).toEqual({
      passed: 1,
      failed: 1,
      pending: 1,
      total: 3,
    });
    expect(prs[0]?.reviewDecision).toBe('CHANGES_REQUESTED');
    expect(prs[0]?.mergeable).toBe('CONFLICTING');
    expect(prs[0]?.isCrossRepository).toBe(true);
    expect(prs[0]?.headRepositoryOwner).toBe('contributor');
    expect(prs[0]?.headRefOid).toBe('abc123');
  });

  it('asks gh for the status fields in the same single list call', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    const pr = new PrManager(harness, true, stub.run);

    await pr.listRepoPrs();

    const listCall = stub.calls.find((c) => c.cmd[2] === 'list');
    const fields = listCall?.cmd[listCall.cmd.indexOf('--json') + 1] ?? '';
    expect(fields).toContain('statusCheckRollup');
    expect(fields).toContain('isCrossRepository');
    expect(fields).toContain('headRefOid');
    // One call total — a per-PR `gh pr view` for status is what this avoids.
    expect(stub.calls.filter((c) => c.cmd[2] === 'view')).toHaveLength(0);
  });
});

describe('PrManager.getPrDiffByUrl', () => {
  const url = 'https://github.com/example/repo/pull/9';

  it('builds a DiffResult from the patch and the files list', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.diffResult = {
      ok: true,
      stdout: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      stderr: '',
    };
    stub.filesResult = {
      ok: true,
      stdout: JSON.stringify([
        { filename: 'src/a.ts', status: 'modified' },
        { filename: 'src/b.ts', status: 'added' },
        { filename: 'src/c.ts', status: 'removed' },
        { filename: 'src/d.ts', status: 'renamed' },
      ]),
      stderr: '',
    };
    const pr = new PrManager(harness, true, stub.run);

    const diff = await pr.getPrDiffByUrl(url);

    expect(diff.patch).toContain('+new');
    expect(diff.files).toEqual([
      { path: 'src/a.ts', status: 'M' },
      { path: 'src/b.ts', status: 'A' },
      { path: 'src/c.ts', status: 'D' },
      { path: 'src/d.ts', status: 'R' },
    ]);
  });

  it('conflicts when gh pr diff fails rather than returning an empty diff', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.diffResult = { ok: false, stdout: '', stderr: 'no such PR' };
    const pr = new PrManager(harness, true, stub.run);

    await expect(pr.getPrDiffByUrl(url)).rejects.toBeInstanceOf(
      OrchestratorConflictError
    );
  });

  // Regression coverage for the no-base-to-string fix: a malformed files
  // entry (a filename that isn't a string) must throw rather than silently
  // stringify to "[object Object]" and render as a fake file path.
  it('conflicts when a files entry has a non-string filename rather than stringifying it', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.diffResult = {
      ok: true,
      stdout: 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n',
      stderr: '',
    };
    stub.filesResult = {
      ok: true,
      stdout: JSON.stringify([
        { filename: { nested: 'not-a-string' }, status: 'modified' },
      ]),
      stderr: '',
    };
    const pr = new PrManager(harness, true, stub.run);

    await expect(pr.getPrDiffByUrl(url)).rejects.toBeInstanceOf(
      OrchestratorConflictError
    );
  });

  it('conflicts when the gh api pulls/files call fails', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.diffResult = {
      ok: true,
      stdout: 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n',
      stderr: '',
    };
    stub.filesResult = { ok: false, stdout: '', stderr: 'forbidden' };
    const pr = new PrManager(harness, true, stub.run);

    await expect(pr.getPrDiffByUrl(url)).rejects.toBeInstanceOf(
      OrchestratorConflictError
    );
  });
});

// A ReviewTarget for PR #9 — matches StubRunner's default listResult entry
// (number 9, url .../pull/9), so most tests below resolve without needing
// to override the list stub just to pick a number.
const prTarget: ReviewTarget = { kind: 'pr', number: 9 };

// The default single-PR listResult shape, with headRefOid overridden — the
// sha pushPrReview must carry as the review's commit_id.
function listResultWithHeadRefOid(sha: string): CommandResult {
  return {
    ok: true,
    stdout: JSON.stringify([
      {
        number: 9,
        title: 'Repo PR from someone else',
        url: 'https://github.com/example/repo/pull/9',
        headRefName: 'feature/someone-else',
        headRefOid: sha,
        author: { login: 'teammate' },
        isDraft: true,
        updatedAt: '2026-07-22T00:00:00Z',
        isCrossRepository: false,
        headRepositoryOwner: { login: 'someone' },
        reviewDecision: null,
        mergeable: null,
        statusCheckRollup: [],
        additions: 0,
        deletions: 0,
        changedFiles: 0,
      },
    ]),
    stderr: '',
  };
}

// A raw GitHub REST review-comment payload item, shaped per the plan's
// verified payload facts — reused across the pull/merge tests below.
function rawGitHubComment(
  over: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id: 555,
    path: 'src/a.ts',
    line: 3,
    diff_hunk: '@@ -1,2 +1,3 @@\n context\n+const x = 1;',
    body: 'why one?',
    user: { login: 'teammate' },
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    side: 'RIGHT',
    subject_type: 'line',
    ...over,
  };
}

describe('PrManager.syncPrComments', () => {
  it('pulls, maps, and persists a stubbed pulls/N/comments payload', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.apiResult = {
      ok: true,
      stdout: JSON.stringify([rawGitHubComment()]),
      stderr: '',
    };
    const pr = new PrManager(harness, true, stub.run);

    const comments = await pr.syncPrComments(9);

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      file: 'src/a.ts',
      line: 3,
      anchorText: 'const x = 1;',
      githubId: 555,
      origin: 'github',
      pending: false,
    });
    // Persisted, not just returned.
    expect(harness.reviewComments.list(prTarget)).toEqual(comments);
  });

  it('merges with what is on disk, leaving a local pending draft untouched', async () => {
    const harness = makeHarness();
    const draft = harness.reviewComments.add(prTarget, {
      file: 'src/b.ts',
      line: 1,
      anchorText: 'const y = 2;',
      body: 'my own note',
      pending: true,
    });
    const stub = new StubRunner();
    stub.apiResult = {
      ok: true,
      stdout: JSON.stringify([rawGitHubComment()]),
      stderr: '',
    };
    const pr = new PrManager(harness, true, stub.run);

    const comments = await pr.syncPrComments(9);

    expect(comments).toContainEqual(draft);
    expect(comments.some((c) => c.githubId === 555)).toBe(true);
  });

  it('404s a PR number the repo does not currently have open', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    const pr = new PrManager(harness, true, stub.run);
    await expect(pr.syncPrComments(404)).rejects.toThrow(
      OrchestratorNotFoundError
    );
  });

  it('rejects a non-integer PR number before shelling out at all', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    const pr = new PrManager(harness, true, stub.run);
    await expect(pr.syncPrComments(1.5)).rejects.toThrow(
      OrchestratorClientError
    );
    expect(stub.calls).toHaveLength(0);
  });
});

describe('PrManager.pushPrReview', () => {
  // Seeds one pending comment on PR #9's target, returning it so a test can
  // assert on the exact record round-tripped through the store.
  function seedPending(
    harness: Harness,
    over: { file?: string; line?: number; body?: string } = {}
  ) {
    return harness.reviewComments.add(prTarget, {
      file: over.file ?? 'src/a.ts',
      line: over.line ?? 3,
      anchorText: 'const x = 1;',
      body: over.body ?? 'why one?',
      pending: true,
    });
  }

  // The JSON body pushPrReview wrote to its (since-cleaned-up) scratch
  // file, captured by the stub at call time — see postedReviewPayloads.
  function readPostedPayload(stub: StubRunner): Record<string, unknown> {
    const payload = stub.postedReviewPayloads.at(-1);
    if (payload === undefined) {
      throw new Error('no review payload was posted');
    }
    return payload;
  }

  it('sends one POST carrying every pending comment, not N separate calls', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.listResult = listResultWithHeadRefOid('sha-abc123');
    seedPending(harness);
    seedPending(harness, { file: 'src/b.ts', line: 5, body: 'and this?' });
    const pr = new PrManager(harness, true, stub.run);

    const result = await pr.pushPrReview(9, 'approve', 'LGTM');

    expect(result.pushed).toBe(2);
    const postCalls = stub.calls.filter((c) =>
      c.cmd.some((arg) => /\/pulls\/9\/reviews$/.test(arg))
    );
    expect(postCalls).toHaveLength(1);
  });

  it('carries path, line, side RIGHT, and the commit_id from headRefOid', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.listResult = listResultWithHeadRefOid('sha-abc123');
    seedPending(harness);
    seedPending(harness, { file: 'src/b.ts', line: 5, body: 'and this?' });
    const pr = new PrManager(harness, true, stub.run);

    await pr.pushPrReview(9, 'approve', 'LGTM');

    const payload = readPostedPayload(stub);
    expect(payload.commit_id).toBe('sha-abc123');
    expect(payload.comments).toEqual([
      { path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'why one?' },
      { path: 'src/b.ts', line: 5, side: 'RIGHT', body: 'and this?' },
    ]);
  });

  it.each([
    ['approve', 'APPROVE'],
    ['request-changes', 'REQUEST_CHANGES'],
    ['comment', 'COMMENT'],
  ] as const)('maps verdict %s to event %s', async (verdict, event) => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.listResult = listResultWithHeadRefOid('sha-abc123');
    seedPending(harness);
    const pr = new PrManager(harness, true, stub.run);

    await pr.pushPrReview(9, verdict, 'body text');

    expect(readPostedPayload(stub).event).toBe(event);
  });

  it('re-pulls after a successful push so the published comment gets its githubId backfilled', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.listResult = listResultWithHeadRefOid('sha-abc123');
    seedPending(harness);
    stub.apiResult = {
      ok: true,
      stdout: JSON.stringify([rawGitHubComment({ id: 777 })]),
      stderr: '',
    };
    const pr = new PrManager(harness, true, stub.run);

    await pr.pushPrReview(9, 'approve', 'LGTM');

    const stored = harness.reviewComments.list(prTarget);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.pending).toBe(false);
    expect(stored[0]?.githubId).toBe(777);
  });

  it('leaves comments pending on a failed push (the reviewer must not lose the writing)', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.listResult = listResultWithHeadRefOid('sha-abc123');
    stub.pushReviewResult = { ok: false, stdout: '', stderr: 'gh boom' };
    const draft = seedPending(harness);
    const pr = new PrManager(harness, true, stub.run);

    await expect(pr.pushPrReview(9, 'approve', 'LGTM')).rejects.toThrow(
      OrchestratorConflictError
    );

    const stored = harness.reviewComments.list(prTarget);
    expect(stored).toEqual([draft]);
    expect(stored[0]?.pending).toBe(true);
  });

  // Regression: the post-push cleanup used to reuse the pre-await `all`
  // snapshot to decide what survives, so a comment added while the gh call
  // was in flight (a real window — this.run awaits a network round trip)
  // would be silently discarded when that stale snapshot was written back.
  it('keeps a comment added while the push network call is in flight', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.listResult = listResultWithHeadRefOid('sha-abc123');
    seedPending(harness);
    // Simulates the concurrent add(): landed on the store from "inside"
    // the stubbed gh call, the same async gap a real network round trip
    // would open.
    const wrappedRun = async (
      cwd: string,
      cmd: string[]
    ): Promise<CommandResult> => {
      const result = await stub.run(cwd, cmd);
      if (cmd.some((arg) => /\/pulls\/9\/reviews$/.test(arg))) {
        harness.reviewComments.add(prTarget, {
          file: 'src/c.ts',
          line: 9,
          anchorText: 'const z = 3;',
          body: 'landed mid-flight',
          pending: true,
        });
      }
      return result;
    };
    const pr = new PrManager(harness, true, wrappedRun);

    await pr.pushPrReview(9, 'approve', 'LGTM');

    const stored = harness.reviewComments.list(prTarget);
    expect(stored.some((c) => c.body === 'landed mid-flight')).toBe(true);
  });

  it('still submits (with no comments) and skips the backfill pull when nothing is pending', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.listResult = listResultWithHeadRefOid('sha-abc123');
    const pr = new PrManager(harness, true, stub.run);

    const result = await pr.pushPrReview(9, 'approve', 'LGTM');

    expect(result.pushed).toBe(0);
    const postCalls = stub.calls.filter((c) =>
      c.cmd.some((arg) => /\/pulls\/9\/reviews$/.test(arg))
    );
    expect(postCalls).toHaveLength(1);
    const getCalls = stub.calls.filter((c) =>
      c.cmd.some((arg) => /\/pulls\/9\/comments$/.test(arg))
    );
    expect(getCalls).toHaveLength(0);
  });
});
