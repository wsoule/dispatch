import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { useTestAuth } from '../testAuth.js';
import { seedLedger } from './fixtures.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timed out');
}

const OWNER = {
  address: 'human:test',
  canDecide: true,
  kind: 'human',
} as const;

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let base: string;
const originalHome = process.env.DISPATCH_HOME;

function boot(): Promise<ServerHandle> {
  return startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
  });
}

// A daemon restart on the same root and DISPATCH_HOME.
async function restart(): Promise<void> {
  await handle.stop();
  handle = await boot();
  useTestAuth(handle);
  base = `http://127.0.0.1:${handle.port}`;
}

beforeEach(async () => {
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-home-')));
  process.env.DISPATCH_HOME = fakeHome;
  root = realpathSync(initGitRepo('dispatch-memory-cutover-'));
  handle = await boot();
  useTestAuth(handle);
  base = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('the ledger cutover', () => {
  it('records the cutover once, at the first boot of this build', async () => {
    const first = handle.memory.shared!.meta('ledger-cutover-at');
    expect(first).toMatch(/^\d{4}-/);
    await restart();
    expect(handle.memory.shared!.meta('ledger-cutover-at')).toBe(first);
  });

  // A teammate's older build pushes a lesson row after the cutover.
  it('turns rows written after the cutover into proposals waiting for a human', async () => {
    const cutover = handle.memory.shared!.meta('ledger-cutover-at')!;
    const createdAt = new Date(Date.parse(cutover) + 1000).toISOString();
    const row = seedLedger(
      root,
      {
        kind: 'hazard',
        title: 'pushed by an older build',
        detail: 'd',
        authoredBy: 'human:ada',
      },
      createdAt
    );
    const report = handle.memory.importLedger()!;
    expect(report.memory).toMatchObject({ proposed: 1, imported: 0 });
    const open = () => handle.memory.engine!.proposals(OWNER, 'open');
    await waitFor(() => open()[0]?.gate !== null);
    const [p] = open();
    expect(p).toMatchObject({
      author: 'agent:dispatch',
      taskId: null,
      origin: `ledger:${row.id}@${createdAt}`,
    });
    expect(p.reason).toContain('claims author human:ada');
    // No task, so it reads as elevated and waits for a human.
    expect(p.gate).toMatch(/^m-/);
  });

  // Once the boot's import has run, every unseen row came from elsewhere,
  // whatever createdAt it claims.
  it('proposes a row that arrives later claiming an old or empty createdAt', () => {
    for (const createdAt of ['2020-01-01T00:00:00.000Z', '']) {
      seedLedger(
        root,
        {
          kind: 'hazard',
          title: `claims ${createdAt === '' ? 'no time' : createdAt}`,
          detail: 'd',
          authoredBy: 'human:test',
        },
        createdAt
      );
    }
    const report = handle.memory.importLedger()!;
    expect(report.memory).toMatchObject({ proposed: 2, imported: 0 });
    expect(
      handle.memory.engine!.list(OWNER, { scope: 'team' }).map((e) => e.title)
    ).toEqual([]);
    const authors = handle.memory
      .engine!.proposals(OWNER, 'open')
      .map((p) => p.author);
    expect(authors).toEqual(['agent:dispatch', 'agent:dispatch']);
  });

  it('prompts use memory even when it is unavailable: no ledger fallback after v0', async () => {
    const task = await json<{ meta: { id: string } }>(
      await fetch(`${base}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'x' }),
      })
    );
    handle.memory.shared!.close();
    expect(
      handle.memory.prepare({
        runId: 'r-000001',
        taskId: task.meta.id,
        lineage: 'r-000001',
        runKind: 'execute',
        isClaude: true,
        dispatchTools: true,
        continues: false,
      })
    ).toEqual({ text: null, indexSection: null, memory: { mode: 'prompt' } });
  });

  it('POST /api/ledger is gone and GET /api/ledger?class=audit returns receipts only', async () => {
    const post = await fetch(`${base}/api/ledger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(post.status).toBe(404);
    seedLedger(
      root,
      {
        kind: 'decision',
        title: 'Scope extended for run r-000001',
        detail: 'a — b [gate m-1]',
        authoredBy: 'human:test',
      },
      '2026-01-01T00:00:00.000Z'
    );
    seedLedger(
      root,
      {
        kind: 'hazard',
        title: 'a lesson',
        detail: 'd',
        authoredBy: 'human:test',
      },
      '2026-01-02T00:00:00.000Z'
    );
    const audit = await json<{ title: string }[]>(
      await fetch(`${base}/api/ledger?class=audit`)
    );
    expect(audit.map((r) => r.title)).toEqual([
      'Scope extended for run r-000001',
    ]);
    expect(
      (await json<unknown[]>(await fetch(`${base}/api/ledger`))).length
    ).toBe(2);
  });
});
