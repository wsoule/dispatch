import { describe, expect, it } from 'bun:test';

import type { Finding } from '../src/findings.js';
import { generateFindingId } from '../src/ids.js';

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
    raisedBy: 'agent:wyat/claude',
  };

  it('round-trips through JSON', () => {
    const revived = JSON.parse(JSON.stringify(base)) as Finding;
    expect(revived).toEqual(base);
  });

  // JSON.stringify drops undefined, so a field turned optional rather than
  // nullable would silently vanish from every stored finding.
  it('round-trips its nullable fields as null, not as absent keys', () => {
    const nullable: Finding = {
      ...base,
      runId: null,
      file: null,
      line: null,
      ruling: null,
    };
    const revived = JSON.parse(JSON.stringify(nullable)) as Finding;
    expect(revived).toEqual(nullable);
    expect(Object.keys(revived).sort()).toEqual(Object.keys(nullable).sort());
  });
});
