import { getSection, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
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
let handle: ServerHandle;
let baseUrl: string;
let taskId: string;

beforeEach(async () => {
  root = initDispatchGitRepo();
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
  });
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

  it('writes a constraint ledger entry so a dependent task inherits it', async () => {
    await fetch(`${baseUrl}/api/tasks/${taskId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        overrides: 'join on the issue UUID',
        reason: 'display keys are not stable',
      }),
    });
    const entries = await json<{ kind: string; detail: string }[]>(
      await fetch(`${baseUrl}/api/ledger`)
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('constraint');
    expect(entries[0].detail).toContain('join on the issue UUID');
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
    const doc = await json<{ body: string }>(res);
    // Exactly one real Activity heading — nothing got split into a second
    // one — and no fake bullet landed in the genuine Activity section.
    expect(doc.body.match(/^## Activity/gm)).toHaveLength(1);
    expect(getSection(doc.body, 'Activity')).toBe('');
    // The reason survives attached to its amendment instead of being severed
    // off wherever the injected heading line landed.
    const amendments = getSection(doc.body, 'Amendments');
    expect(amendments).toContain(overrides);
    expect(amendments).toContain(reason);

    const entries = await json<{ detail: string }[]>(
      await fetch(`${baseUrl}/api/ledger`)
    );
    expect(entries[0].detail).toContain(reason);
  });
});
