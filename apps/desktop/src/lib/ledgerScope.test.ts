import type { LedgerEntry } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { taskLedgerEntries } from './ledgerScope';

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    id: 'l-000001',
    epicId: null,
    sourceTaskId: 't-1',
    kind: 'decision',
    title: 'Scope extended for run r-ca9858',
    detail: 'src/app.ts — needed to wire the new route',
    appliesTo: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('taskLedgerEntries', () => {
  test('keeps a project-wide entry sourced from this task', () => {
    const entries = [entry({ id: 'l-a' })];
    expect(taskLedgerEntries(entries, 't-1').map((e) => e.id)).toEqual(['l-a']);
  });

  test('drops entries sourced from another task', () => {
    expect(taskLedgerEntries([entry({ sourceTaskId: 't-2' })], 't-1')).toEqual(
      []
    );
  });

  test('drops entries with no source task at all', () => {
    expect(taskLedgerEntries([entry({ sourceTaskId: null })], 't-1')).toEqual(
      []
    );
  });

  test('leaves epic-scoped entries to the epic ledger', () => {
    // The epic's own view already renders these; repeating them on the task
    // would show the same entry twice for a task that has a parent.
    expect(taskLedgerEntries([entry({ epicId: 'e-1' })], 't-1')).toEqual([]);
  });
});
