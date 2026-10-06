import { TaskStore } from '@dispatch-foo/core';
import type { Message } from '@dispatch-foo/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { Executor, RunMeta } from '../src/orchestrator/types.js';
import { json } from './json.js';
import { ParkingExecutor } from './messaging/harness.js';
import { initGitRepo, StallingExecutor } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// What restarting the daemon does to a run that is only waiting on a human:
// the desktop app's takeover restarts without refusing on such runs, so they
// have to come back, with their question answerable in the new daemon.

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}

let fakeHome: string;
let root: string;
let handle: ServerHandle | undefined;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initGitRepo('dispatch-restart-parked-');
  TaskStore.init(root);
});

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// Stops whatever serves `root` and boots a fresh daemon on it, with a quiet
// window short enough for the auto-resume sweep to run inside a test.
async function boot(executor: Executor): Promise<void> {
  await handle?.stop();
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', executor);
    },
    autoResumeQuietMs: 40,
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
}

async function runs(): Promise<RunMeta[]> {
  return (await json(await fetch(`${baseUrl}/api/runs`))) as RunMeta[];
}

async function dispatchRun(title: string): Promise<RunMeta> {
  const task: { meta: { id: string } } = await json(
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
  );
  const run = (await json(
    await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  )) as RunMeta;
  await waitFor(async () =>
    (await runs()).some((r) => r.id === run.id && r.state === 'running')
  );
  return run;
}

async function openGates(): Promise<Message[]> {
  const open: { items: Message[] } = await json(
    await fetch(`${baseUrl}/api/decisions/open`)
  );
  return open.items;
}

async function successorOf(runId: string): Promise<RunMeta> {
  let found: RunMeta | undefined;
  await waitFor(async () => {
    found = (await runs()).find(
      (r) => r.resumedFrom === runId && r.state === 'running'
    );
    return found !== undefined;
  });
  return found!;
}

async function reply(messageId: string, choice?: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/messages/${messageId}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      body: choice ?? 'use sqlite',
      ...(choice === undefined ? {} : { choice }),
    }),
  });
  expect(res.status).toBe(201);
}

function isApproval(m: Message): boolean {
  return (m.data as { type?: string } | undefined)?.type === 'tool-approval';
}

describe('a daemon restart while a run waits on a human', () => {
  it('resumes a run parked on a tool approval; the old gate closes and the re-asked call is answerable', async () => {
    const first = new ParkingExecutor();
    await boot(first);
    const parked = await dispatchRun('Needs a shell');
    first.park('req-1', 'Bash', { command: 'pnpm install' });
    await waitFor(async () =>
      (await runs()).some(
        (r) => r.id === parked.id && r.state === 'awaiting-approval'
      )
    );
    const parkedGate = (await openGates()).find(isApproval);
    expect(parkedGate).toBeDefined();

    const parking = new ParkingExecutor();
    await boot(parking);
    // The run that was parked when the daemon stopped is picked back up.
    const successor = await successorOf(parked.id);
    expect(successor.sessionId).toBe('session-parking');
    // The approval it was parked on did not survive: dead runs' gates close.
    expect((await openGates()).filter(isApproval)).toEqual([]);
    // The resumed agent asks for the call again; that gate is live here.
    parking.park('req-again', 'Bash', { command: 'pnpm install' });
    let gate: Message | undefined;
    await waitFor(async () => {
      gate = (await openGates()).find(isApproval);
      return gate !== undefined;
    });
    await reply(gate!.id, gate!.choices?.[0]);
    await waitFor(() => Promise.resolve(parking.decisions.length === 1));
    expect(parking.decisions[0]).toMatchObject({
      requestId: 'req-again',
      decision: { allow: true },
    });
  });

  it('resumes a run parked on a question; the question stays open and the answer reaches the resumed run', async () => {
    const stalling = new StallingExecutor();
    await boot(stalling);
    const asking = await dispatchRun('Asks a question');
    const token = stalling.lastRunToken;
    if (token === undefined) throw new Error('no run token minted');
    const asked = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: ['human:test'],
        kind: 'question',
        blocking: true,
        body: 'Which database?',
      }),
    });
    expect(asked.status).toBe(201);
    const questionId = ((await json(asked)) as { message: { id: string } })
      .message.id;

    const after = new StallingExecutor();
    await boot(after);
    await successorOf(asking.id);
    // The question is still waiting, in the new daemon, for the human.
    expect((await openGates()).map((m) => m.id)).toContain(questionId);
    await reply(questionId);
    // The answer reaches the run that picked the work back up.
    await waitFor(() =>
      Promise.resolve(
        [...after.sent, ...after.notified].some((t) => t.includes('use sqlite'))
      )
    );
  });
});
