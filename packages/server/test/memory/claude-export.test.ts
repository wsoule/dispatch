import { DEFAULT_MEMORY, TaskStore } from '@dispatch/core';
import {
  createMemoryIds,
  insertFresh,
  MemoryError,
  newMemoryEntry,
  parsedHash,
  parseMemoryFile,
} from '@dispatch/memory';
import type {
  MemoryEngine,
  MemoryEntry,
  MemoryStore,
  Principal,
  SqliteMemoryStore,
} from '@dispatch/memory';
import type { DeliveryEngine } from '@dispatch/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { EventBus } from '../../src/events.js';
import { LedgerStore } from '../../src/ledger.js';
import {
  ClaudeExportManager,
  overseerLineageOpen,
  runLineageOpen,
} from '../../src/memory/claudeExport.js';
import type {
  ClaudeExportDeps,
  ExportTarget,
} from '../../src/memory/claudeExport.js';
import { PersonalStores } from '../../src/memory/personalStores.js';
import { openMemory } from '../../src/memory/service.js';
import { GateHandlers } from '../../src/messaging/gates.js';
import {
  claudeMemoryDir,
  claudeMemoryRoot,
} from '../../src/orchestrator/paths.js';
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
let host: TestMemoryHost;
let engine: MemoryEngine;
let shared: SqliteMemoryStore;
let projectKey: string;
let mgr: ClaudeExportManager;
const managers: ClaudeExportManager[] = [];

const personal = (identity: string) => personalStores.personal(identity);

// `obj` with some methods replaced, the way a busy database or a refusing engine behaves.
function withOverrides<T extends object>(obj: T, over: Partial<T>): T {
  return new Proxy(obj, {
    get: (t, prop) => {
      if (Object.hasOwn(over, prop)) return over[prop as keyof T];
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== 'function') return value;
      return (value as (...args: unknown[]) => unknown).bind(t);
    },
  });
}

// Another manager over the same stores: a restarted daemon, or one with a dependency swapped.
function managerWith(
  over: Partial<ClaudeExportDeps> = {}
): ClaudeExportManager {
  const m = new ClaudeExportManager({
    rootDir: root,
    engine,
    shared,
    personalStore: () => personal('self'),
    config: () => DEFAULT_MEMORY,
    pollMs: 10,
    ...over,
  });
  managers.push(m);
  return m;
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'claude-export-')));
  process.env.DISPATCH_HOME = home;
  root = join(home, 'project');
  mkdirSync(root);
  personalStores = new PersonalStores({ dir: join(home, 'personal') });
  host = new TestMemoryHost();
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
  engine = t.engine;
  projectKey = host.projectKey();
  mgr = managerWith();
});

afterEach(() => {
  for (const m of managers.splice(0)) m.close();
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

  it('reads nothing as deleted when the lineage directory is gone', async () => {
    const team = saveTeam('keep the team lesson');
    const mine = savePersonal('keep my fact');
    const { dir } = mgr.prepare(target);
    rmSync(dir, { recursive: true, force: true });
    expect(await mgr.ingest(target)).toMatchObject({ proposed: 0, retired: 0 });
    expect(shared.getEntry(team.id)?.status).toBe('active');
    expect(personal('self').getEntry(mine.id)?.status).toBe('active');
    expect(shared.listProposals()).toEqual([]);
    expect(shared.manifest(lineage)).toHaveLength(2);
  });

  // Root reads any directory, so only another user can see this refusal.
  it.skipIf(process.getuid?.() === 0)(
    'reads nothing as deleted when the lineage directory will not list',
    async () => {
      const mine = savePersonal('keep my fact');
      const { dir } = mgr.prepare(target);
      chmodSync(dir, 0o000);
      try {
        expect(await mgr.ingest(target)).toMatchObject({
          retired: 0,
          problems: ['.: unreadable'],
        });
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(personal('self').getEntry(mine.id)?.status).toBe('active');
    }
  );

  it('closes a lineage whose directory is gone without reading its manifest as deletions', async () => {
    saveTeam('keep the team lesson');
    const mine = savePersonal('keep my fact');
    const { dir } = mgr.prepare(target);
    rmSync(dir, { recursive: true, force: true });
    expect(
      await mgr.sweep({ targetOf: () => target, isOpen: () => false })
    ).toEqual({ scanned: 0, closed: 1 });
    expect(personal('self').getEntry(mine.id)?.status).toBe('active');
    expect(shared.listProposals()).toEqual([]);
    expect(shared.manifest(lineage)).toEqual([]);
  });

  it('leaves nothing readable as deleted when a close fails before its manifest clears', async () => {
    const team = saveTeam('keep the team lesson');
    const mine = savePersonal('keep my fact');
    const { dir } = mgr.prepare(target);
    const busy = managerWith({
      shared: withOverrides(shared, {
        replaceManifest: () => {
          throw new Error('database is locked');
        },
      }),
    });
    await expect(busy.closeLineage(lineage, target)).rejects.toThrow(
      'database is locked'
    );
    expect(existsSync(dir)).toBe(false);
    expect(await mgr.ingest(target)).toMatchObject({ proposed: 0, retired: 0 });
    expect(shared.getEntry(team.id)?.status).toBe('active');
    expect(personal('self').getEntry(mine.id)?.status).toBe('active');
    expect(shared.listProposals()).toEqual([]);
    // The next sweep finishes the close and leaves nothing behind.
    expect(
      await mgr.sweep({ targetOf: () => target, isOpen: () => false })
    ).toEqual({ scanned: 0, closed: 1 });
    expect(shared.manifest(lineage)).toEqual([]);
    expect(readdirSync(claudeMemoryRoot(root))).toEqual([]);
  });

  it('never shows exported files beside a manifest that does not name them', () => {
    saveTeam('pnpm 11 ignores onlyBuiltDependencies');
    const dir = claudeMemoryDir(root, lineage);
    // What a crash just before each manifest write would leave at the lineage path.
    const atManifestWrite: (string[] | null)[] = [];
    const watched = managerWith({
      shared: withOverrides(shared, {
        replaceManifest: (name, rows) => {
          atManifestWrite.push(existsSync(dir) ? readdirSync(dir) : null);
          shared.replaceManifest(name, rows);
        },
      }),
    });
    watched.prepare(target);
    watched.prepare(target);
    expect(atManifestWrite).toEqual([null, null]);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('keeps a lineage a resume reopened while its close was waiting on the final scan', async () => {
    const team = saveTeam('retire me later');
    const { dir } = mgr.prepare(target);
    rmSync(join(dir, `${team.id}.md`));
    // The final scan proposes a retire whose gate this test holds open.
    const release: (() => void)[] = [];
    host.raise = (p) =>
      new Promise((resolve) => release.push(() => resolve(`msg-${p.id}`)));
    const closing = mgr.closeLineage(lineage, target);
    await waitFor(() => release.length === 1);
    mgr.prepare(target);
    for (const r of release) r();
    await closing;
    expect(existsSync(join(dir, 'MEMORY.md'))).toBe(true);
    expect(shared.manifest(lineage).map((r) => r.memoryId)).toEqual([team.id]);
    expect(shared.meta(`export-index:${lineage}`)).not.toBeNull();
  });

  it('remembers recorded refusals across a restart: none is recorded twice, and a refused new file is not retried', async () => {
    const { dir } = mgr.prepare(target);
    symlinkSync('/etc/hosts', join(dir, 'link.md'));
    writeFileSync(join(dir, 'new.md'), 'refused once');
    const limited = managerWith({
      engine: withOverrides(engine, {
        save: () => Promise.reject(new MemoryError('limited', 'slow down')),
      }),
    });
    expect((await limited.ingest(target)).problems.sort()).toEqual([
      'link.md: symlink',
      'new.md: limited',
    ]);
    limited.close();
    const restarted = managerWith();
    expect(await restarted.ingest(target)).toMatchObject({
      saved: 0,
      problems: [],
    });
    expect(personal('self').ingestProblems(10)).toHaveLength(2);
    expect(personal('self').listEntries()).toEqual([]);
  });

  it('records a refusal on a later scan when recording it failed', async () => {
    const { dir } = mgr.prepare(target);
    symlinkSync('/etc/hosts', join(dir, 'link.md'));
    const self = personal('self');
    let busy = true;
    const flaky = managerWith({
      personalStore: () =>
        withOverrides<MemoryStore>(self, {
          transaction: <T>(fn: () => T): T => {
            if (busy) {
              busy = false;
              throw new Error('database is locked');
            }
            return self.transaction(fn);
          },
        }),
    });
    await expect(flaky.ingest(target)).rejects.toThrow('database is locked');
    expect((await flaky.ingest(target)).problems).toEqual(['link.md: symlink']);
    expect(self.ingestProblems(10)).toHaveLength(1);
  });

  it('keeps a too-large file’s first 8 KiB whole, cut on a character boundary', async () => {
    const { dir } = mgr.prepare(target);
    writeFileSync(join(dir, 'wide.md'), `x${'é'.repeat(35_000)}`);
    expect((await mgr.ingest(target)).problems).toEqual(['wide.md: too-large']);
    const self = personal('self');
    const [wide] = self.ingestProblems(10);
    expect(self.takeIngestProblem(wide.id)?.content).toBe(
      `x${'é'.repeat(4095)}`
    );
  });
});

describe('when a lineage closes', () => {
  const NOW = Date.parse('2026-09-28T12:00:00.000Z');
  const DAY_MS = 86_400_000;
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const run = (id: string, over: Partial<RunMeta> = {}): RunMeta =>
    ({
      id,
      taskId: TASK,
      state: 'finished',
      operator: 'human:wyat',
      memoryLineage: 'r-000001',
      createdAt: ago(2 * DAY_MS),
      updatedAt: ago(DAY_MS),
      ...over,
    }) as RunMeta;
  const notLive = () => false;

  it('keeps a run lineage open while any of its runs is live, reviewed or not', () => {
    const runs = [run('r-000001', { reviewedAt: ago(DAY_MS) })];
    expect(
      runLineageOpen(runs, 'r-000001', (id) => id === 'r-000001', NOW)
    ).toBe(true);
    expect(runLineageOpen(runs, 'r-000001', notLive, NOW)).toBe(false);
    expect(runLineageOpen([], 'r-000001', notLive, NOW)).toBe(false);
  });

  it('closes a run lineage once a newer execute run of its task starts another lineage', () => {
    const mine = run('r-000001');
    const newer = { createdAt: ago(DAY_MS / 2), memoryLineage: 'r-000002' };
    expect(runLineageOpen([mine], 'r-000001', notLive, NOW)).toBe(true);
    expect(
      runLineageOpen([mine, run('r-000002', newer)], 'r-000001', notLive, NOW)
    ).toBe(false);
    // A review run, another task's run, or an older run replaces nothing.
    for (const other of [
      run('r-000002', { ...newer, kind: 'review' }),
      run('r-000002', { ...newer, taskId: 't-other1' }),
      run('r-000002', { ...newer, createdAt: ago(3 * DAY_MS) }),
    ])
      expect(runLineageOpen([mine, other], 'r-000001', notLive, NOW)).toBe(
        true
      );
  });

  it('closes a run lineage a week after its last run moved', () => {
    const at = (days: number) => [
      run('r-000001', {
        createdAt: ago(10 * DAY_MS),
        updatedAt: ago(days * DAY_MS),
      }),
    ];
    expect(runLineageOpen(at(6.9), 'r-000001', notLive, NOW)).toBe(true);
    expect(runLineageOpen(at(7), 'r-000001', notLive, NOW)).toBe(false);
  });

  it('closes an overseer conversation’s directory a day after its last write', () => {
    const dir = claudeMemoryDir(root, 'o-conversation1');
    expect(overseerLineageOpen(dir, NOW)).toBe(false);
    mkdirSync(dir, { recursive: true });
    const touch = (ms: number) =>
      utimesSync(dir, (NOW - ms) / 1000, (NOW - ms) / 1000);
    touch(23 * 3_600_000);
    expect(overseerLineageOpen(dir, NOW)).toBe(true);
    touch(24 * 3_600_000);
    expect(overseerLineageOpen(dir, NOW)).toBe(false);
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
  return { engine, gates: new GateHandlers(), store: { getAgent: () => null } };
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

  it('sweeps the directories again on its interval, not only at boot', async () => {
    const at = new Date().toISOString();
    const reviewed = {
      id: 'r-000001',
      taskId: TASK,
      state: 'finished',
      operator: 'human:wyat',
      memoryLineage: 'r-000001',
      createdAt: at,
      updatedAt: at,
      reviewedAt: at,
    } as RunMeta;
    const dir = claudeMemoryDir(root, 'r-000001');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'note.md'), 'from r-000001');
    const memory = openMemory({
      rootDir: root,
      store: TaskStore.init(root),
      events: new EventBus(),
      ledgerStore: new LedgerStore(root),
      ...quietDaemon(root, { list: () => [reviewed] }),
      dbPath: join(home, 'interval-memory.db'),
      exportSweepMs: 20,
    });
    try {
      await waitFor(() => !existsSync(dir));
      expect(
        memory.personal
          .personal('self')
          .listEntries()
          .map((e) => e.title)
      ).toEqual(['from r-000001']);
    } finally {
      memory.close();
    }
  });
});

describe('overflow into docs (docs Task 18)', () => {
  const DOC_ID = 'doc-01K3Z9R0000000000000000000';
  const longNote = (type: string) =>
    `---\ndescription: a long ${type} note\nmetadata:\n  type: ${type}\n---\n${'line of text\n'.repeat(1000)}`;
  const calls: {
    entryId: string;
    human: string;
    identity: string;
    author: string;
    title: string;
    body: string;
  }[] = [];
  const docsOverflow = {
    overflow: (input: (typeof calls)[number]) => {
      calls.push(input);
      return DOC_ID;
    },
  };
  let overflowMgr: ClaudeExportManager;
  beforeEach(() => {
    calls.length = 0;
    overflowMgr = managerWith({ docsOverflow, projectKey });
  });

  it('overflows a project-keyed personal note into a personal doc and refs it by id and project', async () => {
    const { dir } = overflowMgr.prepare(target);
    writeFileSync(join(dir, 'long.md'), longNote('project'));
    expect((await overflowMgr.ingest(target)).saved).toBe(1);
    const [entry] = personal('self').listEntries();
    expect(entry.projectKey).toBe(projectKey);
    expect(entry.body).toMatch(
      new RegExp(
        `\\[truncated by Dispatch: \\d+ bytes; full text in doc ${DOC_ID} of project ${projectKey}\\]$`
      )
    );
    expect(entry.refs).toContainEqual({ type: 'doc', id: DOC_ID });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      entryId: entry.id,
      human: 'human:wyat',
      identity: 'self',
      author: 'run:r-9f2c01',
      title: 'a long project note',
    });
    expect(calls[0].body).toBe('line of text\n'.repeat(1000).trimEnd());
    // The manifest names the entry's revision after the overflow edit.
    const [row] = shared.manifest(lineage);
    expect(row.rev).toBe(entry.rev);
  });

  it("writes a run's growth of a human's own note as the run's text, not the human's", async () => {
    const now = new Date().toISOString();
    const mine = insertFresh(
      personal('self'),
      ids,
      Date.parse(now),
      (id) =>
        newMemoryEntry(
          {
            scope: 'personal',
            kind: 'fact',
            title: 'my short note',
            body: 'short',
            projectKey,
            author: 'human:wyat',
            trust: 'human',
          },
          id,
          now
        ),
      'human:wyat',
      'save'
    );
    const { dir } = overflowMgr.prepare(target);
    const file = readdirSync(dir).find(
      (f) => f !== 'MEMORY.md' && f.endsWith('.md')
    );
    if (file === undefined) throw new Error('no exported file');
    const path = join(dir, file);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        /\nshort\n?$/,
        `\n${'line of text\n'.repeat(1000)}`
      )
    );
    await overflowMgr.ingest(target);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ entryId: mine.id, author: RUN.address });
  });

  it('truncates a cross-project personal note plainly and never calls docs', async () => {
    const { dir } = overflowMgr.prepare(target);
    writeFileSync(join(dir, 'long.md'), longNote('feedback'));
    await overflowMgr.ingest(target);
    const [entry] = personal('self').listEntries();
    expect(entry.projectKey).toBeNull();
    expect(entry.body).toMatch(
      /\[truncated by Dispatch: \d+ bytes; long-form belongs in Docs\]$/
    );
    expect(entry.refs.some((r) => r.type === 'doc')).toBe(false);
    expect(calls).toEqual([]);
  });

  it("truncates a team entry's supersede proposal plainly: a shared entry never points at a personal doc", async () => {
    const team = saveTeam('team lesson');
    const { dir } = overflowMgr.prepare(target);
    const file = join(dir, `${team.id}.md`);
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        /\nbody of team lesson\n/,
        `\n${'line of text\n'.repeat(1000)}`
      )
    );
    expect(await overflowMgr.ingest(target)).toMatchObject({ proposed: 1 });
    const [proposal] = shared.listProposals({ states: ['open'] });
    expect(proposal.action).toBe('supersede');
    expect(proposal.content?.body).toMatch(/long-form belongs in Docs\]$/);
    expect(JSON.stringify(proposal)).not.toContain(DOC_ID);
    expect(calls).toEqual([]);
  });

  it('keeps a long personal note plain without the docs port', async () => {
    const { dir } = mgr.prepare(target);
    writeFileSync(join(dir, 'long.md'), longNote('project'));
    await mgr.ingest(target);
    expect(personal('self').listEntries()[0].body).toMatch(
      /long-form belongs in Docs\]$/
    );
  });
});
