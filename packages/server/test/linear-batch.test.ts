import { TaskStore } from '@dispatch-foo/core';
import type { TaskDoc } from '@dispatch-foo/core';
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { TaskChangeBatch } from '../src/linear/batch.js';

function setup() {
  const store = TaskStore.init(mkdtempSync(join(tmpdir(), 'dispatch-batch-')));
  const cache = new TaskCache();
  const docs = new Map<string, TaskDoc>();
  const published: string[][] = [];
  const calls = { upsert: 0, refresh: 0, rebuild: 0 };
  const upsert = cache.upsert.bind(cache);
  const refresh = cache.refresh.bind(cache);
  const rebuild = cache.rebuild.bind(cache);
  cache.upsert = (d) => {
    calls.upsert++;
    upsert(d);
  };
  cache.refresh = (s, ids) => {
    calls.refresh++;
    return refresh(s, ids);
  };
  cache.rebuild = (s) => {
    calls.rebuild++;
    return rebuild(s);
  };
  const batch = new TaskChangeBatch(
    store,
    cache,
    (id) => docs.get(id),
    (ids) => published.push(ids)
  );
  return { store, cache, docs, published, calls, batch };
}

afterEach(() => setSystemTime());

describe('TaskChangeBatch', () => {
  it('holds writes until the window passes, then publishes them as one event', () => {
    setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    const { store, docs, published, calls, batch } = setup();
    for (let n = 0; n < 5; n++) {
      const doc = store.create({ title: `T${n}` });
      docs.set(doc.meta.id, doc);
      batch.add(doc.meta.id);
    }
    expect(published).toEqual([]);

    setSystemTime(new Date('2026-09-01T00:00:02.000Z'));
    const late = store.create({ title: 'late' });
    docs.set(late.meta.id, late);
    batch.add(late.meta.id);

    expect(published).toHaveLength(1);
    expect(published[0]).toHaveLength(6);
    // The cache took each doc as it was written; only the event waited.
    expect(calls).toEqual({ upsert: 6, refresh: 0, rebuild: 0 });
    expect(batch.count()).toBe(6);
  });

  it("keeps a user's edit that lands between the pass's write and its flush", () => {
    const { store, cache, docs, batch } = setup();
    const doc = store.create({ title: 'Written by the pass' });
    docs.set(doc.meta.id, doc);
    batch.add(doc.meta.id);
    expect(cache.get(doc.meta.id)?.meta.title).toBe('Written by the pass');

    // What an API edit does while the pass awaits: the store, then the cache.
    store.update(doc.meta.id, { title: 'Edited by the user' });
    cache.refresh(store, [doc.meta.id]);
    batch.flush();

    expect(cache.get(doc.meta.id)?.meta.title).toBe('Edited by the user');
  });

  it('dedupes an id written twice, and publishes the rest on the final flush', () => {
    const { store, docs, published, cache, batch } = setup();
    const doc = store.create({ title: 'Twice' });
    docs.set(doc.meta.id, doc);
    batch.add(doc.meta.id);
    batch.add(doc.meta.id);
    batch.flush();
    batch.flush();

    expect(published).toEqual([[doc.meta.id]]);
    expect(cache.get(doc.meta.id)?.meta.title).toBe('Twice');
  });

  it('reads back just the written ids when it does not hold one of their docs', () => {
    const { store, cache, published, calls, batch } = setup();
    const doc = store.create({ title: 'Unknown to the pass' });
    batch.add(doc.meta.id);
    batch.flush();

    expect(calls).toEqual({ upsert: 0, refresh: 1, rebuild: 0 });
    expect(cache.get(doc.meta.id)?.meta.title).toBe('Unknown to the pass');
    expect(published).toEqual([[doc.meta.id]]);
  });
});
