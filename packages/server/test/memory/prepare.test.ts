import { TaskStore, updateConfig } from '@dispatch/core';
import {
  createMemoryIds,
  insertFresh,
  newMemoryEntry,
  topicFileName,
} from '@dispatch/memory';
import type { MemoryEntry, SqliteMemoryStore } from '@dispatch/memory';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventBus } from '../../src/events.js';
import { LedgerStore } from '../../src/ledger.js';
import { EXPORT_PROMPT_LINE } from '../../src/memory/claudeModes.js';
import { openMemory } from '../../src/memory/service.js';
import type { MemoryService } from '../../src/memory/service.js';
import { claudeMemoryDir, projectKeyOf } from '../../src/orchestrator/paths.js';
import type { RunKind, RunMeta } from '../../src/orchestrator/types.js';
import { waitFor } from '../messaging/harness.js';
import { quietDaemon } from './fixtures.js';

const originalHome = process.env.DISPATCH_HOME;
const UNLOADED =
  'Your auto-memory directory is not active; save memories with memory_save.';

let home: string;
let root: string;
let taskId: string;
let runs: RunMeta[];
let memory: MemoryService;
let shared: SqliteMemoryStore;

function roster(email: string): void {
  writeFileSync(
    join(root, '.dispatch', 'team.yml'),
    `members:\n  - handle: ada\n    email: ${email}\n    displayName: Ada\n    emails: []\n`
  );
}

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'memory-prepare-')));
  process.env.DISPATCH_HOME = home;
  root = join(home, 'project');
  mkdirSync(root);
  const store = TaskStore.init(root);
  taskId = store.create({
    title: 'Bump pnpm',
    writes: ['pnpm-workspace.yaml'],
  }).meta.id;
  updateConfig(root, { memory: { claudeAutoMemory: 'export' } });
  roster('ada@x.com');
  runs = [];
  memory = openMemory({
    rootDir: root,
    store,
    events: new EventBus(),
    ledgerStore: new LedgerStore(root),
    ...quietDaemon(root, {
      taskIdOfRun: (id) => runs.find((r) => r.id === id)?.taskId ?? null,
      list: () => runs,
    }),
    dbPath: join(root, 'memory.db'),
    preflight: () => Promise.resolve({ ok: true, version: '2.1.210' }),
  });
  if (memory.shared === null) throw new Error('memory.db did not open');
  shared = memory.shared;
  await memory.refreshPreflight();
});

afterEach(() => {
  memory.close();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

// A live run of the task, acting for `operator`.
function run(operator: string | null, kind: RunKind = 'execute'): RunMeta {
  const now = new Date().toISOString();
  const id = `r-${String(runs.length + 1).padStart(6, '0')}`;
  const meta: RunMeta = {
    id,
    taskId,
    taskTitle: 'Bump pnpm',
    executor: 'claude',
    state: 'running',
    branch: `dispatch/${id}`,
    baseBranch: 'main',
    worktreePath: join(home, 'worktrees', id),
    createdAt: now,
    updatedAt: now,
    operator,
    memoryLineage: id,
    kind,
  };
  runs.push(meta);
  return meta;
}

function prepare(meta: RunMeta) {
  return memory.prepare({
    runId: meta.id,
    taskId,
    lineage: meta.id,
    runKind: meta.kind ?? 'execute',
    isClaude: true,
    dispatchTools: true,
  });
}

// A team hazard every run of the task sees.
function hazard(): MemoryEntry {
  return insertFresh(
    shared,
    createMemoryIds(),
    Date.now(),
    (id) =>
      newMemoryEntry(
        {
          scope: 'team',
          kind: 'hazard',
          title: 'pnpm 11 ignores onlyBuiltDependencies',
          body: 'use allowBuilds',
          author: 'run:r-000000',
          trust: 'agent',
        },
        id,
        new Date().toISOString()
      ),
    'run:r-000000',
    'save'
  );
}

describe('MemoryService.prepare', () => {
  it('keeps an owner whose Claude import is unconfirmed native, with the index in the prompt', () => {
    const e = hazard();
    memory.personal
      .personal('self')
      .setMeta(`claude-import:${projectKeyOf(root)}`, 'unconfirmed');
    const meta = run('human:wyat');
    const out = prepare(meta);
    expect(out.memory).toEqual({ mode: 'native' });
    expect(out.text).toContain('## Memory');
    expect(out.text).toContain(`(${e.handle})`);
    expect(out.indexSection).toBe(out.text);
    expect(existsSync(claudeMemoryDir(root, meta.id))).toBe(false);
  });

  it('exports a teammate’s memory once the preflight passes, and records its index recalls', async () => {
    const e = hazard();
    shared.setMeta('claude-probe-passed', '2.1.207');
    const meta = run('human:ada');
    const out = prepare(meta);
    const dir = claudeMemoryDir(root, meta.id);
    expect(out.text).toBe(EXPORT_PROMPT_LINE);
    expect(out.indexSection).toContain(`(${e.handle})`);
    expect(out.memory).toMatchObject({
      mode: 'export',
      dir,
      probeVersion: '2.1.207',
    });
    expect(out.memory.unloadedNote).toContain(`(${e.handle})`);
    expect(out.memory.unloadedNote).toContain(UNLOADED);
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toContain(
      topicFileName(e)
    );
    expect(shared.recallsForRun(meta.id).map((r) => r.via)).toEqual(['index']);

    memory.recall(meta.id, meta.id, [join(dir, topicFileName(e))], 'read');
    expect(shared.recallsForRun(meta.id).map((r) => r.via)).toEqual([
      'index',
      'read',
    ]);

    // The run's end scans what Claude left; the directory stays for its lineage.
    writeFileSync(
      join(dir, 'lockfile-note.md'),
      '---\nname: lockfile-note\ndescription: the lockfile pins pnpm 11\nmetadata:\n  type: project\n---\nCheck it first.\n'
    );
    memory.runEnded({ ...meta, state: 'finished' });
    const ada = memory.host.operatorOf({
      address: 'human:ada',
      canDecide: true,
      kind: 'human',
    });
    if (ada === null) throw new Error('ada has no identity');
    await waitFor(() =>
      memory.personal
        .personal(ada.identity)
        .listEntries()
        .some((x) => x.title === 'the lockfile pins pnpm 11')
    );
    expect(existsSync(dir)).toBe(true);
  });

  it('drops to prompt when the operator’s personal store will not open', () => {
    const meta = run('human:ada');
    // Bind ada, then change the roster email: the handle now reads as reused.
    memory.host.operatorOf({
      address: 'human:ada',
      canDecide: true,
      kind: 'human',
    });
    roster('ada@new.com');
    const out = prepare(meta);
    expect(out.memory).toEqual({ mode: 'prompt' });
    expect(out.text).toContain('(personal memory unavailable)');
    expect(existsSync(claudeMemoryDir(root, meta.id))).toBe(false);
  });

  it('gives a review run prompt mode and no index', () => {
    hazard();
    const out = prepare(run('human:ada', 'review'));
    expect(out).toEqual({
      text: null,
      indexSection: null,
      memory: { mode: 'prompt' },
    });
  });
});
