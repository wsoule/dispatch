import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  dbVersion,
  DISPATCH_DB_VERSION,
  openDispatchDb,
} from '../src/sqliteDb.js';
import { SqliteTaskStore } from '../src/sqliteTaskStore.js';
import { TaskStore } from '../src/store.js';
import type { UpdatePatch } from '../src/store.js';
import { parseTaskFile, serializeTaskFile } from '../src/taskfile.js';
import { defaultTaskFields } from '../src/types.js';

const FIELDS: UpdatePatch = {
  estimate: 3,
  dueDate: '2026-10-01',
  startDate: '2026-09-01',
  cycle: {
    id: 'cyc-1',
    number: 12,
    name: 'Cycle 12',
    startsAt: '2026-09-21T00:00:00.000Z',
    endsAt: '2026-10-05T00:00:00.000Z',
  },
  relatedTo: ['t-aaaaaa'],
  duplicateOf: 't-bbbbbb',
  initiatives: ['e-cccccc'],
  color: '#5e6ad2',
  icon: 'rocket',
  sortOrder: 2.5,
};

const OLD_FILE = `---
id: t-abc123
title: Old
status: ready
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-01-01T00:00:00.000Z
updated: 2026-01-01T00:00:00.000Z
external: null
writes: []
---

## Description
`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'dispatch-fields-'));
}

describe('Linear-parity task fields', () => {
  it('defaults every field on a file written before them', () => {
    const doc = parseTaskFile(OLD_FILE);
    expect(doc.meta).toMatchObject(defaultTaskFields());
    // And an untouched file serializes byte for byte.
    expect(serializeTaskFile(doc)).toBe(OLD_FILE);
  });

  it('round-trips every field through the markdown backend', () => {
    const root = tmp();
    const store = TaskStore.init(root);
    const created = store.create({
      title: 'Ship it',
      creator: 'human:wyat',
    });
    const updated = store.update(created.meta.id, FIELDS);
    const reread = store.get(created.meta.id)!;
    expect(reread).toEqual(updated);
    expect(reread.meta).toMatchObject({ ...FIELDS, creator: 'human:wyat' });
    const file = readFileSync(store.taskFilePath(created.meta.id)!, 'utf8');
    expect(file).toContain('due-date: 2026-10-01');
    expect(file).toContain('related-to:');
    expect(file).toContain('sort-order: 2.5');
    // Clearing a field drops its key again.
    store.update(created.meta.id, { estimate: null, relatedTo: [] });
    const cleared = readFileSync(store.taskFilePath(created.meta.id)!, 'utf8');
    expect(cleared).not.toContain('estimate:');
    expect(cleared).not.toContain('related-to:');
  });

  it('round-trips every field through the SQLite backend', () => {
    const root = tmp();
    const db = openDispatchDb(':memory:');
    const store = new SqliteTaskStore(root, db);
    const plain = store.create({ title: 'Plain' });
    expect(store.get(plain.meta.id)!.meta).toMatchObject(defaultTaskFields());
    const created = store.create({ title: 'Ship it', creator: 'agent' });
    const updated = store.update(created.meta.id, FIELDS);
    expect(store.get(created.meta.id)).toEqual(updated);
    expect(store.get(created.meta.id)!.meta).toMatchObject(FIELDS);
    db.close();
  });

  it('migrates a version-2 database, reading old rows with defaults', () => {
    const root = tmp();
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    const dbPath = join(root, '.dispatch', 'dispatch.db');
    const v2 = new Database(dbPath);
    v2.exec(`
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
  kind TEXT NOT NULL, parent TEXT, milestone TEXT, blocked_by TEXT NOT NULL,
  labels TEXT NOT NULL, priority TEXT NOT NULL, assignee TEXT NOT NULL,
  created TEXT NOT NULL, updated TEXT NOT NULL, external TEXT,
  self_review INTEGER NOT NULL, fix_loop INTEGER, writes TEXT NOT NULL,
  risk TEXT NOT NULL, model TEXT, archived_at TEXT, exercised INTEGER NOT NULL,
  derived_from TEXT, attachments TEXT, slug TEXT NOT NULL, body TEXT NOT NULL
);
INSERT INTO tasks VALUES ('e-abc123', 'Old epic', 'ready', 'epic', NULL, NULL,
  '[]', '[]', 'none', 'none', '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z', NULL, 1, NULL, '[]', 'routine', NULL, NULL, 0,
  NULL, NULL, 'old-epic', '');
PRAGMA user_version = 2;
`);
    v2.close();
    const db = openDispatchDb(dbPath);
    expect(dbVersion(db)).toBe(DISPATCH_DB_VERSION);
    const store = new SqliteTaskStore(root, db);
    const old = store.get('e-abc123')!;
    expect(old.meta.kind).toBe('milestone');
    expect(old.meta).toMatchObject(defaultTaskFields());
    expect(store.list({ kind: 'milestone' }).map((d) => d.meta.id)).toEqual([
      'e-abc123',
    ]);
    const next = store.update('e-abc123', FIELDS);
    expect(store.get('e-abc123')).toEqual(next);
    db.close();
  });

  it('migrates a version-3 database, adding the sort order column', () => {
    const root = tmp();
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    const dbPath = join(root, '.dispatch', 'dispatch.db');
    const v3 = new Database(dbPath);
    v3.exec(`
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
  kind TEXT NOT NULL, parent TEXT, milestone TEXT, blocked_by TEXT NOT NULL,
  labels TEXT NOT NULL, priority TEXT NOT NULL, assignee TEXT NOT NULL,
  created TEXT NOT NULL, updated TEXT NOT NULL, external TEXT,
  self_review INTEGER NOT NULL, fix_loop INTEGER, writes TEXT NOT NULL,
  risk TEXT NOT NULL, model TEXT, archived_at TEXT, exercised INTEGER NOT NULL,
  derived_from TEXT, attachments TEXT, estimate REAL, due_date TEXT,
  start_date TEXT, cycle TEXT, related_to TEXT, duplicate_of TEXT,
  initiatives TEXT, creator TEXT, color TEXT, icon TEXT,
  slug TEXT NOT NULL, body TEXT NOT NULL
);
INSERT INTO tasks (id, title, status, kind, blocked_by, labels, priority,
  assignee, created, updated, self_review, writes, risk, exercised, color,
  slug, body)
VALUES ('m-abc123', 'Beta', 'ready', 'milestone', '[]', '[]', 'none', 'none',
  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, '[]', 'routine',
  0, '#f00', 'beta', '');
PRAGMA user_version = 3;
`);
    v3.close();
    const db = openDispatchDb(dbPath);
    expect(dbVersion(db)).toBe(DISPATCH_DB_VERSION);
    const store = new SqliteTaskStore(root, db);
    expect(store.get('m-abc123')!.meta).toMatchObject({
      color: '#f00',
      sortOrder: null,
    });
    store.update('m-abc123', { sortOrder: 3 });
    expect(store.get('m-abc123')!.meta.sortOrder).toBe(3);
    db.close();
  });
});
