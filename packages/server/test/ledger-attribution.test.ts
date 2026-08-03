import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { Executor, ExecutorRun } from '../src/orchestrator/types.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

interface LedgerEntryBody {
  authoredBy: string;
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timed out');
}

// Never finishes, so a dispatched run stays `running` — mirrors how a real
// agent run is still live when its own mid-run tool call posts to the ledger.
const controllable: Executor = {
  start() {
    return {
      interrupt: async () => {},
      send: () => {},
      approve: () => {},
    } satisfies ExecutorRun;
  },
};

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-ledger-attribution-'));
  runGitSync(root, ['init', '-b', 'main']);
  runGitSync(root, ['config', 'user.email', 'test@example.com']);
  runGitSync(root, ['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'README.md'), '# test repo\n');
  runGitSync(root, ['add', '-A']);
  runGitSync(root, ['commit', '-m', 'initial commit']);
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', controllable);
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

async function liveRun(title: string): Promise<string> {
  const task = await json<{ meta: { id: string } }>(
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
  );
  const meta = await json<{ id: string }>(
    await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executor: 'claude' }),
    })
  );
  await waitFor(async () => {
    const r = await json<{ meta: { state: string } }>(
      await fetch(`${baseUrl}/api/runs/${meta.id}`)
    );
    return r.meta.state === 'running';
  });
  return meta.id;
}

function postLedgerEntry(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/ledger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'decision',
      title: 't',
      detail: 'd',
      ...body,
    }),
  });
}

// Covers the exact path packages/mcp/src/tools.ts's record_decision takes:
// it only runs inside a live agent run and forwards that run's id.
describe('a ledger entry records who authored it', () => {
  it('credits the agent running the run named by runId', async () => {
    const runId = await liveRun('mid-run discovery');
    const entry = await json<LedgerEntryBody>(await postLedgerEntry({ runId }));
    expect(entry.authoredBy).toBe('agent:test/claude');
  });

  it("credits 'none', not the local human, when runId doesn't resolve to a known run", async () => {
    const entry = await json<LedgerEntryBody>(
      await postLedgerEntry({ runId: 'r-nosuch1' })
    );
    expect(entry.authoredBy).toBe('none');
  });

  it('still credits the local human when no runId is given', async () => {
    const entry = await json<LedgerEntryBody>(await postLedgerEntry({}));
    expect(entry.authoredBy).toBe('human:test');
  });

  it('400s a non-string runId rather than passing it through', async () => {
    const res = await postLedgerEntry({ runId: 42 });
    expect(res.status).toBe(400);
  });
});
