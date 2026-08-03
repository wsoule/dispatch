import { describe, expect, it } from 'bun:test';

import type { DraftRecord } from '../../src/orchestrator/plan.js';
import { sortDraftsNewestFirst } from '../../src/orchestrator/plan.js';

function draft(id: string, createdAt: string): DraftRecord {
  return { id, createdAt, state: 'ready' } as unknown as DraftRecord;
}

describe('sortDraftsNewestFirst', () => {
  it('puts a later createdAt first', () => {
    const sorted = sortDraftsNewestFirst([
      draft('d-old', '2026-08-03T10:00:00.000Z'),
      draft('d-new', '2026-08-03T10:00:01.000Z'),
    ]);
    expect(sorted.map((d) => d.id)).toEqual(['d-new', 'd-old']);
  });

  // Two drafts raised inside one millisecond carry the same timestamp, which
  // is the case that made the API's ordering assertion flaky under load.
  it('breaks a same-millisecond tie toward the later-inserted draft', () => {
    const same = '2026-08-03T10:00:00.000Z';
    const sorted = sortDraftsNewestFirst([
      draft('d-first', same),
      draft('d-second', same),
    ]);
    expect(sorted.map((d) => d.id)).toEqual(['d-second', 'd-first']);
  });

  it('keeps ties ordered across a mixed batch', () => {
    const same = '2026-08-03T10:00:00.000Z';
    const sorted = sortDraftsNewestFirst([
      draft('d-a', same),
      draft('d-b', same),
      draft('d-newest', '2026-08-03T10:00:05.000Z'),
    ]);
    expect(sorted.map((d) => d.id)).toEqual(['d-newest', 'd-b', 'd-a']);
  });
});
