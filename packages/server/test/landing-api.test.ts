import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { LandingSnapshot } from '../src/landing.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import type { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { CommandResult } from '../src/orchestrator/pr.js';
import { defaultCommandRunner } from '../src/orchestrator/pr.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-landing-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  runGitSync(dir, ['commit', '--allow-empty', '-m', 'initial commit']);
  return dir;
}

// One open repo PR the fake `gh pr list --state open` call returns — its
// url is what a seeded run's `prUrl` is matched against by buildLandingSnapshot.
const OPEN_PR = {
  number: 9,
  title: 'Add landing feed',
  url: 'https://github.com/example/repo/pull/9',
  headRefName: 'feature/landing',
  baseRefName: 'main',
  headRefOid: 'deadbeef9',
  author: { login: 'someone' },
  isDraft: false,
  updatedAt: '2026-08-08T00:00:00Z',
  state: 'OPEN',
  isCrossRepository: false,
  headRepositoryOwner: { login: 'example' },
  reviewDecision: null,
  mergeable: 'MERGEABLE',
  statusCheckRollup: [],
  additions: 3,
  deletions: 1,
  changedFiles: 1,
};

// A scripted gh/git CommandRunner answering exactly what detectPrCapability
// and PrManager's list calls need — mirrors prs-api.test.ts's stubRunner,
// scoped to only the commands the landing route's inputs touch.
function stubRunner(listResult: CommandResult) {
  return (_cwd: string, cmd: string[]): Promise<CommandResult> => {
    if (cmd[0] === 'gh' && cmd[1] === '--version') {
      return Promise.resolve({
        ok: true,
        stdout: 'gh version 2.0.0',
        stderr: '',
      });
    }
    if (
      cmd[0] === 'git' &&
      cmd[1] === 'remote' &&
      cmd[2] === 'get-url' &&
      cmd[3] === 'origin'
    ) {
      return Promise.resolve({
        ok: true,
        stdout: 'https://github.com/example/repo.git',
        stderr: '',
      });
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'list') {
      return Promise.resolve(listResult);
    }
    return Promise.resolve({
      ok: false,
      stdout: '',
      stderr: 'unhandled stub command',
    });
  };
}

function openPrListResult(): CommandResult {
  return { ok: true, stdout: JSON.stringify([OPEN_PR]), stderr: '' };
}

function mergedPrListResult(): CommandResult {
  return { ok: true, stdout: JSON.stringify([]), stderr: '' };
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
// Captured through startServer's registerExecutors hook, so tests can drive
// dispatch/finish/prUrl directly rather than round-tripping through HTTP.
let orchestrator: Orchestrator;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  TaskStore.init(root);
});

afterEach(async () => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  await handle.stop();
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

describe('GET /api/landing', () => {
  it('joins a finished run with its PR into one run-pr row', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: async (cwd, cmd) => {
        if (
          cmd[0] === 'gh' &&
          cmd[1] === 'pr' &&
          cmd[2] === 'list' &&
          cmd.includes('merged')
        ) {
          return mergedPrListResult();
        }
        return stubRunner(openPrListResult())(cwd, cmd);
      },
      registerExecutors: (o) => {
        orchestrator = o;
        o.registerExecutor(
          'fake',
          new FakeExecutor({ finish: { state: 'finished' } })
        );
      },
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    // Populates PrManager.cachedPrs() deterministically, ahead of any run
    // carrying a `prUrl` — no `gh pr view` merged-check call to stub, and no
    // race with the (unstarted-here) 60s production poll timer.
    await handle.prManager.pollOnce();

    const store = new TaskStore(root);
    const task = store.create({ title: 'Add landing feed' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );
    orchestrator.setRunPrUrl(meta.id, OPEN_PR.url);

    const res = await fetch(`${baseUrl}/api/landing`);
    expect(res.status).toBe(200);
    const body = (await json(res)) as LandingSnapshot;
    expect(body.generatedAt).toBeTruthy();
    const runPrRows = body.rows.filter((r) => r.kind === 'run-pr');
    expect(runPrRows).toHaveLength(1);
    expect(runPrRows[0].runId).toBe(meta.id);
    expect(runPrRows[0].pr?.url).toBe(OPEN_PR.url);
  });

  // Task 7: a PR row carries `worktree` once one has been cut for it — the
  // real wiring `toLandingWorktree(prWorktrees.list())` replaces the always-
  // empty Map Task 4 left behind.
  it('carries a worktree on a pr row once one has been created', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: async (cwd, cmd) => {
        // detectPrCapability's two calls, and the poll's `gh pr list`
        // (open/merged) — the existing stubRunner helper's own repertoire.
        if (
          (cmd[0] === 'gh' && cmd[1] === '--version') ||
          (cmd[0] === 'git' &&
            cmd[1] === 'remote' &&
            cmd[2] === 'get-url' &&
            cmd[3] === 'origin') ||
          (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'list')
        ) {
          return cmd.includes('merged')
            ? mergedPrListResult()
            : stubRunner(openPrListResult())(cwd, cmd);
        }
        // Everything else (git worktree add/list, git status, git
        // rev-parse) is PrWorktreeManager's own real work against `root`.
        return defaultCommandRunner(cwd, cmd);
      },
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
    await handle.prManager.pollOnce();

    // Simulates what PrManager.fetchPrHead's fork-gated fetch would have
    // left behind, without a real GitHub remote.
    runGitSync(root, [
      'update-ref',
      `refs/dispatch/pr/${OPEN_PR.number}`,
      runGitSync(root, ['rev-parse', 'HEAD']).trim(),
    ]);
    const created = await handle.prWorktrees.create(OPEN_PR.number);

    const res = await fetch(`${baseUrl}/api/landing`);
    expect(res.status).toBe(200);
    const body = (await json(res)) as LandingSnapshot;
    const prRow = body.rows.find((r) => r.id === `pr-${OPEN_PR.number}`);
    expect(prRow?.worktree?.path).toBe(created.path);
    expect(prRow?.worktree?.syncState).toBe('synced');
    expect(prRow?.worktree?.headOid).toBe(created.headOid);

    rmSync(created.path, { recursive: true, force: true });
  });

  it('200s with queue-local rows intact when the project lacks pr capability', async () => {
    // No prCommandRunner override — the real defaultCommandRunner against a
    // repo with no configured remote reports pr:false, same as GET /api/prs's
    // own capability-off case. The route must not 409 for a local-only repo.
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      registerExecutors: (o) => {
        orchestrator = o;
        o.registerExecutor(
          'fake',
          new FakeExecutor({ finish: { state: 'finished' } })
        );
      },
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const store = new TaskStore(root);
    const task = store.create({ title: 'Local-only work' });
    const meta = await orchestrator.dispatch(task.meta.id, 'fake');
    await waitFor(
      () => orchestrator.getRun(meta.id)?.meta.state === 'finished'
    );

    const res = await fetch(`${baseUrl}/api/landing`);
    expect(res.status).toBe(200);
    const body = (await json(res)) as LandingSnapshot;
    expect(body.generatedAt).toBeTruthy();
    expect(body.rows.some((r) => r.kind === 'pr' || r.kind === 'run-pr')).toBe(
      false
    );
    const queueLocalRows = body.rows.filter((r) => r.kind === 'queue-local');
    expect(queueLocalRows).toHaveLength(1);
    expect(queueLocalRows[0].runId).toBe(meta.id);
  });
});
