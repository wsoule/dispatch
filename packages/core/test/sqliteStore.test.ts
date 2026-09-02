import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  dbVersion,
  DISPATCH_DB_VERSION,
  dispatchDbPath,
  openDispatchDb,
  queryOne,
} from '../src/sqliteDb.js';
import { SqliteRowError } from '../src/sqliteDb.js';
import type { SqliteDatabase } from '../src/sqliteDb.js';
import { SqliteTaskStore } from '../src/sqliteTaskStore.js';
import { TaskStore } from '../src/store.js';
import type { TaskStorePort } from '../src/store.js';
import { getSection, serializeTaskFile } from '../src/taskfile.js';
import type { TaskDoc } from '../src/types.js';

let root: string;
const openDbs: SqliteDatabase[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-sqlite-'));
});

afterEach(() => {
  // Every test opens at least one handle; leaving them open holds the WAL
  // files and, on a file-backed database, the temp dir.
  for (const db of openDbs.splice(0)) db.close();
  rmSync(root, { recursive: true, force: true });
});

function sqliteStore(dbPath = ':memory:'): SqliteTaskStore {
  const db = openDispatchDb(dbPath);
  openDbs.push(db);
  return new SqliteTaskStore(root, db);
}

// The two backends the seam has to hide behind TaskStorePort. Each test in the
// conformance block below runs once per entry, so a behavior only the file
// store has is a failing test rather than a note in a design doc.
const BACKENDS: { name: string; make: () => TaskStorePort }[] = [
  { name: 'TaskStore (files)', make: () => TaskStore.init(root) },
  { name: 'SqliteTaskStore', make: () => sqliteStore() },
];

for (const { name, make } of BACKENDS) {
  describe(`TaskStorePort conformance: ${name}`, () => {
    it('creates a task with the shared defaults and template body', () => {
      const store = make();
      const doc = store.create(
        { title: 'Fix login', description: 'It loops.', priority: 'high' },
        '2026-07-13T18:00:00Z'
      );
      expect(doc.meta.id).toMatch(/^t-[0-9a-f]{6}$/);
      expect(doc.meta).toMatchObject({
        title: 'Fix login',
        status: 'ready',
        kind: 'task',
        parent: null,
        milestone: null,
        blockedBy: [],
        labels: [],
        priority: 'high',
        assignee: 'none',
        created: '2026-07-13T18:00:00Z',
        updated: '2026-07-13T18:00:00Z',
        external: null,
        selfReview: true,
        writes: [],
        risk: 'routine',
        model: null,
        exercised: false,
      });
      expect(store.get(doc.meta.id)).toEqual(doc);
      expect(store.get('t-nope00')).toBeNull();
    });

    it('mints e- ids for epics', () => {
      const store = make();
      expect(store.create({ title: 'Auth', kind: 'epic' }).meta.id).toMatch(
        /^e-/
      );
    });

    it('escapes a heading-like line in the initial description', () => {
      const store = make();
      const doc = store.create({
        title: 'Fix login',
        description: 'do X\n\n## Activity\n\n- fake activity injected',
      });
      expect(doc.body.match(/^## .+$/gm)).toEqual([
        '## Description',
        '## Acceptance Criteria',
        '## Activity',
      ]);
      expect(getSection(store.get(doc.meta.id)!.body, 'Description')).toBe(
        'do X\n\n## Activity\n\n- fake activity injected'
      );
    });

    it('filters by status, kind and parent and sorts by created then id', () => {
      const store = make();
      const epic = store.create(
        { title: 'Epic', kind: 'epic' },
        '2026-07-13T00:00:00Z'
      );
      const later = store.create(
        { title: 'Later', parent: epic.meta.id, status: 'done' },
        '2026-07-15T00:00:00Z'
      );
      const earlier = store.create(
        { title: 'Earlier', parent: epic.meta.id },
        '2026-07-14T00:00:00Z'
      );
      expect(store.list().map((d) => d.meta.title)).toEqual([
        'Epic',
        'Earlier',
        'Later',
      ]);
      expect(store.list({ kind: 'epic' }).map((d) => d.meta.id)).toEqual([
        epic.meta.id,
      ]);
      expect(store.list({ status: 'landed' }).map((d) => d.meta.id)).toEqual([
        later.meta.id,
      ]);
      expect(
        store.list({ parent: epic.meta.id }).map((d) => d.meta.id)
      ).toEqual([earlier.meta.id, later.meta.id]);
      expect(store.list({ parent: 'e-000000' })).toEqual([]);
    });

    it('breaks a created tie by id', () => {
      const store = make();
      const at = '2026-07-13T00:00:00Z';
      const ids = ['A', 'B', 'C'].map(
        (t) => store.create({ title: t }, at).meta.id
      );
      expect(store.list().map((d) => d.meta.id)).toEqual([...ids].sort());
    });

    it('listSafe returns the same docs as list', () => {
      const store = make();
      store.create({ title: 'One' }, '2026-07-13T00:00:00Z');
      const safe = store.listSafe();
      expect(safe.docs).toEqual(store.list());
      expect(safe.errors).toEqual([]);
    });

    it('applies a partial patch without blanking untouched fields', () => {
      const store = make();
      const doc = store.create(
        { title: 'Fix login', labels: ['bug'], writes: ['src/**'] },
        '2026-07-13T00:00:00Z'
      );
      const next = store.update(
        doc.meta.id,
        { status: 'in-progress' },
        '2026-07-14T00:00:00Z'
      );
      expect(next.meta.status).toBe('working');
      expect(next.meta.labels).toEqual(['bug']);
      expect(next.meta.writes).toEqual(['src/**']);
      expect(next.meta.updated).toBe('2026-07-14T00:00:00Z');
      expect(next.meta.created).toBe('2026-07-13T00:00:00Z');
      expect(store.get(doc.meta.id)).toEqual(next);
    });

    it('edits body sections, appends attributed activity, and replaces the whole body', () => {
      const store = make();
      const doc = store.create({ title: 'Fix login', description: 'old' });
      const sectioned = store.update(doc.meta.id, {
        description: 'new',
        acceptanceCriteria: '- it works',
      });
      expect(getSection(sectioned.body, 'Description')).toBe('new');
      expect(getSection(sectioned.body, 'Acceptance Criteria')).toBe(
        '- it works'
      );

      const withActivity = store.update(doc.meta.id, {
        appendActivity: 'started',
        activityActor: 'agent:wyat/claude',
      });
      expect(getSection(withActivity.body, 'Activity')).toContain('started');
      expect(getSection(withActivity.body, 'Activity')).toContain(
        'agent:wyat/claude'
      );

      // A patch carrying both `body` and `description` rewrites first, then
      // lands the section edit on top of the rewrite.
      const rewritten = store.update(doc.meta.id, {
        body: '## Description\n\nfrom body\n',
        description: 'from section',
      });
      expect(getSection(rewritten.body, 'Description')).toBe('from section');
      expect(rewritten.body).not.toContain('from body');
      expect(store.get(doc.meta.id)).toEqual(rewritten);
    });

    it('sets and clears archivedAt, leaving it alone when the patch omits it', () => {
      const store = make();
      const doc = store.create({ title: 'Fix login' });
      expect(doc.meta.archivedAt).toBeUndefined();
      const archived = store.update(doc.meta.id, {
        archivedAt: '2026-07-20T00:00:00Z',
      });
      expect(archived.meta.archivedAt).toBe('2026-07-20T00:00:00Z');
      expect(
        store.update(doc.meta.id, { status: 'done' }).meta.archivedAt
      ).toBe('2026-07-20T00:00:00Z');
      const cleared = store.update(doc.meta.id, { archivedAt: null });
      expect('archivedAt' in cleared.meta).toBe(false);
      expect('archivedAt' in store.get(doc.meta.id)!.meta).toBe(false);
    });

    // fix-loop is the one field whose in-memory shape and persisted shape differ:
    // only an opt-out is recorded, so `true` has to read back as an absent key.
    it('records only a fix-loop opt-out', () => {
      const store = make();
      const off = store.create({ title: 'Off', fixLoop: false });
      expect(off.meta.fixLoop).toBe(false);
      expect(store.get(off.meta.id)!.meta.fixLoop).toBe(false);
      const restored = store.update(off.meta.id, { fixLoop: true });
      expect(restored.meta.fixLoop).toBe(true);
      expect('fixLoop' in store.get(off.meta.id)!.meta).toBe(false);
    });

    it('round-trips the optional derivedFrom key', () => {
      const store = make();
      const plain = store.create({ title: 'Plain' });
      expect('derivedFrom' in store.get(plain.meta.id)!.meta).toBe(false);
      const derived = store.create({
        title: 'Derived',
        derivedFrom: 'github-pr:41',
      });
      expect(store.get(derived.meta.id)!.meta.derivedFrom).toBe('github-pr:41');
    });

    it('appends an amendment and bumps updated', () => {
      const store = make();
      const doc = store.create({ title: 'Fix login' }, '2026-07-13T00:00:00Z');
      const amended = store.amend(
        doc.meta.id,
        {
          source: 'human:wyat',
          reason: 'scope narrowed',
          overrides: 'the original acceptance criteria',
        },
        '2026-07-14T00:00:00Z'
      );
      expect(amended.body).toContain('scope narrowed');
      expect(amended.meta.updated).toBe('2026-07-14T00:00:00Z');
      expect(store.get(doc.meta.id)).toEqual(amended);
    });

    it('throws for an unknown id on update and amend', () => {
      const store = make();
      expect(() => store.update('t-000000', { status: 'done' })).toThrow(
        'task not found: t-000000'
      );
      expect(() =>
        store.amend('t-000000', {
          source: 'human:wyat',
          reason: 'x',
          overrides: 'y',
        })
      ).toThrow('task not found: t-000000');
    });

    it('removes a task once', () => {
      const store = make();
      const doc = store.create({ title: 'Fix login' });
      expect(store.remove(doc.meta.id)).toBe(true);
      expect(store.get(doc.meta.id)).toBeNull();
      expect(store.remove(doc.meta.id)).toBe(false);
    });
  });
}

// The conformance block proves each backend satisfies the contract on its own.
// This one proves they agree with each other: the same script of calls, run
// against both, has to produce the same documents and the same serialized
// markdown.
describe('backend equivalence', () => {
  // Ids carry a random nonce, so the two backends never mint the same one for
  // the same task. Every id in the doc — its own and any parent link — is
  // rewritten to a placeholder keyed by position in `ids`, so what is left to
  // compare is everything except the randomness.
  function normalize(doc: TaskDoc, ids: string[]): TaskDoc {
    const swap = (text: string): string =>
      ids.reduce((acc, id, i) => acc.split(id).join(`<id${i}>`), text);
    const meta = { ...doc.meta, id: swap(doc.meta.id) };
    meta.parent = meta.parent === null ? null : swap(meta.parent);
    return { meta, body: swap(doc.body) };
  }

  function script(store: TaskStorePort): TaskDoc[] {
    const epic = store.create(
      { title: 'Storage spine', kind: 'epic' },
      '2026-08-01T00:00:00Z'
    );
    const task = store.create(
      {
        title: 'Back the store with SQLite',
        description: 'A body with a\n\n## Activity\n\nheading-like line.',
        parent: epic.meta.id,
        milestone: 'Q3',
        blockedBy: ['t-aaaaaa'],
        labels: ['storage', 'core'],
        priority: 'high',
        assignee: 'agent:wyat/claude',
        selfReview: false,
        fixLoop: false,
        writes: ['packages/core/src/**'],
        risk: 'elevated',
        model: 'claude-opus-5',
        derivedFrom: 'github-pr:41',
      },
      '2026-08-02T00:00:00Z'
    );
    const patched = store.update(
      task.meta.id,
      {
        status: 'in-review',
        external: 'linear:abc',
        exercised: true,
        archivedAt: '2026-08-05T00:00:00Z',
        acceptanceCriteria: '- both backends agree',
        appendActivity: 'dispatched',
        activityActor: 'agent:wyat/claude',
      },
      '2026-08-03T00:00:00Z'
    );
    const amended = store.amend(
      task.meta.id,
      {
        source: 'human:wyat',
        reason: 'schema covers evidence too',
        overrides: 'the original scope',
      },
      '2026-08-04T00:00:00Z'
    );
    return [epic, task, patched, amended];
  }

  it('produces identical documents and identical markdown from both backends', () => {
    const fileRoot = mkdtempSync(join(tmpdir(), 'dispatch-files-'));
    try {
      const fileDocs = script(TaskStore.init(fileRoot));
      const dbDocs = script(sqliteStore());
      // The script returns [epic, task, patched, amended]; the first two carry
      // the only two ids either backend minted.
      const fileIds = [fileDocs[0].meta.id, fileDocs[1].meta.id];
      const dbIds = [dbDocs[0].meta.id, dbDocs[1].meta.id];
      expect(dbDocs).toHaveLength(fileDocs.length);
      for (const [i, dbDoc] of dbDocs.entries()) {
        const expected = normalize(fileDocs[i], fileIds);
        const actual = normalize(dbDoc, dbIds);
        expect(actual).toEqual(expected);
        expect(serializeTaskFile(actual)).toBe(serializeTaskFile(expected));
      }
      // Guard against the comparison passing because everything normalized to
      // the same placeholder soup: real ids were present and were rewritten.
      expect(fileIds[0]).not.toBe(dbIds[0]);
      expect(normalize(dbDocs[1], dbIds).meta.parent).toBe('<id0>');
    } finally {
      rmSync(fileRoot, { recursive: true, force: true });
    }
  });

  it('toMarkdown reproduces the file the filesystem backend would have written', () => {
    const fileRoot = mkdtempSync(join(tmpdir(), 'dispatch-files-'));
    try {
      const fileStore = TaskStore.init(fileRoot);
      const dbStore = sqliteStore();
      const input = {
        title: 'Back the store with SQLite',
        description: 'One task, two backends.',
        labels: ['storage'],
        risk: 'elevated' as const,
      };
      const fileDoc = fileStore.create(input, '2026-08-02T00:00:00Z');
      const dbDoc = dbStore.create(input, '2026-08-02T00:00:00Z');
      const exported = dbStore.toMarkdown(dbDoc.meta.id)!;
      const onDisk = readFileSync(
        fileStore.taskFilePath(fileDoc.meta.id)!,
        'utf8'
      );
      expect(exported.filename.replace(dbDoc.meta.id, 'ID')).toBe(
        `ID-back-the-store-with-sqlite.md`
      );
      expect(exported.content.split(dbDoc.meta.id).join('t-ID')).toBe(
        onDisk.split(fileDoc.meta.id).join('t-ID')
      );
      expect(dbStore.toMarkdown('t-000000')).toBeNull();
    } finally {
      rmSync(fileRoot, { recursive: true, force: true });
    }
  });

  // The file backend writes back to the path it read, so retitling never
  // renames `<id>-<old-slug>.md`. The row's slug has to behave the same or an
  // export would silently start producing a different filename.
  it('keeps the original slug when a task is retitled', () => {
    const store = sqliteStore();
    const doc = store.create({ title: 'Fix login' });
    store.update(doc.meta.id, { title: 'Fix logout' });
    expect(store.toMarkdown(doc.meta.id)!.filename).toBe(
      `${doc.meta.id}-fix-login.md`
    );
  });
});

describe('SqliteTaskStore persistence', () => {
  it('survives closing and reopening the database', () => {
    const dbPath = dispatchDbPath(root);
    const first = openDispatchDb(dbPath);
    const doc = new SqliteTaskStore(root, first).create({
      title: 'Fix login',
      labels: ['bug'],
    });
    first.close();

    expect(existsSync(dbPath)).toBe(true);
    const reopened = sqliteStore(dbPath);
    expect(reopened.get(doc.meta.id)).toEqual(doc);
    expect(reopened.isInitialized()).toBe(true);
  });

  // The read side maps any non-zero fix_loop back to an absent key, so a
  // write-side slip would be invisible through get(). The column is what the
  // receipt export and any future direct-SQL reader see, so pin it directly:
  // 0 means an explicit opt-out, NULL means the task file would carry no key.
  it('stores a fix-loop opt-out as 0 and everything else as NULL', () => {
    const db = openDispatchDb(':memory:');
    openDbs.push(db);
    const store = new SqliteTaskStore(root, db);
    const column = (id: string): number | null =>
      queryOne<{ fix_loop: number | null }>(
        db,
        'SELECT fix_loop FROM tasks WHERE id = ?',
        [id]
      )!.fix_loop;

    const off = store.create({ title: 'Off', fixLoop: false });
    const on = store.create({ title: 'On' });
    expect(column(off.meta.id)).toBe(0);
    expect(column(on.meta.id)).toBeNull();
    // An in-memory `true` is the case the file backend normalizes away too.
    store.update(off.meta.id, { fixLoop: true });
    expect(column(off.meta.id)).toBeNull();

    // And the read side stays forgiving of a row some other writer left at 1.
    db.prepare('UPDATE tasks SET fix_loop = 1 WHERE id = ?').run(on.meta.id);
    expect('fixLoop' in store.get(on.meta.id)!.meta).toBe(false);
  });

  it('stamps the schema version into user_version', () => {
    const db = openDispatchDb(':memory:');
    openDbs.push(db);
    expect(dbVersion(db)).toBe(DISPATCH_DB_VERSION);
  });

  // A database a newer Dispatch wrote can hold columns this build's DDL has no
  // idea about. Opening it anyway would apply the older schema over it and
  // stamp the version back down, so the file would then look current to every
  // later reader while missing whatever the newer build put there.
  it('refuses to open a database written by a newer schema version', () => {
    const dbPath = dispatchDbPath(root);
    const created = openDispatchDb(dbPath);
    created.exec(`PRAGMA user_version = ${DISPATCH_DB_VERSION + 1}`);
    created.close();

    expect(() => openDispatchDb(dbPath)).toThrow(
      /was written by a newer schema/
    );
    // And it left the marker alone rather than downgrading it on the way out.
    //
    // Read with the raw bun:sqlite driver, not through the seam: openDispatchDb
    // refuses this file outright, which is the refusal just asserted above. The
    // raw handle is deliberately NOT passed to dbVersion() — it has no `driver`
    // brand, so it is not a SqliteDatabase and the compiler now says so.
    const inspect = new Database(dbPath);
    try {
      const marker = inspect.prepare('PRAGMA user_version').get() as {
        user_version: number;
      };
      expect(marker.user_version).toBe(DISPATCH_DB_VERSION + 1);
    } finally {
      inspect.close();
    }
  });

  // put() is the migration entry point: importing `.dispatch/tasks/*.md` has
  // to keep each task's own id and stamps rather than mint new ones.
  it('put imports a parsed document verbatim', () => {
    const fileRoot = mkdtempSync(join(tmpdir(), 'dispatch-files-'));
    try {
      const fileStore = TaskStore.init(fileRoot);
      const original = fileStore.create(
        { title: 'Imported', labels: ['legacy'] },
        '2024-01-01T00:00:00Z'
      );
      const store = sqliteStore();
      store.put(original);
      expect(store.get(original.meta.id)).toEqual(original);
      expect(store.toMarkdown(original.meta.id)!.filename).toBe(
        `${original.meta.id}-imported.md`
      );
    } finally {
      rmSync(fileRoot, { recursive: true, force: true });
    }
  });

  // Without the guard, create() would upsert straight over the existing row
  // and the first task would vanish. A generator stuck on one id is the only
  // way to reach it: six random hex chars will not repeat on their own.
  it('throws rather than overwriting when id minting keeps colliding', () => {
    const db = openDispatchDb(':memory:');
    openDbs.push(db);
    const store = new SqliteTaskStore(root, db, () => 't-fixed0');
    const first = store.create({ title: 'First' }, '2026-07-13T00:00:00Z');
    expect(first.meta.id).toBe('t-fixed0');
    expect(() =>
      store.create({ title: 'Second' }, '2026-07-13T00:00:00Z')
    ).toThrow('id collision persisted: t-fixed0');
    expect(store.get('t-fixed0')!.meta.title).toBe('First');
    expect(store.list()).toHaveLength(1);
  });
});

// A shared database is not a private one: the daemon writes it, the CLI reads
// it, and a migration writes documents that came from files someone may have
// renamed by hand. None of those rows have been through create(), so nothing
// downstream may assume the columns are well formed.
describe('SqliteTaskStore rejects rows it cannot trust', () => {
  function storeWith(db: SqliteDatabase): SqliteTaskStore {
    return new SqliteTaskStore(root, db);
  }

  // The file backend gates every id on `<t|e>-<6 hex>` before it becomes a
  // path (TaskStore.taskFilePath). Without the same gate, an imported id is
  // pasted straight into `<id>-<slug>.md` and the export escapes the tasks
  // directory.
  it('put refuses an id that is not a task id', () => {
    const db = openDispatchDb(':memory:');
    openDbs.push(db);
    const store = storeWith(db);
    const good = store.create({ title: 'Real' });
    for (const id of [
      '../../../etc/passwd',
      't-abc12',
      't-ABC123',
      'x-abc123',
      't-abc123/../../escape',
      '',
    ]) {
      expect(() => store.put({ ...good, meta: { ...good.meta, id } })).toThrow(
        `not a task id: ${id}`
      );
    }
    expect(store.list()).toHaveLength(1);
  });

  // The slug half of the filename is normalized rather than rejected, since a
  // migration reads it off a filename someone may have touched. slugify is
  // idempotent, so a real slug survives and a traversal cannot.
  it('put reduces a slug to slug characters', () => {
    const db = openDispatchDb(':memory:');
    openDbs.push(db);
    const store = storeWith(db);
    const doc = store.create({ title: 'Fix login' });
    store.put(doc, '../../etc/passwd');
    expect(store.toMarkdown(doc.meta.id)!.filename).toBe(
      `${doc.meta.id}-etc-passwd.md`
    );
    store.put(doc, 'already-a-slug');
    expect(store.toMarkdown(doc.meta.id)!.filename).toBe(
      `${doc.meta.id}-already-a-slug.md`
    );
  });

  // put() cannot be the only gate: a writer holding the same database file can
  // INSERT whatever it likes, so the export re-checks on the way out.
  it('toMarkdown refuses a row another writer left unsafe', () => {
    const db = openDispatchDb(':memory:');
    openDbs.push(db);
    const store = storeWith(db);
    const doc = store.create({ title: 'Fix login' });
    db.prepare('UPDATE tasks SET slug = ? WHERE id = ?').run(
      '../../../etc/passwd',
      doc.meta.id
    );
    expect(() => store.toMarkdown(doc.meta.id)).toThrow(SqliteRowError);

    db.prepare('UPDATE tasks SET id = ? WHERE id = ?').run(
      '../escape',
      doc.meta.id
    );
    expect(() => store.toMarkdown('../escape')).toThrow('is not a task id');
  });

  // A blocked_by that read as [] would silently unblock a task; a writes that
  // read as [] would erase its declared write scope. The file backend throws a
  // TaskParseError here, so the database backend raises too.
  it('throws rather than defaulting a damaged JSON column', () => {
    for (const column of ['blocked_by', 'labels', 'writes']) {
      const db = openDispatchDb(':memory:');
      openDbs.push(db);
      const store = storeWith(db);
      const doc = store.create({
        title: 'Blocked',
        blockedBy: ['t-aaaaaa'],
        writes: ['src/**'],
      });
      db.prepare(`UPDATE tasks SET ${column} = ? WHERE id = ?`).run(
        'not json',
        doc.meta.id
      );
      expect(() => store.get(doc.meta.id)).toThrow(SqliteRowError);
      expect(() => store.get(doc.meta.id)).toThrow(column);
      expect(() => store.list()).toThrow(SqliteRowError);
    }
  });

  it('throws on an enum column outside its set', () => {
    for (const [column, bad] of [
      ['kind', 'milestone'],
      ['priority', 'urgentish'],
      ['risk', 'spicy'],
    ]) {
      const db = openDispatchDb(':memory:');
      openDbs.push(db);
      const store = storeWith(db);
      const doc = store.create({ title: 'Odd' });
      db.prepare(`UPDATE tasks SET ${column} = ? WHERE id = ?`).run(
        bad,
        doc.meta.id
      );
      expect(() => store.get(doc.meta.id)).toThrow(SqliteRowError);
      expect(() => store.get(doc.meta.id)).toThrow(column);
    }
  });

  // status is whatever config.yml lists and assignee is a serialized ActorRef,
  // so neither is a closed set and neither may be rejected.
  it('leaves open-ended columns alone', () => {
    const db = openDispatchDb(':memory:');
    openDbs.push(db);
    const store = storeWith(db);
    const doc = store.create({ title: 'Custom' });
    db.prepare('UPDATE tasks SET status = ?, assignee = ? WHERE id = ?').run(
      'awaiting-legal',
      'agent:wyat/codex',
      doc.meta.id
    );
    expect(store.get(doc.meta.id)!.meta.status).toBe('awaiting-legal');
    expect(store.get(doc.meta.id)!.meta.assignee).toBe('agent:wyat/codex');
  });

  // Same division of labour as the file backend: list() propagates, listSafe()
  // collects the bad one and returns the rest, keyed by id where the file
  // backend keys by filename.
  it('listSafe skips a damaged row and keeps the others', () => {
    const db = openDispatchDb(':memory:');
    openDbs.push(db);
    const store = storeWith(db);
    const good = store.create({ title: 'Good' }, '2026-07-13T00:00:00Z');
    const bad = store.create({ title: 'Bad' }, '2026-07-14T00:00:00Z');
    db.prepare('UPDATE tasks SET writes = ? WHERE id = ?').run(
      '{"not":"an array"}',
      bad.meta.id
    );

    const safe = store.listSafe();
    expect(safe.docs.map((d) => d.meta.id)).toEqual([good.meta.id]);
    expect(safe.errors).toHaveLength(1);
    expect(safe.errors[0].file).toBe(bad.meta.id);
    expect(safe.errors[0].message).toContain('writes');
    expect(() => store.list()).toThrow(SqliteRowError);
  });
});

describe('SqliteTaskStore id claiming', () => {
  // The collision check is the INSERT, not a SELECT before it: a row that
  // appears between the two — another process on the same database file — must
  // lose the id rather than be overwritten by it.
  it('never overwrites a row that appeared after the id was minted', () => {
    const db = openDispatchDb(':memory:');
    openDbs.push(db);
    const other = new SqliteTaskStore(root, db);
    const ids = ['t-aaaaaa', 't-bbbbbb'];
    let next = 0;
    const store = new SqliteTaskStore(root, db, () => {
      const id = ids[Math.min(next, ids.length - 1)];
      next += 1;
      // Stand in for a concurrent writer: by the time this id is used, someone
      // else already holds it.
      if (id === 't-aaaaaa') {
        other.put({
          ...blankDoc('t-aaaaaa', 'Theirs'),
        });
      }
      return id;
    });

    const mine = store.create({ title: 'Mine' }, '2026-07-13T00:00:00Z');
    expect(mine.meta.id).toBe('t-bbbbbb');
    expect(store.get('t-aaaaaa')!.meta.title).toBe('Theirs');
    expect(store.list()).toHaveLength(2);
  });
});

// A minimal valid document, for tests that need to stand in for another writer.
function blankDoc(id: string, title: string): TaskDoc {
  return {
    meta: {
      id,
      title,
      status: 'todo',
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'none',
      assignee: 'none',
      created: '2026-07-13T00:00:00Z',
      updated: '2026-07-13T00:00:00Z',
      external: null,
      selfReview: true,
      writes: [],
      risk: 'routine',
      model: null,
      exercised: false,
    },
    body: '\n## Description\n\n\n## Acceptance Criteria\n\n## Activity\n',
  };
}
