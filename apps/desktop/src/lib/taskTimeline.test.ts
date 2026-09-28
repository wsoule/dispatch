import { describe, expect, test } from 'bun:test';

import { parseActivity } from './activityFeed';
import { diffStat, taskTimeline, timelineKind } from './taskTimeline';

describe('timelineKind', () => {
  test.each([
    ['dispatched (claude, branch dispatch/t-1)', 'dispatched'],
    ['[run r-1] finished: finished — 3 files, $0.40', 'finished'],
    ['[run r-1] finished: failed — 0 files, $0.10', 'failed'],
    ['run r-1 merged into main', 'merged'],
    ['run r-1 discarded', 'discarded'],
    ['run r-1 opened PR: https://github.com/o/r/pull/4', 'pr'],
    ['requested changes (run r-1): tighten the tests', 'changes'],
    ['[run r-1] cancelled', 'stopped'],
    ['[epic] landed on main', 'merged'],
    ['moved to review', 'note'],
  ] as const)('%s', (text, kind) => {
    expect(timelineKind(text)).toBe(kind);
  });
});

test('the timeline is newest first, tags stripped, undated lines last', () => {
  const entries = parseActivity(
    [
      '- 2026-09-20T10:00:00.000Z dispatched (claude, branch b) — human:wyat',
      '- an old undated note',
      '- 2026-09-21T10:00:00.000Z [run r-1] finished: finished — 2 files, $0.30',
    ].join('\n')
  );
  // The dispatch is credited to a person and still reads as a dispatch.
  expect(taskTimeline(entries).map((i) => [i.kind, i.text])).toEqual([
    ['finished', 'finished — 2 files, $0.30'],
    ['dispatched', 'dispatched (claude, branch b)'],
    ['note', 'an old undated note'],
  ]);
});

test('diffStat counts body lines, not file headers', () => {
  const patch = [
    'diff --git a/x.ts b/x.ts',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1,2 +1,3 @@',
    ' keep',
    '-old',
    '+new',
    '+more',
  ].join('\n');
  expect(diffStat(patch, 1)).toEqual({
    files: 1,
    additions: 2,
    deletions: 1,
  });
});
