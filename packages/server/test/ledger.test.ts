import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LedgerStore } from '../src/ledger';

function root(): string {
  return mkdtempSync(join(tmpdir(), 'dispatch-ledger-'));
}

// Writes ledger.jsonl directly so a test can put lines in the file that the
// store would never mint on its own — here, two entries sharing one id.
function seedLines(dir: string, records: Record<string, unknown>[]): void {
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  writeFileSync(
    join(dir, '.dispatch', 'ledger.jsonl'),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`
  );
}

describe('LedgerStore', () => {
  test('add() writes one JSONL line and defaults epicId/appliesTo', () => {
    const store = new LedgerStore(root());
    const entry = store.add({
      kind: 'hazard',
      title: 'withActionFeedback swallows rejections',
      detail: 'every catch downstream of it is dead code',
      authoredBy: '',
    });
    expect(entry.epicId).toBeNull();
    expect(entry.sourceTaskId).toBeNull();
    expect(entry.appliesTo).toEqual([]);
    expect(store.list()).toEqual([entry]);
  });

  // Ledger entries are never edited — a second write for the same id is a
  // fresh append, so the file keeps growing rather than being rewritten.
  test('two adds append two lines, both readable back', () => {
    const dir = root();
    const store = new LedgerStore(dir);
    store.add({ kind: 'decision', title: 'a', detail: 'a', authoredBy: '' });
    store.add({ kind: 'constraint', title: 'b', detail: 'b', authoredBy: '' });

    const file = readFileSync(join(dir, '.dispatch', 'ledger.jsonl'), 'utf8');
    expect(file.trim().split('\n')).toHaveLength(2);
    expect(store.list()).toHaveLength(2);
  });

  test('list({ epicId }) filters to that epic, including project-wide-only when epicId is null', () => {
    const store = new LedgerStore(root());
    const wide = store.add({
      kind: 'decision',
      title: 'a',
      detail: 'a',
      authoredBy: '',
    });
    const scoped = store.add({
      epicId: 'e-111111',
      kind: 'decision',
      title: 'b',
      detail: 'b',
      authoredBy: '',
    });

    expect(store.list({ epicId: null }).map((e) => e.id)).toEqual([wide.id]);
    expect(store.list({ epicId: 'e-111111' }).map((e) => e.id)).toEqual([
      scoped.id,
    ]);
  });

  describe('entriesFor()', () => {
    test('an untargeted entry scoped to an epic applies to every task under it', () => {
      const store = new LedgerStore(root());
      const entry = store.add({
        epicId: 'e-111111',
        kind: 'hazard',
        title: 'shared trap',
        detail: 'watch out',
        authoredBy: '',
      });

      expect(store.entriesFor('t-under-epic', 'e-111111')).toEqual([entry]);
      expect(store.entriesFor('t-other-epic', 'e-222222')).toEqual([]);
      expect(store.entriesFor('t-no-epic', null)).toEqual([]);
    });

    test('a project-wide entry (epicId null) applies regardless of the task’s own epic', () => {
      const store = new LedgerStore(root());
      const entry = store.add({
        kind: 'constraint',
        title: 'always run bun run format',
        detail: 'before every commit',
        authoredBy: '',
      });

      expect(store.entriesFor('t-a', 'e-111111')).toEqual([entry]);
      expect(store.entriesFor('t-b', null)).toEqual([entry]);
    });

    test('a targeted entry (non-empty appliesTo) reaches only the listed tasks', () => {
      const store = new LedgerStore(root());
      const entry = store.add({
        epicId: 'e-111111',
        kind: 'decision',
        title: 'use fetch retries',
        detail: 'retry POSTs up to 3 times',
        appliesTo: ['t-target'],
        authoredBy: '',
      });

      expect(store.entriesFor('t-target', 'e-111111')).toEqual([entry]);
      expect(store.entriesFor('t-sibling', 'e-111111')).toEqual([]);
    });

    // Targeting is the stronger signal: an entry aimed at a task follows it
    // even when the epic it was raised under is not the task's own.
    test('an explicit appliesTo target wins regardless of epic', () => {
      const store = new LedgerStore(root());
      const entry = store.add({
        epicId: 'e-111111',
        kind: 'hazard',
        title: 'the migration renames this column',
        detail: 'coordinate with the other epic',
        appliesTo: ['t-target'],
        authoredBy: '',
      });

      expect(store.entriesFor('t-target', 'e-222222')).toEqual([entry]);
      expect(store.entriesFor('t-target', null)).toEqual([entry]);
    });

    test('a store with no file yet applies nothing', () => {
      const store = new LedgerStore(root());
      expect(store.entriesFor('t-a', null)).toEqual([]);
    });
  });
});

// A well-formed line, so a test only has to say what it wants to be wrong.
function ledgerLine(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'l-good01',
    epicId: null,
    sourceTaskId: null,
    kind: 'constraint',
    title: 'a real one',
    detail: 'detail',
    appliesTo: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('LedgerStore malformed lines', () => {
  test('a line that is not JSON costs itself, not the rest of the ledger', () => {
    const dir = root();
    mkdirSync(join(dir, '.dispatch'), { recursive: true });
    writeFileSync(
      join(dir, '.dispatch', 'ledger.jsonl'),
      [
        JSON.stringify(ledgerLine()),
        '{"id": "l-trunc0", "kind": "hazard"',
        JSON.stringify(ledgerLine({ id: 'l-good02' })),
      ].join('\n') + '\n'
    );

    const store = new LedgerStore(dir);
    expect(store.list().map((e) => e.id)).toEqual(['l-good01', 'l-good02']);
  });

  test('a parseable line that is not an entry is dropped rather than injected', () => {
    const dir = root();
    const { appliesTo: _dropped, ...noAppliesTo } = ledgerLine({
      id: 'l-bad001',
      title: 'the shapeless one',
    });
    const { id: _idLess, ...noId } = ledgerLine({ title: 'the id-less one' });
    seedLines(dir, [noAppliesTo, noId, ledgerLine()]);
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const store = new LedgerStore(dir);
      // Without the guard this throws: entriesFor calls .includes() on a
      // missing appliesTo.
      expect(store.entriesFor('t-a', null).map((e) => e.id)).toEqual([
        'l-good01',
      ]);
      expect(store.list().map((e) => e.id)).toEqual(['l-good01']);

      // Logged once per damaged line, not once per read.
      store.list();
      expect(errors).toHaveBeenCalledTimes(2);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('LedgerStore id collisions', () => {
  // Ledger entries are injected into later task prompts, so an entry dropped by
  // id-keyed compaction is a constraint the next agent never hears about.
  test('two entries sharing an id both survive compaction', () => {
    const dir = root();
    seedLines(dir, [
      {
        id: 'l-abc123',
        epicId: null,
        sourceTaskId: null,
        kind: 'constraint',
        title: 'the older entry',
        detail: 'never widen the public API without a version bump',
        appliesTo: [],
        createdAt: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 'l-abc123',
        epicId: null,
        sourceTaskId: null,
        kind: 'hazard',
        title: 'the newer entry',
        detail: 'the watcher misses renames on APFS',
        appliesTo: [],
        createdAt: '2026-07-02T00:00:00.000Z',
      },
    ]);
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const store = new LedgerStore(dir);
      expect(store.list()).toHaveLength(2);
      expect(store.entriesFor('t-a', null).map((e) => e.title)).toEqual([
        'the older entry',
        'the newer entry',
      ]);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toContain('l-abc123');
    } finally {
      errors.mockRestore();
    }
  });

  // The same line twice is one entry duplicated (a bad merge, a copied file),
  // not two entries — compaction should still collapse it.
  test('a line duplicated verbatim still compacts to one entry', () => {
    const dir = root();
    const line = {
      id: 'l-dupdup',
      epicId: null,
      sourceTaskId: null,
      kind: 'decision',
      title: 'one entry',
      detail: 'written twice',
      appliesTo: [],
      createdAt: '2026-07-01T00:00:00.000Z',
    };
    seedLines(dir, [line, line]);
    expect(new LedgerStore(dir).list()).toHaveLength(1);
  });

  test('add() re-mints when the generator hands back an id the file already holds', () => {
    const dir = root();
    const minted = ['l-dupdup', 'l-dupdup', 'l-fresh1'];
    let next = 0;
    const store = new LedgerStore(dir, () => minted[next++] ?? 'l-exhaust');
    const first = store.add({
      kind: 'decision',
      title: 'a',
      detail: 'a',
      authoredBy: '',
    });
    const second = store.add({
      kind: 'hazard',
      title: 'b',
      detail: 'b',
      authoredBy: '',
    });

    expect(first.id).toBe('l-dupdup');
    expect(second.id).toBe('l-fresh1');
    expect(store.list()).toHaveLength(2);
  });

  test('add() throws rather than reusing an id when every attempt is taken', () => {
    const dir = root();
    const store = new LedgerStore(dir, () => 'l-always');
    store.add({ kind: 'decision', title: 'a', detail: 'a', authoredBy: '' });
    expect(() =>
      store.add({ kind: 'hazard', title: 'b', detail: 'b', authoredBy: '' })
    ).toThrow(/unused ledger id/);
  });
});

describe('LedgerStore attribution', () => {
  test('round-trips the actor that authored an entry', () => {
    const root_ = root();
    const store = new LedgerStore(root_);
    const written = store.add({
      kind: 'decision',
      title: 'x',
      detail: 'y',
      authoredBy: 'agent:wyat/claude',
    });
    expect(new LedgerStore(root_).list()).toContainEqual(
      expect.objectContaining({
        id: written.id,
        authoredBy: 'agent:wyat/claude',
      })
    );
  });

  // ledger.jsonl is append-only and pre-dates authoredBy, so a legacy line
  // must still load with the field defaulted rather than undefined.
  test('defaults authoredBy on an entry written before attribution existed', () => {
    const dir = root();
    seedLines(dir, [
      {
        id: 'l-legacy',
        epicId: null,
        sourceTaskId: null,
        kind: 'decision',
        title: 'old',
        detail: '',
        appliesTo: [],
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    ]);
    expect(new LedgerStore(dir).list()[0]?.authoredBy).toBe('');
  });
});
