import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { Executor, RunMeta } from '../src/orchestrator/types.js';
import { json } from './json.js';
import {
  initGitRepoAt,
  runGitSync,
  StallingExecutor,
} from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// Waits for `check` to become true, polling every `intervalMs`, rejecting
// after `timeoutMs` — used below to wait for the watcher's debounced rebuild
// to land without hardcoding a sleep duration.
async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}

let root: string;
let fakeHome: string;
let handle: ServerHandle | undefined;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  // startServer hydrates the merge queue, which writes run state under
  // DISPATCH_HOME — left unset it lands in the real home, one dir per test.
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-server-resilience-'));
});

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('boot with a corrupt task file already on disk', () => {
  it('starts anyway, serves the good tasks, and reports the problem via health', async () => {
    const store = TaskStore.init(root);
    store.create({ title: 'Good task' }, '2026-07-13T01:00:00Z');
    writeFileSync(join(store.tasksDir, 'corrupt.md'), 'no frontmatter here');

    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    const baseUrl = `http://127.0.0.1:${handle.port}`;

    const health = await json(await fetch(`${baseUrl}/api/health`));
    expect(health.ok).toBe(true);
    expect(health.problems).toEqual(['corrupt.md: missing frontmatter']);

    const tasks = await json(await fetch(`${baseUrl}/api/tasks`));
    expect(tasks.map((t: { meta: { title: string } }) => t.meta.title)).toEqual(
      ['Good task']
    );
  });
});

describe('a task file going bad while the daemon is running', () => {
  it('stays alive and keeps serving the last-good cache, then recovers once fixed', async () => {
    const store = TaskStore.init(root);
    store.create({ title: 'Good task' }, '2026-07-13T01:00:00Z');

    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    const baseUrl = `http://127.0.0.1:${handle.port}`;

    // Confirm the daemon is healthy and serving the one good task before
    // introducing corruption.
    const before = await json(await fetch(`${baseUrl}/api/tasks`));
    expect(before).toHaveLength(1);

    const corruptFile = join(store.tasksDir, 'corrupt.md');
    writeFileSync(corruptFile, 'no frontmatter here');

    // The watcher debounces at 100ms; wait for the rebuild to notice the new
    // file and surface it as a health problem instead of crashing the
    // process.
    await waitFor(async () => {
      const health = await json(await fetch(`${baseUrl}/api/health`));
      return health.ok === true && health.problems.length > 0;
    });

    const healthWhileCorrupt = await json(await fetch(`${baseUrl}/api/health`));
    expect(healthWhileCorrupt.ok).toBe(true);
    expect(healthWhileCorrupt.problems).toEqual([
      'corrupt.md: missing frontmatter',
    ]);

    const tasksWhileCorrupt = await json(await fetch(`${baseUrl}/api/tasks`));
    expect(tasksWhileCorrupt).toHaveLength(1);

    // Fix the file in place — same id/kind, valid frontmatter this time —
    // and confirm it reappears and the health problem clears.
    writeFileSync(
      corruptFile,
      [
        '---',
        'id: t-cafe01',
        'title: Fixed',
        'status: todo',
        'kind: task',
        'created: 2026-07-13T02:00:00Z',
        'updated: 2026-07-13T02:00:00Z',
        '---',
        '',
      ].join('\n')
    );

    await waitFor(async () => {
      const health = await json(await fetch(`${baseUrl}/api/health`));
      return health.problems.length === 0;
    });

    const tasksAfterFix = await json(await fetch(`${baseUrl}/api/tasks`));
    expect(
      tasksAfterFix.map((t: { meta: { title: string } }) => t.meta.title).sort()
    ).toEqual(['Fixed', 'Good task']);
  });
});

describe('unexpected internal errors', () => {
  it('returns opaque 500 JSON, never a stack trace or filesystem path', async () => {
    const store = TaskStore.init(root);
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      webDistDir: null,
    });
    useTestAuth(handle);
    const baseUrl = `http://127.0.0.1:${handle.port}`;

    // Remove the tasks directory out from under the store so the next create
    // throws ENOENT — an error class handleApi does not map, exercising the
    // Bun.serve error handler instead of the framework's dev error page.
    rmSync(store.tasksDir, { recursive: true, force: true });

    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Doomed' }),
    });
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe(
      'application/json; charset=utf-8'
    );
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal error' });
    expect(text).not.toContain(root);
    expect(text).not.toContain('at ');
  });
});

describe('boot with a malformed config.yml', () => {
  it('starts anyway and keeps serving, rather than dying on the carto read', async () => {
    const store = TaskStore.init(root);
    store.create({ title: 'Survivor' }, '2026-07-13T01:00:00Z');
    // Unparseable YAML: the boot-path loadConfig that picks carto's mode
    // throws on this, and a config typo must not take the daemon down.
    writeFileSync(join(root, '.dispatch/config.yml'), 'statuses: [a\n');

    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    const tasks = await json(
      await fetch(`http://127.0.0.1:${handle.port}/api/tasks`)
    );
    expect(tasks.map((t: { meta: { title: string } }) => t.meta.title)).toEqual(
      ['Survivor']
    );
  });

  // Task 7 review, IMPORTANT 7: the prWorktreeDir read on the boot path
  // (index.ts, alongside carto's) must be guarded the same way — a config
  // typo here must not take the daemon down either.
  it('falls back to the default PR worktree location, rather than dying on the prWorktreeDir read', async () => {
    TaskStore.init(root);
    writeFileSync(join(root, '.dispatch/config.yml'), 'statuses: [a\n');

    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);

    expect(handle.prWorktrees.worktreePathFor(1)).toBe(
      join(dirname(root), `${basename(root)}-worktrees`, 'pr-1')
    );
  });
});

// Task 7 review, IMPORTANT 8's other half: PrWorktreeManager's own
// constructor refuses a prWorktreeDir that resolves inside rootDir — but
// that refusal (buildPrWorktreeManager in index.ts) must degrade to the
// default location rather than crash boot, the same as any other bad
// optional config value.
describe('boot with a prWorktreeDir misconfigured to resolve inside rootDir', () => {
  it('falls back to the default location instead of dying at boot', async () => {
    TaskStore.init(root);
    writeFileSync(
      join(root, '.dispatch/config.yml'),
      `prWorktreeDir: ${join(root, 'nested-worktrees')}\n`
    );

    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);

    expect(handle.prWorktrees.worktreePathFor(1)).toBe(
      join(dirname(root), `${basename(root)}-worktrees`, 'pr-1')
    );
  });
});

// The 2026-08-22 incident: dispatchd restarted with three runs in flight,
// reconcileOnBoot force-failed all three, and one nearly-complete run — its
// worktree, branch and session entirely intact — was lost outright, because
// re-dispatching its task started a brand new run instead of picking that one
// up. These cover both halves of the fix: boot recovers the run by itself
// (deferring while the agent it orphaned is still writing), and a re-dispatch
// of the task resumes rather than starting over.
describe('a daemon restart with a run in flight', () => {
  // Boots a daemon on the shared `root`, replacing whatever is running there.
  // `quietMs` squeezes the recovery sweep's quiet window down to something a
  // test can wait out — or, passed something huge, holds the sweep off so a
  // test can drive the re-dispatch path without racing it.
  async function boot(executor: Executor, quietMs: number): Promise<string> {
    await handle?.stop();
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      webDistDir: null,
      registerExecutors: (orchestrator) => {
        orchestrator.registerExecutor('claude', executor);
      },
      autoResumeQuietMs: quietMs,
    });
    useTestAuth(handle);
    return `http://127.0.0.1:${handle.port}`;
  }

  async function runsOn(baseUrl: string): Promise<RunMeta[]> {
    const runs: RunMeta[] = await json(await fetch(`${baseUrl}/api/runs`));
    return runs;
  }

  // The run created to continue `runId`, if one has landed yet.
  async function successorOf(
    baseUrl: string,
    runId: string
  ): Promise<RunMeta | undefined> {
    return (await runsOn(baseUrl)).find((r) => r.resumedFrom === runId);
  }

  // POSTs what `dispatch run <taskId>` posts. The JSON content-type is not
  // optional even for an empty body — it is the daemon's CSRF guard, and a
  // POST without it never reaches the handler (see requireJsonContentType).
  async function postRun(
    baseUrl: string,
    taskId: string,
    body: Record<string, unknown> = {}
  ): Promise<Response> {
    return await fetch(`${baseUrl}/api/tasks/${taskId}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // Dispatches a run and lands one real commit in its worktree — the work the
  // incident lost.
  async function dispatchAndCommit(
    baseUrl: string,
    taskId: string
  ): Promise<RunMeta> {
    const meta: RunMeta = await json(await postRun(baseUrl, taskId));
    writeFileSync(join(meta.worktreePath, 'work.txt'), 'nearly done\n');
    runGitSync(meta.worktreePath, ['add', '-A']);
    runGitSync(meta.worktreePath, ['commit', '-m', 'agent: nearly done']);
    return meta;
  }

  // Waits for the boot sweep to have force-failed `runId`, whichever of the
  // two dead states its survey settled on.
  async function waitForCrashRecorded(
    baseUrl: string,
    runId: string
  ): Promise<void> {
    await waitFor(async () => {
      const run = (await runsOn(baseUrl)).find((r) => r.id === runId);
      return run?.state === 'failed' || run?.state === 'interrupted-dirty';
    });
  }

  it('picks the crashed run back up in its own worktree instead of losing it', async () => {
    initGitRepoAt(root);
    const store = TaskStore.init(root);
    const task = store.create({ title: 'In flight when the daemon dies' });

    const before = new StallingExecutor();
    const firstUrl = await boot(before, 40);
    const lost = await dispatchAndCommit(firstUrl, task.meta.id);
    expect(lost.state).toBe('running');

    // The restart. Nothing else changes: same root, same repo, same worktree.
    const after = new StallingExecutor();
    const baseUrl = await boot(after, 40);

    await waitFor(
      async () => (await successorOf(baseUrl, lost.id)) !== undefined,
      10_000
    );
    const successor = await successorOf(baseUrl, lost.id);
    expect(successor?.worktreePath).toBe(lost.worktreePath);
    expect(successor?.branch).toBe(lost.branch);
    expect(successor?.state).toBe('running');
    // Same checkout, and the pre-crash commit is still the branch head: the
    // work carried over rather than being started again from nothing.
    expect(
      runGitSync(lost.worktreePath, ['log', '-1', '--pretty=%s'])
    ).toContain('agent: nearly done');
    expect(after.started[0]?.cwd).toBe(lost.worktreePath);
    // The run the restart killed stays dead — it is the successor that runs.
    const predecessor = (await runsOn(baseUrl)).find((r) => r.id === lost.id);
    expect(predecessor?.state).toBe('failed');
  });

  it('defers while the orphaned agent is still committing, and resumes once it stops', async () => {
    initGitRepoAt(root);
    const store = TaskStore.init(root);
    const task = store.create({ title: 'Orphan outlives the daemon' });

    const before = new StallingExecutor();
    const firstUrl = await boot(before, 60);
    const lost = await dispatchAndCommit(firstUrl, task.meta.id);

    const after = new StallingExecutor();
    const baseUrl = await boot(after, 60);

    // The orphaned agent process survived the restart and is still landing
    // commits. Every commit moves the branch head, so each sample the recovery
    // sweep takes sees a worktree that changed since the one before it.
    let stillGoing = true;
    let landed = 0;
    const orphan = (async () => {
      while (stillGoing) {
        writeFileSync(
          join(lost.worktreePath, `orphan-${landed}.txt`),
          'still going\n'
        );
        runGitSync(lost.worktreePath, ['add', '-A']);
        runGitSync(lost.worktreePath, [
          'commit',
          '-m',
          `orphan commit ${landed}`,
        ]);
        landed++;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();

    // Polled on the orphan's own progress rather than a wall-clock sleep: what
    // has to be true before the assertion means anything is that the sweep had
    // several quiet windows' worth of moving ground to look at.
    await waitFor(() => Promise.resolve(landed > 4), 10_000);
    // ...and it refused every one of them: resuming here would put a second
    // agent in the orphan's checkout.
    expect(await successorOf(baseUrl, lost.id)).toBeUndefined();
    expect(after.started).toHaveLength(0);

    stillGoing = false;
    await orphan;

    // Deferred, not abandoned: the same sweep picks the run up once the branch
    // stops moving, and the orphan's own commits are still on it.
    await waitFor(
      async () => (await successorOf(baseUrl, lost.id)) !== undefined,
      10_000
    );
    expect((await successorOf(baseUrl, lost.id))?.worktreePath).toBe(
      lost.worktreePath
    );
    expect(
      runGitSync(lost.worktreePath, ['log', '-1', '--pretty=%s'])
    ).toContain(`orphan commit ${landed - 1}`);
  });

  // A re-dispatch arriving while the sweep is still proving the orphan has
  // stopped is the same hazard wearing a different hat: it would resume into
  // the contested worktree immediately, and the sweep would then find the run
  // "already resumed" and quietly exit. It has to wait for the same proof.
  it('refuses a re-dispatch while the orphan is still writing, then resumes once it stops', async () => {
    initGitRepoAt(root);
    const store = TaskStore.init(root);
    const task = store.create({ title: 'Re-dispatched too early' });

    const before = new StallingExecutor();
    const firstUrl = await boot(before, 60);
    const lost = await dispatchAndCommit(firstUrl, task.meta.id);

    const after = new StallingExecutor();
    const baseUrl = await boot(after, 60);
    await waitForCrashRecorded(baseUrl, lost.id);

    let stillGoing = true;
    let landed = 0;
    const orphan = (async () => {
      while (stillGoing) {
        writeFileSync(
          join(lost.worktreePath, `orphan-${landed}.txt`),
          'still going\n'
        );
        runGitSync(lost.worktreePath, ['add', '-A']);
        runGitSync(lost.worktreePath, [
          'commit',
          '-m',
          `orphan commit ${landed}`,
        ]);
        landed++;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    await waitFor(() => Promise.resolve(landed > 2), 10_000);

    const refused = await postRun(baseUrl, task.meta.id);
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toContain('daemon restart');
    expect(after.started).toHaveLength(0);

    stillGoing = false;
    await orphan;

    // The refusal re-armed the sweep rather than washing its hands of the run,
    // so the work still comes back without anyone asking twice.
    await waitFor(
      async () => (await successorOf(baseUrl, lost.id)) !== undefined,
      10_000
    );
    expect((await successorOf(baseUrl, lost.id))?.worktreePath).toBe(
      lost.worktreePath
    );
  });

  // The rest boot with the recovery sweep held off (a quiet window longer than
  // the test lives), so what is under test is the re-dispatch itself rather
  // than the boot sweep racing it to the same run. Each first waits out one
  // sweep sample so `observedQuiet` is set and the resume is not refused.
  async function bootAndSettle(
    executor: Executor,
    runId: string
  ): Promise<string> {
    const baseUrl = await boot(executor, 30);
    await waitForCrashRecorded(baseUrl, runId);
    // One quiet window plus a margin: enough for the sweep to take its two
    // matching samples and record that the worktree is not moving.
    await waitFor(
      async () => (await successorOf(baseUrl, runId)) !== undefined,
      10_000
    );
    return baseUrl;
  }

  it('resumes the lost run when the task is re-dispatched', async () => {
    initGitRepoAt(root);
    const store = TaskStore.init(root);
    const task = store.create({ title: 'Re-dispatched after the restart' });

    const before = new StallingExecutor();
    const firstUrl = await boot(before, 60_000);
    const lost = await dispatchAndCommit(firstUrl, task.meta.id);

    // The sweep resumes this one itself, which is the point — the re-dispatch
    // below then finds a live run and is refused for the ordinary reason,
    // proving the two paths agree rather than racing.
    const after = new StallingExecutor();
    const baseUrl = await bootAndSettle(after, lost.id);
    const successor = await successorOf(baseUrl, lost.id);

    expect(successor?.worktreePath).toBe(lost.worktreePath);
    expect(successor?.branch).toBe(lost.branch);
    expect(after.started[0]?.cwd).toBe(lost.worktreePath);

    const redispatch = await postRun(baseUrl, task.meta.id);
    expect(redispatch.status).toBe(409);
    expect((await json(redispatch)).error).toContain('already has a live run');
  });

  it('starts a genuinely new run when the re-dispatch asks for a fresh one', async () => {
    initGitRepoAt(root);
    const store = TaskStore.init(root);
    const task = store.create({ title: 'Re-dispatched with --fresh' });

    const before = new StallingExecutor();
    const firstUrl = await boot(before, 60_000);
    const lost = await dispatchAndCommit(firstUrl, task.meta.id);

    const after = new StallingExecutor();
    const baseUrl = await boot(after, 60_000);
    await waitForCrashRecorded(baseUrl, lost.id);

    const fresh: RunMeta = await json(
      await postRun(baseUrl, task.meta.id, { fresh: true })
    );
    expect(fresh.resumedFrom).toBeUndefined();
    expect(fresh.worktreePath).not.toBe(lost.worktreePath);
    expect(fresh.branch).not.toBe(lost.branch);
  });

  it('rejects a non-boolean fresh flag rather than guessing', async () => {
    initGitRepoAt(root);
    const store = TaskStore.init(root);
    const task = store.create({ title: 'Bad fresh flag' });
    const baseUrl = await boot(new StallingExecutor(), 60_000);

    const res = await postRun(baseUrl, task.meta.id, { fresh: 'yes' });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('invalid fresh: expected a boolean');
  });
});
