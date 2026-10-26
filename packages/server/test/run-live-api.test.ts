import { TaskStore } from '@dispatch-foo/core';
import type { TaskDoc } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import type { RunDetailView } from '../src/orchestrator/transcript.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// Streams a line, then parks on an approval gate, so the run stays live
// (awaiting approval) with text it has not logged yet.
function streamingScript(): FakeExecutor {
  return new FakeExecutor({
    steps: [
      { delta: { segmentId: 'seg-1', text: 'Reading the ' } },
      {
        delta: { segmentId: 'seg-1', text: 'tests.' },
        approval: { requestId: 'go', toolName: 'noop', input: {} },
      },
    ],
    finish: { state: 'finished', costUsd: 0, turns: 1 },
  });
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

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-run-live-'));
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
      orchestrator.registerExecutor('fake', streamingScript());
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

describe('GET /api/runs/:id live text', () => {
  it('carries what a live run streamed and has not logged, and nothing once it ends', async () => {
    const task = (await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Stream me' }),
      })
    )) as TaskDoc;
    const run = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'fake' }),
      })
    );
    const detail = async (): Promise<RunDetailView> =>
      (await json(
        await fetch(`${baseUrl}/api/runs/${run.id}`)
      )) as RunDetailView;
    await waitFor(
      async () => (await detail()).meta.state === 'awaiting-approval'
    );

    const parked = await detail();
    expect(parked.live).toEqual({
      seq: 2,
      turnId: expect.any(String),
      segments: [{ id: 'seg-1', text: 'Reading the tests.' }],
    });
    expect(parked.entries).toEqual([]);

    // Stopped before it finished the line: the run ends, and its unfinished
    // text goes with it.
    const stopped = await fetch(`${baseUrl}/api/runs/${run.id}/stop`, {
      method: 'POST',
    });
    expect(stopped.status).toBe(200);
    await waitFor(async () => (await detail()).meta.state === 'finished');
    const ended = await detail();
    expect('live' in ended).toBe(false);
    expect(ended.entries.filter((e) => e.kind === 'assistant')).toEqual([]);
  });
});
