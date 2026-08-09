import { TaskStore } from '@dispatch/core';
import type { Finding } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import type {
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
} from '../src/orchestrator/types.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// Answers a review dispatch by writing `output` to the findings path the
// rubric named, then finishing — no Agent SDK involved.
class ScriptedReviewer implements Executor {
  lastPrompt = '';

  constructor(private readonly output: string) {}

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    this.lastPrompt = opts.prompt;
    const match = /as one JSON object: (\S+)/.exec(opts.prompt);
    setTimeout(() => {
      try {
        if (match !== null) writeFileSync(match[1], this.output);
      } catch {
        // The run directory can be torn down before this fires; the finish
        // below still has to happen so nothing hangs.
      }
      events.onFinish({ state: 'finished' });
    }, 0);
    return {
      interrupt: async () => {},
      requestStop: () => {},
      send: () => {},
      approve: () => {},
    };
  }
}

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timed out');
}

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-review-api-'));
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
let taskId: string;
let base: string;
let head: string;
let reviewer: ScriptedReviewer;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  const store = TaskStore.init(root);
  taskId = store.create({
    title: 'harden the sync path',
    risk: 'critical',
    writes: ['src.ts'],
  }).meta.id;

  base = runGitSync(root, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(root, 'src.ts'), 'export const answer = 42;\n');
  runGitSync(root, ['add', 'src.ts']);
  runGitSync(root, ['commit', '-m', 'add src']);
  head = runGitSync(root, ['rev-parse', 'HEAD']).trim();

  reviewer = new ScriptedReviewer(
    JSON.stringify({
      findings: [
        {
          severity: 'critical',
          title: 'sync overwrites the external workspace on first run',
          detail: 'reproduced against a scratch copy',
          file: 'src.ts',
          line: 1,
          recommendation: 'blocks',
        },
      ],
    })
  );
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', reviewer);
      orchestrator.registerExecutor(
        'fake',
        new FakeExecutor({ finish: { state: 'finished' } })
      );
    },
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function startReview(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/tasks/${taskId}/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/tasks/:id/review', () => {
  it('202s with the review run and lands its findings on the task', async () => {
    const res = await startReview({ base, head, scope: 'full', round: 0 });
    expect(res.status).toBe(202);
    const meta = await json<{ id: string; kind: string; model: string }>(res);
    expect(meta.kind).toBe('review');
    expect(meta.model).toBe('claude-opus-5');

    await waitFor(async () => {
      const list = await json<Finding[]>(
        await fetch(`${baseUrl}/api/tasks/${taskId}/findings`)
      );
      return list.length === 1;
    });
    const findings = await json<Finding[]>(
      await fetch(`${baseUrl}/api/tasks/${taskId}/findings`)
    );
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].verdict).toBe('open');
    expect(findings[0].recommendation).toBe('blocks');
    expect(findings[0].detail).toBe('reproduced against a scratch copy');
    expect(findings[0].runId).toBe(meta.id);
  });

  it('builds a rubric naming the risk tier and the destructive write', async () => {
    const res = await startReview({
      base,
      head,
      extraRisks: ['confirm the first-run path cannot bulk-overwrite'],
    });
    const meta = await json<{ id: string }>(res);
    await waitFor(async () => {
      const run = await json<{ meta: { state: string } }>(
        await fetch(`${baseUrl}/api/runs/${meta.id}`)
      );
      return run.meta.state === 'finished';
    });
    expect(reviewer.lastPrompt).toContain('## Risk-derived checks');
    expect(reviewer.lastPrompt).toContain('is `critical`');
    expect(reviewer.lastPrompt).toContain(
      '- confirm the first-run path cannot bulk-overwrite'
    );
    expect(reviewer.lastPrompt).not.toContain('export const answer = 42');
  });

  it('400s a missing base and an unknown scope', async () => {
    expect((await startReview({ head })).status).toBe(400);
    expect((await startReview({ base, head, scope: 'partial' })).status).toBe(
      400
    );
  });

  // `refs/dispatch/pr/<n>` is only ever created behind the fork
  // confirmation gate, and the gated path calls the runner directly. Naming
  // one here would cut a worktree from a fork's code without that gate.
  it('400s a head that names a PR head ref, qualified or not', async () => {
    runGitSync(root, ['update-ref', 'refs/dispatch/pr/7', head]);
    for (const bad of [
      'refs/dispatch/pr/7',
      // Git resolves an unqualified name through `refs/<name>` before
      // `refs/heads/<name>`, so this reaches the very same ref.
      'dispatch/pr/7',
      'refs/dispatch/pr/7^{commit}',
      // A loose ref is a file, so on a case-insensitive volume (macOS's
      // default) these resolve to the ref created as `refs/dispatch/pr/7`.
      'refs/Dispatch/pr/7',
      'Dispatch/PR/7',
    ]) {
      const res = await startReview({ base, head: bad });
      expect(res.status).toBe(400);
      const body = await json<{ error: string }>(res);
      expect(body.error).toContain('invalid head');
      expect(body.error).toContain('fork');
    }
  });

  // The two shapes real callers send: the desktop's ReviewView posts
  // `head: run.branch` (a `dispatch/…` local branch) and the server's own
  // tests post a sha. Neither may be caught by the PR-head-ref refusal.
  it('accepts a dispatch run branch as head', async () => {
    const branch = `dispatch/${taskId}-harden-the-sync-path-abc123`;
    runGitSync(root, ['branch', branch, head]);
    const res = await startReview({ base, head: branch });
    expect(res.status).toBe(202);
  });

  it('404s an unknown task', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/t-000000/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base, head }),
    });
    expect(res.status).toBe(404);
  });

  // The manual/API trigger reviews a task's own implementation run — the
  // path record_evidence/record_mutation actually feed, unlike the fix loop.
  it("renders the implementation run's evidence when runId is supplied", async () => {
    const runRes = await fetch(`${baseUrl}/api/tasks/${taskId}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executor: 'fake' }),
    });
    const implRun = await json<{ id: string }>(runRes);
    await fetch(`${baseUrl}/api/runs/${implRun.id}/evidence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        command: 'bun test',
        exitCode: 0,
        durationMs: 4200,
        summary: '158 pass, 0 fail',
      }),
    });
    await fetch(`${baseUrl}/api/runs/${implRun.id}/mutations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        guard: 'null check on foo()',
        file: 'src/foo.ts',
        testsFailed: 0,
      }),
    });

    const reviewRes = await startReview({ base, head, runId: implRun.id });
    const reviewMeta = await json<{ id: string }>(reviewRes);
    await waitFor(async () => {
      const run = await json<{ meta: { state: string } }>(
        await fetch(`${baseUrl}/api/runs/${reviewMeta.id}`)
      );
      return run.meta.state === 'finished';
    });

    expect(reviewer.lastPrompt).toContain(
      '- `bun test` — exit 0, 4200ms: 158 pass, 0 fail'
    );
    expect(reviewer.lastPrompt).toContain(
      '- `null check on foo()` in src/foo.ts: 0 test(s) failed — RED FLAG: 0 tests failed'
    );
    expect(reviewer.lastPrompt).toContain(
      'A mutation record with `testsFailed: 0` is a red flag'
    );
  });
});

describe('GET /api/tasks/:id/findings', () => {
  it('returns only the findings for that task', async () => {
    await fetch(`${baseUrl}/api/findings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: 't-other0',
        severity: 'minor',
        title: 'elsewhere',
        detail: 'not this task',
      }),
    });
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/findings`);
    expect(res.status).toBe(200);
    expect(await json<Finding[]>(res)).toEqual([]);
  });
});
