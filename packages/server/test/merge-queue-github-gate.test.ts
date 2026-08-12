import { DISPATCH_DIR, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus } from '../src/events.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import {
  githubHoldReason,
  MergeQueue,
} from '../src/orchestrator/mergeQueue.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type {
  CommandResult,
  PrCheckSummary,
  RepoPr,
} from '../src/orchestrator/pr.js';
import { initGitRepo } from './orchestrator/helpers.js';

let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

// Same cleanup contract as merge-queue.test.ts: a queue left running past its
// test can still have timers armed (blocked-retry, auto-refresh).
const liveQueues: MergeQueue[] = [];

function makeQueue(
  ...args: ConstructorParameters<typeof MergeQueue>
): MergeQueue {
  const queue = new MergeQueue(...args);
  liveQueues.push(queue);
  return queue;
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-merge-queue-github-gate-');
});

afterEach(() => {
  for (const queue of liveQueues) queue.stop();
  liveQueues.length = 0;
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

// Same scriptable command stub as merge-queue.test.ts's StubRunner, trimmed
// to just the calls this file's scenarios exercise.
class StubRunner {
  readonly calls: { cwd: string; cmd: string[] }[] = [];
  rebaseResult: CommandResult = { ok: true, stdout: '', stderr: '' };
  fetchResult: CommandResult = { ok: true, stdout: '', stderr: '' };
  pushResult: CommandResult = { ok: true, stdout: '', stderr: '' };
  ghMergeResult: CommandResult = { ok: true, stdout: '', stderr: '' };

  run = (cwd: string, cmd: string[]): Promise<CommandResult> => {
    this.calls.push({ cwd, cmd });
    if (cmd[0] === 'git' && cmd[1] === 'fetch')
      return Promise.resolve(this.fetchResult);
    if (cmd[0] === 'git' && cmd[1] === 'rebase' && cmd[2] === '--abort') {
      return Promise.resolve({ ok: true, stdout: '', stderr: '' });
    }
    if (cmd[0] === 'git' && cmd[1] === 'rebase')
      return Promise.resolve(this.rebaseResult);
    if (cmd[0] === 'git' && cmd[1] === 'push')
      return Promise.resolve(this.pushResult);
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'merge') {
      return Promise.resolve(this.ghMergeResult);
    }
    return Promise.resolve({
      ok: false,
      stdout: '',
      stderr: 'unhandled stub command',
    });
  };
}

interface Harness {
  rootDir: string;
  orchestrator: Orchestrator;
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
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
    new FakeExecutor({
      finish: {
        state: 'finished',
        costUsd: 0,
        turns: 1,
        sessionId: 'sess-fake',
      },
    })
  );
  return { rootDir: repo, orchestrator, store, cache, events };
}

async function dispatchAndFinish(
  harness: Harness,
  title = 'Ship it'
): Promise<{ runId: string; taskId: string }> {
  const task = harness.store.create({ title });
  const meta = await harness.orchestrator.dispatch(task.meta.id, 'fake');
  await waitFor(
    () => harness.orchestrator.getRun(meta.id)?.meta.state === 'finished'
  );
  return { runId: meta.id, taskId: task.meta.id };
}

// Full-field RepoPr/PrCheckSummary builders, defaulting to a "green, clear to
// merge" PR — every scenario overrides only the field(s) it cares about,
// exactly like the task brief's `pr({...})`/`c({...})` shorthand.
function c(overrides: Partial<PrCheckSummary> = {}): PrCheckSummary {
  return { passed: 0, failed: 0, pending: 0, total: 0, runs: [], ...overrides };
}

function pr(overrides: Partial<RepoPr> = {}): RepoPr {
  return {
    number: 1,
    title: 'Test PR',
    url: 'https://github.com/example/repo/pull/1',
    headRefName: 'feature',
    baseRefName: 'main',
    author: 'octocat',
    isDraft: false,
    updatedAt: '2026-01-01T00:00:00Z',
    headRefOid: 'abc123',
    state: 'OPEN',
    isCrossRepository: false,
    headRepositoryOwner: 'example',
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    checks: c(),
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    ...overrides,
  };
}

describe('githubHoldReason', () => {
  it('holds when PR state is unknown (poll pending)', () => {
    expect(githubHoldReason(undefined)).toBe('PR state unknown (poll pending)');
  });

  it('holds a draft PR', () => {
    expect(githubHoldReason(pr({ isDraft: true }))).toBe('draft');
  });

  it('holds a PR that conflicts with its base', () => {
    expect(githubHoldReason(pr({ mergeable: 'CONFLICTING' }))).toBe(
      'conflicts with base'
    );
  });

  it('holds on failing checks, naming the count', () => {
    expect(githubHoldReason(pr({ checks: c({ failed: 2 }) }))).toBe(
      '2 checks failing'
    );
  });

  it('holds on pending checks, naming the count', () => {
    expect(githubHoldReason(pr({ checks: c({ pending: 1 }) }))).toBe(
      'waiting on CI (1 running)'
    );
  });

  it('holds on changes requested', () => {
    expect(githubHoldReason(pr({ reviewDecision: 'CHANGES_REQUESTED' }))).toBe(
      'changes requested'
    );
  });

  it('holds on review required', () => {
    expect(githubHoldReason(pr({ reviewDecision: 'REVIEW_REQUIRED' }))).toBe(
      'review required'
    );
  });

  it('clears a green PR', () => {
    expect(githubHoldReason(pr({}))).toBeNull();
  });

  it('clears a PR with no CI configured at all', () => {
    expect(githubHoldReason(pr({ checks: c({ total: 0 }) }))).toBeNull();
  });
});

describe('MergeQueue GitHub gate', () => {
  it('holds a red PR-routed entry in waiting-github with the reason set, then merges once the PR turns green', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const prUrl = 'https://github.com/example/repo/pull/7';
    harness.orchestrator.setRunPrUrl(runId, prUrl);
    const stub = new StubRunner();
    let live = pr({ url: prUrl, isDraft: true });
    const queue = makeQueue(
      { ...harness, prState: (url) => (url === live.url ? live : undefined) },
      stub.run
    );

    queue.enqueue(runId);
    await waitFor(
      () =>
        queue.snapshot().entries.find((e) => e.runId === runId)?.state ===
        'waiting-github'
    );
    const held = queue.snapshot().entries.find((e) => e.runId === runId);
    expect(held?.reason).toBe('draft');
    expect(queue.snapshot().history).toHaveLength(0);
    expect(
      stub.calls.some((call) => call.cmd[0] === 'gh' && call.cmd[2] === 'merge')
    ).toBe(false);

    // The PR turns green; a fresh pump (mirroring the queue's own
    // landing.changed-triggered recheck) picks it back up and merges it.
    live = { ...live, isDraft: false };
    queue.recheck();
    await waitFor(() => queue.snapshot().history.length === 1);
    expect(queue.snapshot().history[0].state).toBe('merged');
    const mergeCall = stub.calls.find(
      (call) =>
        call.cmd[0] === 'gh' && call.cmd[1] === 'pr' && call.cmd[2] === 'merge'
    );
    expect(mergeCall?.cmd).toEqual(['gh', 'pr', 'merge', prUrl, '--squash']);
  });

  // The gate runs BEFORE rebase/verify in process() (see mergeQueue.ts):
  // a held entry must never pay for the verify pipeline just to be parked
  // afterward, and its check data described a pre-rebase head anyway.
  it('parks a red PR-routed entry without running rebase or verify steps', async () => {
    const harness = makeHarness();
    writeFileSync(
      join(harness.rootDir, DISPATCH_DIR, 'config.yml'),
      'verifyCommand: "echo verifying"\n'
    );
    const { runId } = await dispatchAndFinish(harness);
    const prUrl = 'https://github.com/example/repo/pull/21';
    harness.orchestrator.setRunPrUrl(runId, prUrl);
    const stub = new StubRunner();
    const redPr = pr({ url: prUrl, isDraft: true });
    const queue = makeQueue(
      { ...harness, prState: (url) => (url === redPr.url ? redPr : undefined) },
      stub.run
    );

    queue.enqueue(runId);
    await waitFor(
      () =>
        queue.snapshot().entries.find((e) => e.runId === runId)?.state ===
        'waiting-github'
    );

    const held = queue.snapshot().entries.find((e) => e.runId === runId);
    expect(held?.reason).toBe('draft');
    expect(held?.steps).toBeUndefined();
    expect(
      stub.calls.some(
        (call) => call.cmd[0] === 'git' && call.cmd[1] === 'rebase'
      )
    ).toBe(false);
    expect(stub.calls.some((call) => call.cmd[0] === 'bash')).toBe(false);
  });

  it('merges a PR-routed entry immediately when prState is not wired (back-compat)', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    harness.orchestrator.setRunPrUrl(
      runId,
      'https://github.com/example/repo/pull/9'
    );
    const stub = new StubRunner();
    const queue = makeQueue(harness, stub.run); // no prState on ctx

    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().history.length === 1);
    expect(queue.snapshot().history[0].state).toBe('merged');
  });

  it('never consults prState for a local (non-PR) entry', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const stub = new StubRunner();
    const queue = makeQueue(
      {
        ...harness,
        prState: (): RepoPr | undefined => {
          throw new Error('prState must not be called for a local entry');
        },
      },
      stub.run
    );

    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().history.length === 1);
    expect(queue.snapshot().history[0].state).toBe('merged');
  });

  it('does not block another entry from processing while one sits in waiting-github', async () => {
    const harness = makeHarness();
    const { runId: runA } = await dispatchAndFinish(harness, 'Task A');
    const prUrl = 'https://github.com/example/repo/pull/1';
    harness.orchestrator.setRunPrUrl(runA, prUrl);
    const { runId: runB } = await dispatchAndFinish(harness, 'Task B');
    const stub = new StubRunner();
    const redPr = pr({ url: prUrl, isDraft: true });
    const queue = makeQueue(
      { ...harness, prState: (url) => (url === redPr.url ? redPr : undefined) },
      stub.run
    );

    queue.enqueue(runA);
    queue.enqueue(runB);

    await waitFor(() => queue.snapshot().history.length === 1);
    expect(queue.snapshot().history[0].runId).toBe(runB);
    expect(queue.snapshot().history[0].state).toBe('merged');
    const heldA = queue.snapshot().entries.find((e) => e.runId === runA);
    expect(heldA?.state).toBe('waiting-github');
    expect(heldA?.reason).toBe('draft');
  });

  it('re-checks a waiting-github entry when landing.changed fires', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const prUrl = 'https://github.com/example/repo/pull/3';
    harness.orchestrator.setRunPrUrl(runId, prUrl);
    const stub = new StubRunner();
    let live = pr({ url: prUrl, isDraft: true });
    const queue = makeQueue(
      { ...harness, prState: (url) => (url === live.url ? live : undefined) },
      stub.run
    );

    queue.enqueue(runId);
    await waitFor(
      () =>
        queue.snapshot().entries.find((e) => e.runId === runId)?.state ===
        'waiting-github'
    );

    live = { ...live, isDraft: false };
    // The wiring under test: PrManager's own poll broadcasts this after
    // every refreshCache() call, with no direct reference to the queue.
    harness.events.broadcast({ type: 'landing.changed' });

    await waitFor(() => queue.snapshot().history.length === 1);
    expect(queue.snapshot().history[0].state).toBe('merged');
  });

  // Regression: cachedPrByUrl only ever holds OPEN PRs, so a PR that merges
  // or closes on GitHub simply disappears from the cache — prState(url)
  // reads as undefined forever after, same as "poll hasn't run yet". Without
  // `cacheReady` distinguishing the two, a held entry would park in
  // waiting-github permanently the moment its PR left GitHub's open list.
  it('processes a held entry once its PR drops out of a known-fresh cache (fails loudly, not silently, when unreviewed)', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const prUrl = 'https://github.com/example/repo/pull/11';
    harness.orchestrator.setRunPrUrl(runId, prUrl);
    const stub = new StubRunner();
    let live: RepoPr | undefined = pr({ url: prUrl, isDraft: true });
    const queue = makeQueue(
      {
        ...harness,
        prState: (url) =>
          live !== undefined && url === live.url ? live : undefined,
        // The cache is known fresh throughout this test — the PR "closing"
        // below is a real drop from a fresh poll, not a poll that hasn't run.
        cacheReady: () => true,
      },
      stub.run
    );

    queue.enqueue(runId);
    await waitFor(
      () =>
        queue.snapshot().entries.find((e) => e.runId === runId)?.state ===
        'waiting-github'
    );

    // The PR closes without merging on GitHub: it drops out of the next
    // poll's open-PR list (prState now returns undefined), but the run was
    // never reviewed (reviewedAt stays unset) — nothing in this process ever
    // saw it merge. The entry must not stay parked: it reaches process()
    // again and fails loudly on `gh pr merge` (the PR really is closed),
    // exactly the same failure a human would see running the command by
    // hand — visible and retryable, not a silent permanent hold.
    live = undefined;
    stub.ghMergeResult = {
      ok: false,
      stdout: '',
      stderr: 'GraphQL: Pull request is not open (mergePullRequest)',
    };
    queue.recheck();

    await waitFor(() => queue.snapshot().history.length === 1);
    expect(queue.snapshot().history[0].state).toBe('failed');
    expect(queue.snapshot().history[0].reason).toContain('gh pr merge failed');
  });

  // The other half of the same fix: before the FIRST successful poll,
  // prState(url) is ALSO undefined — but that must still hold, since it's
  // genuinely unknown rather than known-gone. cacheReady staying false is
  // what keeps this case distinct from the one above.
  it('keeps a held entry parked while the PR cache has never been filled', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const prUrl = 'https://github.com/example/repo/pull/12';
    harness.orchestrator.setRunPrUrl(runId, prUrl);
    const stub = new StubRunner();
    // No PR ever cached, and cacheReady always false — the "poll hasn't run
    // yet" case for the entire test, not just at enqueue time.
    const queue = makeQueue(
      { ...harness, prState: () => undefined, cacheReady: () => false },
      stub.run
    );

    queue.enqueue(runId);
    await waitFor(
      () =>
        queue.snapshot().entries.find((e) => e.runId === runId)?.state ===
        'waiting-github'
    );
    expect(
      queue.snapshot().entries.find((e) => e.runId === runId)?.reason
    ).toBe('PR state unknown (poll pending)');

    queue.recheck();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queue.snapshot().entries.find((e) => e.runId === runId)?.state).toBe(
      'waiting-github'
    );
    expect(queue.snapshot().history).toHaveLength(0);
  });

  // Fix part (a): a run reviewed out-of-band (PrManager's own poller saw the
  // PR merged and called markRunMergedViaPr, entirely outside this queue)
  // must release a waiting-github hold — nextEligible() has to notice
  // `reviewedAt` is now set and let the entry through to process()'s
  // existing reviewedAt cleanup, rather than keep re-deriving a hold off a
  // PR that no longer needs one.
  it('releases a waiting-github hold once the run is reviewed externally', async () => {
    const harness = makeHarness();
    const { runId } = await dispatchAndFinish(harness);
    const prUrl = 'https://github.com/example/repo/pull/13';
    harness.orchestrator.setRunPrUrl(runId, prUrl);
    const stub = new StubRunner();
    const redPr = pr({ url: prUrl, isDraft: true });
    const queue = makeQueue(
      { ...harness, prState: (url) => (url === redPr.url ? redPr : undefined) },
      stub.run
    );

    queue.enqueue(runId);
    await waitFor(
      () =>
        queue.snapshot().entries.find((e) => e.runId === runId)?.state ===
        'waiting-github'
    );

    // Simulate PrManager's own poller having seen this PR merged, entirely
    // outside the queue.
    harness.orchestrator.markRunMergedViaPr(runId);
    queue.recheck();

    await waitFor(() => queue.snapshot().history.length === 1);
    expect(queue.snapshot().history[0].state).toBe('failed');
    expect(queue.snapshot().history[0].reason).toBe(
      'run was already reviewed outside the merge queue'
    );
  });
});
