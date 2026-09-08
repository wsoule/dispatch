import type { LedgerEntry } from '@dispatch/core/browser';
import { describePolicyAuthorization } from '@dispatch/core/browser';
import { describe, expect, test } from 'bun:test';

import { isPolicyReceipt, policyReceipts } from './policyReceipts';

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    id: 'l-000001',
    epicId: null,
    sourceTaskId: 't-aaaaaa',
    kind: 'decision',
    title: 'Scope extended for run r-x',
    detail: 'src/x.ts — needed',
    appliesTo: [],
    authoredBy: 'human:x',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('isPolicyReceipt', () => {
  // The marker is core's phrasing, so a rewording there must fail here
  // rather than silently emptying the receipts panel.
  test('recognizes the authorization line core writes for a rung demotion', () => {
    const line = describePolicyAuthorization({
      mode: 'auto',
      gate: 'scope',
      rung: 2,
      authorizedBy: 'rung',
    });
    expect(isPolicyReceipt(entry({ detail: `granted — ${line}` }))).toBe(true);
  });

  test('recognizes the authorization line for a per-gate override', () => {
    const line = describePolicyAuthorization({
      mode: 'auto',
      gate: 'merge',
      rung: 1,
      authorizedBy: 'override',
    });
    expect(isPolicyReceipt(entry({ detail: line }))).toBe(true);
  });

  test('a human decision is not a receipt', () => {
    expect(
      isPolicyReceipt(entry({ detail: 'granted [decided via app]' }))
    ).toBe(false);
  });

  test('only decisions count, even when a hazard quotes the marker', () => {
    expect(
      isPolicyReceipt(
        entry({ kind: 'hazard', detail: 'this was auto-decided by nobody' })
      )
    ).toBe(false);
  });
});

describe('policyReceipts', () => {
  test('filters to receipts, newest first, capped', () => {
    const auto = (id: string, createdAt: string) =>
      entry({
        id,
        createdAt,
        detail: describePolicyAuthorization({
          mode: 'auto',
          gate: 'scope',
          rung: 2,
          authorizedBy: 'rung',
        }),
      });
    const result = policyReceipts(
      [
        auto('l-1', '2026-09-01T00:00:00.000Z'),
        entry({ id: 'l-h', detail: 'by hand' }),
        auto('l-3', '2026-09-03T00:00:00.000Z'),
        auto('l-2', '2026-09-02T00:00:00.000Z'),
      ],
      2
    );
    expect(result.map((e) => e.id)).toEqual(['l-3', 'l-2']);
  });
});
