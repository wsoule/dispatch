import { TaskStore } from '@dispatch/core';
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
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-findings-api-'));
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
  baseUrl = `http://127.0.0.1:${handle.port}`;
  const taskRes = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'fix the flaky watcher test' }),
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

describe('POST /api/findings', () => {
  it('creates an open finding for a review run', async () => {
    const res = await fetch(`${baseUrl}/api/findings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId,
        severity: 'important',
        title: 'withActionFeedback swallows rejections',
        detail: 'every catch downstream of it is dead code',
      }),
    });
    expect(res.status).toBe(201);
    const finding = await json<{ verdict: string; taskId: string }>(res);
    expect(finding.verdict).toBe('open');
    expect(finding.taskId).toBe(taskId);
  });

  it('accepts a blocks-or-park recommendation and rejects anything else', async () => {
    const ok = await fetch(`${baseUrl}/api/findings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId,
        severity: 'critical',
        title: 't',
        detail: 'd',
        recommendation: 'park',
      }),
    });
    expect(ok.status).toBe(201);
    expect((await json<{ recommendation: string }>(ok)).recommendation).toBe(
      'park'
    );

    const bad = await fetch(`${baseUrl}/api/findings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId,
        severity: 'critical',
        title: 't',
        detail: 'd',
        recommendation: 'maybe',
      }),
    });
    expect(bad.status).toBe(400);
  });

  it('400s a missing taskId', async () => {
    const res = await fetch(`${baseUrl}/api/findings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ severity: 'minor', title: 't', detail: 'd' }),
    });
    expect(res.status).toBe(400);
  });

  it('400s an invalid severity', async () => {
    const res = await fetch(`${baseUrl}/api/findings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId,
        severity: 'urgent',
        title: 't',
        detail: 'd',
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/findings', () => {
  it('filters by taskId and verdict', async () => {
    await fetch(`${baseUrl}/api/findings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId,
        severity: 'minor',
        title: 'a',
        detail: 'a',
      }),
    });
    const res = await fetch(
      `${baseUrl}/api/findings?taskId=${taskId}&verdict=open`
    );
    expect(res.status).toBe(200);
    const findings = await json<unknown[]>(res);
    expect(findings).toHaveLength(1);
  });

  it('400s an unknown verdict filter', async () => {
    const res = await fetch(`${baseUrl}/api/findings?verdict=bogus`);
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/findings/:id', () => {
  it('rules a finding addressed', async () => {
    const created = await json<{ id: string }>(
      await fetch(`${baseUrl}/api/findings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId,
          severity: 'critical',
          title: 't',
          detail: 'd',
        }),
      })
    );
    const res = await fetch(`${baseUrl}/api/findings/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'addressed', ruling: 'fixed' }),
    });
    expect(res.status).toBe(200);
    const finding = await json<{ verdict: string; ruling: string }>(res);
    expect(finding.verdict).toBe('addressed');
    expect(finding.ruling).toBe('fixed');
  });

  it('404s an unknown finding', async () => {
    const res = await fetch(`${baseUrl}/api/findings/f-nope00`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'addressed' }),
    });
    expect(res.status).toBe(404);
  });

  it('400s an invalid verdict', async () => {
    const created = await json<{ id: string }>(
      await fetch(`${baseUrl}/api/findings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId,
          severity: 'critical',
          title: 't',
          detail: 'd',
        }),
      })
    );
    const res = await fetch(`${baseUrl}/api/findings/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'bogus' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/ledger', () => {
  it('creates an entry defaulting to project-wide and untargeted', async () => {
    const res = await fetch(`${baseUrl}/api/ledger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'decision',
        title: 'retry POSTs',
        detail: 'up to 3 times on 5xx',
      }),
    });
    expect(res.status).toBe(201);
    const entry = await json<{ epicId: null; appliesTo: string[] }>(res);
    expect(entry.epicId).toBeNull();
    expect(entry.appliesTo).toEqual([]);
  });

  it('400s an invalid kind', async () => {
    const res = await fetch(`${baseUrl}/api/ledger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'bogus', title: 't', detail: 'd' }),
    });
    expect(res.status).toBe(400);
  });

  it('400s a missing detail', async () => {
    const res = await fetch(`${baseUrl}/api/ledger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'hazard', title: 't' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/ledger', () => {
  it('filters by epicId, and epicId= (empty) selects project-wide-only entries', async () => {
    await fetch(`${baseUrl}/api/ledger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'decision', title: 'wide', detail: 'd' }),
    });
    await fetch(`${baseUrl}/api/ledger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'decision',
        title: 'scoped',
        detail: 'd',
        epicId: 'e-111111',
      }),
    });

    const all = await json<unknown[]>(await fetch(`${baseUrl}/api/ledger`));
    expect(all).toHaveLength(2);

    const scoped = await json<{ title: string }[]>(
      await fetch(`${baseUrl}/api/ledger?epicId=e-111111`)
    );
    expect(scoped.map((e) => e.title)).toEqual(['scoped']);

    const wide = await json<{ title: string }[]>(
      await fetch(`${baseUrl}/api/ledger?epicId=`)
    );
    expect(wide.map((e) => e.title)).toEqual(['wide']);
  });
});
