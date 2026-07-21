import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import type { CommandResult } from '../../src/orchestrator/pr.js';
import { detectPrCapability, PrManager } from '../../src/orchestrator/pr.js';
import {
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from '../../src/orchestrator/types.js';
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
  delayMs = 0;

  run = async (cwd: string, cmd: string[]): Promise<CommandResult> => {
    this.calls.push({ cwd, cmd });
    if (this.delayMs > 0) await sleep(this.delayMs);
    if (cmd[0] === 'git' && cmd[1] === 'push') return this.pushResult;
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'create') {
      return this.createResult;
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'view') {
      return this.viewResult;
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

interface Harness {
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
    new FakeExecutor({ finish: { state: 'finished', costUsd: 0, turns: 1 } })
  );
  return { orchestrator, store, cache, events };
}

async function dispatchAndFinish(harness: Harness): Promise<{
  runId: string;
  taskId: string;
}> {
  const task = harness.store.create({ title: 'PR me' });
  const meta = harness.orchestrator.dispatch(task.meta.id, 'fake');
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
    const meta = harness.orchestrator.dispatch(task.meta.id, 'stuck');
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
