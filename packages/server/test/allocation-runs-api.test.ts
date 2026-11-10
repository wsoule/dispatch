import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import {
  type AllocationRun,
  type AllocationRunInput,
  type AllocationRunItem,
  AllocationRunStore,
  type AllocationRunSummary,
  parseAllocationRunInput,
} from '../src/planning/allocationRuns.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// The allocation run log: the store keeps runs newest first with their
// counts, the parser refuses runs whose items disagree with their mode, and
// the routes record, list and read them.

function item(over: Partial<AllocationRunItem> = {}): AllocationRunItem {
  return {
    issueId: 't-aaaaaa',
    identifier: 't-aaaaaa',
    title: 'Take card payments',
    projectId: 't-pppppp',
    projectName: 'Storefront',
    milestoneId: 't-mmmmmm',
    milestoneName: 'Beta',
    assigneeId: 'human:ana',
    assigneeName: 'Ana',
    fromStatus: 'backlog',
    toStatus: 'ready',
    outcome: 'would_assign',
    note: null,
    ...over,
  };
}

function run(over: Partial<AllocationRunInput> = {}): AllocationRunInput {
  return {
    mode: 'dry_run',
    items: [item()],
    projects: [
      {
        projectId: 't-pppppp',
        projectName: 'Storefront',
        outcome: 'allocating',
        reason: null,
        skipped: 1,
      },
      {
        projectId: 't-qqqqqq',
        projectName: 'Search',
        outcome: 'blocked',
        reason: 'Project has no lead',
        skipped: 0,
      },
    ],
    ...over,
  };
}

describe('AllocationRunStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dispatch-alloc-runs-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('records runs with counts and lists them newest first', () => {
    let tick = 0;
    const store = new AllocationRunStore(
      join(dir, 'nested', 'runs.db'),
      () => new Date(Date.UTC(2026, 10, 6, 9, tick++))
    );
    const first = store.record(run(), 'human:wyat');
    const second = store.record(
      run({
        mode: 'applied',
        items: [item({ outcome: 'assigned' }), item({ outcome: 'failed' })],
      }),
      'human:wyat'
    );
    expect(first.counts).toEqual({
      assigned: 0,
      wouldAssign: 1,
      failed: 0,
      blocked: 1,
      skipped: 1,
    });
    expect(second.counts.assigned).toBe(1);
    expect(second.counts.failed).toBe(1);
    expect(store.list().map((each) => each.id)).toEqual([second.id, first.id]);
    expect('items' in (store.list()[0] ?? {})).toBe(false);
    expect(store.get(first.id)?.items).toHaveLength(1);
    expect(store.appliedSince(first.at).map((each) => each.id)).toEqual([
      second.id,
    ]);
    store.close();
  });
});

describe('parseAllocationRunInput', () => {
  it('accepts a well-formed run', () => {
    expect(parseAllocationRunInput(run()).ok).toBe(true);
  });

  it('refuses items that disagree with the mode', () => {
    const applied = parseAllocationRunInput(run({ mode: 'applied' }));
    expect(applied).toEqual({
      ok: false,
      error: 'items do not match the applied mode',
    });
    const dry = parseAllocationRunInput(
      run({ items: [item({ outcome: 'assigned' })] })
    );
    expect(dry.ok).toBe(false);
  });

  it('refuses a malformed item or project', () => {
    expect(
      parseAllocationRunInput({ ...run(), items: [{ issueId: 1 }] }).ok
    ).toBe(false);
    expect(
      parseAllocationRunInput({ ...run(), projects: [{ skipped: -1 }] }).ok
    ).toBe(false);
    expect(parseAllocationRunInput({ ...run(), mode: 'live' }).ok).toBe(false);
  });
});

describe('/api/planning/allocation-runs', () => {
  let fakeHome: string;
  let root: string;
  let handle: ServerHandle;
  let baseUrl: string;
  const originalDispatchHome = process.env.DISPATCH_HOME;

  beforeEach(async () => {
    fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
    process.env.DISPATCH_HOME = fakeHome;
    root = mkdtempSync(join(tmpdir(), 'dispatch-alloc-api-'));
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
    baseUrl = `http://127.0.0.1:${handle.port}/api/planning/allocation-runs`;
  });

  afterEach(async () => {
    await handle.stop();
    if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalDispatchHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('records a run, lists it and reads it back', async () => {
    const posted = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(run()),
    });
    expect(posted.status).toBe(201);
    const recorded = (await json(posted)) as AllocationRun;
    expect(recorded.mode).toBe('dry_run');
    expect(recorded.by).toMatch(/^human:/);

    const listed = (await json(await fetch(baseUrl))) as AllocationRunSummary[];
    expect(listed.map((each) => each.id)).toEqual([recorded.id]);

    const one = (await json(
      await fetch(`${baseUrl}/${recorded.id}`)
    )) as AllocationRun;
    expect(one.items).toHaveLength(1);
    expect((await fetch(`${baseUrl}/ar-missing`)).status).toBe(404);
  });

  it('refuses a malformed run', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'applied', items: [], projects: 'x' }),
    });
    expect(res.status).toBe(400);
  });
});
