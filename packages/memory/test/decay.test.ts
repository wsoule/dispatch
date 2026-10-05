import { SYSTEM_ADDRESS } from '@dispatch-foo/protocol';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decayStore } from '../src/decay.js';
import {
  createMemoryIds,
  insertFresh,
  newMemoryEntry,
} from '../src/records.js';
import { openMemoryDb } from '../src/schema.js';
import { SqliteMemoryStore } from '../src/sqliteStore.js';
import type { MemoryEntry } from '../src/types.js';

const DAY = 86_400_000;
const NOW = new Date('2026-09-25T00:00:00.000Z');
const ago = (days: number) =>
  new Date(NOW.getTime() - days * DAY).toISOString();
const policy = { now: NOW, staleAfterDays: 60, retireAfterDays: 180 };
const ids = createMemoryIds();

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function store(path = ':memory:'): SqliteMemoryStore {
  return new SqliteMemoryStore(openMemoryDb(path));
}

function put(
  s: SqliteMemoryStore,
  over: Partial<MemoryEntry> = {}
): MemoryEntry {
  return insertFresh(
    s,
    ids,
    NOW.getTime(),
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
        NOW.toISOString()
      ),
      ...over,
    }),
    'run:r-9f2c01',
    'save'
  );
}

describe('decayStore', () => {
  it('ages fresh → stale after 60 days without use, and stale → expired after 180', () => {
    const s = store();
    const a = put(s, { updatedAt: ago(61), createdAt: ago(61) });
    const b = put(s, {
      updatedAt: ago(200),
      createdAt: ago(200),
      decay: 'stale',
    });
    const c = put(s, { updatedAt: ago(200), lastRecalledAt: ago(10) });
    const d = put(s, { updatedAt: ago(59), createdAt: ago(59) });
    expect(decayStore(s, policy)).toMatchObject({ staled: 1, expired: 1 });
    expect(s.getEntry(a.id)?.decay).toBe('stale');
    expect(s.getEntry(b.id)?.decay).toBe('expired');
    expect(s.getEntry(c.id)?.decay).toBe('fresh');
    expect(s.getEntry(d.id)?.decay).toBe('fresh');
    expect(s.revisions(a.id).at(-1)).toMatchObject({
      cause: 'decay',
      rev: 2,
      by: SYSTEM_ADDRESS,
    });
    expect(s.getEntry(a.id)?.updatedAt).toBe(ago(61));
    expect(s.meta('last_decay_at')).toBe(NOW.toISOString());
  });

  it('names each scope whose entries it changed, in MEMORY_SCOPES order', () => {
    const s = store();
    put(s, { scope: 'team', updatedAt: ago(61) });
    put(s, { scope: 'project', updatedAt: ago(1) });
    expect(decayStore(s, policy).scopes).toEqual(['team']);
    put(s, { scope: 'team', updatedAt: ago(61) });
    put(s, { scope: 'project', updatedAt: ago(200) });
    expect(decayStore(s, policy).scopes).toEqual(['project', 'team']);
    // The project entry was marked stale last pass; it retires 120 days on.
    expect(decayStore(s, policy).scopes).toEqual([]);
  });

  it('exempts pinned entries and human constraints written directly; imported and amendment constraints still decay', () => {
    const s = store();
    const pinned = put(s, { pinned: true, updatedAt: ago(400) });
    const human = put(s, {
      kind: 'constraint',
      trust: 'human',
      origin: null,
      updatedAt: ago(400),
    });
    const amended = put(s, {
      kind: 'constraint',
      trust: 'human',
      origin: 'amendment:t-1a2b3c@x',
      updatedAt: ago(400),
    });
    const imported = put(s, {
      kind: 'constraint',
      trust: 'agent',
      origin: 'ledger:l-1@x',
      updatedAt: ago(400),
    });
    decayStore(s, policy);
    s.setMeta(
      'last_decay_at',
      new Date(NOW.getTime() + 120 * DAY).toISOString()
    );
    decayStore(s, { ...policy, now: new Date(NOW.getTime() + 121 * DAY) });
    expect([pinned, human].map((e) => s.getEntry(e.id)?.decay)).toEqual([
      'fresh',
      'fresh',
    ]);
    expect([amended, imported].map((e) => s.getEntry(e.id)?.decay)).toEqual([
      'expired',
      'expired',
    ]);
    expect(s.revisions(imported.id).map((r) => [r.rev, r.cause])).toEqual([
      [1, 'save'],
      [2, 'decay'],
      [3, 'decay'],
    ]);
  });

  const at = (days: number) => ({
    ...policy,
    now: new Date(NOW.getTime() + days * DAY),
  });

  // A lesson saved while the clock ran 200 days behind looks 200 days idle
  // once it is corrected: it goes stale, but retires only 120 days later.
  it('retires only once the sweep that marked it stale is retire-minus-stale days old', () => {
    const s = store();
    const old = put(s, { updatedAt: ago(200), createdAt: ago(200) });
    expect(decayStore(s, policy)).toMatchObject({ staled: 1, expired: 0 });
    expect(decayStore(s, at(2))).toMatchObject({ expired: 0 });
    s.setMeta('last_decay_at', at(119).now.toISOString());
    expect(decayStore(s, at(119.5))).toMatchObject({ expired: 0 });
    expect(s.getEntry(old.id)?.decay).toBe('stale');
    s.setMeta('last_decay_at', at(120).now.toISOString());
    expect(decayStore(s, at(120.5))).toMatchObject({ expired: 1 });
    expect(s.getEntry(old.id)?.decay).toBe('expired');
  });

  it('changes nothing across a clock jump far past the sweep interval, and says why', () => {
    const s = store();
    const stale = put(s, { updatedAt: ago(400), decay: 'stale' });
    const fresh = put(s, { updatedAt: ago(1) });
    s.setMeta('last_decay_at', ago(1));
    const out = decayStore(s, at(3650));
    expect(out).toMatchObject({ staled: 0, expired: 0 });
    expect(out.anomaly).toContain('clock');
    expect(s.getEntry(stale.id)?.decay).toBe('stale');
    expect(s.getEntry(fresh.id)?.decay).toBe('fresh');
    expect(decayStore(s, at(0)).anomaly).toContain('future');
  });

  it('clamps a future stamp to now, so it never freezes expiry for the store', () => {
    const s = store();
    // Marked stale by a sweep while the clock ran 200 days fast.
    const skewed = put(s, { updatedAt: ago(400) });
    s.setMeta('last_decay_at', at(199).now.toISOString());
    decayStore(s, at(200));
    expect(s.getEntry(skewed.id)?.decay).toBe('stale');
    // Saved while the clock ran fast, and an old lesson a sweep marked stale.
    const ahead = put(s, { updatedAt: at(30).now.toISOString() });
    const old = put(s, { updatedAt: ago(400), decay: 'stale' });
    // The clock comes back: one sweep stands down, the next works.
    expect(decayStore(s, at(0)).anomaly).toContain('future');
    const out = decayStore(s, at(1));
    expect(out.anomaly).toBeNull();
    expect(s.getEntry(old.id)?.decay).toBe('expired');
    expect(s.getEntry(skewed.id)?.decay).toBe('stale');
    expect(s.getEntry(ahead.id)?.decay).toBe('fresh');
  });

  it('rewrites stored stamps from the future to the sweep time', () => {
    const s = store();
    const ahead = put(s, {
      createdAt: at(30).now.toISOString(),
      updatedAt: at(30).now.toISOString(),
      lastRecalledAt: at(40).now.toISOString(),
    });
    decayStore(s, policy);
    expect(s.getEntry(ahead.id)).toMatchObject({
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      lastRecalledAt: NOW.toISOString(),
    });
  });

  it('leaves retired entries alone', () => {
    const s = store();
    const retired = put(s, {
      status: 'retired',
      statusReason: 'forgotten',
      updatedAt: ago(400),
    });
    expect(decayStore(s, policy)).toMatchObject({ staled: 0, expired: 0 });
    expect(s.getEntry(retired.id)).toMatchObject({ decay: 'fresh', rev: 1 });
  });

  it('prunes recalls older than a year; recall_count keeps the total', () => {
    const s = store();
    const e = put(s);
    s.recordRecall(e.id, {
      runId: 'r-1',
      via: 'index',
      at: ago(400),
      countsAsUse: false,
    });
    s.recordRecall(e.id, {
      runId: 'r-2',
      via: 'index',
      at: ago(1),
      countsAsUse: false,
    });
    expect(decayStore(s, policy).prunedRecalls).toBe(1);
    expect(s.getEntry(e.id)?.recallCount).toBe(2);
    expect(s.recallsForRun('r-1')).toEqual([]);
    expect(s.recallsForRun('r-2')).toHaveLength(1);
  });
});

describe('SqliteMemoryStore.backup', () => {
  it('backs up twice in a row, leaving one .bak at 0600 that opens with its entries', () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'memory-backup-')));
    const path = join(dir, 'memory.db');
    const s = store(path);
    const e = put(s);
    s.backup(`${path}.bak`);
    writeFileSync(`${path}.bak.tmp`, 'a leftover from a crashed backup');
    s.backup(`${path}.bak`);
    s.close();
    expect(
      readdirSync(dir).filter((f) => f.startsWith('memory.db.bak'))
    ).toEqual(['memory.db.bak']);
    expect(statSync(join(dir, 'memory.db.bak')).mode & 0o777).toBe(0o600);
    const restored = store(`${path}.bak`);
    expect(restored.getEntry(e.id)).toEqual(e);
    expect(
      restored
        .searchEntries(['allowbuilds'], 'all', {}, 10)
        .map((h) => h.entry.id)
    ).toEqual([e.id]);
    restored.close();
  });
});
