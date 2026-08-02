import { describe, expect, it } from 'bun:test';

import type { CommandEvidence, MutationEvidence } from '../src/evidence.js';

describe('CommandEvidence shape', () => {
  const base: CommandEvidence = {
    command: 'bun test',
    exitCode: 0,
    durationMs: 4200,
    summary: '158 pass, 0 fail',
    at: '2026-08-02T00:00:00.000Z',
  };

  it('round-trips through JSON', () => {
    const revived = JSON.parse(JSON.stringify(base)) as CommandEvidence;
    expect(revived).toEqual(base);
  });
});

describe('MutationEvidence shape', () => {
  const base: MutationEvidence = {
    guard: 'null check on foo()',
    file: 'src/foo.ts',
    testsFailed: 2,
    at: '2026-08-02T00:00:00.000Z',
  };

  it('accepts testsFailed: 0 as the red-flag case', () => {
    const vacuous: MutationEvidence = { ...base, testsFailed: 0 };
    expect(vacuous.testsFailed).toBe(0);
  });

  it('round-trips through JSON', () => {
    const revived = JSON.parse(JSON.stringify(base)) as MutationEvidence;
    expect(revived).toEqual(base);
  });
});
