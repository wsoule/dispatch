import type { AddLedgerInput } from '@dispatch/core';
import { openSqliteDb } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { renderImportReport } from '../../src/memory/ledgerImport.js';
import type { LedgerImportReport } from '../../src/memory/ledgerImport.js';
import {
  memoryDbPath,
  personalMemoryDir,
} from '../../src/orchestrator/paths.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth } from '../testAuth.js';
import { BEFORE_CUTOVER, importAtCutover, seedLedger } from './fixtures.js';

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

// A ledger row from before the cutover, imported as the boot import would.
function seedLesson(input: Partial<AddLedgerInput> & { title: string }): void {
  seedLedger(
    root,
    { kind: 'hazard', detail: 'detail', authoredBy: 'human:test', ...input },
    BEFORE_CUTOVER
  );
  importAtCutover(handle.memory);
}

describe('memory read routes', () => {
  it('imports lessons and lists them; receipts stay out', async () => {
    seedLesson({ title: 'pnpm 11 ignores onlyBuiltDependencies' });
    seedLesson({
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
    seedLesson({
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
      ledgerImport: LedgerImportReport;
      ledgerImportText: string;
    }>(await fetch(`${base}/api/memory/health`));
    expect(health).toMatchObject({
      available: true,
      ledgerImport: { outcome: 'ok' },
    });
    // Settings shows the CLI's own rendering rather than a copy of it.
    expect(health.ledgerImportText).toBe(
      renderImportReport(health.ledgerImport)
    );
  });

  it('retries a busy memory.db off the event loop, then answers 503 with Retry-After', async () => {
    const save = (title: string) =>
      fetch(`${base}/api/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: 'project',
          kind: 'hazard',
          title,
          body: 'detail',
        }),
      });
    const other = openSqliteDb(memoryDbPath(root));
    other.exec('BEGIN IMMEDIATE');
    // Released while the route waits between attempts: the retry lands.
    setTimeout(() => other.exec('ROLLBACK'), 150);
    expect((await save('lands after a retry')).status).toBe(201);
    other.exec('BEGIN IMMEDIATE');
    try {
      const busy = await save('never lands');
      expect(busy.status).toBe(503);
      expect(busy.headers.get('retry-after')).toBe('1');
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
  });

  it('retries a busy identities.db off the event loop, then answers 503', async () => {
    const issued = (await (
      await fetch(`${base}/api/team/tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com', tier: 'request' }),
      })
    ).json()) as { token: string };
    const asAlice = (path: string, body: unknown) =>
      rawFetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${issued.token}`,
        },
        body: JSON.stringify(body),
      });
    // A personal save binds the teammate's alias, so a link writes only the code.
    const saved = await asAlice('/api/memory', {
      scope: 'personal',
      kind: 'preference',
      title: 'tabs',
      body: 'two spaces',
    });
    expect(saved.status).toBe(201);
    const other = openSqliteDb(join(personalMemoryDir(), 'identities.db'));
    other.exec('BEGIN IMMEDIATE');
    setTimeout(() => other.exec('ROLLBACK'), 150);
    const started = performance.now();
    const health = fetch(`${base}/api/health`);
    const linked = asAlice('/api/memory/link', {});
    expect((await health).status).toBe(200);
    expect(performance.now() - started).toBeLessThan(1000);
    expect((await linked).status).toBe(200);
    other.exec('BEGIN IMMEDIATE');
    try {
      const busy = await asAlice('/api/memory/link', {});
      expect(busy.status).toBe(503);
      expect(busy.headers.get('retry-after')).toBe('1');
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
  });

  it('refuses the shared agent token, and A2A agents', async () => {
    const res = await rawFetch(`${base}/api/memory`, {
      headers: { authorization: `Bearer ${handle.tokens.agentToken}` },
    });
    expect(res.status).toBe(403);
    const added = await fetch(`${base}/api/a2a/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'acme', approve: true }),
    });
    expect(added.status).toBe(201);
    const client = await json<{ token: string }>(added);
    const a2a = await rawFetch(`${base}/api/memory`, {
      headers: { authorization: `Bearer ${client.token}` },
    });
    expect(a2a.status).toBe(403);
    expect((await json<{ code: string }>(a2a)).code).toBe('auth_a2a_client');
  });

  it('dry-runs the ledger import for a decider only', async () => {
    seedLesson({ title: 'lesson' });
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
    seedLesson({ title: 'recalled lesson', appliesTo: [] });
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
