import { DEFAULT_FIX_LOOP, TaskStore } from '@dispatch/core';
import type { Finding, TaskDoc } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { useTestAuth, wsUrl } from './testAuth.js';

// The commit a fix round leaves behind. A round that commits nothing gives the
// re-review an empty range, which the loop refuses to review at all.
let commitCounter = 0;
function commitFixWork(cwd: string): void {
  commitCounter += 1;
  writeFileSync(
    join(cwd, 'src.ts'),
    `export const answer = ${commitCounter};\n`
  );
  runGitSync(cwd, ['add', '-A']);
  runGitSync(cwd, ['commit', '-m', `fix round ${commitCounter}`]);
}

// One executor serving both halves of the loop: a review prompt names an
// output path and gets findings written to it, a fix prompt commits its work.
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
      } else {
        commitFixWork(opts.cwd);
      }
      events.onFinish({ state: 'finished', sessionId: 'session-1' });
    }, 0);
    return {
      interrupt: async () => {},
      requestStop: () => {},
      send: () => {},
      approve: () => {},
    };
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

// Holds one run kind open until the test releases it, so a state the loop
// would otherwise pass straight through can be observed and acted on.
class GatedAgent implements Executor {
  readonly prompts: string[] = [];
  private pending: (() => void) | null = null;

  constructor(private readonly gate: 'fix' | 'review') {}

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    this.prompts.push(opts.prompt);
    const match = /as one JSON object: (\S+)/.exec(opts.prompt);
    const finish = (): void => {
      if (match !== null) writeFileSync(match[1], '{"findings": []}');
      else commitFixWork(opts.cwd);
      events.onFinish({ state: 'finished', sessionId: 'session-1' });
    };
    const kind = match !== null ? 'review' : 'fix';
    if (kind === this.gate) this.pending = finish;
    else setTimeout(finish, 0);
    return {
      interrupt: async () => {},
      requestStop: () => {},
      send: () => {},
      approve: () => {},
    };
  }

  releaseGate(): void {
    const finish = this.pending;
    this.pending = null;
    finish?.();
  }
}

// The auto-start happy path in one executor: the implementer and fix rounds
// commit real work, the first review raises one finding, every later review
// comes back clean — so an ignited loop runs review -> fix -> re-review and
// ends complete without any manual advance call.
class ConvergingAgent implements Executor {
  readonly prompts: string[] = [];
  private reviewCount = 0;

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    this.prompts.push(opts.prompt);
    const match = /as one JSON object: (\S+)/.exec(opts.prompt);
    setTimeout(() => {
      if (match !== null) {
        this.reviewCount += 1;
        writeFileSync(
          match[1],
          this.reviewCount === 1
            ? JSON.stringify({
                findings: [
                  {
                    severity: 'important',
                    title: 'sync path clobbers the workspace',
                    detail: 'reproduced against a scratch copy',
                    file: 'src.ts',
                    line: 1,
                  },
                ],
              })
            : '{"findings": []}'
        );
      } else {
        commitFixWork(opts.cwd);
      }
      events.onFinish({ state: 'finished', sessionId: 'session-1' });
    }, 0);
    return {
      interrupt: async () => {},
      requestStop: () => {},
      send: () => {},
      approve: () => {},
    };
  }
}

// Reviews everything clean. `commitOnFix` decides whether its fix rounds leave
// a commit behind, which is what separates a real review range from an empty one.
class CleanAgent implements Executor {
  constructor(private readonly commitOnFix = false) {}

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    const match = /as one JSON object: (\S+)/.exec(opts.prompt);
    setTimeout(() => {
      if (match !== null) writeFileSync(match[1], '{"findings": []}');
      else if (this.commitOnFix) commitFixWork(opts.cwd);
      events.onFinish({ state: 'finished', sessionId: 'session-1' });
    }, 0);
    return {
      interrupt: async () => {},
      requestStop: () => {},
      send: () => {},
      approve: () => {},
    };
  }
}

// Commits a file the task's writes don't cover, once — a resumed round
// reuses the same worktree, where a second commit would find nothing changed.
class UndeclaredWriteAgent implements Executor {
  private committed = false;

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorRun {
    const match = /as one JSON object: (\S+)/.exec(opts.prompt);
    setTimeout(() => {
      if (match === null && !this.committed) {
        this.committed = true;
        writeFileSync(join(opts.cwd, 'undeclared.ts'), 'export const y = 1;\n');
        runGitSync(opts.cwd, ['add', '-A']);
        runGitSync(opts.cwd, ['commit', '-m', 'touch an undeclared file']);
      }
      if (match !== null) writeFileSync(match[1], '{"findings": []}');
      events.onFinish({ state: 'finished', sessionId: 'session-1' });
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
  // Opted out of auto-ignition: these tests drive the loop through the manual
  // advance route, which must keep working exactly as before auto-start.
  // The auto-start suite below flips this back on per test.
  taskId = store.create({
    title: 'harden the sync path',
    risk: 'elevated',
    writes: ['src.ts'],
    model: 'claude-haiku-4-5-20251001',
    fixLoop: false,
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

// Replaces the running daemon with one driven by `executor`, against the same
// project directory — also how the boot-resume path is exercised.
async function restartWith(executor: Executor): Promise<void> {
  await handle.stop();
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', executor);
    },
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
}

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

function seedFinding(
  overrides: Record<string, unknown> = {}
): Promise<Response> {
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
      ...overrides,
    }),
  });
}

function patchFinding(id: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/findings/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function allFindings(): Promise<Finding[]> {
  return fetch(`${baseUrl}/api/findings?taskId=${taskId}`).then((res) =>
    json<Finding[]>(res)
  );
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
async function seedImplementerRun(): Promise<string> {
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
  return meta.id;
}

// Collects every `fixloop.capped` the daemon broadcasts from now on, so a test
// can assert on the reason the loop stopped rather than only its final state.
function collectCappedEvents(): CappedEvent[] {
  const seen: CappedEvent[] = [];
  const ws = new WebSocket(wsUrl(handle));
  ws.addEventListener('message', (ev) => {
    const parsed = JSON.parse(ev.data as string) as CappedEvent;
    if (parsed.type === 'fixloop.capped') seen.push(parsed);
  });
  return seen;
}

interface CappedEvent {
  type: string;
  taskId: string;
  round: number;
  cap: number;
  reason: string;
}

// Waits until the loop has stopped dispatching. A test that returns with a run
// still in flight has its temp dirs deleted out from under that run.
async function settle(): Promise<FixLoopState> {
  await waitFor(async () => {
    const { state } = await fixLoopState();
    return state === 'capped' || state === 'complete';
  });
  return await fixLoopState();
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

  // The fix loop dispatches `kind: 'execute'` through dispatchAuxRun, not
  // through dispatch(). A task synthesized from a PR always has open findings
  // — filing them is the point of the review — so without a refusal on the aux
  // path this route puts a write-access agent in a worktree cut from a
  // caller-supplied base, on the one task that must never be executed.
  it('refuses to open a loop on a task derived from an external artifact', async () => {
    const derived = new TaskStore(root).create({
      title: 'Review PR #7: Bump deps',
      writes: ['src.ts'],
      derivedFrom: 'github-pr:7',
    });
    await fetch(`${baseUrl}/api/findings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: derived.meta.id,
        severity: 'important',
        title: 'something to fix',
        detail: 'so the loop has work to dispatch',
        file: 'src.ts',
        line: 1,
      }),
    });

    const res = await fetch(
      `${baseUrl}/api/tasks/${derived.meta.id}/fix-loop/advance`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseSha }),
      }
    );
    expect(res.status).not.toBe(200);
    // No run at all: the refusal precedes the worktree, so nothing was cut
    // from the PR head and no branch was left behind.
    expect(await listRuns()).toEqual([]);
  });
});

describe('the fix loop', () => {
  it('escalates to a fresh implementer at round 4 and stops at the cap', async () => {
    const capped = new Promise<{ taskId: string; round: number }>((resolve) => {
      const ws = new WebSocket(wsUrl(handle));
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
    agent = new ScriptedAgent(1);
    await restartWith(agent);

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

describe('a standing block', () => {
  it('stops a loop that never reached the cap', async () => {
    const gated = new GatedAgent('fix');
    await restartWith(gated);

    const findingId = (await json<Finding>(await seedFinding())).id;
    await advance({ baseSha });
    expect((await fixLoopState()).state).toBe('implementing');

    // Ruled on mid-round, long before the cap. `blocked` is not `open`, so
    // nothing downstream sees a finding here at all.
    const res = await adjudicate(findingId, {
      verdict: 'blocked',
      ruling: 'this ships a data-loss path; it must not merge',
    });
    expect(res.status).toBe(200);
    expect(await openFindings()).toEqual([]);

    gated.releaseGate();
    await waitFor(async () => {
      const state = (await fixLoopState()).state;
      return state !== 'implementing' && state !== 'reviewing';
    });

    // The re-review came back clean and the loop still must not settle.
    expect((await fixLoopState()).state).toBe('capped');
    const task = await json<TaskDoc>(
      await fetch(`${baseUrl}/api/tasks/${taskId}`)
    );
    expect(task.meta.labels).toContain('blocked');
  }, 30000);
});

describe('a standing block with other findings still open', () => {
  it('stops the loop instead of spending rounds on a task a human stopped', async () => {
    const blocked = (await json<Finding>(await seedFinding())).id;
    await seedFinding({ title: 'still open, nobody has ruled on it' });
    const ruled = await adjudicate(blocked, {
      verdict: 'blocked',
      ruling: 'this ships a data-loss path; it must not merge',
    });
    expect(ruled.status).toBe(200);

    const state = await json<FixLoopState>(await advance({ baseSha }));

    expect(state.state).toBe('capped');
    expect(state.stopReason).toBe('standing-block');
    // Round 0: the block was standing before the loop opened, so no fix run
    // was ever dispatched against it.
    expect(state.round).toBe(0);
    expect(await listRuns()).toEqual([]);
    expect(await openFindings()).toHaveLength(1);
  }, 30000);
});

describe('closing the findings a review judged', () => {
  it('leaves a finding filed after the review started open', async () => {
    const gated = new GatedAgent('review');
    await restartWith(gated);

    const before = (await json<Finding>(await seedFinding())).id;
    await advance({ baseSha, cap: 1 });
    await waitFor(async () => (await fixLoopState()).state === 'reviewing');

    // Filed while the review is in flight, so that review never saw it.
    const during = (await json<Finding>(await seedFinding())).id;
    gated.releaseGate();
    await settle();

    const all = await json<Finding[]>(
      await fetch(`${baseUrl}/api/tasks/${taskId}/findings`)
    );
    const byId = new Map(all.map((f) => [f.id, f.verdict]));
    expect(byId.get(before)).toBe('addressed');
    expect(byId.get(during)).toBe('open');
  }, 30000);

  it('leaves a finding it was never handed open, even one older than the run', async () => {
    const gated = new GatedAgent('review');
    await restartWith(gated);

    const handed = (await json<Finding>(await seedFinding())).id;
    await advance({ baseSha, cap: 1 });
    await waitFor(async () => (await fixLoopState()).state === 'reviewing');

    // Written straight into the store, dated before the review run existed:
    // the window between reading the open findings and the run being created.
    appendFileSync(
      join(root, '.dispatch', 'findings.jsonl'),
      `${JSON.stringify({
        id: 'f-unseen',
        taskId,
        runId: null,
        severity: 'minor',
        verdict: 'open',
        title: 'filed in the window this review never saw',
        detail: 'detail',
        file: null,
        line: null,
        ruling: null,
        round: 0,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      })}\n`
    );

    gated.releaseGate();
    await settle();

    const byId = new Map((await allFindings()).map((f) => [f.id, f.verdict]));
    expect(byId.get(handed)).toBe('addressed');
    expect(byId.get('f-unseen')).toBe('open');
  }, 30000);
});

describe('a daemon restart mid-round', () => {
  it('resumes a loop left stalled in implementing', async () => {
    const gated = new GatedAgent('fix');
    await restartWith(gated);
    await seedFinding();
    await advance({ baseSha, cap: 2 });
    expect((await fixLoopState()).state).toBe('implementing');

    // The gated run never finishes: it dies with the daemon having committed
    // nothing, so no terminal hook will ever fire for it again.
    await restartWith(new ScriptedAgent());
    const settled = await settle();
    expect(settled.state).toBe('capped');
    expect(settled.round).toBe(2);
    const runs = await listRuns();
    expect(runs.some((run) => run.kind === 'review')).toBe(true);
  }, 30000);
});

describe('an escalation step the resume path cannot serve', () => {
  it('goes fresh when a high tier lands on a resume step', async () => {
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      `${readFileSync(join(root, '.dispatch', 'config.yml'), 'utf8')}fixLoop:\n  cap: 1\n  escalation:\n    - round: 1\n      strategy: resume\n      modelTier: high\n`
    );
    await restartWith(new ScriptedAgent());
    await seedImplementerRun();
    await seedFinding();
    await advance({ baseSha });
    await settle();

    // Resuming would have kept the seed run's cheaper model, so the step is
    // served by a fresh run at the execute model instead.
    const runs = await fixRuns();
    expect(runs[1].resumedFrom).toBeUndefined();
    expect(runs[1].model).toBe('claude-opus-5');
  }, 30000);
});

describe('PATCH /api/findings/:id', () => {
  it('refuses to park or block, and still allows the plain verdicts', async () => {
    const findingId = (await json<Finding>(await seedFinding())).id;
    const patch = (body: unknown): Promise<Response> =>
      fetch(`${baseUrl}/api/findings/${findingId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    for (const verdict of ['parked', 'blocked']) {
      const res = await patch({ verdict });
      expect(res.status).toBe(400);
      expect((await json<{ error: string }>(res)).error).toContain(
        'adjudicate'
      );
    }
    expect((await openFindings())[0].verdict).toBe('open');
    expect((await patch({ verdict: 'addressed' })).status).toBe(200);
  });
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

describe('a fix round that committed nothing', () => {
  it('reviews no empty range and clears no finding', async () => {
    await restartWith(new CleanAgent());
    const findingId = (
      await json<Finding>(
        await seedFinding({ severity: 'critical', recommendation: 'blocks' })
      )
    ).id;
    await advance({ baseSha, cap: 1 });
    const settled = await settle();

    expect(settled.state).toBe('capped');
    expect(settled.lastReviewedSha).toBeNull();
    expect((await listRuns()).some((run) => run.kind === 'review')).toBe(false);
    expect((await openFindings()).map((f) => f.id)).toEqual([findingId]);
  }, 30000);
});

describe('a clean review over a real range', () => {
  it('retires what it judged but never a critical finding', async () => {
    await restartWith(new CleanAgent(true));
    const critical = (
      await json<Finding>(await seedFinding({ severity: 'critical' }))
    ).id;
    const important = (await json<Finding>(await seedFinding())).id;
    await advance({ baseSha, cap: 1 });
    const settled = await settle();

    expect(settled.lastReviewedSha).not.toBe(baseSha);
    const byId = new Map((await allFindings()).map((f) => [f.id, f.verdict]));
    expect(byId.get(important)).toBe('addressed');
    expect(byId.get(critical)).toBe('open');
    expect(settled.state).toBe('capped');
  }, 30000);
});

describe('a baseSha that is not a commit', () => {
  it('is refused at the boundary rather than opening a loop', async () => {
    await seedFinding();
    const res = await advance({ baseSha: '0'.repeat(40) });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toContain('baseSha');
    expect(
      (await fetch(`${baseUrl}/api/tasks/${taskId}/fix-loop`)).status
    ).toBe(404);
  });

  it('400s a cap outside the allowed range', async () => {
    expect((await advance({ baseSha, cap: 1e21 })).status).toBe(400);
    expect((await advance({ baseSha, cap: 0 })).status).toBe(400);
    expect(
      (await fetch(`${baseUrl}/api/tasks/${taskId}/fix-loop`)).status
    ).toBe(404);
  });
});

describe('an execute run a human already merged or discarded', () => {
  it('is neither resumed nor built on, and the loop still moves', async () => {
    await restartWith(new CleanAgent());
    const runId = await seedImplementerRun();
    const reviewed = await fetch(`${baseUrl}/api/runs/${runId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'discard' }),
    });
    expect(reviewed.status).toBe(200);

    await seedFinding();
    const res = await advance({ baseSha, cap: 1 });
    expect(res.status).toBe(200);

    const settled = await settle();
    expect(settled.round).toBe(1);
    const runs = await fixRuns();
    expect(runs).toHaveLength(2);
    expect(runs[1].resumedFrom).toBeUndefined();
  }, 30000);
});

describe('a finding that already carries a ruling', () => {
  it('cannot have that ruling cleared by PATCH', async () => {
    for (const verdict of ['blocked', 'parked'] as const) {
      const findingId = (await json<Finding>(await seedFinding())).id;
      const ruled = await adjudicate(findingId, {
        verdict,
        ruling: 'this ships a data-loss path; it must not merge',
      });
      expect(ruled.status).toBe(200);

      const res = await patchFinding(findingId, { verdict: 'addressed' });
      expect(res.status).toBe(400);
      expect((await json<{ error: string }>(res)).error).toContain(
        'adjudicate'
      );
      expect((await patchFinding(findingId, { ruling: null })).status).toBe(
        400
      );
      const byId = new Map((await allFindings()).map((f) => [f.id, f]));
      expect(byId.get(findingId)?.verdict).toBe(verdict);
      expect(byId.get(findingId)?.ruling).toContain('data-loss');
    }
  });
});

describe('the reason a loop stopped', () => {
  it('separates a standing block from an exhausted round budget', async () => {
    const gated = new GatedAgent('fix');
    await restartWith(gated);
    const capped = collectCappedEvents();

    const findingId = (await json<Finding>(await seedFinding())).id;
    await advance({ baseSha });
    await adjudicate(findingId, {
      verdict: 'blocked',
      ruling: 'this ships a data-loss path; it must not merge',
    });
    gated.releaseGate();
    const settled = await settle();

    expect(settled.state).toBe('capped');
    expect(settled.round).toBeLessThan(settled.cap);
    expect(settled.stopReason).toBe('standing-block');
    await waitFor(() => Promise.resolve(capped.length > 0));
    expect(capped[0]).toMatchObject({
      taskId,
      round: settled.round,
      cap: settled.cap,
      reason: 'standing-block',
    });
  }, 30000);

  it('re-labels a capped loop once its last open finding is ruled on', async () => {
    await seedFinding();
    await advance({ baseSha, cap: 1 });
    await waitFor(async () => (await fixLoopState()).state === 'capped');
    expect((await fixLoopState()).stopReason).toBe('rounds-exhausted');

    const open = await openFindings();
    expect(open.length).toBeGreaterThan(0);
    for (const finding of open) {
      await adjudicate(finding.id, {
        verdict: 'blocked',
        ruling: 'this ships a data-loss path; it must not merge',
      });
    }

    expect(await openFindings()).toEqual([]);
    const settled = await fixLoopState();
    expect(settled.state).toBe('capped');
    expect(settled.stopReason).toBe('standing-block');
  }, 30000);
});

describe('a fix loop that cannot take another step', () => {
  it('stops where a human can act instead of retrying forever', async () => {
    const gated = new GatedAgent('fix');
    await restartWith(gated);
    const capped = collectCappedEvents();
    await seedFinding();
    await advance({ baseSha });
    expect((await fixLoopState()).state).toBe('implementing');

    // Broken while the round is in flight, so the throw lands on the
    // hook-driven advance, where no caller is waiting on the promise.
    const configPath = join(root, '.dispatch', 'config.yml');
    writeFileSync(
      configPath,
      `${readFileSync(configPath, 'utf8')}fixLoop:\n  cap: 0\n`
    );
    gated.releaseGate();
    const settled = await settle();

    expect(settled.state).toBe('capped');
    expect(settled.stopReason).toBe('error');
    expect(settled.stopDetail).toContain('fixLoop.cap');
    await waitFor(() => Promise.resolve(capped.length > 0));
    expect(capped[0].reason).toBe('error');

    // And it stays stopped: the same failing step is not retried on every hook.
    const again = await json<FixLoopState>(await advance({}));
    expect(again.state).toBe('capped');
    expect(again.stopReason).toBe('error');
  }, 30000);
});

describe('an unreadable fix-loops.jsonl', () => {
  it('does not stop the daemon booting', async () => {
    await seedFinding();
    await advance({ baseSha, cap: 1 });
    await settle();
    await handle.stop();

    const file = join(root, '.dispatch', 'fix-loops.jsonl');
    rmSync(file);
    mkdirSync(file);
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      registerExecutors: (orchestrator) => {
        orchestrator.registerExecutor('claude', new ScriptedAgent());
      },
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
    expect((await fetch(`${baseUrl}/api/tasks`)).status).toBe(200);
  }, 30000);
});

// Auto-ignition: the loop opens off a finished implementer with no advance
// call. The beforeEach task is opted out, so each test here opts it back in
// (or leaves it out, when the opt-out itself is the subject).
describe('auto-starting the fix loop', () => {
  function optIn(): void {
    new TaskStore(root).update(taskId, { fixLoop: true });
  }

  async function reviewRuns(): Promise<RunMeta[]> {
    const runs = await listRuns();
    return runs
      .filter((run) => run.kind === 'review')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // Long enough for an ignition that was going to happen to have happened:
  // the decision is enqueued synchronously off the run's terminal hook.
  function ignitionWindow(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 500));
  }

  it('runs implement -> review -> fix -> re-review to complete, no API call', async () => {
    optIn();
    await restartWith(new ConvergingAgent());
    const implementerId = await seedImplementerRun();

    const settled = await settle();
    expect(settled.state).toBe('complete');
    expect(settled.round).toBe(1);
    // The base the loop pinned is the commit before the implementer's work.
    expect(settled.baseSha).toBe(baseSha);
    expect(settled.lastReviewedSha).not.toBe(baseSha);

    // One review to raise the finding, one scoped re-review to retire it.
    const reviews = await reviewRuns();
    expect(reviews).toHaveLength(2);
    expect(reviews.every((run) => run.state === 'finished')).toBe(true);
    // The implementer, then the round-1 fix resumed from its session.
    const fixes = await fixRuns();
    expect(fixes).toHaveLength(2);
    expect(fixes[0].id).toBe(implementerId);
    expect(fixes[1].resumedFrom).toBeDefined();

    const findings = await allFindings();
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe('addressed');
  }, 30000);

  it('does not ignite when config.fixLoop.auto is off, manual advance still works', async () => {
    optIn();
    const configPath = join(root, '.dispatch', 'config.yml');
    writeFileSync(
      configPath,
      `${readFileSync(configPath, 'utf8')}fixLoop:\n  auto: false\n`
    );
    await seedImplementerRun();
    await ignitionWindow();

    expect(
      (await fetch(`${baseUrl}/api/tasks/${taskId}/fix-loop`)).status
    ).toBe(404);
    expect(await reviewRuns()).toEqual([]);

    // The manual route stays the explicit entry for gated projects.
    const res = await advance({ baseSha });
    expect(res.status).toBe(200);
    expect((await json<FixLoopState>(res)).state).toBe('complete');
  }, 30000);

  it('does not ignite for a task that opted out', async () => {
    // The beforeEach task carries fix-loop: false already.
    await seedImplementerRun();
    await ignitionWindow();

    expect(
      (await fetch(`${baseUrl}/api/tasks/${taskId}/fix-loop`)).status
    ).toBe(404);
    expect(await reviewRuns()).toEqual([]);
  }, 30000);

  it('does not ignite off an implementer that committed nothing', async () => {
    optIn();
    await restartWith(new CleanAgent());
    await seedImplementerRun();
    await ignitionWindow();

    expect(
      (await fetch(`${baseUrl}/api/tasks/${taskId}/fix-loop`)).status
    ).toBe(404);
    expect(await reviewRuns()).toEqual([]);
  }, 30000);

  it('caps an auto-started loop and still demands adjudication', async () => {
    optIn();
    const configPath = join(root, '.dispatch', 'config.yml');
    writeFileSync(
      configPath,
      `${readFileSync(configPath, 'utf8')}fixLoop:\n  cap: 1\n`
    );
    await seedImplementerRun();

    const settled = await settle();
    expect(settled.state).toBe('capped');
    expect(settled.round).toBe(1);
    expect(settled.stopReason).toBe('rounds-exhausted');

    // The cap resolves through a human ruling, exactly as a manual loop does.
    const open = await openFindings();
    expect(open.length).toBeGreaterThan(0);
    for (const finding of open) {
      const res = await adjudicate(finding.id, {
        verdict: 'parked',
        ruling: 'accepted for this release; tracked as a follow-up',
      });
      expect(res.status).toBe(200);
    }
    expect((await fixLoopState()).state).toBe('complete');
  }, 30000);
});

describe('an undeclared write', () => {
  it('is filed once and still lets the loop reach complete', async () => {
    new TaskStore(root).update(taskId, { writes: ['docs/**'] });
    await restartWith(new UndeclaredWriteAgent());
    await seedFinding();
    await advance({ baseSha });

    const state = await settle();
    expect(state.state).toBe('complete');

    const findings = await fetch(
      `${baseUrl}/api/findings?taskId=${taskId}`
    ).then((res) => json<Finding[]>(res));
    const undeclared = findings.filter((f) =>
      f.title.includes('outside declared writes')
    );
    expect(undeclared).toHaveLength(1);
    // Batched: the paths live in `files`, so a later round adds nothing here.
    expect(undeclared[0].files).toEqual(['undeclared.ts']);
    expect(undeclared[0].severity).toBe('minor');
  }, 30000);
});
