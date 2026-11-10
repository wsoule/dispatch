import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import { EventBus } from '../../src/events.js';
import {
  AccountFailover,
  type AccountSource,
  UNKNOWN_RESET_MS,
} from '../../src/orchestrator/accountFailover.js';
import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import type { FakeExecutorScript } from '../../src/orchestrator/executors/fake.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import type {
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
} from '../../src/orchestrator/types.js';
import { initGitRepo } from './helpers.js';

// Usage-limit failover (t-2299c8c6): a run its account's usage limit stops
// continues its session on the next stored account that still has usage.

function source(
  labels: string[],
  failover = true
): AccountSource & { setFailover(on: boolean): void } {
  let on = failover;
  return {
    failover: () => on,
    labels: () => labels,
    token: (_executor, label) => `tok-${label}`,
    setFailover: (next) => {
      on = next;
    },
  };
}

describe('AccountFailover', () => {
  it('records nothing when no accounts are stored', () => {
    const accounts = new AccountFailover(source([]));
    expect(accounts.accountFor('claude')).toBeUndefined();
    expect(accounts.afterLimit('claude', 'default')).toBeNull();
  });

  it('starts on the default login, and keeps a predecessor on its account', () => {
    const accounts = new AccountFailover(source(['work']));
    expect(accounts.accountFor('claude')).toEqual({ label: 'default' });
    expect(accounts.accountFor('claude', 'work')).toEqual({
      label: 'work',
      token: 'tok-work',
    });
    // A removed account falls back to the default login.
    expect(accounts.accountFor('claude', 'gone')).toEqual({
      label: 'default',
    });
  });

  it('moves past limited accounts in order and back once a limit resets', () => {
    let now = Date.parse('2026-10-20T12:00:00Z');
    const accounts = new AccountFailover(source(['a', 'b']), () => now);
    expect(
      accounts.afterLimit('claude', 'default', '2026-10-20T13:00:00Z')
    ).toEqual({ label: 'a', token: 'tok-a' });
    expect(accounts.afterLimit('claude', 'a')).toEqual({
      label: 'b',
      token: 'tok-b',
    });
    expect(accounts.accountFor('claude')?.label).toBe('b');
    expect(accounts.afterLimit('claude', 'b')).toBeNull();
    expect(accounts.status('claude')).toEqual([
      { label: 'default', limitedUntil: '2026-10-20T13:00:00.000Z' },
      {
        label: 'a',
        limitedUntil: new Date(now + UNKNOWN_RESET_MS).toISOString(),
      },
      {
        label: 'b',
        limitedUntil: new Date(now + UNKNOWN_RESET_MS).toISOString(),
      },
    ]);
    now = Date.parse('2026-10-20T13:00:01Z');
    expect(accounts.accountFor('claude', 'b')).toEqual({ label: 'default' });
  });

  it('with failover off, marks the limit but never moves the run', () => {
    const accounts = new AccountFailover(source(['a'], false));
    expect(accounts.afterLimit('claude', 'default')).toBeNull();
    expect(accounts.accountFor('claude')).toEqual({ label: 'default' });
  });
});

// Plays one script per start, in order, the last one repeating, and keeps
// every start's options.
class SequencedExecutor implements Executor {
  readonly starts: ExecutorStartOptions[] = [];

  constructor(private readonly scripts: FakeExecutorScript[]) {}

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    const script =
      this.scripts[Math.min(this.starts.length, this.scripts.length - 1)];
    this.starts.push(opts);
    return new FakeExecutor(script).start(opts, events);
  }
}

const LIMITED: FakeExecutorScript = {
  session: 'sess-1',
  finish: {
    state: 'failed',
    sessionId: 'sess-1',
    error: 'Claude usage limit reached before the agent finished',
    usageLimit: { resetsAt: '2099-01-01T00:00:00.000Z' },
  },
};
const DONE: FakeExecutorScript = {
  session: 'sess-1',
  finish: { state: 'finished', sessionId: 'sess-1' },
};

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

describe('orchestrator account failover', () => {
  let fakeHome: string;
  let repo: string;
  const originalDispatchHome = process.env.DISPATCH_HOME;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
    process.env.DISPATCH_HOME = fakeHome;
    repo = initGitRepo();
  });

  afterEach(() => {
    if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalDispatchHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  function setup(
    accounts: AccountSource,
    scripts: FakeExecutorScript[]
  ): {
    orchestrator: Orchestrator;
    store: TaskStore;
    executor: SequencedExecutor;
  } {
    const store = TaskStore.init(repo);
    const cache = new TaskCache();
    cache.rebuild(store);
    const orchestrator = new Orchestrator({
      rootDir: repo,
      store,
      cache,
      events: new EventBus(),
      accountFailover: new AccountFailover(accounts),
    });
    const executor = new SequencedExecutor(scripts);
    orchestrator.registerExecutor('claude', executor);
    return { orchestrator, store, executor };
  }

  it('continues a usage-limited run on the next account, same session', async () => {
    const { orchestrator, store, executor } = setup(source(['work']), [
      LIMITED,
      DONE,
    ]);
    const task = store.create({ title: 'Add a flag', status: 'ready' });
    const first = await orchestrator.dispatchOrResume(task.meta.id, {
      executor: 'claude',
    });
    expect(first.account).toBe('default');

    await waitFor(() =>
      orchestrator.list().some((r) => r.state === 'finished')
    );
    const successor = orchestrator
      .list()
      .find((r) => r.resumedFrom === first.id)!;
    expect(successor.account).toBe('work');
    expect(successor.state).toBe('finished');
    expect(orchestrator.list().find((r) => r.id === first.id)?.state).toBe(
      'failed'
    );

    expect(executor.starts).toHaveLength(2);
    expect(executor.starts[0].account).toEqual({ label: 'default' });
    expect(executor.starts[1].account).toEqual({
      label: 'work',
      token: 'tok-work',
    });
    expect(executor.starts[1].resumeSessionId).toBe('sess-1');

    const body = store.get(task.meta.id)!.body;
    expect(body).toContain(
      `usage limit on account 'default' — continuing on account 'work' (run ${successor.id})`
    );
  });

  it('stays failed when every account is out of usage', async () => {
    const { orchestrator, store, executor } = setup(source(['work']), [
      LIMITED,
    ]);
    const task = store.create({ title: 'Add a flag', status: 'ready' });
    await orchestrator.dispatchOrResume(task.meta.id, { executor: 'claude' });

    await waitFor(
      () => orchestrator.list().filter((r) => r.state === 'failed').length === 2
    );
    // Give a third (wrong) failover a chance to start.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(executor.starts.map((s) => s.account?.label)).toEqual([
      'default',
      'work',
    ]);
    expect(orchestrator.list()).toHaveLength(2);
  });

  it('does nothing with failover off', async () => {
    const { orchestrator, store, executor } = setup(source(['work'], false), [
      LIMITED,
      DONE,
    ]);
    const task = store.create({ title: 'Add a flag', status: 'ready' });
    await orchestrator.dispatchOrResume(task.meta.id, { executor: 'claude' });
    await waitFor(() => orchestrator.list().some((r) => r.state === 'failed'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(executor.starts).toHaveLength(1);
  });

  it('starts new runs on an account that still has usage', async () => {
    const { orchestrator, store, executor } = setup(source(['work']), [
      LIMITED,
      DONE,
    ]);
    const first = store.create({ title: 'First', status: 'ready' });
    await orchestrator.dispatchOrResume(first.meta.id, { executor: 'claude' });
    await waitFor(() =>
      orchestrator.list().some((r) => r.state === 'finished')
    );
    const second = store.create({ title: 'Second', status: 'ready' });
    const run = await orchestrator.dispatchOrResume(second.meta.id, {
      executor: 'claude',
    });
    expect(run.account).toBe('work');
    expect(executor.starts[2].account?.label).toBe('work');
  });

  it('records no account when none are stored', async () => {
    const { orchestrator, store, executor } = setup(source([]), [LIMITED]);
    const task = store.create({ title: 'Add a flag', status: 'ready' });
    const run = await orchestrator.dispatchOrResume(task.meta.id, {
      executor: 'claude',
    });
    expect('account' in run).toBe(false);
    await waitFor(() => orchestrator.list().some((r) => r.state === 'failed'));
    expect(executor.starts[0].account).toBeUndefined();
  });
});
