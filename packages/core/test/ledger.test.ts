import { describe, expect, it } from 'bun:test';

import { generateLedgerId } from '../src/ids.js';
import type { LedgerEntry } from '../src/ledger.js';

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

  it('round-trips through JSON', () => {
    const revived = JSON.parse(JSON.stringify(base)) as LedgerEntry;
    expect(revived).toEqual(base);
  });

  // JSON.stringify drops undefined, so a field turned optional rather than
  // nullable would silently vanish from a stored project-wide entry.
  it('round-trips a project-wide entry with its nulls, not as absent keys', () => {
    const projectWide: LedgerEntry = {
      ...base,
      epicId: null,
      sourceTaskId: null,
      appliesTo: [],
    };
    const revived = JSON.parse(JSON.stringify(projectWide)) as LedgerEntry;
    expect(revived).toEqual(projectWide);
    expect(Object.keys(revived).sort()).toEqual(
      Object.keys(projectWide).sort()
    );
  });
});
