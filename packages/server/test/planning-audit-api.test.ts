import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import {
  type PlanningAuditEntry,
  planningChanges,
} from '../src/planning/audit.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// The planning audit: planningChanges says what a planning patch changed,
// field by field, in words; PATCH /api/config records it and GET
// /api/planning/audit lists it, newest first.

const names = (ref: string) => (ref === 'human:ana' ? 'Ana' : ref);
const titles = (id: string) => (id === 't-beta00' ? 'Beta' : id);

describe('planningChanges', () => {
  it('names each changed field with its value before and after', () => {
    expect(
      planningChanges(
        undefined,
        {
          tuning: { warnLeadDays: 10 },
          watchers: ['human:ana'],
          weights: { 't-beta00': 2 },
          allocation: 'daily',
          warnings: 'off',
        },
        names,
        titles
      )
    ).toEqual([
      { what: 'Warn ahead', before: '7 days', after: '10 days' },
      { what: 'Watcher added', before: null, after: 'Ana' },
      { what: 'Weight of Beta', before: null, after: '2' },
      { what: 'Allocate', before: 'Manual', after: 'Daily' },
    ]);
  });

  it('says nothing when nothing changed', () => {
    expect(planningChanges(undefined, undefined, names, titles)).toEqual([]);
  });
});

describe('/api/planning/audit', () => {
  let fakeHome: string;
  let root: string;
  let handle: ServerHandle;
  let baseUrl: string;
  const originalDispatchHome = process.env.DISPATCH_HOME;

  beforeEach(async () => {
    fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
    process.env.DISPATCH_HOME = fakeHome;
    root = mkdtempSync(join(tmpdir(), 'dispatch-audit-api-'));
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
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}/api`;
  });

  afterEach(async () => {
    await handle.stop();
    if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalDispatchHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  async function patch(planning: unknown): Promise<number> {
    const res = await fetch(`${baseUrl}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planning }),
    });
    return res.status;
  }

  it('records each planning change, newest first, and ignores other config', async () => {
    expect(await patch({ tuning: { stallDays: 3 } })).toBe(200);
    expect(await patch({ warnings: 'notify' })).toBe(200);
    await fetch(`${baseUrl}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoCommit: true }),
    });
    const entries = (await json(
      await fetch(`${baseUrl}/planning/audit`)
    )) as PlanningAuditEntry[];
    expect(entries.map((e) => [e.what, e.before, e.after])).toEqual([
      ['Daily digest', 'Off', 'Notify'],
      ['Stalled after', '7 days', '3 days'],
    ]);
    expect(entries[0]?.by).toMatch(/^human:/);
  });

  it('records nothing for a refused change', async () => {
    expect(await patch({ tuning: { stallDays: -1 } })).toBe(400);
    const entries = (await json(
      await fetch(`${baseUrl}/planning/audit`)
    )) as PlanningAuditEntry[];
    expect(entries).toEqual([]);
  });
});
