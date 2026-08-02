import { DEFAULT_FIX_LOOP, TaskStore } from '@dispatch/core';
import type { Finding, TaskDoc } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { FixLoopState } from '../src/orchestrator/fixLoop.js';
import { escalationFor, FixLoopStore } from '../src/orchestrator/fixLoop.js';
import type {
  Executor,
  ExecutorEvents,
  ExecutorRun,
  ExecutorStartOptions,
  RunMeta,
} from '../src/orchestrator/types.js';
import { runGitSync } from './orchestrator/helpers.js';

// One executor serving both halves of the loop: a review prompt names an
// output path and gets findings written to it, a fix prompt is just recorded.
class ScriptedAgent implements Executor {
  readonly prompts: string[] = [];
  private reviewCount = 0;

  // `malformedReviews` makes the first N reviews emit unusable output, which
  // the review runner turns into a failed run rather than a clean result.
  constructor(private readonly malformedReviews = 0) {}

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    this.prompts.push(opts.prompt);
    const match = /as one JSON object: (\S+)/.exec(opts.prompt);
    setTimeout(() => {
      if (match !== null) {
        this.reviewCount += 1;
        writeFileSync(
          match[1],
          this.reviewCount <= this.malformedReviews
            ? 'I checked everything and it looks fine to me.'
            : this.findingsPayload(this.reviewCount)
        );
      }
      events.onFinish({ state: 'finished', sessionId: 'session-1' });
    }, 0);
    return { interrupt: async () => {}, send: () => {}, approve: () => {} };
  }

  // A fresh finding every review, so the loop keeps having work to do and runs
  // all the way into its cap.
  private findingsPayload(nth: number): string {
    return JSON.stringify({
      findings: [
        {
          severity: 'important',
          title: `still wrong after pass ${nth}`,
          detail: `the sync path is still reachable from the first-run branch (pass ${nth})`,
          file: 'src.ts',
          line: 1,
        },
      ],
    });
  }
}

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timed out');
}

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-fix-loop-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'src.ts'), 'export const answer = 42;\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
let taskId: string;
let baseSha: string;
let agent: ScriptedAgent;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  const store = TaskStore.init(root);
  taskId = store.create({
    title: 'harden the sync path',
    risk: 'elevated',
    writes: ['src.ts'],
    model: 'claude-haiku-4-5-20251001',
  }).meta.id;
  baseSha = runGitSync(root, ['rev-parse', 'HEAD']).trim();

  agent = new ScriptedAgent();
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', agent);
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

function advance(body: unknown = {}): Promise<Response> {
  return fetch(`${baseUrl}/api/tasks/${taskId}/fix-loop/advance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function adjudicate(findingId: string, body: unknown): Promise<Response> {
  return fetch(
    `${baseUrl}/api/tasks/${taskId}/findings/${findingId}/adjudicate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

function seedFinding(): Promise<Response> {
  return fetch(`${baseUrl}/api/findings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      taskId,
      severity: 'important',
      title: 'first-run sync overwrites the workspace',
      detail: 'reproduced against a scratch copy',
      file: 'src.ts',
      line: 1,
    }),
  });
}

function listRuns(): Promise<RunMeta[]> {
  return fetch(`${baseUrl}/api/runs`).then((res) => json<RunMeta[]>(res));
}

async function fixRuns(): Promise<RunMeta[]> {
  const runs = await listRuns();
  return runs
    .filter((run) => run.kind !== 'review')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// Dispatches the task's first implementer and waits for it to come to rest, so
// there is a real run (with a resumable session) for round 1 to resume into.
async function seedImplementerRun(): Promise<void> {
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001' }),
  });
  const meta = await json<RunMeta>(res);
  await waitFor(async () => {
    const runs = await listRuns();
    return runs.some((run) => run.id === meta.id && run.state === 'finished');
  });
}

function fixLoopState(): Promise<FixLoopState> {
  return fetch(`${baseUrl}/api/tasks/${taskId}/fix-loop`).then((res) =>
    json<FixLoopState>(res)
  );
}

function openFindings(): Promise<Finding[]> {
  return fetch(`${baseUrl}/api/findings?taskId=${taskId}&verdict=open`).then(
    (res) => json<Finding[]>(res)
  );
}

describe('escalationFor', () => {
  it('resumes for the first three rounds and goes fresh at four', () => {
    const table = DEFAULT_FIX_LOOP.escalation;
    expect([1, 2, 3].map((r) => escalationFor(r, table))).toEqual([
      { round: 1, strategy: 'resume', modelTier: 'standard' },
      { round: 2, strategy: 'resume', modelTier: 'standard' },
      { round: 3, strategy: 'resume', modelTier: 'standard' },
    ]);
    expect([4, 5].map((r) => escalationFor(r, table))).toEqual([
      { round: 4, strategy: 'fresh', modelTier: 'high' },
      { round: 5, strategy: 'fresh', modelTier: 'high' },
    ]);
  });

  it('falls back to a resume when the table is empty', () => {
    expect(escalationFor(2, [])).toEqual({
      round: 2,
      strategy: 'resume',
      modelTier: 'standard',
    });
  });
});

describe('FixLoopStore', () => {
  it('compacts to the last line written for a task', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-fix-loop-store-'));
    const store = new FixLoopStore(dir);
    const state: FixLoopState = {
      taskId: 't-000001',
      round: 0,
      cap: 5,
      state: 'idle',
      baseSha: 'abc123',
      lastReviewedSha: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    store.put(state);
    store.put({ ...state, round: 2, state: 'reviewing' });

    const file = join(dir, '.dispatch', 'fix-loops.jsonl');
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
    const reloaded = new FixLoopStore(dir).get('t-000001');
    expect(reloaded?.round).toBe(2);
    expect(reloaded?.state).toBe('reviewing');
    expect(reloaded?.baseSha).toBe('abc123');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('POST /api/tasks/:id/fix-loop/advance', () => {
  it('completes without dispatching when nothing is open', async () => {
    const res = await advance({ baseSha });
    expect(res.status).toBe(200);
    expect((await json<FixLoopState>(res)).state).toBe('complete');
    expect(await listRuns()).toEqual([]);
  });

  it('400s a first call with no baseSha', async () => {
    const res = await advance({});
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toContain('baseSha');
  });

  it('404s a task with no loop', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/fix-loop`);
    expect(res.status).toBe(404);
  });
});

describe('the fix loop', () => {
  it('escalates to a fresh implementer at round 4 and stops at the cap', async () => {
    const capped = new Promise<{ taskId: string; round: number }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
      ws.addEventListener('message', (ev) => {
        const parsed = JSON.parse(ev.data as string) as {
          type: string;
          taskId?: string;
          round?: number;
        };
        if (parsed.type === 'fixloop.capped') {
          resolve({ taskId: parsed.taskId!, round: parsed.round! });
        }
      });
    });
    await seedImplementerRun();
    await seedFinding();
    await advance({ baseSha });

    const event = await capped;
    expect(event).toEqual({ taskId, round: DEFAULT_FIX_LOOP.cap });

    const loop = await fixLoopState();
    expect(loop.state).toBe('capped');
    expect(loop.round).toBe(DEFAULT_FIX_LOOP.cap);
    expect(loop.baseSha).toBe(baseSha);
    expect(loop.lastReviewedSha).not.toBeNull();

    // The seed implementer, then one run per round: three resumes, then two
    // fresh ones at the execute model rather than the task's cheaper override.
    const runs = await fixRuns();
    expect(runs).toHaveLength(1 + DEFAULT_FIX_LOOP.cap);
    expect(
      runs.slice(1, 4).map((run) => run.resumedFrom !== undefined)
    ).toEqual([true, true, true]);
    expect(runs.slice(4).map((run) => run.resumedFrom)).toEqual([
      undefined,
      undefined,
    ]);
    expect(runs.slice(4).map((run) => run.model)).toEqual([
      'claude-opus-5',
      'claude-opus-5',
    ]);
    expect(runs[1].model).toBe('claude-haiku-4-5-20251001');

    // The findings are rendered into the fix prompt as written, not summarised.
    const roundFourPrompt = agent.prompts.find((p) =>
      p.startsWith('# Fix round 4')
    );
    expect(roundFourPrompt).toContain('fresh implementer');
    expect(roundFourPrompt).toContain('still wrong after pass 3');

    // The cap does not dispatch again, and does not resolve itself.
    const again = await advance({});
    expect((await json<FixLoopState>(again)).state).toBe('capped');
    expect(await fixRuns()).toHaveLength(1 + DEFAULT_FIX_LOOP.cap);

    // And it survives a reload: the state is on disk, not in the process.
    const reloaded = new FixLoopStore(root).get(taskId);
    expect(reloaded?.state).toBe('capped');
    expect(reloaded?.round).toBe(DEFAULT_FIX_LOOP.cap);
    expect(reloaded?.baseSha).toBe(baseSha);
  }, 30000);
});

describe('a review that produced unusable output', () => {
  it('never reads as clean and never completes the loop', async () => {
    await handle.stop();
    agent = new ScriptedAgent(1);
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      registerExecutors: (orchestrator) => {
        orchestrator.registerExecutor('claude', agent);
      },
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const findingId = (await json<Finding>(await seedFinding())).id;
    await advance({ baseSha, cap: 1 });
    await waitFor(async () => (await fixLoopState()).state === 'capped');

    // The finding that went in is still open: a failed review cleared nothing.
    expect((await openFindings()).map((f) => f.id)).toEqual([findingId]);
    const runs = await listRuns();
    expect(
      runs.some((run) => run.kind === 'review' && run.state === 'failed')
    ).toBe(true);
  }, 30000);
});

describe('POST /api/tasks/:id/findings/:fid/adjudicate', () => {
  let findingId: string;

  beforeEach(async () => {
    findingId = (await json<Finding>(await seedFinding())).id;
  });

  it('rejects a missing, empty or whitespace-only ruling', async () => {
    for (const body of [
      { verdict: 'parked' },
      { verdict: 'parked', ruling: '' },
      { verdict: 'parked', ruling: '   ' },
    ]) {
      const res = await adjudicate(findingId, body);
      expect(res.status).toBe(400);
      expect((await json<{ error: string }>(res)).error).toContain('ruling');
    }
    expect((await openFindings())[0].verdict).toBe('open');
  });

  it('rejects an unknown verdict and an unknown finding', async () => {
    expect(
      (await adjudicate(findingId, { verdict: 'addressed', ruling: 'no' }))
        .status
    ).toBe(400);
    expect(
      (await adjudicate('f-000000', { verdict: 'parked', ruling: 'no' })).status
    ).toBe(404);
  });

  it('parks a finding with its ruling and lets a capped loop settle', async () => {
    await advance({ baseSha, cap: 1 });
    await waitFor(async () => (await fixLoopState()).state === 'capped');
    const open = await openFindings();

    for (const finding of open) {
      const res = await adjudicate(finding.id, {
        verdict: 'parked',
        ruling: 'accepted for this release; tracked as a follow-up',
      });
      expect(res.status).toBe(200);
      const body = await json<{ finding: Finding; fixLoop: FixLoopState }>(res);
      expect(body.finding.verdict).toBe('parked');
      expect(body.finding.ruling).toContain('accepted for this release');
    }
    expect((await fixLoopState()).state).toBe('complete');
  }, 30000);

  it('blocks the task on a blocking ruling and refuses to settle', async () => {
    await advance({ baseSha, cap: 1 });
    await waitFor(async () => (await fixLoopState()).state === 'capped');
    const open = await openFindings();
    expect(open.length).toBeGreaterThan(0);

    for (const [index, finding] of open.entries()) {
      await adjudicate(finding.id, {
        verdict: index === 0 ? 'blocked' : 'parked',
        ruling: 'this ships a data-loss path; it must not merge',
      });
    }

    const task = await json<TaskDoc>(
      await fetch(`${baseUrl}/api/tasks/${taskId}`)
    );
    expect(task.meta.assignee).toBe('human');
    expect(task.meta.labels).toContain('blocked');
    expect(task.body).toContain('blocked by finding');
    expect((await fixLoopState()).state).toBe('capped');
  }, 30000);
});
