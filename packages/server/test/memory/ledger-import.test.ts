import { describeFloorHold, describePolicyAuthorization } from '@dispatch/core';
import type { LedgerEntry } from '@dispatch/core';
import {
  createMemoryIds,
  openMemoryDb,
  SqliteMemoryStore,
} from '@dispatch/memory';
import type { MemoryStore } from '@dispatch/memory';
import { describe, expect, it } from 'bun:test';

import {
  DEP_MAP_DEGRADED_TITLE,
  scopeExtensionTitle,
  undeclaredWritesTitle,
} from '../../src/ledger.js';
import {
  classifyLedgerEntry,
  importLedger,
  ledgerOrigin,
  renderImportReport,
} from '../../src/memory/ledgerImport.js';

const NOW = new Date('2026-09-25T10:00:00.000Z');
let n = 0;
function row(over: Partial<LedgerEntry> = {}): LedgerEntry {
  n += 1;
  return {
    id: `l-${n.toString(16).padStart(6, '0')}`,
    epicId: null,
    sourceTaskId: 't-1a2b3c',
    kind: 'hazard',
    title: `lesson ${n}`,
    detail: 'what to do',
    appliesTo: [],
    createdAt: `2026-09-0${(n % 9) + 1}T00:00:00.000Z`,
    authoredBy: 'agent:wyat/claude',
    ...over,
  };
}
const fresh = () => new SqliteMemoryStore(openMemoryDb(':memory:'));
// Answers the overridden methods itself; every other method keeps its `this`.
function wrapStore(
  store: SqliteMemoryStore,
  override: Partial<MemoryStore>
): MemoryStore {
  return new Proxy(store, {
    get(target, prop) {
      if (Object.hasOwn(override, prop))
        return override[prop as keyof MemoryStore];
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
const run = (
  store: SqliteMemoryStore,
  rows: LedgerEntry[],
  extra: Partial<Parameters<typeof importLedger>[0]> = {}
) =>
  importLedger({
    rows,
    damaged: 0,
    store,
    ids: createMemoryIds(),
    now: NOW,
    cutoverAt: null,
    cutoverSwept: false,
    ...extra,
  });

describe('classifyLedgerEntry', () => {
  it('sends receipts to audit, pinned to core’s own wording', () => {
    const policy = describePolicyAuthorization({
      mode: 'auto',
      gate: 'scope',
      rung: 2,
      authorizedBy: 'rung',
    });
    expect(
      classifyLedgerEntry(
        row({ kind: 'decision', detail: `granted — ${policy}` })
      )
    ).toEqual({ to: 'audit', reason: 'policy' });
    expect(
      classifyLedgerEntry(
        row({
          kind: 'decision',
          detail: `x — ${describeFloorHold('force-push')}`,
        })
      )
    ).toEqual({ to: 'audit', reason: 'floor' });
    expect(classifyLedgerEntry(row({ kind: 'handoff' }))).toEqual({
      to: 'audit',
      reason: 'handoff',
    });
    expect(
      classifyLedgerEntry(
        row({ kind: 'decision', title: scopeExtensionTitle('r-9f2c01') })
      )
    ).toEqual({ to: 'audit', reason: 'scope' });
    expect(
      classifyLedgerEntry(
        row({ authoredBy: 'none', title: undeclaredWritesTitle(3) })
      )
    ).toEqual({ to: 'audit', reason: 'undeclared-writes' });
    expect(
      classifyLedgerEntry(
        row({
          authoredBy: 'none',
          title: 'changed src/a.ts outside its declared writes',
        })
      )
    ).toEqual({ to: 'audit', reason: 'undeclared-writes' });
    expect(
      classifyLedgerEntry(
        row({ authoredBy: 'none', title: DEP_MAP_DEGRADED_TITLE })
      )
    ).toEqual({ to: 'audit', reason: 'dep-map' });
  });

  it('keeps lessons, including an undeclared-writes title a human wrote', () => {
    expect(classifyLedgerEntry(row())).toEqual({ to: 'memory' });
    expect(classifyLedgerEntry(row({ kind: 'constraint' }))).toEqual({
      to: 'memory',
    });
    expect(
      classifyLedgerEntry(
        row({ title: 'changed 3 files outside its declared writes' })
      )
    ).toEqual({ to: 'memory' });
  });
});

describe('importLedger', () => {
  it('imports lessons as active team entries with agent trust, and proves parity', () => {
    const store = fresh();
    const rows = [
      row({
        epicId: 'e-000001',
        appliesTo: ['t-ffffff'],
        authoredBy: 'human:wyat',
      }),
      row({ authoredBy: '' }),
      row({ authoredBy: 'none', title: 'dependency map degraded' }),
    ];
    const report = run(store, rows);
    expect(report.outcome).toBe('ok');
    expect(report).toMatchObject({
      read: 3,
      damaged: 0,
      memory: { total: 2, imported: 2, proposed: 0 },
      audit: { total: 1, 'dep-map': 1 },
      memoryRows: { before: 0, after: 2 },
    });
    const imported = store.listEntries();
    expect(imported.map((e) => [e.scope, e.trust, e.status])).toEqual([
      ['team', 'agent', 'active'],
      ['team', 'agent', 'active'],
    ]);
    expect(imported[0]).toMatchObject({
      epic: 'e-000001',
      appliesTo: ['t-ffffff'],
      refs: [{ type: 'task', id: 't-1a2b3c' }],
      author: 'human:wyat',
      origin: ledgerOrigin(rows[0]),
      createdAt: rows[0].createdAt,
      lastRecalledAt: NOW.toISOString(),
    });
    expect(imported[1].author).toBe('agent:dispatch');
  });

  it('is idempotent by origin', () => {
    const store = fresh();
    const rows = [row(), row()];
    run(store, rows);
    const again = run(store, rows);
    expect(again.memory).toMatchObject({ imported: 0, alreadyImported: 2 });
    expect(store.countEntries()).toBe(2);
  });

  // Same id, different createdAt: two entries, both kept.
  it('imports duplicate ids with different createdAt as two entries', () => {
    const store = fresh();
    const first = row({
      id: 'l-aaaaaa',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    const second = row({
      id: 'l-aaaaaa',
      createdAt: '2026-09-02T00:00:00.000Z',
    });
    expect(run(store, [first, second]).memory.imported).toBe(2);
  });

  it('imports a lesson the ledger holds twice only once, counting the copy', () => {
    const store = fresh();
    const same = {
      title: 'pnpm 11 ignores onlyBuiltDependencies',
      detail: 'use allowBuilds',
    };
    const report = run(store, [row(same), row(same), row()]);
    expect(report.outcome).toBe('ok');
    expect(report.memory).toMatchObject({ imported: 2, duplicates: 1 });
    expect(store.countEntries()).toBe(2);
    expect(renderImportReport(report)).toContain('duplicates 1');
  });

  // A hard-deleted import never comes back on the next ledger change.
  it('keeps tombstoned origins gone', () => {
    const store = fresh();
    const lesson = row();
    run(store, [lesson]);
    store.deleteEntry(
      store.listEntries()[0].id,
      'human:wyat',
      NOW.toISOString()
    );
    const again = run(store, [
      lesson,
      row({
        kind: 'decision',
        detail: 'auto-decided by policy rung 2 (scope gate)',
      }),
    ]);
    expect(again.memory).toMatchObject({
      imported: 0,
      alreadyImported: 1,
      alreadyDeleted: 1,
    });
    expect(store.countEntries()).toBe(0);
  });

  it('cuts an 8 KiB-plus detail with a marker, and a long title into the body', () => {
    const store = fresh();
    const report = run(store, [
      row({ title: `${'t'.repeat(250)}`, detail: 'd'.repeat(9000) }),
    ]);
    const [e] = store.listEntries();
    expect(report.memory.truncated).toBe(1);
    expect(new TextEncoder().encode(e.title).byteLength).toBe(200);
    expect(new TextEncoder().encode(e.body).byteLength).toBeLessThanOrEqual(
      8192
    );
    expect(e.body.startsWith('t'.repeat(50))).toBe(true);
    expect(e.body).toMatch(/\[truncated on import: \d+ bytes\]$/);
  });

  it('truncates a long ledger lesson plainly: team entries never point at a doc (docs Task 18)', () => {
    const store = fresh();
    run(store, [row({ detail: 'x'.repeat(20_000) })]);
    const [entry] = store.listEntries();
    expect(entry.scope).toBe('team');
    expect(entry.body).toMatch(/\[truncated on import: \d+ bytes\]$/);
    expect(entry.refs.some((r) => r.type === 'doc')).toBe(false);
  });

  it('writes nothing on a dry run but reports the same counts', () => {
    const store = fresh();
    const report = run(store, [row(), row()], { dryRun: true });
    expect(report.outcome).toBe('dry-run');
    expect(report.memoryRows).toEqual({ before: 0, after: 2 });
    expect(store.countEntries()).toBe(0);
  });

  it('counts damaged rows in read without failing', () => {
    const report = run(fresh(), [row()], { damaged: 2 });
    expect(report).toMatchObject({ outcome: 'ok', read: 3, damaged: 2 });
  });

  // A hand-edited ledger line can carry any kind string; it is damage, not a lesson.
  it('counts a row of an unknown kind as damaged', () => {
    const store = fresh();
    const odd = { ...row(), kind: 'note' } as unknown as LedgerEntry;
    const report = run(store, [odd, row()], { damaged: 1 });
    expect(report).toMatchObject({
      outcome: 'ok',
      read: 3,
      damaged: 2,
      memory: { total: 1, imported: 1 },
    });
    expect(store.listEntries().map((e) => e.kind)).toEqual(['hazard']);
  });

  // Core's reader leaves these fields unchecked, so a hand-edited line can
  // carry any JSON there; neither side of the cutover may store or throw on it.
  for (const [field, value] of [
    ['epicId', ['e-123456']],
    ['sourceTaskId', ['t-123456']],
    ['authoredBy', 5],
  ] as const) {
    it(`counts a row whose ${field} is not a string as damaged`, () => {
      for (const cutoverAt of [null, '2026-01-01T00:00:00.000Z']) {
        const store = fresh();
        const odd = { ...row(), [field]: value } as unknown as LedgerEntry;
        const report = run(store, [odd, row()], { cutoverAt });
        expect(report).toMatchObject({
          outcome: 'ok',
          read: 2,
          damaged: 1,
          memory: { total: 1 },
        });
        expect(store.countEntries() + store.countOpenProposals()).toBe(1);
      }
    });
  }

  // In the ledger such a row reached no task; imported with an empty list it
  // would reach its whole epic or project.
  it('counts a row whose appliesTo names no task id as damaged', () => {
    const store = fresh();
    const report = run(store, [
      row({ appliesTo: ['not a task', 'T-1A2B3C'] }),
      row({ appliesTo: ['not a task', 't-abcdef'] }),
    ]);
    expect(report).toMatchObject({
      outcome: 'ok',
      read: 2,
      damaged: 1,
      memory: { total: 1, imported: 1 },
    });
    expect(store.listEntries()[0].appliesTo).toEqual(['t-abcdef']);
  });

  it('keeps the first 50 distinct targets and counts a longer list as truncated', () => {
    const ids = Array.from(
      { length: 60 },
      (_, i) => `t-${i.toString(16).padStart(6, '0')}`
    );
    const store = fresh();
    const report = run(store, [
      row({ appliesTo: ids.slice(0, 50).flatMap((id) => [id, id]) }),
      row({ appliesTo: ids }),
    ]);
    expect(report.memory).toMatchObject({ imported: 2, truncated: 1 });
    expect(store.listEntries().map((e) => e.appliesTo)).toEqual([
      ids.slice(0, 50),
      ids.slice(0, 50),
    ]);
  });

  it('keeps a title on one line and drops an author or task that is not a valid id', () => {
    const store = fresh();
    run(store, [
      row({
        title: 'first\n## Evil\r\nthird fourth',
        authoredBy: 'human:bad name\n## Evil',
        sourceTaskId: 'not a task',
      }),
    ]);
    const [e] = store.listEntries();
    expect(e.title).toBe('first ## Evil third fourth');
    expect(e.author).toBe('agent:dispatch');
    expect(e.refs).toEqual([]);
  });

  // A failed check writes nothing. The store lies about its row count after
  // the first call, as a trigger or a racing writer could.
  it('rolls back and reports MISMATCH when a check fails', () => {
    const store = fresh();
    let calls = 0;
    const lying = wrapStore(store, {
      countEntries: () => store.countEntries() + (calls++ > 0 ? 1 : 0),
    });
    const report = importLedger({
      rows: [row()],
      damaged: 0,
      store: lying,
      ids: createMemoryIds(),
      now: NOW,
      cutoverAt: null,
      cutoverSwept: false,
    });
    expect(report.outcome).toBe('MISMATCH');
    expect(report.mismatches[0]).toContain('memory rows');
    expect(store.countEntries()).toBe(0);
  });

  // A second process can write between a count taken outside the
  // transaction and its BEGIN, which would read as a false MISMATCH.
  it('takes the before counts inside the import’s own transaction', () => {
    const store = fresh();
    let raced = false;
    const racing = wrapStore(store, {
      transaction: <T>(fn: () => T): T => {
        if (!raced) {
          raced = true;
          run(store, [row()]);
        }
        return store.transaction(fn);
      },
    });
    const report = importLedger({
      rows: [row()],
      damaged: 0,
      store: racing,
      ids: createMemoryIds(),
      now: NOW,
      cutoverAt: null,
      cutoverSwept: false,
    });
    expect(report.outcome).toBe('ok');
    expect(report.memoryRows).toEqual({ before: 1, after: 2 });
    expect(store.countEntries()).toBe(2);
  });

  it('renders the report in the spec’s shape', () => {
    const text = renderImportReport(
      run(fresh(), [
        row(),
        row({
          authoredBy: 'none',
          title: 'changed 2 files outside its declared writes',
        }),
      ])
    );
    expect(text).toContain(
      'ledger rows read          2   (constraint 0 · hazard 2 · decision 0 · handoff 0)'
    );
    expect(text).toContain(
      '→ audit-only              1   (policy 0 · floor 0 · scope 0 · undeclared-writes 1 · dep-map 0 · handoff 0)'
    );
    expect(text).toContain('memory rows       0 → 1');
  });
});
