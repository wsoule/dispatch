import { describe, expect, it } from 'bun:test';

import { rankEntries, reaches, specificity } from '../src/rank.js';
import { newMemoryEntry } from '../src/records.js';
import type { MemoryEntry } from '../src/types.js';

const ctx = { taskId: 't-1a2b3c', milestone: 'e-000001' };
let n = 0;
function e(over: Partial<MemoryEntry> = {}): MemoryEntry {
  n += 1;
  return {
    ...newMemoryEntry(
      {
        scope: 'team',
        kind: 'fact',
        title: `t${n}`,
        body: '',
        author: 'run:r-1',
        trust: 'agent',
      },
      `mem-${String(n).padStart(26, '0')}`,
      '2026-09-01T00:00:00.000Z'
    ),
    ...over,
  };
}
const r = (entry: MemoryEntry, matched = false, score = 0) => ({
  entry,
  matched,
  score,
});
const order = (items: ReturnType<typeof r>[]) =>
  rankEntries(items, ctx).map((x) => x.entry.title);

describe('rank', () => {
  it('compares pinned, kind class, specificity, relevance, trust, recency, id — in that order', () => {
    const pinnedFact = e({ pinned: true, title: 'pinned-fact' });
    const hazard = e({ kind: 'hazard', title: 'hazard' });
    expect(order([r(hazard), r(pinnedFact)])).toEqual([
      'pinned-fact',
      'hazard',
    ]);
    const taskFact = e({ appliesTo: ['t-1a2b3c'], title: 'task-fact' });
    const decision = e({ kind: 'decision', title: 'decision' });
    expect(order([r(taskFact), r(decision)])).toEqual([
      'decision',
      'task-fact',
    ]);
    const milestoneFact = e({ milestone: 'e-000001', title: 'milestone-fact' });
    expect(
      order([r(e({ title: 'wide' })), r(milestoneFact), r(taskFact)])
    ).toEqual(['task-fact', 'milestone-fact', 'wide']);
    expect(
      order([
        r(e({ title: 'unmatched' })),
        r(e({ title: 'weak' }), true, -1),
        r(e({ title: 'strong' }), true, -9),
      ])
    ).toEqual(['strong', 'weak', 'unmatched']);
    expect(
      order([
        r(e({ title: 'agent' })),
        r(e({ title: 'human', trust: 'human' })),
        r(e({ title: 'confirmed', trust: 'confirmed' })),
      ])
    ).toEqual(['human', 'confirmed', 'agent']);
    expect(
      order([
        r(e({ title: 'old' })),
        r(e({ title: 'recalled', lastRecalledAt: '2026-09-20T00:00:00.000Z' })),
      ])
    ).toEqual(['recalled', 'old']);
  });

  it('reaches by milestone, appliesTo and personal project key', () => {
    expect(reaches(e({ milestone: 'e-000009' }), ctx, 'aaaaaaaaaaaa')).toBe(
      false
    );
    expect(reaches(e({ appliesTo: ['t-ffffff'] }), ctx, 'aaaaaaaaaaaa')).toBe(
      false
    );
    expect(
      reaches(
        e({ scope: 'personal', projectKey: 'bbbbbbbbbbbb' }),
        ctx,
        'aaaaaaaaaaaa'
      )
    ).toBe(false);
    expect(
      reaches(e({ scope: 'personal', projectKey: null }), ctx, 'aaaaaaaaaaaa')
    ).toBe(true);
    // No task context (the overseer, an empty search): everything shared reaches, ranked as specificity 1.
    expect(
      reaches(
        e({ milestone: 'e-000009' }),
        { taskId: null, milestone: null },
        'aaaaaaaaaaaa'
      )
    ).toBe(true);
    expect(
      specificity(e({ milestone: 'e-000009' }), {
        taskId: null,
        milestone: null,
      })
    ).toBe(1);
  });

  // A milestone's page lists the lessons its tasks' runs narrowed to it.
  it('reaches the milestone itself with an entry narrowed to it', () => {
    const milestone = { taskId: 'e-000001', milestone: null };
    expect(
      reaches(e({ milestone: 'e-000001' }), milestone, 'aaaaaaaaaaaa')
    ).toBe(true);
    expect(
      reaches(e({ milestone: 'e-000009' }), milestone, 'aaaaaaaaaaaa')
    ).toBe(false);
    expect(specificity(e({ milestone: 'e-000001' }), milestone)).toBe(2);
  });
});
