import type { Finding } from '@dispatch/core/browser';
import { describe, expect, test } from 'bun:test';

import {
  countOpenFindings,
  findingWarnings,
  groupOpenFindingsBySeverity,
  partitionFindings,
  ruleKeyOf,
} from './findings';

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: 'f-1',
    taskId: 't-1',
    runId: null,
    severity: 'minor',
    verdict: 'open',
    title: 'Title',
    detail: 'Detail',
    file: null,
    line: null,
    ruling: null,
    round: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    raisedBy: '',
    ...overrides,
  };
}

describe('groupOpenFindingsBySeverity', () => {
  test('groups only open findings, most severe first', () => {
    const groups = groupOpenFindingsBySeverity([
      finding({ id: 'f-1', severity: 'minor' }),
      finding({ id: 'f-2', severity: 'critical' }),
      finding({ id: 'f-3', severity: 'important' }),
      finding({ id: 'f-4', severity: 'critical', verdict: 'addressed' }),
    ]);
    expect(groups.map((g) => g.severity)).toEqual([
      'critical',
      'important',
      'minor',
    ]);
    expect(groups[0]?.findings.map((f) => f.id)).toEqual(['f-2']);
  });

  test('omits a severity with nothing open rather than an empty group', () => {
    const groups = groupOpenFindingsBySeverity([
      finding({ id: 'f-1', severity: 'minor', verdict: 'parked' }),
    ]);
    expect(groups).toEqual([]);
  });
});

describe('countOpenFindings', () => {
  test('counts overall and per severity, ignoring non-open verdicts', () => {
    const counts = countOpenFindings([
      finding({ id: 'f-1', severity: 'critical' }),
      finding({ id: 'f-2', severity: 'critical' }),
      finding({ id: 'f-3', severity: 'minor' }),
      finding({ id: 'f-4', severity: 'minor', verdict: 'blocked' }),
    ]);
    expect(counts).toEqual({ open: 3, critical: 2, important: 0, minor: 1 });
  });
});

describe('ruleKeyOf', () => {
  test('a per-file check keys on the text before its path', () => {
    expect(
      ruleKeyOf(
        finding({ title: 'file changed outside declared writes: apps/a.ts' })
      )
    ).toBe('file changed outside declared writes');
  });

  test('a batched check keys on its whole title', () => {
    expect(
      ruleKeyOf(finding({ title: '139 files changed outside declared writes' }))
    ).toBe('139 files changed outside declared writes');
  });
});

describe('partitionFindings', () => {
  const check = (over: Partial<Finding>) =>
    finding({ raisedBy: 'none', ...over });

  test('splits what an agent judged from what a check reported', () => {
    const { judgment, checks } = partitionFindings([
      finding({ id: 'f-1', severity: 'important', raisedBy: 'agent:a' }),
      check({ id: 'f-2', title: 'rule: a.ts', file: 'a.ts' }),
    ]);
    expect(judgment.flatMap((g) => g.findings.map((f) => f.id))).toEqual([
      'f-1',
    ]);
    expect(checks.map((c) => c.rule)).toEqual(['rule']);
  });

  // The 139 records already on disk are the reason this function exists.
  test('collapses a run of per-file checks into one rule', () => {
    const legacy = ['a.ts', 'b.ts', 'c.ts'].map((path, i) =>
      check({
        id: `f-${i}`,
        title: `file changed outside declared writes: ${path}`,
        file: path,
      })
    );
    const { judgment, checks } = partitionFindings(legacy);
    expect(judgment).toEqual([]);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.files).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(checks[0]?.findings).toHaveLength(3);
  });

  test('reads a batched check straight off its files array', () => {
    const { checks } = partitionFindings([
      check({
        title: '3 files changed outside declared writes',
        file: null,
        files: ['a.ts', 'b.ts', 'c.ts'],
      }),
    ]);
    expect(checks[0]?.files).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  test('does not list a path twice when records overlap', () => {
    const { checks } = partitionFindings([
      check({
        id: 'f-1',
        title: 'file changed outside declared writes: a.ts',
        file: 'a.ts',
      }),
      check({
        id: 'f-2',
        title: 'file changed outside declared writes: a.ts',
        file: 'a.ts',
      }),
    ]);
    expect(checks[0]?.files).toEqual(['a.ts']);
  });

  test('ignores findings that are no longer open', () => {
    const { judgment, checks } = partitionFindings([
      finding({ id: 'f-1', verdict: 'parked', raisedBy: 'agent:a' }),
      check({ id: 'f-2', verdict: 'addressed', title: 'rule: a.ts' }),
    ]);
    expect(judgment).toEqual([]);
    expect(checks).toEqual([]);
  });
});

describe('findingWarnings', () => {
  // Checks count rules, not rows: one rule can span a hundred files.
  test('counts judgment and rules separately', () => {
    const partition = partitionFindings([
      finding({ id: 'f-1', severity: 'important', raisedBy: 'agent:a' }),
      finding({
        id: 'f-2',
        raisedBy: 'none',
        title: 'file changed outside declared writes: a.ts',
        file: 'a.ts',
      }),
      finding({
        id: 'f-3',
        raisedBy: 'none',
        title: 'file changed outside declared writes: b.ts',
        file: 'b.ts',
      }),
    ]);
    expect(findingWarnings(partition)).toEqual([
      '1 open finding',
      '1 check fired',
    ]);
  });

  test('pluralises each clause on its own count', () => {
    const partition = partitionFindings([
      finding({ id: 'f-1', severity: 'critical', raisedBy: 'agent:a' }),
      finding({ id: 'f-2', severity: 'minor', raisedBy: 'agent:b' }),
      finding({ id: 'f-3', raisedBy: 'none', title: 'rule one: a.ts' }),
      finding({ id: 'f-4', raisedBy: 'none', title: 'rule two: b.ts' }),
    ]);
    expect(findingWarnings(partition)).toEqual([
      '2 open findings',
      '2 checks fired',
    ]);
  });

  test('omits a clause with nothing in it rather than saying zero', () => {
    expect(findingWarnings(partitionFindings([]))).toEqual([]);
  });
});
