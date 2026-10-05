import { getSection, TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { rawFetch, useTestAuth } from './testAuth.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function createTask(
  title: string,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, ...extra }),
  });
  return (await json<{ meta: { id: string } }>(res)).meta.id;
}

// The app token by default; `bearer` sends another credential (the shared agentToken).
function amend(
  id: string,
  body: { overrides: string; reason: string },
  bearer?: string
): Promise<Response> {
  const headers = {
    'content-type': 'application/json',
    ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
  };
  const init = { method: 'POST', headers, body: JSON.stringify(body) };
  return bearer === undefined
    ? fetch(`${baseUrl}/api/tasks/${id}/amend`, init)
    : rawFetch(`${baseUrl}/api/tasks/${id}/amend`, init);
}

interface MemoryEntryBody {
  kind: string;
  title: string;
  trust: string;
  body: string;
  epic: string | null;
  appliesTo: string[];
  origin: string;
}

// The memory entry an amendment's `memory` result points at.
async function memoryEntry(id: string): Promise<MemoryEntryBody> {
  const res = await fetch(`${baseUrl}/api/memory/${id}`);
  return (await json<{ entry: MemoryEntryBody }>(res)).entry;
}

// The memory entry an amendment response points at.
async function memoryOf(res: Response): Promise<MemoryEntryBody> {
  const { memory } = await json<{ memory: { id: string } }>(res);
  return memoryEntry(memory.id);
}

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-amendments-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

let root: string;
let fakeHome: string;
let handle: ServerHandle;
let baseUrl: string;
let taskId: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  // startServer hydrates the merge queue, which writes run state under
  // DISPATCH_HOME — left unset it lands in the real home, one dir per test.
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
  const taskRes = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'store the linear reference' }),
  });
  taskId = (await json<{ meta: { id: string } }>(taskRes)).meta.id;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('POST /api/tasks/:id/amend', () => {
  it('records the amendment in the task body and returns it', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        overrides: 'join on the issue UUID, not the display key',
        reason: 'display keys are not stable across a rename',
        source: 'task-review',
      }),
    });
    expect(res.status).toBe(200);
    const doc = await json<{ body: string }>(res);
    expect(doc.body).toContain('join on the issue UUID, not the display key');
    expect(doc.body).toContain('task-review');

    const reread = await json<{ body: string }>(
      await fetch(`${baseUrl}/api/tasks/${taskId}`)
    );
    expect(reread.body).toContain(
      'join on the issue UUID, not the display key'
    );
  });

  it('accumulates a second amendment rather than replacing the first', async () => {
    await fetch(`${baseUrl}/api/tasks/${taskId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overrides: 'first fix', reason: 'first reason' }),
    });
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        overrides: 'second fix',
        reason: 'second reason',
      }),
    });
    const doc = await json<{ body: string }>(res);
    expect(doc.body).toContain('first fix');
    expect(doc.body).toContain('second fix');
  });

  it('carries the amendment into memory as a human constraint that reaches its dependents, and writes no ledger row', async () => {
    const dependent = await createTask('depends on it', {
      blockedBy: [taskId],
    });
    const entry = await memoryOf(
      await amend(taskId, {
        overrides: 'join on the issue UUID',
        reason: 'display keys are not stable',
      })
    );
    expect(entry).toMatchObject({
      kind: 'constraint',
      trust: 'human',
      appliesTo: [dependent],
      epic: null,
    });
    // The index shows titles only, so the title carries the override itself.
    expect(entry.title).toBe(`Amended ${taskId}: join on the issue UUID`);
    expect(entry.body).toContain('display keys are not stable');
    expect(entry.origin).toMatch(new RegExp(`^amendment:${taskId}@`));
    expect(await json<unknown[]>(await fetch(`${baseUrl}/api/ledger`))).toEqual(
      []
    );
  });

  it('the shared agent token proposes the amendment’s constraint instead', async () => {
    const res = await json<{ memory: { status: string } }>(
      await amend(
        taskId,
        { overrides: 'x', reason: 'y' },
        handle.tokens.agentToken
      )
    );
    expect(res.memory.status).toBe('proposed');
  });

  it('with no dependents, reach falls back to the parent epic, then to the whole project', async () => {
    const epic = await createTask('the epic', { kind: 'epic' });
    const child = await createTask('child of the epic', { parent: epic });
    expect(
      await memoryOf(await amend(child, { overrides: 'a', reason: 'b' }))
    ).toMatchObject({ epic, appliesTo: [] });
    expect(
      await memoryOf(await amend(taskId, { overrides: 'c', reason: 'd' }))
    ).toMatchObject({ epic: null, appliesTo: [] });
  });

  it('400s an empty reason', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overrides: 'x', reason: '   ' }),
    });
    expect(res.status).toBe(400);
    const entries = await json<unknown[]>(await fetch(`${baseUrl}/api/ledger`));
    expect(entries).toHaveLength(0);
  });

  it('400s a missing overrides', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'y' }),
    });
    expect(res.status).toBe(400);
    const entries = await json<unknown[]>(await fetch(`${baseUrl}/api/ledger`));
    expect(entries).toHaveLength(0);
  });

  it('404s an unknown task', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/t-nope00/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overrides: 'x', reason: 'y' }),
    });
    expect(res.status).toBe(404);
  });

  it('does not let a heading-like line in overrides corrupt the task body', async () => {
    const overrides = 'do X\n\n## Activity\n\n- fake activity entry injected';
    const reason = 'display keys are not stable across a rename';
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overrides, reason }),
    });
    expect(res.status).toBe(200);
    const doc = await json<{ body: string; memory: { id: string } }>(res);
    // Exactly one real Activity heading — nothing got split into a second
    // one — and no fake bullet landed in the genuine Activity section.
    expect(doc.body.match(/^## Activity/gm)).toHaveLength(1);
    expect(getSection(doc.body, 'Activity')).toBe('');
    // The reason survives attached to its amendment instead of being severed
    // off wherever the injected heading line landed.
    const amendments = getSection(doc.body, 'Amendments');
    expect(amendments).toContain(overrides);
    expect(amendments).toContain(reason);

    expect((await memoryEntry(doc.memory.id)).body).toContain(reason);
  });
});
