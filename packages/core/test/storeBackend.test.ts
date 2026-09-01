import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatchDbPath } from '../src/sqliteDb.js';
import { initProjectStores, openProjectStores } from '../src/storeBackend.js';
import type { ProjectStores } from '../src/storeBackend.js';

let root: string;
const opened: ProjectStores[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-backend-'));
});

afterEach(() => {
  for (const stores of opened.splice(0)) stores.close();
  rmSync(root, { recursive: true, force: true });
});

function track(stores: ProjectStores): ProjectStores {
  opened.push(stores);
  return stores;
}

describe('initProjectStores', () => {
  it('creates .dispatch/tasks and config.yml on the file backend', () => {
    const stores = track(initProjectStores({ rootDir: root }));
    expect(stores.backend).toBe('files');
    expect(stores.records).toBeNull();
    expect(existsSync(join(root, '.dispatch/tasks'))).toBe(true);
    expect(readFileSync(join(root, '.dispatch/config.yml'), 'utf8')).toContain(
      'autoCommit: true'
    );
    const doc = stores.tasks.create({ title: 'Fix login' });
    expect(existsSync(join(root, '.dispatch/tasks'))).toBe(true);
    expect(stores.tasks.get(doc.meta.id)).toEqual(doc);
  });

  // The database holds the tasks, but config.yml stays a plain committable
  // file either way — that is the part of `.dispatch/` the storage plan keeps.
  it('creates the database and config.yml but no tasks dir on the sqlite backend', () => {
    const stores = track(
      initProjectStores({ rootDir: root, backend: 'sqlite' })
    );
    expect(stores.backend).toBe('sqlite');
    expect(existsSync(dispatchDbPath(root))).toBe(true);
    expect(existsSync(join(root, '.dispatch/config.yml'))).toBe(true);
    expect(existsSync(join(root, '.dispatch/tasks'))).toBe(false);
    const doc = stores.tasks.create({ title: 'Fix login' });
    expect(stores.tasks.get(doc.meta.id)).toEqual(doc);
  });

  it('honours an explicit dbPath outside .dispatch', () => {
    const dbPath = join(root, 'receipts', 'nested', 'state.db');
    const stores = track(
      initProjectStores({ rootDir: root, backend: 'sqlite', dbPath })
    );
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(dispatchDbPath(root))).toBe(false);
    expect(stores.tasks.rootDir).toBe(root);
  });

  it('is idempotent on both backends', () => {
    track(initProjectStores({ rootDir: root })).close();
    const files = track(initProjectStores({ rootDir: root }));
    const doc = files.tasks.create({ title: 'Survives' });

    track(initProjectStores({ rootDir: root, backend: 'sqlite' })).close();
    const db = track(initProjectStores({ rootDir: root, backend: 'sqlite' }));
    db.tasks.create({ title: 'Also survives' });
    expect(db.tasks.list()).toHaveLength(1);
    expect(files.tasks.get(doc.meta.id)).not.toBeNull();
  });
});

describe('openProjectStores', () => {
  it('exposes the record stores only on the sqlite backend', () => {
    expect(track(openProjectStores({ rootDir: root })).records).toBeNull();
    const stores = track(
      initProjectStores({ rootDir: root, backend: 'sqlite' })
    );
    expect(stores.records).not.toBeNull();
    const finding = stores.records!.findings.add({
      taskId: 't-abc123',
      runId: null,
      severity: 'minor',
      title: 'T',
      detail: 'd',
      raisedBy: 'human:wyat',
    });
    const entry = stores.records!.ledger.add({
      kind: 'decision',
      title: 'D',
      detail: 'd',
      authoredBy: 'human:wyat',
    });
    stores.records!.evidence.addCommand('r-aaaaaa', {
      command: 'bun test',
      exitCode: 0,
      durationMs: 1,
      summary: 'ok',
      at: '2026-08-01T00:00:00Z',
    });
    // All four stores share one handle, so one close() releases everything.
    expect(stores.records!.findings.get(finding.id)).not.toBeNull();
    expect(stores.records!.ledger.get(entry.id)).not.toBeNull();
    expect(stores.records!.evidence.commandsFor('r-aaaaaa')).toHaveLength(1);
  });

  it('creates nothing on the file backend', () => {
    const stores = track(openProjectStores({ rootDir: root }));
    expect(existsSync(join(root, '.dispatch'))).toBe(false);
    expect(stores.tasks.isInitialized()).toBe(false);
    expect(stores.tasks.list()).toEqual([]);
  });

  // The file backend's `new TaskStore(rootDir)` creates nothing, so attaching
  // to a database must not either — a read in a repo that never opted in would
  // otherwise leave dispatch.db and its -wal/-shm companions behind, and make
  // an uninitialized project answer isInitialized() with true.
  it('creates no database when attaching to a project that has none', () => {
    const stores = track(
      openProjectStores({ rootDir: root, backend: 'sqlite' })
    );
    expect(existsSync(dispatchDbPath(root))).toBe(false);
    expect(existsSync(`${dispatchDbPath(root)}-wal`)).toBe(false);
    expect(existsSync(`${dispatchDbPath(root)}-shm`)).toBe(false);
    expect(existsSync(join(root, '.dispatch'))).toBe(false);
    expect(stores.tasks.isInitialized()).toBe(false);
    expect(stores.records).toBeNull();
    // Reads answer empty, exactly as the file backend does with no tasks dir.
    expect(stores.tasks.list()).toEqual([]);
    expect(stores.tasks.listSafe()).toEqual({ docs: [], errors: [] });
    expect(stores.tasks.get('t-abc123')).toBeNull();
    expect(stores.tasks.remove('t-abc123')).toBe(false);
    // Writes refuse rather than vanish.
    expect(() => stores.tasks.create({ title: 'Nowhere' })).toThrow(
      'no dispatch database'
    );
    expect(() => stores.tasks.update('t-abc123', { status: 'done' })).toThrow(
      'task not found'
    );
    expect(existsSync(dispatchDbPath(root))).toBe(false);
  });

  it('attaches to a database a previous init created', () => {
    track(initProjectStores({ rootDir: root, backend: 'sqlite' })).close();
    const stores = track(
      openProjectStores({ rootDir: root, backend: 'sqlite' })
    );
    expect(stores.tasks.isInitialized()).toBe(true);
    expect(stores.records).not.toBeNull();
  });

  it('tolerates a second close', () => {
    const stores = track(
      openProjectStores({ rootDir: root, backend: 'sqlite' })
    );
    stores.close();
    expect(() => {
      stores.close();
    }).not.toThrow();
  });

  it('reads back what a previous session wrote to the same database', () => {
    const first = initProjectStores({ rootDir: root, backend: 'sqlite' });
    const doc = first.tasks.create({ title: 'Persisted' });
    first.close();
    const second = track(
      openProjectStores({ rootDir: root, backend: 'sqlite' })
    );
    expect(second.tasks.get(doc.meta.id)).toEqual(doc);
  });
});
