import type { CommandEvidence, MutationEvidence } from '@dispatch/core/browser';
import { describe, expect, test } from 'bun:test';

import { caseWarnings, isDeadGuard, summarizeCase } from './reviewCase';

const cmd = (exitCode: number): CommandEvidence => ({
  command: 'bun test',
  exitCode,
  durationMs: 1200,
  summary: '158 pass, 0 fail',
  at: '2026-08-03T00:00:00.000Z',
});

const mut = (testsFailed: number): MutationEvidence => ({
  guard: 'taskId guard',
  file: 'a.ts',
  testsFailed,
  at: '2026-08-03T00:00:00.000Z',
});

describe('isDeadGuard', () => {
  test('zero failures means the guard is dead or its test vacuous', () => {
    expect(isDeadGuard(mut(0))).toBe(true);
  });

  test('a guard whose removal broke tests is live', () => {
    expect(isDeadGuard(mut(3))).toBe(false);
  });
});

describe('summarizeCase', () => {
  test('no evidence is distinguishable from passing evidence', () => {
    expect(summarizeCase([], [])).toEqual({
      commands: 0,
      failedCommands: 0,
      deadGuards: 0,
      hasEvidence: false,
    });
    expect(summarizeCase([cmd(0)], []).hasEvidence).toBe(true);
  });

  test('counts failed commands and dead guards', () => {
    expect(summarizeCase([cmd(0), cmd(1)], [mut(0), mut(2), mut(0)])).toEqual({
      commands: 2,
      failedCommands: 1,
      deadGuards: 2,
      hasEvidence: true,
    });
  });

  test('mutations alone still count as evidence', () => {
    expect(summarizeCase([], [mut(2)]).hasEvidence).toBe(true);
  });
});

describe('caseWarnings', () => {
  test('a clean case warns about nothing', () => {
    expect(caseWarnings(summarizeCase([cmd(0)], [mut(2)]))).toEqual([]);
  });

  test('the absence of any evidence is itself the warning', () => {
    expect(caseWarnings(summarizeCase([], []))).toEqual([
      'no recorded verification',
    ]);
  });

  test('failures and dead guards are pluralised', () => {
    expect(caseWarnings(summarizeCase([cmd(1)], [mut(0)]))).toEqual([
      '1 failed command',
      '1 dead guard',
    ]);
    expect(
      caseWarnings(summarizeCase([cmd(1), cmd(1)], [mut(0), mut(0)]))
    ).toEqual(['2 failed commands', '2 dead guards']);
  });
});
