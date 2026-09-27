import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth } from '../testAuth.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let base: string;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-home-')));
  process.env.DISPATCH_HOME = fakeHome;
  root = realpathSync(initGitRepo('dispatch-memory-'));
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
  });
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

async function addLedger(body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${base}/api/ledger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'hazard', detail: 'detail', ...body }),
  });
  expect(res.status).toBe(201);
}

describe('memory read routes', () => {
  it('imports lessons on ledger.changed and lists them; receipts stay out', async () => {
    await addLedger({ title: 'pnpm 11 ignores onlyBuiltDependencies' });
    await addLedger({
      kind: 'decision',
      title: 'Merged r-1',
      detail: 'ok — auto-decided by policy rung 4 (merge gate)',
    });
    const { entries } = await json<{
      entries: { title: string; trust: string; state: string }[];
    }>(await fetch(`${base}/api/memory`));
    expect(entries.map((e) => [e.title, e.trust, e.state])).toEqual([
      ['pnpm 11 ignores onlyBuiltDependencies', 'agent', 'active'],
    ]);
  });

  it('searches, reads by #handle, and reports health', async () => {
    await addLedger({
      title: 'flaky server tests under load',
      detail: 'run them in chunks',
    });
    const search = await json<{
      hits: { handle: string; snippet: string }[];
      search: string;
    }>(
      await fetch(`${base}/api/memory/search?q=${encodeURIComponent('chunks')}`)
    );
    expect(search.search).toBe('fts5');
    expect(search.hits).toHaveLength(1);
    const read = await fetch(
      `${base}/api/memory/${encodeURIComponent(search.hits[0].handle)}`
    );
    expect(read.status).toBe(200);
    expect((await json<{ entry: { body: string } }>(read)).entry.body).toBe(
      'run them in chunks'
    );
    const health = await json<{
      available: boolean;
      ledgerImport: { outcome: string };
    }>(await fetch(`${base}/api/memory/health`));
    expect(health).toMatchObject({
      available: true,
      ledgerImport: { outcome: 'ok' },
    });
  });

  it('refuses the shared agent token, and A2A agents', async () => {
    const res = await rawFetch(`${base}/api/memory`, {
      headers: { authorization: `Bearer ${handle.tokens.agentToken}` },
    });
    expect(res.status).toBe(403);
    const reg = await json<{ address: string; token: string }>(
      await rawFetch(`${base}/api/agents/register`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${handle.tokens.agentToken}`,
        },
        body: JSON.stringify({ name: 'a2a.acme', client: 'a2a' }),
      })
    );
    const approved = await fetch(
      `${base}/api/agents/${encodeURIComponent(reg.address)}/approve`,
      { method: 'POST' }
    );
    expect(approved.status).toBe(200);
    const a2a = await rawFetch(`${base}/api/memory`, {
      headers: { authorization: `Bearer ${reg.token}` },
    });
    expect(a2a.status).toBe(403);
  });

  it('dry-runs the ledger import for a decider only', async () => {
    await addLedger({ title: 'lesson' });
    const dry = await json<{
      report: { outcome: string; memory: { alreadyImported: number } };
      text: string;
    }>(
      await fetch(`${base}/api/memory/import/ledger?dryRun=1`, {
        method: 'POST',
      })
    );
    expect(dry.report).toMatchObject({
      outcome: 'dry-run',
      memory: { alreadyImported: 1 },
    });
    expect(dry.text).toContain('ledger rows read');
    const teammate = handle.team.teammates.issue('ada', 'request');
    const refused = await rawFetch(
      `${base}/api/memory/import/ledger?dryRun=1`,
      { method: 'POST', headers: { authorization: `Bearer ${teammate}` } }
    );
    expect(refused.status).toBe(403);
  });

  it('answers 400 with the field for a bad filter, and 404 for an unknown handle', async () => {
    const bad = await fetch(`${base}/api/memory?scope=galaxy`);
    expect(bad.status).toBe(400);
    expect((await json<{ field: string }>(bad)).field).toBe('scope');
    expect(
      (await fetch(`${base}/api/memory/${encodeURIComponent('#AAAAAAAA')}`))
        .status
    ).toBe(404);
  });

  it('serves a run its own recalls and index, and refuses other readers', async () => {
    await addLedger({ title: 'recalled lesson', appliesTo: [] });
    const runId = 'r-memory';
    const shared = handle.memory.shared;
    expect(shared).not.toBeNull();
    const entry = shared?.listEntries()[0];
    expect(entry?.title).toBe('recalled lesson');
    shared?.recordRecall(entry?.id ?? '', {
      runId,
      via: 'index',
      at: new Date().toISOString(),
      countsAsUse: false,
    });
    const recalls = await json<{
      recalls: { handle: string | null; via: string }[];
    }>(await fetch(`${base}/api/memory/recalls?runId=${runId}`));
    expect(recalls.recalls).toEqual([
      expect.objectContaining({ handle: entry?.handle, via: 'index' }),
    ]);
    const index = await json<{ text: string; included: string[] }>(
      await fetch(`${base}/api/memory/index?runId=${runId}`)
    );
    expect(index.included).toEqual([entry?.handle ?? '']);
    expect(index.text).toContain('recalled lesson');
    const teammate = handle.team.teammates.issue('ada', 'request');
    const refused = await rawFetch(
      `${base}/api/memory/recalls?runId=${runId}`,
      { headers: { authorization: `Bearer ${teammate}` } }
    );
    expect(refused.status).toBe(403);
    const missing = await fetch(`${base}/api/memory/index`);
    expect(missing.status).toBe(400);
    expect((await json<{ field: string }>(missing)).field).toBe('taskId');
  });
});
