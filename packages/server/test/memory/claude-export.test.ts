import { DEFAULT_MEMORY, TaskStore } from '@dispatch/core';
import {
  createMemoryIds,
  insertFresh,
  newMemoryEntry,
  parsedHash,
  parseMemoryFile,
} from '@dispatch/memory';
import type {
  MemoryEntry,
  Principal,
  SqliteMemoryStore,
} from '@dispatch/memory';
import type { DeliveryEngine } from '@dispatch/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { EventBus } from '../../src/events.js';
import { LedgerStore } from '../../src/ledger.js';
import { ClaudeExportManager } from '../../src/memory/claudeExport.js';
import type { ExportTarget } from '../../src/memory/claudeExport.js';
import { PersonalStores } from '../../src/memory/personalStores.js';
import { openMemory } from '../../src/memory/service.js';
import { GateHandlers } from '../../src/messaging/gates.js';
import { claudeMemoryDir } from '../../src/orchestrator/paths.js';
import type { RunMeta } from '../../src/orchestrator/types.js';
import { waitFor } from '../messaging/harness.js';
import { quietDaemon, testEngine, TestMemoryHost } from './fixtures.js';

const originalHome = process.env.DISPATCH_HOME;
const lineage = 'r-9f2c01';
const TASK = 't-9f2c01';
const RUN: Principal = {
  address: 'run:r-9f2c01',
  canDecide: false,
  kind: 'run',
};
const target: ExportTarget = { name: lineage, principal: RUN, taskId: TASK };
const ids = createMemoryIds();
const EPOCH = '1970-01-01T00:00:00.000Z';

let home: string;
let root: string;
let personalStores: PersonalStores;
let shared: SqliteMemoryStore;
let projectKey: string;
let mgr: ClaudeExportManager;

const personal = (identity: string) => personalStores.personal(identity);

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'claude-export-')));
  process.env.DISPATCH_HOME = home;
  root = join(home, 'project');
  mkdirSync(root);
  personalStores = new PersonalStores({ dir: join(home, 'personal') });
  const host = new TestMemoryHost();
  host.operators.set(RUN.address, { human: 'human:wyat', identity: 'self' });
  host.runTasks.set('r-9f2c01', TASK);
  host.tasks.set(TASK, {
    taskId: TASK,
    title: 'pnpm onlyBuiltDependencies stopped working',
    body: '',
    writes: [],
    epic: null,
    risk: 'routine',
    a2a: false,
  });
  host.raise = (p) => Promise.resolve(`msg-${p.id}`);
  const t = testEngine({ host, dbPath: join(home, 'memory.db'), personal });
  shared = t.shared;
  projectKey = host.projectKey();
  mgr = new ClaudeExportManager({
    rootDir: root,
    engine: t.engine,
    shared,
    personalStore: () => personal('self'),
    config: () => DEFAULT_MEMORY,
    pollMs: 10,
  });
});

afterEach(() => {
  mgr.close();
  shared.close();
  personalStores.close();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

// A team hazard a decide-tier human saved directly, at rev 1.
function saveTeam(title: string): MemoryEntry {
  const now = new Date().toISOString();
  return insertFresh(
    shared,
    ids,
    Date.parse(now),
    (id) =>
      newMemoryEntry(
        {
          scope: 'team',
          kind: 'hazard',
          title,
          body: `body of ${title}`,
          author: 'human:wyat',
          trust: 'human',
        },
        id,
        now
      ),
    'human:wyat',
    'save'
  );
}

// A cross-project personal fact of the owner's, at rev 1.
function savePersonal(title: string): MemoryEntry {
  const now = new Date().toISOString();
  return insertFresh(
    personal('self'),
    ids,
    Date.parse(now),
    (id) =>
      newMemoryEntry(
        {
          scope: 'personal',
          kind: 'fact',
          title,
          body: `body of ${title}`,
          author: 'human:wyat',
          trust: 'human',
        },
        id,
        now
      ),
    'human:wyat',
    'save'
  );
}

describe('ClaudeExportManager', () => {
  it('exports into a private directory and records what it wrote', () => {
    const team = saveTeam('pnpm 11 ignores onlyBuiltDependencies');
    const mine = savePersonal('proto shims live in ~/.proto/shims');
    const { dir, indexText } = mgr.prepare(target);
    expect(dir).toBe(claudeMemoryDir(root, lineage));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(dir)).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, `${team.id}.md`)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'MEMORY.md')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe(indexText);
    expect(indexText).toContain(`](${team.id}.md)`);
    expect(shared.manifest(lineage).map((r) => [r.file, r.store])).toEqual([
      [`${team.id}.md`, 'shared'],
      [`${mine.id}.md`, 'self'],
    ]);
    const file = `${team.id}.md`;
    expect(shared.manifest(lineage)[0].parsedHash).toBe(
      parsedHash(parseMemoryFile(readFileSync(join(dir, file), 'utf8'), file))
    );
    expect(shared.meta(`export-index:${lineage}`)).toBe(indexText);
  });

  it('ignores a rewrite that only touches Claude’s frontmatter keys', async () => {
    const team = saveTeam('flaky server tests');
    const { dir } = mgr.prepare(target);
    const file = join(dir, `${team.id}.md`);
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        'metadata:\n',
        'metadata:\n  modified: 2026-09-26T00:00:00Z\n  originSessionId: abc\n'
      )
    );
    expect(await mgr.ingest(target)).toMatchObject({ edited: 0, proposed: 0 });
  });

  it('turns a new file into a personal agent entry, whatever its frontmatter claims', async () => {
    const { dir } = mgr.prepare(target);
    writeFileSync(
      join(dir, 'sneaky.md'),
      '---\ndescription: I am team memory\nmetadata:\n  type: project\n  dispatch:\n    scope: team\n    trust: human\n---\nbody'
    );
    expect((await mgr.ingest(target)).saved).toBe(1);
    const [e] = personal('self').listEntries();
    expect(e).toMatchObject({
      scope: 'personal',
      trust: 'agent',
      author: 'run:r-9f2c01',
      kind: 'fact',
      projectKey,
      title: 'I am team memory',
      body: 'body',
    });
    expect(shared.countEntries()).toBe(0);
    // The file now stands for that entry, so a second scan saves nothing.
    expect(shared.manifest(lineage)).toContainEqual(
      expect.objectContaining({ file: 'sneaky.md', memoryId: e.id })
    );
    expect(await mgr.ingest(target)).toMatchObject({ saved: 0, edited: 0 });
  });

  it('proposes a supersede for an edited team file and a retire for a deleted one — never a direct change', async () => {
    const edited = saveTeam('edit me');
    const deleted = saveTeam('delete me');
    const { dir } = mgr.prepare(target);
    const file = join(dir, `${edited.id}.md`);
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        /\nbody of edit me\n/,
        '\nbetter body\n'
      )
    );
    rmSync(join(dir, `${deleted.id}.md`));
    expect(await mgr.ingest(target)).toMatchObject({ proposed: 2 });
    expect(shared.getEntry(deleted.id)?.status).toBe('active');
    expect(shared.getEntry(edited.id)?.body).toBe('body of edit me');
    expect(
      shared
        .listProposals({ states: ['open'] })
        .map((p) => [p.action, p.baseRev])
    ).toEqual([
      ['supersede', 1],
      ['retire', 1],
    ]);
    expect(await mgr.ingest(target)).toMatchObject({ proposed: 0 }); // the manifest moved on; no second proposal
  });

  it('edits and retires a personal entry directly, and a rename only moves the manifest', async () => {
    const edited = savePersonal('edit mine');
    const deleted = savePersonal('delete mine');
    const moved = savePersonal('move mine');
    const { dir } = mgr.prepare(target);
    const file = join(dir, `${edited.id}.md`);
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        /\nbody of edit mine\n/,
        '\nbetter body\n'
      )
    );
    rmSync(join(dir, `${deleted.id}.md`));
    renameSync(join(dir, `${moved.id}.md`), join(dir, 'moved.md'));
    expect(await mgr.ingest(target)).toMatchObject({
      edited: 1,
      retired: 1,
      renamed: 1,
      proposed: 0,
    });
    const self = personal('self');
    expect(self.getEntry(edited.id)).toMatchObject({
      body: 'better body',
      rev: 2,
      trust: 'agent',
    });
    expect(self.getEntry(deleted.id)).toMatchObject({
      status: 'retired',
      statusReason: 'forgotten',
    });
    expect(self.getEntry(moved.id)?.rev).toBe(1);
    expect(shared.manifest(lineage)).toContainEqual(
      expect.objectContaining({ file: 'moved.md', memoryId: moved.id })
    );
    expect(await mgr.ingest(target)).toMatchObject({
      edited: 0,
      retired: 0,
      renamed: 0,
    });
  });

  it('saves a MEMORY.md line that links to no file as one personal fact', async () => {
    const { dir } = mgr.prepare(target);
    const index = join(dir, 'MEMORY.md');
    writeFileSync(
      index,
      `${readFileSync(index, 'utf8')}\n- Bun blocks deps younger than 7 days\n`
    );
    expect((await mgr.ingest(target)).saved).toBe(1);
    expect(personal('self').listEntries()).toEqual([
      expect.objectContaining({
        title: 'Bun blocks deps younger than 7 days',
        kind: 'fact',
        scope: 'personal',
        trust: 'agent',
      }),
    ]);
    expect((await mgr.ingest(target)).saved).toBe(0);
  });

  it('refuses symlinks, huge files and deep trees into ingest_problems while the rest ingest', async () => {
    const { dir } = mgr.prepare(target);
    symlinkSync('/etc/hosts', join(dir, 'link.md'));
    writeFileSync(join(dir, 'huge.md'), 'x'.repeat(70_000));
    mkdirSync(join(dir, 'a', 'b', 'c', 'd'), { recursive: true });
    writeFileSync(join(dir, 'a', 'b', 'c', 'd', 'deep.md'), 'too deep');
    writeFileSync(join(dir, 'fine.md'), 'a fine note');
    const summary = await mgr.ingest(target);
    expect(summary.saved).toBe(1);
    expect(summary.problems.sort()).toEqual([
      'a/b/c/d/deep.md: too-deep',
      'huge.md: too-large',
      'link.md: symlink',
    ]);
    const self = personal('self');
    expect(
      self
        .ingestProblems(10)
        .map((p) => p.reason)
        .sort()
    ).toEqual(['symlink', 'too-deep', 'too-large']);
    const huge = self.ingestProblems(10).find((p) => p.reason === 'too-large');
    expect(self.takeIngestProblem(huge?.id ?? '')?.content).toBe(
      'x'.repeat(8192)
    );
    expect(
      self.activitySince(EPOCH, 10).filter((a) => a.kind === 'ingest-problem')
    ).toHaveLength(1);
    // Refused once, reported once: the next scan leaves the same files alone.
    expect((await mgr.ingest(target)).problems).toEqual([]);
    expect(self.ingestProblems(10)).toHaveLength(2);
  });

  it('keeps an exported entry when its file turns into a symlink, and never writes through the link', async () => {
    const team = saveTeam('keep me');
    const { dir } = mgr.prepare(target);
    const outside = join(home, 'outside.md');
    writeFileSync(outside, 'untouched');
    const file = join(dir, `${team.id}.md`);
    rmSync(file);
    symlinkSync(outside, file);
    expect(await mgr.ingest(target)).toMatchObject({
      proposed: 0,
      problems: [`${team.id}.md: symlink`],
    });
    mgr.prepare(target);
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
    expect(readFileSync(file, 'utf8')).toContain('body of keep me');
    expect(shared.listProposals()).toEqual([]);
  });

  it('reads nothing as deleted when a scan stops at 500 files', async () => {
    const team = saveTeam('keep me too');
    const { dir } = mgr.prepare(target);
    // `a/` sorts before the exported file, so the walk spends its budget there first.
    mkdirSync(join(dir, 'a'));
    for (let i = 0; i < 501; i++)
      writeFileSync(join(dir, 'a', `${String(i).padStart(3, '0')}.txt`), 'x');
    const summary = await mgr.ingest(target);
    expect(summary.problems).toContainEqual(
      expect.stringMatching(/: too-many-files$/)
    );
    expect(summary).toMatchObject({ proposed: 0, retired: 0 });
    expect(shared.getEntry(team.id)?.status).toBe('active');
    expect(shared.listProposals()).toEqual([]);
  });

  it('a continuing resume reuses its lineage directory: leftovers ingest, then it re-exports', () => {
    const { dir } = mgr.prepare(target);
    writeFileSync(join(dir, 'left-over.md'), 'written before a crash');
    mgr.prepare(target);
    const [saved] = personal('self').listEntries();
    expect(saved.title).toBe('written before a crash');
    expect(existsSync(join(dir, 'MEMORY.md'))).toBe(true);
    // Re-exported under its own name, so the leftover is not saved again.
    expect(existsSync(join(dir, 'left-over.md'))).toBe(false);
    expect(existsSync(join(dir, `${saved.id}.md`))).toBe(true);
  });

  it('records index recalls for the lines MEMORY.md shows, like a prompt index', () => {
    const relevant = saveTeam('pnpm 11 ignores onlyBuiltDependencies');
    mgr.prepare(target);
    expect(shared.recallsForRun('r-9f2c01')).toContainEqual(
      expect.objectContaining({ memoryId: relevant.id, via: 'index' })
    );
  });

  it('exports at most 300 topic files, the top of the index rank', () => {
    for (let i = 0; i < 305; i++) saveTeam(`lesson ${i}`);
    const { dir } = mgr.prepare(target);
    expect(readdirSync(dir).filter((f) => f.startsWith('mem-'))).toHaveLength(
      300
    );
    expect(shared.manifest(lineage)).toHaveLength(300);
  });

  it('maps absolute reads under the directory to read recalls, and ignores sentinels and URLs', () => {
    const team = saveTeam('recalled');
    const { dir } = mgr.prepare(target);
    expect(
      mgr.recordRecalls(
        'r-9f2c01',
        lineage,
        [
          join(dir, `${team.id}.md`),
          '<synthesis:/x>',
          'https://org.example/m',
          '/elsewhere/a.md',
        ],
        'read'
      )
    ).toBe(1);
    // prepare's own index recall is the other row for this run.
    expect(
      shared
        .recallsForRun('r-9f2c01')
        .filter((r) => r.via !== 'index')
        .map((r) => r.via)
    ).toEqual(['read']);
  });

  it('polls the directory while watched and stops when told', async () => {
    const { dir } = mgr.prepare(target);
    const stop = mgr.watch(target);
    writeFileSync(join(dir, 'while-live.md'), 'noted while live');
    await waitFor(() => personal('self').listEntries().length === 1);
    stop();
    writeFileSync(join(dir, 'after-stop.md'), 'noted after stop');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(
      personal('self')
        .listEntries()
        .map((e) => e.title)
    ).toEqual(['noted while live']);
  });

  it('sweeps at boot: ingests leftovers with no live run and deletes closed lineages', async () => {
    const { dir } = mgr.prepare(target);
    writeFileSync(join(dir, 'late.md'), 'late note');
    expect(
      await mgr.sweep({ targetOf: () => target, isOpen: () => false })
    ).toEqual({ scanned: 1, closed: 1 });
    expect(existsSync(dir)).toBe(false);
    expect(
      personal('self')
        .listEntries()
        .map((e) => e.title)
    ).toContain('late note');
    expect(shared.manifest(lineage)).toEqual([]);
    expect(shared.meta(`export-index:${lineage}`)).toBeNull();
  });

  it('scans an open lineage in a sweep and keeps its directory', async () => {
    const { dir } = mgr.prepare(target);
    writeFileSync(join(dir, 'kept.md'), 'kept note');
    expect(
      await mgr.sweep({ targetOf: () => target, isOpen: () => true })
    ).toEqual({ scanned: 1, closed: 0 });
    expect(existsSync(join(dir, 'MEMORY.md'))).toBe(true);
    expect(
      personal('self')
        .listEntries()
        .map((e) => e.title)
    ).toEqual(['kept note']);
  });
});

// Messaging with no gate open, enough for recover()'s stray-gate check.
function noOpenGates() {
  const engine = new Proxy(
    {},
    {
      get: (_, prop) => {
        if (prop === 'openBlocking') return () => [];
        throw new Error('this test raises no gates');
      },
    }
  ) as DeliveryEngine;
  return { engine, gates: new GateHandlers() };
}

describe('openMemory and Claude export directories', () => {
  it('ingests leftovers at boot and deletes the directories of closed lineages', async () => {
    const at = new Date().toISOString();
    const run = (id: string, over: Partial<RunMeta>): RunMeta =>
      ({
        id,
        taskId: TASK,
        state: 'finished',
        operator: 'human:wyat',
        memoryLineage: id,
        createdAt: at,
        updatedAt: at,
        ...over,
      }) as RunMeta;
    const runs = [
      run('r-000001', { reviewedAt: at }),
      run('r-000002', { taskId: 't-000002' }),
    ];
    for (const id of ['r-000001', 'r-000002']) {
      mkdirSync(claudeMemoryDir(root, id), { recursive: true });
      writeFileSync(join(claudeMemoryDir(root, id), 'note.md'), `from ${id}`);
    }
    const memory = openMemory({
      rootDir: root,
      store: TaskStore.init(root),
      events: new EventBus(),
      ledgerStore: new LedgerStore(root),
      ...quietDaemon(root, { list: () => runs }),
      messaging: noOpenGates(),
      dbPath: join(home, 'boot-memory.db'),
    });
    try {
      await memory.recover();
      const self = memory.personal.personal('self');
      expect(
        self
          .listEntries()
          .map((e) => [e.title, e.author])
          .sort(([a], [b]) => a.localeCompare(b))
      ).toEqual([
        ['from r-000001', 'run:r-000001'],
        ['from r-000002', 'run:r-000002'],
      ]);
      // Reviewed: closed and deleted. Unreviewed and recent: kept for a resume.
      expect(existsSync(claudeMemoryDir(root, 'r-000001'))).toBe(false);
      expect(existsSync(claudeMemoryDir(root, 'r-000002'))).toBe(true);
    } finally {
      memory.close();
    }
  });
});
