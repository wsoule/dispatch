import { TaskStore } from '@dispatch-foo/core';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus } from '../src/events.js';
import type { ServerEvent } from '../src/events.js';
import { OriginWriter } from '../src/git/originWriter.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { MergeQueue } from '../src/orchestrator/mergeQueue.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { CommandResult, CommandRunner } from '../src/orchestrator/pr.js';
import { defaultCommandRunner } from '../src/orchestrator/pr.js';
import { WorktreeManager } from '../src/orchestrator/worktree.js';
import {
  initGitRepo,
  runGitSync,
  WatchedTaskStore,
} from './orchestrator/helpers.js';

// Origin-first merges: with a remote that carries the base branch, a merge
// lands on origin's copy and the main checkout follows. These run against a
// real bare remote, because the claims are about where commits end up.

// Each case dispatches a run, rebases, fetches and pushes for real; the 5s
// default is too tight once the machine is busy.
setDefaultTimeout(30_000);

let fakeHome: string;
let repo: string;
let origin: string;
const scratch: string[] = [];
const liveQueues: MergeQueue[] = [];
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  repo = initGitRepo('dispatch-origin-landing-');
  origin = mkdtempSync(join(tmpdir(), 'dispatch-origin-bare-'));
  runGitSync(origin, ['init', '--bare', '-b', 'main']);
  runGitSync(repo, ['remote', 'add', 'origin', origin]);
  runGitSync(repo, ['push', '-u', 'origin', 'main']);
});

afterEach(() => {
  for (const queue of liveQueues) queue.stop();
  liveQueues.length = 0;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  for (const dir of [fakeHome, repo, origin, ...scratch]) {
    rmSync(dir, { recursive: true, force: true });
  }
  scratch.length = 0;
});

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

interface Harness {
  orchestrator: Orchestrator;
  store: TaskStore;
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
      finish: { state: 'finished', costUsd: 0, turns: 1, sessionId: 's' },
    })
  );
  return {
    orchestrator,
    store: new WatchedTaskStore(repo, cache),
    events,
  };
}

function makeQueue(harness: Harness, run: CommandRunner): MergeQueue {
  const queue = new MergeQueue(
    {
      rootDir: repo,
      store: harness.store,
      cache: new TaskCache(),
      events: harness.events,
      orchestrator: harness.orchestrator,
    },
    run
  );
  liveQueues.push(queue);
  return queue;
}

// A finished run whose branch carries one real file, so landing it has
// content origin can be checked for.
async function finishedRunWithFile(
  harness: Harness,
  file: string
): Promise<string> {
  const task = harness.store.create({ title: `Add ${file}` });
  const meta = await harness.orchestrator.dispatch(task.meta.id, 'fake');
  await waitFor(
    () => harness.orchestrator.getRun(meta.id)?.meta.state === 'finished'
  );
  const worktree = harness.orchestrator.getRun(meta.id)!.meta.worktreePath;
  writeFileSync(join(worktree, file), `${file}\n`);
  runGitSync(worktree, ['add', file]);
  runGitSync(worktree, ['commit', '-m', `add ${file}`]);
  return meta.id;
}

function originTip(): string {
  return runGitSync(origin, ['rev-parse', 'refs/heads/main']).trim();
}

function originHasFile(file: string): boolean {
  const tree = runGitSync(origin, ['ls-tree', '--name-only', 'main']);
  return tree.split('\n').includes(file);
}

// Pushes an unrelated commit to origin from a second clone: a teammate (or
// CI) moving the branch underneath the daemon.
function pushFromElsewhere(file: string): void {
  const other = mkdtempSync(join(tmpdir(), 'dispatch-other-clone-'));
  scratch.push(other);
  runGitSync(other, ['clone', '-q', origin, '.']);
  runGitSync(other, ['config', 'user.email', 'other@example.com']);
  runGitSync(other, ['config', 'user.name', 'Other']);
  writeFileSync(join(other, file), 'theirs\n');
  runGitSync(other, ['add', file]);
  runGitSync(other, ['commit', '-m', `other: ${file}`]);
  runGitSync(other, ['push', '-q', 'origin', 'main']);
}

function capture(events: EventBus): ServerEvent[] {
  const seen: ServerEvent[] = [];
  events.add({ send: (data: string) => seen.push(JSON.parse(data)) });
  return seen;
}

describe('origin-first merge queue', () => {
  it('lands on origin while the main checkout is dirty and on another branch', async () => {
    const harness = makeHarness();
    const runId = await finishedRunWithFile(harness, 'feature.txt');
    // Every one of these used to block the merge with MergeEnvironmentError.
    runGitSync(repo, ['checkout', '-q', '-b', 'scratch-work']);
    writeFileSync(join(repo, 'README.md'), '# edited, not committed\n');
    writeFileSync(join(repo, 'stray.zip'), 'untracked\n');
    runGitSync(repo, ['add', 'README.md']);

    const queue = makeQueue(harness, defaultCommandRunner);
    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().entries.length === 0, 15_000);

    const entry = queue.snapshot().history[0];
    expect(entry?.state).toBe('merged');
    expect(entry?.landedOn).toBe('origin');
    expect(originHasFile('feature.txt')).toBe(true);
    const run = harness.orchestrator.getRun(runId)!.meta;
    expect(run.reviewAction).toBe('merge');
    expect(run.mergeCommit).toBe(originTip());
    // Followed: local main (not checked out) fast-forwarded to origin.
    expect(runGitSync(repo, ['rev-parse', 'refs/heads/main']).trim()).toBe(
      originTip()
    );
    // The user's checkout was not touched.
    expect(runGitSync(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      'scratch-work'
    );
    expect(existsSync(join(repo, 'stray.zip'))).toBe(true);
    expect(runGitSync(repo, ['diff', '--cached', '--name-only']).trim()).toBe(
      'README.md'
    );
  });

  it('fast-forwards a checked-out base and keeps unrelated edits', async () => {
    const harness = makeHarness();
    const runId = await finishedRunWithFile(harness, 'feature.txt');
    writeFileSync(join(repo, 'README.md'), '# local edit\n');

    const queue = makeQueue(harness, defaultCommandRunner);
    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().entries.length === 0, 15_000);

    expect(queue.snapshot().history[0]?.landedOn).toBe('origin');
    expect(runGitSync(repo, ['rev-parse', 'HEAD']).trim()).toBe(originTip());
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true);
    expect(runGitSync(repo, ['status', '--porcelain', 'README.md'])).toContain(
      'README.md'
    );
  });

  it('never leaves work merged locally but missing on origin, and owes no drain-push', async () => {
    const harness = makeHarness();
    const events = capture(harness.events);
    const runId = await finishedRunWithFile(harness, 'feature.txt');
    const pushes: string[][] = [];
    const recording: CommandRunner = (cwd, cmd, opts) => {
      if (cmd[0] === 'git' && cmd[1] === 'push') pushes.push(cmd);
      return defaultCommandRunner(cwd, cmd, opts);
    };

    const queue = makeQueue(harness, recording);
    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().entries.length === 0, 15_000);

    // Exactly one push, of the landing commit, not of the local branch.
    expect(pushes.length).toBe(1);
    expect(pushes[0]?.[3]).toMatch(/^[0-9a-f]{40}:refs\/heads\/main$/);
    // The local branch is never ahead of origin: every commit it has, origin has.
    const ahead = runGitSync(repo, [
      'rev-list',
      '--count',
      'refs/remotes/origin/main..refs/heads/main',
    ]).trim();
    expect(ahead).toBe('0');
    const drained = events.find((e) => e.type === 'queue.drained');
    expect(drained).toBeUndefined();
  });

  it('rebuilds on the new tip when origin moves between fetch and push', async () => {
    const harness = makeHarness();
    const runId = await finishedRunWithFile(harness, 'feature.txt');
    let raced = false;
    const racing: CommandRunner = (cwd, cmd, opts) => {
      if (!raced && cmd[0] === 'git' && cmd[1] === 'push') {
        raced = true;
        pushFromElsewhere('theirs.txt');
      }
      return defaultCommandRunner(cwd, cmd, opts);
    };

    const queue = makeQueue(harness, racing);
    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().entries.length === 0, 15_000);

    expect(raced).toBe(true);
    expect(queue.snapshot().history[0]?.state).toBe('merged');
    // Both survive: the teammate's push was not overwritten.
    expect(originHasFile('theirs.txt')).toBe(true);
    expect(originHasFile('feature.txt')).toBe(true);
  });

  it('holds the entry, without merging anything, while origin is unreachable', async () => {
    const harness = makeHarness();
    const runId = await finishedRunWithFile(harness, 'feature.txt');
    const before = runGitSync(repo, ['rev-parse', 'HEAD']).trim();
    const offline: CommandRunner = (cwd, cmd, opts) => {
      if (cmd[0] === 'git' && (cmd[1] === 'fetch' || cmd[1] === 'push')) {
        const down: CommandResult = {
          ok: false,
          stdout: '',
          stderr:
            "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com",
        };
        return Promise.resolve(down);
      }
      return defaultCommandRunner(cwd, cmd, opts);
    };

    const queue = makeQueue(harness, offline);
    queue.enqueue(runId);
    await waitFor(
      () => queue.snapshot().entries[0]?.state === 'blocked-environment',
      15_000
    );

    expect(queue.snapshot().entries[0]?.reason).toContain(
      'origin is unreachable'
    );
    expect(harness.orchestrator.getRun(runId)!.meta.reviewedAt).toBeUndefined();
    expect(runGitSync(repo, ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(originHasFile('feature.txt')).toBe(false);
  });

  // The rebase's fetch got through, then the connection dropped before the
  // push. Same hold, decided by the lander rather than the queue's rebase.
  it('holds the entry when origin drops between the fetch and the push', async () => {
    const harness = makeHarness();
    const runId = await finishedRunWithFile(harness, 'feature.txt');
    const dropsOnPush: CommandRunner = (cwd, cmd, opts) => {
      if (cmd[0] === 'git' && cmd[1] === 'push') {
        return Promise.resolve({
          ok: false,
          stdout: '',
          stderr:
            'ssh: connect to host github.com port 22: Network is unreachable\nfatal: Could not read from remote repository.',
        });
      }
      return defaultCommandRunner(cwd, cmd, opts);
    };

    const queue = makeQueue(harness, dropsOnPush);
    queue.enqueue(runId);
    await waitFor(
      () => queue.snapshot().entries[0]?.state === 'blocked-environment',
      15_000
    );

    expect(queue.snapshot().entries[0]?.reason).toContain(
      'origin is unreachable, so nothing was merged'
    );
    expect(harness.orchestrator.getRun(runId)!.meta.reviewedAt).toBeUndefined();
    expect(originHasFile('feature.txt')).toBe(false);
  });

  it('fails with the reason when origin refuses the push outright', async () => {
    const harness = makeHarness();
    const runId = await finishedRunWithFile(harness, 'feature.txt');
    const refused: CommandRunner = (cwd, cmd, opts) => {
      if (cmd[0] === 'git' && cmd[1] === 'push') {
        return Promise.resolve({
          ok: false,
          stdout: '',
          stderr:
            'remote: error: GH006: Protected branch update failed for refs/heads/main.',
        });
      }
      return defaultCommandRunner(cwd, cmd, opts);
    };

    const queue = makeQueue(harness, refused);
    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().entries.length === 0, 15_000);

    const entry = queue.snapshot().history[0];
    expect(entry?.state).toBe('failed');
    expect(entry?.reason).toContain('Protected branch');
    const run = harness.orchestrator.getRun(runId)!.meta;
    expect(run.reviewedAt).toBeUndefined();
    expect(run.reviewFailure?.reason).toContain('Protected branch');
  });

  it('routes the Merge button (mergeNow) through the same origin landing', async () => {
    const harness = makeHarness();
    const runId = await finishedRunWithFile(harness, 'button.txt');
    runGitSync(repo, ['checkout', '-q', '-b', 'elsewhere']);

    const queue = makeQueue(harness, defaultCommandRunner);
    const merged = await queue.mergeNow(runId);

    expect(merged.reviewAction).toBe('merge');
    expect(merged.mergeCommit).toBe(originTip());
    expect(originHasFile('button.txt')).toBe(true);
  });
});

// The board syncer pushes task files the main checkout also holds as
// uncommitted edits. Identical bytes still make `merge --ff-only` refuse, so
// without the settle step the checkout would stop following after one sync.
describe('following origin with pending edits', () => {
  function originCommitsFile(file: string, content: string): void {
    const other = mkdtempSync(join(tmpdir(), 'dispatch-other-clone-'));
    scratch.push(other);
    runGitSync(other, ['clone', '-q', origin, '.']);
    runGitSync(other, ['config', 'user.email', 'other@example.com']);
    runGitSync(other, ['config', 'user.name', 'Other']);
    writeFileSync(join(other, file), content);
    runGitSync(other, ['add', file]);
    runGitSync(other, ['commit', '-m', `board: ${file}`]);
    runGitSync(other, ['push', '-q', 'origin', 'main']);
    runGitSync(repo, ['fetch', '-q', 'origin', 'main']);
  }

  it('follows when the only blocking edit already matches origin byte for byte', () => {
    originCommitsFile('README.md', '# synced by the board\n');
    writeFileSync(join(repo, 'README.md'), '# synced by the board\n');

    const follow = new WorktreeManager(repo).fastForwardToOrigin(
      'main',
      'main'
    );

    expect(follow.outcome).toBe('updated');
    expect(runGitSync(repo, ['rev-parse', 'HEAD']).trim()).toBe(originTip());
    expect(runGitSync(repo, ['status', '--porcelain']).trim()).toBe('');
  });

  it('stays behind, touching nothing, when a blocking edit differs from origin', () => {
    const before = runGitSync(repo, ['rev-parse', 'HEAD']).trim();
    originCommitsFile('README.md', '# theirs\n');
    writeFileSync(join(repo, 'README.md'), '# mine, unsaved work\n');

    const follow = new WorktreeManager(repo).fastForwardToOrigin(
      'main',
      'main'
    );

    expect(follow.outcome).toBe('behind');
    expect(runGitSync(repo, ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe(
      '# mine, unsaved work\n'
    );
  });

  it('restores a settled file when the fast-forward refuses for another reason', () => {
    originCommitsFile('README.md', '# synced\n');
    originCommitsFile('new.txt', 'from origin\n');
    writeFileSync(join(repo, 'README.md'), '# synced\n');
    // An untracked file in the way: settle can't clear it, so the merge refuses.
    writeFileSync(join(repo, 'new.txt'), 'local untracked\n');

    const follow = new WorktreeManager(repo).fastForwardToOrigin(
      'main',
      'main'
    );

    expect(follow.outcome).toBe('behind');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# synced\n');
    expect(runGitSync(repo, ['diff', '--cached', '--name-only']).trim()).toBe(
      ''
    );
  });
});

describe('local fallback', () => {
  it('keeps the local merge when the project has no origin remote', async () => {
    runGitSync(repo, ['remote', 'remove', 'origin']);
    const harness = makeHarness();
    const runId = await finishedRunWithFile(harness, 'feature.txt');

    const queue = makeQueue(harness, defaultCommandRunner);
    queue.enqueue(runId);
    await waitFor(() => queue.snapshot().entries.length === 0, 15_000);

    expect(queue.snapshot().history[0]?.landedOn).toBe('local');
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true);
  });
});

describe('OriginWriter', () => {
  it('runs sections one at a time, in order, and survives a failed one', async () => {
    const writer = new OriginWriter();
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = writer.exclusive(async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
      throw new Error('push rejected');
    });
    const second = writer.exclusive(() => {
      order.push('second');
      return Promise.resolve(2);
    });
    await Promise.resolve();
    expect(writer.busy()).toBe(true);
    expect(order).toEqual(['first:start']);

    release();
    await expect(first).rejects.toThrow('push rejected');
    expect(await second).toBe(2);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(writer.busy()).toBe(false);
  });
});
