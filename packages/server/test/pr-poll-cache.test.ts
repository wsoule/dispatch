import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus } from '../src/events.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { CommandResult } from '../src/orchestrator/pr.js';
import { PrManager } from '../src/orchestrator/pr.js';
import { ReviewCommentStore } from '../src/reviewComments.js';
import { initGitRepo } from './orchestrator/helpers.js';

// Task 2: pollOnce now also refreshes PrManager's own cached repo-PR set
// (RepoPr[]) and broadcasts `landing.changed` when that set's landing-page
// relevant fields actually differ from the previous poll — this file covers
// that cache + delta behavior, distinct from pr.test.ts's coverage of the
// existing per-run merged-check flip.
let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-pr-poll-cache-');
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

// One `gh pr list --json REPO_PR_FIELDS` row, shaped like gh's real output
// (author/headRepositoryOwner as {login} objects, camelCase fields).
function prListItem(
  number: number,
  headRefOid: string
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
}

// Records every command argv it's asked to run and answers `gh pr list` /
// `gh pr view --json state` from scriptable fields — a fake CommandRunner
// keyed on argv, same idiom as pr.test.ts's StubRunner but scoped to just
// the calls pollOnce (plus openPr, for the merged-flip test) makes.
class FakeRunner {
  readonly calls: string[][] = [];
  listResult: CommandResult;
  viewStateResult: CommandResult = {
    ok: true,
    stdout: JSON.stringify({ state: 'OPEN' }),
    stderr: '',
  };

  constructor(listPayload: Record<string, unknown>[]) {
    this.listResult = {
      ok: true,
      stdout: JSON.stringify(listPayload),
      stderr: '',
    };
  }

  run = async (_cwd: string, cmd: string[]): Promise<CommandResult> => {
    this.calls.push(cmd);
    if (cmd[0] === 'git' && cmd[1] === 'push') {
      return { ok: true, stdout: '', stderr: '' };
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'create') {
      return {
        ok: true,
        stdout: 'https://github.com/example/repo/pull/1\n',
        stderr: '',
      };
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'list') {
      return this.listResult;
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'view') {
      const jsonArg = cmd[cmd.indexOf('--json') + 1] ?? '';
      if (jsonArg === 'state') return this.viewStateResult;
    }
    return { ok: false, stdout: '', stderr: 'unhandled stub command' };
  };
}

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

describe('PrManager poll cache', () => {
  test('pollOnce caches the repo PR list and broadcasts landing.changed only on a real delta', async () => {
    const harness = makeHarness();
    const seen: string[] = [];
    harness.events.subscribe((event) => seen.push(event.type));
    const listPayload = [prListItem(9, 'sha-a'), prListItem(10, 'sha-b')];
    const runner = new FakeRunner(listPayload);
    const pr = new PrManager(harness, true, runner.run);

    await pr.pollOnce();
    expect(pr.cachedPrs()).toHaveLength(2);
    expect(
      pr.cachedPrByUrl('https://github.com/example/repo/pull/9')?.headRefOid
    ).toBe('sha-a');
    expect(seen).toEqual(['landing.changed']); // first fill is a delta
    const listCallsAfterFirst = runner.calls.filter(
      (c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'list'
    );
    expect(listCallsAfterFirst).toHaveLength(1);

    // Same payload again -> no new event.
    await pr.pollOnce();
    expect(seen).toEqual(['landing.changed']);

    // Mutate one PR's head sha (a real delta) and poll again.
    listPayload[0].headRefOid = 'sha-a-changed';
    runner.listResult = {
      ok: true,
      stdout: JSON.stringify(listPayload),
      stderr: '',
    };
    await pr.pollOnce();
    expect(seen).toEqual(['landing.changed', 'landing.changed']);
    expect(
      pr.cachedPrByUrl('https://github.com/example/repo/pull/9')?.headRefOid
    ).toBe('sha-a-changed');
  });

  test('keeps the previous cache and skips the delta check when gh pr list fails', async () => {
    const harness = makeHarness();
    const seen: string[] = [];
    harness.events.subscribe((event) => seen.push(event.type));
    const listPayload = [prListItem(9, 'sha-a')];
    const runner = new FakeRunner(listPayload);
    const pr = new PrManager(harness, true, runner.run);

    await pr.pollOnce();
    expect(seen).toEqual(['landing.changed']);
    const cachedBefore = pr.cachedPrs();

    runner.listResult = { ok: false, stdout: '', stderr: 'rate limited' };
    await pr.pollOnce();

    expect(pr.cachedPrs()).toEqual(cachedBefore);
    expect(seen).toEqual(['landing.changed']);
  });

  test('still runs the per-run merged-check view alongside the cache refresh', async () => {
    const harness = makeHarness();
    const task = harness.store.create({ title: 'PR me' });
    const meta = await harness.orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => harness.orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );
    const runner = new FakeRunner([prListItem(9, 'sha-a')]);
    const pr = new PrManager(harness, true, runner.run);
    await pr.openPr(meta.id);

    runner.viewStateResult = {
      ok: true,
      stdout: JSON.stringify({ state: 'MERGED' }),
      stderr: '',
    };
    await pr.pollOnce();

    const listCalls = runner.calls.filter(
      (c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'list'
    );
    const viewCalls = runner.calls.filter(
      (c) =>
        c[0] === 'gh' &&
        c[1] === 'pr' &&
        c[2] === 'view' &&
        c[c.indexOf('--json') + 1] === 'state'
    );
    expect(listCalls).toHaveLength(1);
    expect(viewCalls).toHaveLength(1);
    expect(harness.store.get(task.meta.id)?.meta.status).toBe('done');
  });
});
