import { describe, expect, it } from 'bun:test';

import type {
  Finding,
  FindingSeverity,
  FindingVerdict,
} from '../src/findings.js';
import { generateFindingId } from '../src/ids.js';

const SEVERITIES: FindingSeverity[] = ['critical', 'important', 'minor'];
const VERDICTS: FindingVerdict[] = ['open', 'addressed', 'parked', 'blocked'];

describe('generateFindingId', () => {
  it('mints the f-<6 hex> shape used by Finding.id', () => {
    expect(generateFindingId('2026-07-13T00:00:00Z')).toMatch(
      /^f-[0-9a-f]{6}$/
    );
  });
});

describe('Finding shape', () => {
  const base: Finding = {
    id: generateFindingId('2026-07-13T00:00:00Z', 'n1'),
    taskId: 't-abc123',
    runId: 'r-def456',
    severity: 'critical',
    verdict: 'open',
    title: 'Missing null check',
    detail: 'foo() can be called with null and throws.',
    file: 'src/foo.ts',
    line: 42,
    ruling: null,
    round: 0,
    createdAt: '2026-07-13T00:00:00Z',
    updatedAt: '2026-07-13T00:00:00Z',
  };

  it('accepts every declared severity and verdict', () => {
    for (const severity of SEVERITIES) {
      expect({ ...base, severity }.severity).toBe(severity);
    }
    for (const verdict of VERDICTS) {
      expect({ ...base, verdict }.verdict).toBe(verdict);
    }
  });

  it('allows runId, file, line and ruling to be null', () => {
    const minimal: Finding = { ...base, runId: null, file: null, line: null };
    expect(minimal.runId).toBeNull();
    expect(minimal.file).toBeNull();
    expect(minimal.line).toBeNull();
  });

  it('round-trips through JSON', () => {
    const revived = JSON.parse(JSON.stringify(base)) as Finding;
    expect(revived).toEqual(base);
  });
});
