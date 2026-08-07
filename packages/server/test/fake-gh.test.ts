import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus } from '../src/events.js';
import { makeFakeGhRunner } from '../src/fakeGh.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { PrManager } from '../src/orchestrator/pr.js';
import { ReviewCommentStore } from '../src/reviewComments.js';
import { initGitRepo } from './orchestrator/helpers.js';

// DISPATCH_FAKE_GH is what demo mode and every screenshot run against, so the
// fake has to answer the same commands PrManager actually issues — driven here
// through a real PrManager rather than by inspecting the fake's JSON, so a
// field the fake omits fails the same way it would on screen.
let fakeHome: string;
let repo: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-fake-gh-');
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

const STANDALONE_URL = 'https://github.com/dispatch-demo/repo/pull/7';

function makePrManager(): PrManager {
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
  const reviewComments = new ReviewCommentStore(repo, 'human:test');
  return new PrManager(
    { rootDir: repo, orchestrator, store, cache, events, reviewComments },
    true,
    makeFakeGhRunner()
  );
}

describe('the DISPATCH_FAKE_GH runner', () => {
  it('reports the widened RepoPr shape, so demo rows show status', async () => {
    const prs = await makePrManager().listRepoPrs();
    const pr = prs.find((p) => p.number === 7);
    expect(pr).toBeDefined();
    expect(pr?.checks).toEqual({ passed: 1, failed: 1, pending: 0, total: 2 });
    expect(pr?.reviewDecision).toBe('REVIEW_REQUIRED');
    expect(pr?.mergeable).toBe('CONFLICTING');
    expect(pr?.changedFiles).toBe(1);
    expect(pr?.headRefOid).not.toBe('');
    expect(pr?.headRepositoryOwner).toBe('dispatch-demo');
  });

  it('serves a PR diff, so a demo PR opens on files', async () => {
    const diff = await makePrManager().getPrDiffByUrl(STANDALONE_URL);
    expect(diff.patch).toContain('diff --git a/package.json');
    expect(diff.files).toEqual([{ path: 'package.json', status: 'M' }]);
  });

  it('tells the files call apart from the line-comments call', async () => {
    // Both are `gh api`; the files one leads with `--paginate`, which the
    // fake used to read as the REST path and answer with line comments.
    const manager = makePrManager();
    const diff = await manager.getPrDiffByUrl(STANDALONE_URL);
    const detail = await manager.getPrDetailByUrl(STANDALONE_URL);
    expect(diff.files.map((f) => f.path)).toEqual(['package.json']);
    expect(detail.conversation.every((c) => c.kind !== 'line-comment')).toBe(
      true
    );
  });

  it('agrees with itself: pr view reports what pr list reported', async () => {
    const manager = makePrManager();
    const listed = (await manager.listRepoPrs()).find((p) => p.number === 7);
    if (listed === undefined) throw new Error('the fake lost PR #7');
    const viewed = await manager.getPrDetailByUrl(STANDALONE_URL);
    expect(viewed.status.checks).toEqual(listed.checks);
    expect(viewed.status.mergeable).toBe(listed.mergeable);
    expect(viewed.status.changedFiles).toBe(listed.changedFiles);
  });
});
