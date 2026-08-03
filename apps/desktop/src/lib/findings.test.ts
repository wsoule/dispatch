import type { Finding } from '@dispatch/core/browser';
import { describe, expect, test } from 'bun:test';

import { countOpenFindings, groupOpenFindingsBySeverity } from './findings';

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
