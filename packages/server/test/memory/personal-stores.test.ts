import {
  createMemoryIds,
  insertFresh,
  MemoryError,
  newMemoryEntry,
} from '@dispatch/memory';
import type { MemoryEntry, MemoryStore } from '@dispatch/memory';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PersonalStores } from '../../src/memory/personalStores.js';
import { personalMemoryDir } from '../../src/orchestrator/paths.js';

let root: string;
let opened: PersonalStores[] = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'personal-')));
});
afterEach(() => {
  for (const stores of opened) stores.close();
  opened = [];
  rmSync(root, { recursive: true, force: true });
});

function storesAt(dir = join(root, 'memory')): PersonalStores {
  const stores = new PersonalStores({ dir });
  opened.push(stores);
  return stores;
}

const ADA = `pid-${'A'.repeat(26)}`;
const BEA = `pid-${'B'.repeat(26)}`;

function save(
  store: MemoryStore,
  title: string,
  origin: string | null = null
): MemoryEntry {
  return insertFresh(
    store,
    createMemoryIds(),
    Date.now(),
    (id) =>
      newMemoryEntry(
        {
          scope: 'personal',
          kind: 'fact',
          title,
          body: 'b',
          author: 'human:ada',
          trust: 'human',
          origin,
        },
        id,
        new Date().toISOString()
      ),
    'human:ada',
    'save'
  );
}

describe('PersonalStores', () => {
  it('opens <identity>.db lazily at 0600 in a 0700 directory, and refuses a bad identity', () => {
    const stores = storesAt();
    const store = stores.personal('self');
    expect(store.countEntries()).toBe(0);
    expect(stores.personal('self')).toBe(store);
    expect(statSync(join(root, 'memory', 'self.db')).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'memory')).mode & 0o777).toBe(0o700);
    expect(() => stores.personal('../../etc/passwd')).toThrow(MemoryError);
    expect(stores.opened()).toEqual(['self']);
  });

  it('moves entries with their revisions when an identity is linked', () => {
    const stores = storesAt();
    const from = stores.personal(ADA);
    const e = save(from, 't');
    expect(stores.move(ADA, 'self')).toBe(1);
    expect(stores.personal('self').getEntry(e.id)?.title).toBe('t');
    expect(stores.personal('self').revisions(e.id)).toHaveLength(1);
    expect(from.getEntry(e.id)).toBeNull();
    expect(stores.locate(e.id, ['self', ADA])).toBe('self');
  });

  it('moves recalls, activity and tombstones too, and keeps the moved entries searchable', () => {
    const stores = storesAt();
    const from = stores.personal(ADA);
    const kept = save(from, 'flaky websocket reconnects');
    const gone = save(from, 'old import', 'claude:aaaaaaaaaaaa/x.md');
    from.recordRecall(kept.id, {
      runId: 'r-1',
      via: 'index',
      at: '2026-09-25T10:00:00.000Z',
      countsAsUse: true,
    });
    from.appendActivity({
      id: 'ma-1',
      at: '2026-09-25T10:00:00.000Z',
      kind: 'saved',
      memoryId: kept.id,
      runId: 'r-1',
      summary: 'saved',
    });
    from.deleteEntry(gone.id, 'human:ada', '2026-09-25T10:00:00.000Z');

    expect(stores.move(ADA, BEA)).toBe(1);
    const to = stores.personal(BEA);
    expect(to.recallsForRun('r-1').map((r) => r.memoryId)).toEqual([kept.id]);
    expect(
      to.activitySince('2026-01-01T00:00:00.000Z', 10).map((a) => a.id)
    ).toEqual(['ma-1']);
    expect(to.isTombstoned('claude:aaaaaaaaaaaa/x.md')).toBe(true);
    expect(
      to.searchEntries(['websocket'], 'all', {}, 10).map((h) => h.entry.id)
    ).toEqual([kept.id]);
    expect(from.countEntries()).toBe(0);
    expect(from.recallsForRun('r-1')).toEqual([]);
    expect(from.activitySince('2026-01-01T00:00:00.000Z', 10)).toEqual([]);
  });

  it('finishes a move that stopped after copying, without duplicating', () => {
    const stores = storesAt();
    const from = stores.personal(ADA);
    const to = stores.personal(BEA);
    const e = save(from, 'already copied');
    to.insertEntry(e, 'human:ada', 'save');
    expect(stores.move(ADA, BEA)).toBe(1);
    expect(to.countEntries()).toBe(1);
    expect(to.revisions(e.id)).toHaveLength(1);
    expect(from.countEntries()).toBe(0);
  });

  it('leaves a store alone when moved onto itself', () => {
    const stores = storesAt();
    save(stores.personal(ADA), 'mine');
    expect(stores.move(ADA, ADA)).toBe(0);
    expect(stores.personal(ADA).countEntries()).toBe(1);
  });

  it('retries a store that failed to open, and locate skips it meanwhile', () => {
    const stores = storesAt();
    const e = save(stores.personal('self'), 'mine');
    mkdirSync(join(root, 'memory', `${ADA}.db`));
    let err: unknown = null;
    try {
      stores.personal(ADA);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(MemoryError);
    expect((err as MemoryError).code).toBe('unavailable');
    expect((err as MemoryError).message).toMatch(
      /^personal memory unavailable: /
    );
    expect(stores.locate(e.id, [ADA, 'self'])).toBe('self');
    expect(stores.opened()).toEqual(['self']);
    rmSync(join(root, 'memory', `${ADA}.db`), { recursive: true });
    expect(stores.personal(ADA).countEntries()).toBe(0);
    expect(stores.opened()).toEqual([ADA, 'self']);
  });

  it('keeps personal databases under DISPATCH_HOME, outside any project', () => {
    const saved = process.env.DISPATCH_HOME;
    process.env.DISPATCH_HOME = root;
    try {
      expect(personalMemoryDir()).toBe(join(root, '.dispatch', 'memory'));
    } finally {
      if (saved === undefined) delete process.env.DISPATCH_HOME;
      else process.env.DISPATCH_HOME = saved;
    }
  });
});
