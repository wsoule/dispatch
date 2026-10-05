import { readyTasks, TaskStore } from '@dispatch/core';
import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';

let root: string;
let store: TaskStore;
let cache: TaskCache;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cache-'));
  store = TaskStore.init(root);
  cache = new TaskCache();
});

describe('rebuild + query', () => {
  it('mirrors store.list() after a rebuild', () => {
    store.create({ title: 'A' }, '2026-07-13T01:00:00Z');
    store.create({ title: 'B', status: 'draft' }, '2026-07-13T02:00:00Z');
    cache.rebuild(store);

    expect(cache.query().map((t) => t.meta.title)).toEqual(['A', 'B']);
    expect(cache.query({ status: 'draft' }).map((t) => t.meta.title)).toEqual([
      'B',
    ]);
  });

  it('reflects deletions and edits after a subsequent rebuild', () => {
    const a = store.create({ title: 'A' }, '2026-07-13T01:00:00Z');
    cache.rebuild(store);
    expect(cache.query()).toHaveLength(1);

    store.update(a.meta.id, { title: 'Renamed' }, '2026-07-13T02:00:00Z');
    cache.rebuild(store);
    expect(cache.query()[0].meta.title).toBe('Renamed');
  });
});

describe('upsert', () => {
  it('adds and replaces just the given rows, leaving the rest', () => {
    const a = store.create({ title: 'A' }, '2026-07-13T01:00:00Z');
    cache.rebuild(store);
    const renamed = store.update(
      a.meta.id,
      { title: 'A2' },
      '2026-07-13T02:00:00Z'
    );
    const b = store.create({ title: 'B' }, '2026-07-13T03:00:00Z');

    cache.upsert([renamed, b]);

    expect(cache.query().map((t) => t.meta.title)).toEqual(['A2', 'B']);
    expect(cache.get(b.meta.id)?.meta.title).toBe('B');
  });
});

describe('refresh', () => {
  it('re-reads just the named tasks and reports the ones that changed', () => {
    const a = store.create({ title: 'A' }, '2026-07-13T01:00:00Z');
    const b = store.create({ title: 'B' }, '2026-07-13T02:00:00Z');
    cache.rebuild(store);
    store.update(a.meta.id, { title: 'A2' });
    store.update(b.meta.id, { title: 'B2' });

    expect(cache.refresh(store, [a.meta.id])).toEqual([a.meta.id]);
    // B was not named, so its row still holds what the last read saw.
    expect(cache.query().map((t) => t.meta.title)).toEqual(['A2', 'B']);
    // Nothing moved since: a second refresh is an echo.
    expect(cache.refresh(store, [a.meta.id])).toEqual([]);
  });

  it('adds a new task and drops one the store no longer has', () => {
    const a = store.create({ title: 'A' }, '2026-07-13T01:00:00Z');
    cache.rebuild(store);
    const b = store.create({ title: 'B' }, '2026-07-13T02:00:00Z');
    store.remove(a.meta.id);

    expect(cache.refresh(store, [a.meta.id, b.meta.id]).sort()).toEqual(
      [a.meta.id, b.meta.id].sort()
    );
    expect(cache.query().map((t) => t.meta.title)).toEqual(['B']);
    expect(cache.refresh(store, ['t-000000'])).toEqual([]);
  });

  it('matches a doc read back from its file to the one the writer held', () => {
    const a = store.create({ title: 'A' }, '2026-07-13T01:00:00Z');
    cache.rebuild(store);
    // The patch adds a key the file lists elsewhere, so the two docs differ
    // in key order only.
    const held = store.update(a.meta.id, {
      archivedAt: '2026-07-14T00:00:00Z',
    });
    cache.upsert([held]);

    expect(cache.refresh(store, [a.meta.id])).toEqual([]);
  });

  it('drops a task whose file stops parsing, names it, and clears it once fixed', () => {
    const a = store.create({ title: 'A' }, '2026-07-13T01:00:00Z');
    cache.rebuild(store);
    const path = store.taskFilePath(a.meta.id)!;
    const good = readFileSync(path, 'utf8');
    writeFileSync(path, 'not a task file');

    expect(cache.refresh(store, [a.meta.id])).toEqual([a.meta.id]);
    expect(cache.get(a.meta.id)).toBeNull();
    expect(cache.problems()).toHaveLength(1);
    expect(cache.problems()[0]).toContain(a.meta.id);

    writeFileSync(path, good);
    expect(cache.refresh(store, [a.meta.id])).toEqual([a.meta.id]);
    expect(cache.problems()).toEqual([]);
  });
});

describe('resync', () => {
  it('writes and reports only what differs from the cache', () => {
    const a = store.create({ title: 'A' }, '2026-07-13T01:00:00Z');
    const b = store.create({ title: 'B' }, '2026-07-13T02:00:00Z');
    expect(cache.resync(store).sort()).toEqual([a.meta.id, b.meta.id].sort());
    expect(cache.resync(store)).toEqual([]);

    store.update(a.meta.id, { title: 'A2' });
    store.remove(b.meta.id);
    const c = store.create({ title: 'C' }, '2026-07-13T03:00:00Z');
    expect(cache.resync(store).sort()).toEqual(
      [a.meta.id, b.meta.id, c.meta.id].sort()
    );
    expect(cache.query().map((t) => t.meta.title)).toEqual(['A2', 'C']);
  });
});

describe('queryMeta', () => {
  it('returns the same rows as query() with every body left out', () => {
    store.create({ title: 'A' }, '2026-07-13T01:00:00Z');
    store.create({ title: 'B', status: 'draft' }, '2026-07-13T02:00:00Z');
    cache.rebuild(store);

    expect(cache.queryMeta()).toEqual(
      cache.query().map((doc) => ({ meta: doc.meta }))
    );
    expect(
      cache.queryMeta({ status: 'draft' }).map((t) => t.meta.title)
    ).toEqual(['B']);
  });
});

describe('queryJson + queryMetaJson', () => {
  it('serialize exactly what query() and queryMeta() return, per filter', () => {
    const epic = store.create(
      { title: 'Epic', kind: 'milestone' },
      '2026-07-13T01:00:00Z'
    );
    store.create(
      { title: 'Child', parent: epic.meta.id, description: 'Prose' },
      '2026-07-13T02:00:00Z'
    );
    const gone = store.create(
      { title: 'Gone', status: 'draft' },
      '2026-07-13T03:00:00Z'
    );
    store.update(gone.meta.id, { archivedAt: '2026-07-14T00:00:00Z' });
    cache.rebuild(store);

    for (const filter of [
      {},
      { includeArchived: true },
      { status: 'draft', includeArchived: true },
      { parent: epic.meta.id },
      { containers: true },
    ]) {
      expect(cache.queryJson(filter)).toBe(JSON.stringify(cache.query(filter)));
      expect(cache.queryMetaJson(filter)).toBe(
        JSON.stringify(cache.queryMeta(filter))
      );
    }
    expect(cache.queryMetaJson()).not.toContain('Prose');
  });

  it('never serves a list from before a write', () => {
    const a = store.create({ title: 'A' }, '2026-07-13T01:00:00Z');
    cache.rebuild(store);
    expect(JSON.parse(cache.queryMetaJson())).toHaveLength(1);

    const b = store.create({ title: 'B' }, '2026-07-13T02:00:00Z');
    cache.refresh(store, [b.meta.id]);
    expect(JSON.parse(cache.queryJson())).toHaveLength(2);

    cache.upsert([store.update(a.meta.id, { title: 'A2' })]);
    expect(cache.queryMetaJson()).toContain('"A2"');

    store.remove(b.meta.id);
    cache.resync(store);
    expect(cache.queryJson()).toBe(JSON.stringify(cache.query()));
    expect(JSON.parse(cache.queryMetaJson())).toHaveLength(1);
  });
});

describe('get', () => {
  it('returns a single cached doc by id, or null', () => {
    const a = store.create({ title: 'A' }, '2026-07-13T01:00:00Z');
    cache.rebuild(store);
    expect(cache.get(a.meta.id)?.meta.title).toBe('A');
    expect(cache.get('t-000000')).toBeNull();
  });
});

describe('ready', () => {
  it('delegates to core readyTasks over all cached docs', () => {
    store.create({ title: 'Ready one' }, '2026-07-13T01:00:00Z');
    store.create(
      { title: 'Not ready', status: 'draft' },
      '2026-07-13T02:00:00Z'
    );
    cache.rebuild(store);
    expect(cache.ready().map((t) => t.meta.title)).toEqual(['Ready one']);
  });

  it('reads the queue off the cached items in core order, archived blockers still holding', () => {
    const blocker = store.create({ title: 'Blocker' }, '2026-07-13T01:00:00Z');
    store.update(blocker.meta.id, { archivedAt: '2026-07-14T00:00:00Z' });
    const blocked = store.create(
      { title: 'Blocked', blockedBy: [blocker.meta.id] },
      '2026-07-13T02:00:00Z'
    );
    // Same priority and created stamp: query()'s id order breaks the tie.
    const late = store.create({ title: 'Late' }, '2026-07-13T05:00:00Z');
    const early = store.create({ title: 'Early' }, '2026-07-13T05:00:00Z');
    const urgent = store.create(
      { title: 'Urgent', priority: 'urgent' },
      '2026-07-13T06:00:00Z'
    );
    cache.rebuild(store);

    const expected = readyTasks(cache.query({ includeArchived: true })).map(
      (t) => t.meta.id
    );
    expect(cache.readyIds()).toEqual(expected);
    expect(expected).toHaveLength(3);
    expect(expected[0]).toBe(urgent.meta.id);
    expect(expected).not.toContain(blocked.meta.id);
    expect(expected.slice(1).sort()).toEqual(
      [late.meta.id, early.meta.id].sort()
    );

    // A write moves the queue without a rebuild.
    cache.upsert([store.update(urgent.meta.id, { status: 'draft' })]);
    expect(cache.readyIds()).toEqual(expected.slice(1));
  });
});

describe('allItems', () => {
  it('shares frozen items in query() order and follows every write', () => {
    const a = store.create({ title: 'A' }, '2026-07-13T01:00:00Z');
    const gone = store.create({ title: 'Gone' }, '2026-07-13T02:00:00Z');
    store.update(gone.meta.id, { archivedAt: '2026-07-14T00:00:00Z' });
    cache.rebuild(store);

    const items = cache.allItems();
    expect(items).toEqual(cache.queryMeta({ includeArchived: true }));
    expect(cache.allItems()).toBe(items);
    expect(Object.isFrozen(items[0]?.meta.labels)).toBe(true);
    expect(() => {
      (items[0] as { meta: { title: string } }).meta.title = 'changed';
    }).toThrow();

    cache.upsert([store.update(a.meta.id, { title: 'A2' })]);
    expect(cache.allItems().map((t) => t.meta.title)).toEqual(['A2', 'Gone']);
  });
});

describe('getMany + storedJson', () => {
  it('returns the named rows in the order asked, skipping unknown ids', () => {
    const a = store.create({ title: 'A' }, '2026-07-13T01:00:00Z');
    const b = store.create({ title: 'B' }, '2026-07-13T02:00:00Z');
    cache.rebuild(store);

    expect(
      cache.getMany([b.meta.id, 't-000000', a.meta.id]).map((t) => t.meta.title)
    ).toEqual(['B', 'A']);
    const items = cache.storedJson([a.meta.id], 'item');
    expect([...items.keys()]).toEqual([a.meta.id]);
    expect(JSON.parse(items.get(a.meta.id) ?? '')).toEqual({
      meta: cache.get(a.meta.id)?.meta,
    });
  });
});
