import type { Finding, FindingSeverity } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  composeRowDecoration,
  openFindingsByFile,
  splitByAttention,
  worstSeverity,
} from './reviewAttention';

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'f-000001',
  taskId: 't-1',
  runId: null,
  severity: 'minor',
  verdict: 'open',
  title: 'x',
  detail: 'y',
  file: 'a.ts',
  line: 1,
  ruling: null,
  round: 0,
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
  raisedBy: '',
  ...over,
});

const sev = (severity: FindingSeverity, file = 'a.ts'): Finding =>
  finding({ severity, file });

describe('composeRowDecoration', () => {
  test('an untouched file gets no decoration', () => {
    expect(composeRowDecoration({ viewed: false, comments: 0 })).toBeNull();
  });

  test('a viewed file gets a tick', () => {
    expect(composeRowDecoration({ viewed: true, comments: 0 })).toEqual({
      text: '✓',
      title: 'Viewed',
    });
  });

  test('one comment is singular', () => {
    expect(composeRowDecoration({ viewed: false, comments: 1 })).toEqual({
      text: '1',
      title: '1 unresolved comment',
    });
  });

  test('several comments are plural', () => {
    expect(composeRowDecoration({ viewed: false, comments: 2 })?.title).toBe(
      '2 unresolved comments'
    );
  });

  test('comments and viewed compose into one token', () => {
    expect(composeRowDecoration({ viewed: true, comments: 3 })).toEqual({
      text: '3 ✓',
      title: '3 unresolved comments · Viewed',
    });
  });

  test('a finding leads the token', () => {
    expect(
      composeRowDecoration({ viewed: false, comments: 0, severity: 'critical' })
    ).toEqual({ text: '⚠', title: 'critical finding' });
  });

  test('a finding composes with comments and viewed', () => {
    expect(
      composeRowDecoration({ viewed: true, comments: 1, severity: 'minor' })
    ).toEqual({
      text: '⚠ 1 ✓',
      title: 'minor finding · 1 unresolved comment · Viewed',
    });
  });
});

describe('worstSeverity', () => {
  test('critical outranks important outranks minor', () => {
    expect(worstSeverity([sev('minor'), sev('critical')])).toBe('critical');
    expect(worstSeverity([sev('minor'), sev('important')])).toBe('important');
  });

  test('no findings means no severity', () => {
    expect(worstSeverity([])).toBeNull();
  });

  test('adjudicated findings do not count', () => {
    expect(
      worstSeverity([finding({ severity: 'critical', verdict: 'parked' })])
    ).toBeNull();
  });
});

describe('openFindingsByFile', () => {
  test('buckets open findings by file', () => {
    const map = openFindingsByFile([
      sev('minor', 'a.ts'),
      sev('critical', 'b.ts'),
      sev('minor', 'a.ts'),
    ]);
    expect(map.get('a.ts')?.length).toBe(2);
    expect(map.get('b.ts')?.length).toBe(1);
  });

  test('a file-less finding is omitted rather than bucketed under empty', () => {
    expect(openFindingsByFile([finding({ file: null })]).size).toBe(0);
  });

  test('adjudicated findings are omitted', () => {
    expect(openFindingsByFile([finding({ verdict: 'addressed' })]).size).toBe(
      0
    );
  });
});

describe('splitByAttention', () => {
  const paths = ['a.ts', 'b.ts', 'c.ts'];

  // The load-bearing case. Splitting files into "needs your eyes" and "mechanical" on no
  // evidence would file every file under mechanical on the strength of nothing at all.
  test('no findings and no comments means no grouping', () => {
    expect(splitByAttention(paths, new Map(), new Map())).toEqual({
      grouped: false,
      needsEyes: [],
      mechanical: [],
    });
  });

  test('a file with a finding needs eyes; the rest are mechanical', () => {
    const result = splitByAttention(
      paths,
      new Map([['b.ts', [sev('minor', 'b.ts')]]]),
      new Map()
    );
    expect(result.grouped).toBe(true);
    expect(result.needsEyes).toEqual(['b.ts']);
    expect(result.mechanical).toEqual(['a.ts', 'c.ts']);
  });

  test('an unresolved comment also earns attention', () => {
    const result = splitByAttention(paths, new Map(), new Map([['c.ts', 1]]));
    expect(result.grouped).toBe(true);
    expect(result.needsEyes).toEqual(['c.ts']);
  });

  test('needs-eyes orders by severity, then by path', () => {
    const result = splitByAttention(
      paths,
      new Map([
        ['a.ts', [sev('minor', 'a.ts')]],
        ['b.ts', [sev('critical', 'b.ts')]],
        ['c.ts', [sev('minor', 'c.ts')]],
      ]),
      new Map()
    );
    expect(result.needsEyes).toEqual(['b.ts', 'a.ts', 'c.ts']);
  });

  test('a commented file with no finding sorts below every finding', () => {
    const result = splitByAttention(
      paths,
      new Map([['a.ts', [sev('minor', 'a.ts')]]]),
      new Map([['b.ts', 2]])
    );
    expect(result.needsEyes).toEqual(['a.ts', 'b.ts']);
  });
});
