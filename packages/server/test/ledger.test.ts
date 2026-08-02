import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LedgerStore } from '../src/ledger';

function root(): string {
  return mkdtempSync(join(tmpdir(), 'dispatch-ledger-'));
}

describe('LedgerStore', () => {
  test('add() writes one JSONL line and defaults epicId/appliesTo', () => {
    const store = new LedgerStore(root());
    const entry = store.add({
      kind: 'hazard',
      title: 'withActionFeedback swallows rejections',
      detail: 'every catch downstream of it is dead code',
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
    store.add({ kind: 'decision', title: 'a', detail: 'a' });
    store.add({ kind: 'constraint', title: 'b', detail: 'b' });

    const file = readFileSync(join(dir, '.dispatch', 'ledger.jsonl'), 'utf8');
    expect(file.trim().split('\n')).toHaveLength(2);
    expect(store.list()).toHaveLength(2);
  });

  test('list({ epicId }) filters to that epic, including project-wide-only when epicId is null', () => {
    const store = new LedgerStore(root());
    const wide = store.add({ kind: 'decision', title: 'a', detail: 'a' });
    const scoped = store.add({
      epicId: 'e-111111',
      kind: 'decision',
      title: 'b',
      detail: 'b',
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
      });

      expect(store.entriesFor('t-target', 'e-111111')).toEqual([entry]);
      expect(store.entriesFor('t-sibling', 'e-111111')).toEqual([]);
    });

    test('a store with no file yet applies nothing', () => {
      const store = new LedgerStore(root());
      expect(store.entriesFor('t-a', null)).toEqual([]);
    });
  });
});
