import { describe, expect, it } from 'bun:test';

import { MemoryError } from '../src/errors.js';
import {
  createMemoryIds,
  insertFresh,
  newMemoryEntry,
  newProposal,
} from '../src/records.js';
import { openMemoryDb } from '../src/schema.js';
import { SqliteMemoryStore } from '../src/sqliteStore.js';
import type { MemoryEntry } from '../src/types.js';

const NOW = '2026-09-25T10:00:00.000Z';
const ids = createMemoryIds();

function store(fts: 'auto' | 'off' = 'auto'): SqliteMemoryStore {
  return new SqliteMemoryStore(openMemoryDb(':memory:', { fts }));
}

function entry(
  s: SqliteMemoryStore,
  over: Partial<MemoryEntry> = {}
): MemoryEntry {
  return insertFresh(
    s,
    ids,
    Date.parse(NOW),
    (id) => ({
      ...newMemoryEntry(
        {
          scope: 'team',
          kind: 'hazard',
          title: 'pnpm 11 ignores onlyBuiltDependencies',
          body: 'Use allowBuilds in pnpm-workspace.yaml.',
          author: 'run:r-9f2c01',
          trust: 'agent',
        },
        id,
        NOW
      ),
      ...over,
    }),
    'run:r-9f2c01',
    'save'
  );
}

describe.each(['auto', 'off'] as const)('SqliteMemoryStore (fts %s)', (fts) => {
  it('round-trips an entry and finds it by handle and origin', () => {
    const s = store(fts);
    const e = entry(s, { origin: 'ledger:l-1a2b3c@2026-09-01T00:00:00.000Z' });
    expect(s.getEntry(e.id)).toEqual(e);
    expect(s.entriesByHandle(e.handle)).toEqual([e]);
    expect(
      s.entryByOrigin('ledger:l-1a2b3c@2026-09-01T00:00:00.000Z')?.id
    ).toBe(e.id);
    expect(s.revisions(e.id).map((r) => [r.rev, r.cause])).toEqual([
      [1, 'save'],
    ]);
  });

  it('filters by displayed state', () => {
    const s = store(fts);
    const fresh = entry(s);
    const stale = entry(s, { title: 'stale one', decay: 'stale' });
    const expired = entry(s, { title: 'expired one', decay: 'expired' });
    const retired = entry(s, {
      title: 'retired one',
      status: 'retired',
      statusReason: 'forgotten',
    });
    const idsOf = (states: ('active' | 'stale' | 'retired')[]) =>
      s
        .listEntries({ states })
        .map((e) => e.id)
        .sort();
    expect(idsOf(['active'])).toEqual([fresh.id]);
    expect(idsOf(['stale'])).toEqual([stale.id]);
    expect(idsOf(['retired'])).toEqual([expired.id, retired.id].sort());
  });

  it('searches titles and bodies, ANDing or ORing terms, with a snippet', () => {
    const s = store(fts);
    const a = entry(s);
    entry(s, {
      title: 'flaky server tests under load',
      body: 'Run them in chunks.',
    });
    const all = s.searchEntries(['pnpm', 'allowbuilds'], 'all', {}, 10);
    expect(all.map((h) => h.entry.id)).toEqual([a.id]);
    expect(all[0].snippet.length).toBeGreaterThan(0);
    expect(s.searchEntries(['pnpm', 'chunks'], 'any', {}, 10)).toHaveLength(2);
    expect(s.searchEntries(['pnpm', 'chunks'], 'all', {}, 10)).toHaveLength(0);
  });

  it('treats FTS operator words as plain terms', () => {
    const s = store(fts);
    entry(s, { title: 'near and or not', body: 'x' });
    expect(() =>
      s.searchEntries(['near', 'and', 'not'], 'all', {}, 10)
    ).not.toThrow();
  });
});

describe('SqliteMemoryStore', () => {
  it('refuses an update built on an old revision', () => {
    const s = store();
    const e = entry(s);
    s.updateEntry({ ...e, title: 'v2', rev: 2 }, 'human:wyat', 'edit');
    expect(() =>
      s.updateEntry({ ...e, title: 'v2 again', rev: 2 }, 'human:wyat', 'edit')
    ).toThrow(MemoryError);
    expect(s.revisions(e.id).map((r) => r.rev)).toEqual([1, 2]);
  });

  it('revives a stale entry on a recall that counts as use, and only bumps the count otherwise', () => {
    const s = store();
    const e = entry(s, { decay: 'stale' });
    s.recordRecall(e.id, {
      runId: 'r-000001',
      via: 'index',
      at: NOW,
      countsAsUse: false,
    });
    expect(s.getEntry(e.id)).toMatchObject({
      decay: 'stale',
      recallCount: 1,
      lastRecalledAt: null,
    });
    s.recordRecall(e.id, {
      runId: 'r-000001',
      via: 'read',
      at: NOW,
      countsAsUse: true,
    });
    expect(s.getEntry(e.id)).toMatchObject({
      decay: 'fresh',
      recallCount: 2,
      lastRecalledAt: NOW,
      rev: 2,
    });
    expect(
      s
        .recallsForRun('r-000001')
        .map((r) => r.via)
        .sort()
    ).toEqual(['index', 'read']);
  });

  it('hard-deletes with a tombstone for an imported entry', () => {
    const s = store();
    const e = entry(s, { origin: 'ledger:l-1@t' });
    s.deleteEntry(e.id, 'human:wyat', NOW);
    expect(s.getEntry(e.id)).toBeNull();
    expect(s.revisions(e.id)).toEqual([]);
    expect(s.isTombstoned('ledger:l-1@t')).toBe(true);
    expect(s.searchEntries(['pnpm'], 'all', {}, 10)).toEqual([]);
  });

  it('rolls a failed transaction back', () => {
    const s = store();
    expect(() =>
      s.transaction(() => {
        entry(s);
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(s.countEntries()).toBe(0);
  });

  it('round-trips a proposal and counts open ones', () => {
    const s = store();
    const p = newProposal(
      {
        action: 'add',
        scope: 'team',
        content: {
          kind: 'hazard',
          title: 't',
          body: 'b',
          refs: [],
          epic: null,
          appliesTo: [],
        },
        author: 'run:r-1',
        authorTrust: 'agent',
        runId: 'r-1',
        taskId: 't-1a2b3c',
      },
      ids.proposal(Date.parse(NOW)),
      NOW
    );
    s.insertProposal(p);
    expect(s.getProposal(p.id)).toEqual(p);
    expect(s.countOpenProposals()).toBe(1);
    s.updateProposal({
      ...p,
      state: 'rejected',
      decidedAt: NOW,
      decidedBy: 'human:wyat',
    });
    expect(s.countOpenProposals()).toBe(0);
    expect(s.listProposals({ states: ['rejected'] })).toHaveLength(1);
  });
});
