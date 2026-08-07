import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_REVIEW_CAP } from './impactSummary';

// impactSummary.ts's DEFAULT_REVIEW_CAP is hand-copied from dispatchd's
// DEPENDENT_CAP, which apps/desktop cannot import (a browser app that only
// talks to the server over HTTP). Reads the server source as text at test
// time instead and fails on drift — the same mechanism
// packages/client/test/server-parity.test.ts already uses for
// IMPACT_SUBJECT_KINDS.
function serverSource(...segments: string[]): string {
  return readFileSync(
    join(
      import.meta.dir,
      '..',
      '..',
      '..',
      '..',
      'packages',
      'server',
      'src',
      ...segments
    ),
    'utf8'
  );
}

describe('desktop constants mirror dispatchd', () => {
  it("DEFAULT_REVIEW_CAP matches ReviewRunner's DEPENDENT_CAP", () => {
    const match = /const DEPENDENT_CAP\s*=\s*(\d+)/.exec(
      serverSource('orchestrator', 'review.ts')
    );
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(DEFAULT_REVIEW_CAP);
  });
});
