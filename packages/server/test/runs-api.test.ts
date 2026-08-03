import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { runGitSync } from './orchestrator/helpers.js';

// The exact script index.ts's production registration uses for 'fake' — one
// assistant entry, then an immediate finish. Registered under both 'fake'
// and 'claude' here (see `registerExecutors` below) so every test in this
// file, including ones that omit `executor` from the request body, exercises
// the real HTTP/WS dispatch path without ever constructing a real
// ClaudeExecutor / Agent SDK session — that stays scoped to the
// DISPATCH_CLAUDE_SMOKE-gated test in claude-executor.test.ts.
function defaultFakeScript(): FakeExecutor {
  return new FakeExecutor({
    steps: [
      {
        entry: {
          ts: new Date().toISOString(),
          kind: 'assistant',
          text: 'FakeExecutor: simulating a dispatch run.',
        },
      },
    ],
    finish: { state: 'finished', costUsd: 0, turns: 1 },
  });
}

// Pauses at an approval gate instead of finishing immediately, so a test can
// query a run while it is still deterministically live.
function gatedFakeScript(): FakeExecutor {
  return new FakeExecutor({
    steps: [{ approval: { requestId: 'go', toolName: 'noop', input: {} } }],
    finish: { state: 'finished', costUsd: 0, turns: 1 },
  });
}

// Same escape hatch as api.test.ts/resilience.test.ts: `Response.json()`
// types as `Promise<unknown>` under this repo's strict, DOM-less tsconfig.
function json(res: Response): Promise<any> {
  return res.json();
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}

// Creates a real git repo with an initial commit and a dispatch project on
// top of it — the orchestrator's routes need a real main checkout to
// provision worktrees against.
function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-runs-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('fake', defaultFakeScript());
      orchestrator.registerExecutor('claude', defaultFakeScript());
    },
  });
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function createTask(title: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  return json(res);
}

describe('POST /api/tasks/:id/runs', () => {
  it('404s dispatching an unknown task', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/t-000000/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executor: 'fake' }),
    });
    expect(res.status).toBe(404);
    expect((await json(res)).error).toMatch(/task not found/);
  });

  it('400s an invalid executor name', async () => {
    const task = await createTask('Bad executor');
    const res = await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executor: 'wombat' }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe(
      'invalid executor: wombat (expected fake|claude)'
    );
  });

  // M1: dispatching a task that's already closed out (done/cancelled) is
  // almost certainly a stale UI action, not a real intent to redo the work
  // — refuse it outright with a clear 409 rather than quietly starting a
  // new run against a task nobody expects to still be moving.
  it('409s dispatching a task whose status is done', async () => {
    const task = await createTask('Already done');
    await fetch(`${baseUrl}/api/tasks/${task.meta.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });

    const res = await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executor: 'fake' }),
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe('cannot dispatch a done task');
  });

  it('409s dispatching a task whose status is cancelled', async () => {
    const task = await createTask('Already cancelled');
    await fetch(`${baseUrl}/api/tasks/${task.meta.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' }),
    });

    const res = await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executor: 'fake' }),
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe('cannot dispatch a cancelled task');
  });

  it('dispatches with the default executor when the field is omitted', async () => {
    const task = await createTask('Default executor');
    // No `executor` field at all -> defaults to 'claude' (see
    // registerExecutors in beforeEach: a FakeExecutor stands in for it here
    // so this stays a routing/default-value test, not a real Agent SDK one).
    const res = await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(201);
    expect((await json(res)).executor).toBe('claude');
  });

  it('dispatches with the fake executor, returns 201 with run meta, and writes task Activity', async () => {
    const task = await createTask('Dispatch me');
    const res = await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executor: 'fake' }),
    });
    expect(res.status).toBe(201);
    const meta = await json(res);
    expect(meta.taskId).toBe(task.meta.id);
    expect(meta.executor).toBe('fake');
    expect(meta.branch).toContain(task.meta.id);

    await waitFor(async () => {
      const t = await json(await fetch(`${baseUrl}/api/tasks/${task.meta.id}`));
      return t.meta.status === 'in-review';
    });
    const finished = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}`)
    );
    expect(finished.body).toContain(`dispatched (fake, branch ${meta.branch})`);
  });

  it('allows re-dispatching a task once its prior run is no longer live, with a distinct branch', async () => {
    // The default FakeExecutor wired into startServer finishes synchronously
    // (no approval gate), so by the time the first request's response comes
    // back the run is already terminal — this exercises re-dispatch onto a
    // task whose previous run's worktree/branch is still sitting around
    // un-reviewed, a real scenario the branch-naming scheme must not
    // collide on. (The live-run 409 itself is exercised deterministically
    // at the orchestrator level with a never-resolving approval gate.)
    const task = await createTask('Only one live run');
    const first = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'fake' }),
      })
    );

    const secondRes = await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executor: 'fake' }),
    });
    expect(secondRes.status).toBe(201);
    const second = await json(secondRes);
    expect(second.id).not.toBe(first.id);
    expect(second.branch).not.toBe(first.branch);
  });
});

// M6: the "is this executor name even valid" 400 message must reflect
// whatever is actually registered on this Orchestrator instance, not a
// separately hardcoded list that can drift from it — this server only ever
// registers 'fake', so the message must say just that, not "fake|claude".
describe('POST /api/tasks/:id/runs — known executor names track the registry', () => {
  let soloHandle: ServerHandle;
  let soloBaseUrl: string;
  let soloRoot: string;

  beforeEach(async () => {
    soloRoot = initDispatchGitRepo();
    TaskStore.init(soloRoot);
    soloHandle = await startServer({
      rootDir: soloRoot,
      port: 0,
      writeDaemonFile: false,
      registerExecutors: (orchestrator) => {
        orchestrator.registerExecutor('fake', defaultFakeScript());
      },
    });
    soloBaseUrl = `http://127.0.0.1:${soloHandle.port}`;
  });

  afterEach(async () => {
    await soloHandle.stop();
    rmSync(soloRoot, { recursive: true, force: true });
  });

  it('lists only the registered executor in the invalid-executor message', async () => {
    const taskRes = await fetch(`${soloBaseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Solo executor registry' }),
    });
    const task = await json(taskRes);

    const res = await fetch(`${soloBaseUrl}/api/tasks/${task.meta.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executor: 'wombat' }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe(
      'invalid executor: wombat (expected fake)'
    );
  });
});

describe('GET /api/runs and /api/runs/:id', () => {
  it('lists live + recent runs and fetches one by id with its entries', async () => {
    const task = await createTask('List me');
    const dispatchRes = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'fake' }),
      })
    );

    const list = await json(await fetch(`${baseUrl}/api/runs`));
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((r: { id: string }) => r.id === dispatchRes.id)).toBe(
      true
    );

    const single = await json(
      await fetch(`${baseUrl}/api/runs/${dispatchRes.id}`)
    );
    expect(single.meta.id).toBe(dispatchRes.id);
    expect(Array.isArray(single.entries)).toBe(true);
  });

  it('404s an unknown run id', async () => {
    const res = await fetch(`${baseUrl}/api/runs/r-000000`);
    expect(res.status).toBe(404);
    expect((await json(res)).error).toMatch(/run not found/);
  });
});

// Its own server, with an approval-gated executor, so the run under test
// stays deterministically live instead of racing a fire-and-forget finish.
describe('GET /api/runs/claims', () => {
  let gateHandle: ServerHandle;
  let gateBaseUrl: string;
  let gateRoot: string;

  beforeEach(async () => {
    gateRoot = initDispatchGitRepo();
    TaskStore.init(gateRoot);
    gateHandle = await startServer({
      rootDir: gateRoot,
      port: 0,
      writeDaemonFile: false,
      registerExecutors: (orchestrator) => {
        orchestrator.registerExecutor('fake-gate', gatedFakeScript());
      },
    });
    gateBaseUrl = `http://127.0.0.1:${gateHandle.port}`;
  });

  afterEach(async () => {
    await gateHandle.stop();
    rmSync(gateRoot, { recursive: true, force: true });
  });

  it("lists a live run's claims, seeded from its task's writes", async () => {
    const taskRes = await fetch(`${gateBaseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Claim me', writes: ['a.ts', 'b.ts'] }),
    });
    const task = await json(taskRes);
    const dispatchRes = await json(
      await fetch(`${gateBaseUrl}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'fake-gate' }),
      })
    );
    await waitFor(async () => {
      const r = await json(
        await fetch(`${gateBaseUrl}/api/runs/${dispatchRes.id}`)
      );
      return r.meta.state === 'awaiting-approval';
    });

    const claims = await json(await fetch(`${gateBaseUrl}/api/runs/claims`));
    expect(Array.isArray(claims)).toBe(true);
    const entry = claims.find(
      (c: { runId: string }) => c.runId === dispatchRes.id
    );
    expect(entry).toEqual({
      runId: dispatchRes.id,
      taskId: task.meta.id,
      claims: ['a.ts', 'b.ts'],
    });
  });
});

describe('run review: merge and discard', () => {
  it('merges a finished run, moving the task to done with a real squash commit', async () => {
    const task = await createTask('Merge via API');
    const meta = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'fake' }),
      })
    );
    await waitFor(async () => {
      const r = await json(await fetch(`${baseUrl}/api/runs/${meta.id}`));
      return r.meta.state === 'finished';
    });

    const reviewRes = await fetch(`${baseUrl}/api/runs/${meta.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'merge' }),
    });
    expect(reviewRes.status).toBe(200);

    const finishedTask = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}`)
    );
    expect(finishedTask.meta.status).toBe('done');
    const log = runGitSync(root, ['log', '-1', '--pretty=%s']).trim();
    expect(log).toContain('Merge via API');
  });

  it('reports pushedToOrigin false on GET /api/runs for a merged run with no origin remote', async () => {
    // The shared fixture's FakeExecutor never writes a file, so its merge
    // never produces a mergeCommit — this scenario needs one, hence a
    // dedicated executor script (see the "known executor names" describe
    // block above for the same solo-server pattern).
    const writingRoot = initDispatchGitRepo();
    TaskStore.init(writingRoot);
    const writingHandle = await startServer({
      rootDir: writingRoot,
      port: 0,
      writeDaemonFile: false,
      registerExecutors: (orchestrator) => {
        orchestrator.registerExecutor(
          'fake',
          new FakeExecutor({
            steps: [
              {
                write: (cwd) => {
                  writeFileSync(join(cwd, 'feature.txt'), 'done\n');
                },
                commitMessage: 'agent: add feature',
              },
            ],
            finish: { state: 'finished' },
          })
        );
      },
    });
    const writingBaseUrl = `http://127.0.0.1:${writingHandle.port}`;
    try {
      const taskRes = await fetch(`${writingBaseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Merge with a real commit' }),
      });
      const task = await json(taskRes);
      const meta = await json(
        await fetch(`${writingBaseUrl}/api/tasks/${task.meta.id}/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ executor: 'fake' }),
        })
      );
      await waitFor(async () => {
        const r = await json(
          await fetch(`${writingBaseUrl}/api/runs/${meta.id}`)
        );
        return r.meta.state === 'finished';
      });

      const reviewRes = await fetch(
        `${writingBaseUrl}/api/runs/${meta.id}/review`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'merge' }),
        }
      );
      expect(reviewRes.status).toBe(200);

      const list = await json(await fetch(`${writingBaseUrl}/api/runs`));
      const listed = list.find((r: { id: string }) => r.id === meta.id);
      expect(listed.pushedToOrigin).toBe(false);
    } finally {
      await writingHandle.stop();
      rmSync(writingRoot, { recursive: true, force: true });
    }
  });

  it('400s an invalid review action', async () => {
    const task = await createTask('Bad review action');
    const meta = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'fake' }),
      })
    );
    await waitFor(async () => {
      const r = await json(await fetch(`${baseUrl}/api/runs/${meta.id}`));
      return r.meta.state === 'finished';
    });

    const res = await fetch(`${baseUrl}/api/runs/${meta.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'wat' }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe(
      'invalid action: wat (expected merge|discard|pr)'
    );
  });

  it('discards a finished run, restoring the task to todo', async () => {
    const task = await createTask('Discard via API');
    const meta = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'fake' }),
      })
    );
    await waitFor(async () => {
      const r = await json(await fetch(`${baseUrl}/api/runs/${meta.id}`));
      return r.meta.state === 'finished';
    });

    const res = await fetch(`${baseUrl}/api/runs/${meta.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'discard' }),
    });
    expect(res.status).toBe(200);
    const task2 = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}`)
    );
    expect(task2.meta.status).toBe('todo');
  });
});

describe('GET /api/runs/:id/diff', () => {
  it('404s an unknown run id', async () => {
    const res = await fetch(`${baseUrl}/api/runs/r-000000/diff`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/runs/:id/approval', () => {
  it('400s a missing requestId', async () => {
    const task = await createTask('Approval body validation');
    const meta = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'fake' }),
      })
    );
    const res = await fetch(`${baseUrl}/api/runs/${meta.id}/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allow: true }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/requestId/);
  });

  it('404s an unknown run id', async () => {
    const res = await fetch(`${baseUrl}/api/runs/r-000000/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'x', allow: true }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/runs/:id/message', () => {
  it('400s a missing text field', async () => {
    const task = await createTask('Message body validation');
    const meta = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'fake' }),
      })
    );
    const res = await fetch(`${baseUrl}/api/runs/${meta.id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/text/);
  });
});

describe('POST /api/runs/:id/cancel', () => {
  it('404s an unknown run id', async () => {
    const res = await fetch(`${baseUrl}/api/runs/r-000000/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });
});

describe('WebSocket run.changed / run.log broadcasts', () => {
  it('broadcasts run.changed and at least one run.log entry during a dispatch', async () => {
    const task = await createTask('WS broadcast');
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
    const seenTypes = new Set<string>();
    const gotRunChangedAndLog = new Promise<void>((resolve) => {
      ws.addEventListener('message', (ev) => {
        const parsed = JSON.parse(ev.data as string) as { type: string };
        seenTypes.add(parsed.type);
        if (seenTypes.has('run.changed') && seenTypes.has('run.log')) {
          resolve();
        }
      });
    });
    await new Promise<void>((resolve) =>
      ws.addEventListener('open', () => resolve())
    );

    await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executor: 'fake' }),
    });

    await Promise.race([
      gotRunChangedAndLog,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('WS event timeout')), 3000)
      ),
    ]);
    expect(seenTypes.has('run.changed')).toBe(true);
    expect(seenTypes.has('run.log')).toBe(true);

    ws.close();
  });
});

// The branches surface's HTTP layer (spec §3). The interesting part here is
// URL encoding: every dispatch branch name contains `/`, so the DELETE route
// has to reassemble a name that URL parsing has already split apart.
describe('/api/branches', () => {
  // Dispatches a run and waits for it to finish, leaving one un-reviewed
  // branch + worktree behind for the branches routes to act on.
  async function finishedRun(title = 'Branch surface'): Promise<any> {
    const task = await createTask(title);
    const res = await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executor: 'fake' }),
    });
    const meta = await json(res);
    await waitFor(async () => {
      const run = await json(await fetch(`${baseUrl}/api/runs/${meta.id}`));
      return run.meta.state === 'finished';
    });
    return meta;
  }

  it('lists a finished run as reviewable', async () => {
    const meta = await finishedRun();

    const res = await fetch(`${baseUrl}/api/branches`);
    const entries = await json(res);

    expect(res.status).toBe(200);
    expect(entries).toHaveLength(1);
    expect(entries[0].branch).toBe(meta.branch);
    expect(entries[0].status).toBe('reviewable');
    expect(entries[0].runId).toBe(meta.id);
  });

  it('returns an empty list for a project with no dispatch branches', async () => {
    const res = await fetch(`${baseUrl}/api/branches`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual([]);
  });

  it('frees a worktree while keeping the branch listed', async () => {
    const meta = await finishedRun();

    const res = await fetch(`${baseUrl}/api/branches/free-disk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: meta.branch }),
    });
    const entry = await json(res);

    expect(res.status).toBe(200);
    expect(entry.worktreeExists).toBe(false);
    expect(entry.status).toBe('reviewable');
    // Still listed, because the ref survived — that's what makes it recoverable.
    expect(await json(await fetch(`${baseUrl}/api/branches`))).toHaveLength(1);
    // And the diff still resolves, from the snapshot taken before removal.
    expect((await fetch(`${baseUrl}/api/runs/${meta.id}/diff`)).status).toBe(
      200
    );
  });

  it('400s free-disk without a branch', async () => {
    const res = await fetch(`${baseUrl}/api/branches/free-disk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('branch is required');
  });

  it('deletes a branch with no commits of its own without needing force', async () => {
    // The default fake script only streams an assistant entry — it changes no
    // files, so this branch is identical to main and deleting it destroys
    // nothing. The unmerged guard must not fire on it.
    const meta = await finishedRun();

    const res = await fetch(
      `${baseUrl}/api/branches/${encodeURIComponent(meta.branch)}`,
      { method: 'DELETE' }
    );

    expect(res.status).toBe(200);
    expect(await json(await fetch(`${baseUrl}/api/branches`))).toEqual([]);
  });

  it('409s deleting an unmerged branch and succeeds with force=1', async () => {
    const meta = await finishedRun();
    const encoded = encodeURIComponent(meta.branch);
    // Real committed work on the branch is what makes it unmerged — the
    // default fake script commits nothing, so the guard needs a commit here.
    writeFileSync(join(meta.worktreePath, 'unmerged.txt'), 'work\n');
    runGitSync(meta.worktreePath, ['add', '-A']);
    runGitSync(meta.worktreePath, ['commit', '-m', 'unmerged work']);

    const refused = await fetch(`${baseUrl}/api/branches/${encoded}`, {
      method: 'DELETE',
    });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toMatch(/not merged/);

    const forced = await fetch(`${baseUrl}/api/branches/${encoded}?force=1`, {
      method: 'DELETE',
    });
    expect(forced.status).toBe(200);
    expect(await json(await fetch(`${baseUrl}/api/branches`))).toEqual([]);
  });

  it('deletes a merged orphan ref', async () => {
    runGitSync(root, ['branch', 'dispatch/t-ghost-r000000', 'main']);
    const listed = await json(await fetch(`${baseUrl}/api/branches`));
    expect(listed[0].status).toBe('orphan');

    const res = await fetch(
      `${baseUrl}/api/branches/${encodeURIComponent('dispatch/t-ghost-r000000')}`,
      { method: 'DELETE' }
    );

    expect(res.status).toBe(200);
    expect(await json(await fetch(`${baseUrl}/api/branches`))).toEqual([]);
  });

  it('accepts an un-encoded branch name whose slashes became separate segments', async () => {
    runGitSync(root, ['branch', 'dispatch/t-ghost-r000000', 'main']);

    // A client that did not encodeURIComponent the name — the route rejoins
    // the trailing segments rather than 404ing on a partial name.
    const res = await fetch(
      `${baseUrl}/api/branches/dispatch/t-ghost-r000000`,
      { method: 'DELETE' }
    );

    expect(res.status).toBe(200);
    expect(await json(await fetch(`${baseUrl}/api/branches`))).toEqual([]);
  });

  it('404s an unknown branch', async () => {
    const res = await fetch(
      `${baseUrl}/api/branches/${encodeURIComponent('dispatch/t-nope-r000000')}`,
      { method: 'DELETE' }
    );
    expect(res.status).toBe(404);
  });
});
