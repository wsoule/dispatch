import { describe, expect, it } from 'bun:test';

import { generateLedgerId } from '../src/ids.js';
import type { LedgerEntry, LedgerKind } from '../src/ledger.js';

const KINDS: LedgerKind[] = ['constraint', 'hazard', 'decision', 'handoff'];

describe('generateLedgerId', () => {
  it('mints the l-<6 hex> shape used by LedgerEntry.id', () => {
    expect(generateLedgerId('2026-07-13T00:00:00Z')).toMatch(/^l-[0-9a-f]{6}$/);
  });
});

describe('LedgerEntry shape', () => {
  const base: LedgerEntry = {
    id: generateLedgerId('2026-07-13T00:00:00Z', 'n1'),
    epicId: 'e-abc123',
    sourceTaskId: 't-def456',
    kind: 'constraint',
    title: 'Auth tokens are opaque',
    detail: 'Never decode the session token client-side.',
    appliesTo: ['t-def456'],
    createdAt: '2026-07-13T00:00:00Z',
  };

  it('accepts every declared kind', () => {
    for (const kind of KINDS) {
      expect({ ...base, kind }.kind).toBe(kind);
    }
  });

  it('allows epicId and sourceTaskId to be null, appliesTo to be empty', () => {
    const projectWide: LedgerEntry = {
      ...base,
      epicId: null,
      sourceTaskId: null,
      appliesTo: [],
    };
    expect(projectWide.epicId).toBeNull();
    expect(projectWide.sourceTaskId).toBeNull();
    expect(projectWide.appliesTo).toEqual([]);
  });

  it('round-trips through JSON', () => {
    const revived = JSON.parse(JSON.stringify(base)) as LedgerEntry;
    expect(revived).toEqual(base);
  });
});
