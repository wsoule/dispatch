import { describe, expect, it } from 'bun:test';

import { truncateReason } from '../../src/orchestrator/mergeQueue.js';

describe('truncateReason', () => {
  it('leaves a normal failure message alone', () => {
    expect(truncateReason('rebase failed: conflict in src/a.ts')).toBe(
      'rebase failed: conflict in src/a.ts'
    );
  });

  it('keeps the end of a long one, where the actual error is', () => {
    const noise = 'setup line\n'.repeat(2000);
    const text = `${noise}FAIL src/thing.test.ts > it explodes`;
    const out = truncateReason(text);

    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain('FAIL src/thing.test.ts > it explodes');
    // Says what it dropped, so a truncated log is not mistaken for the whole
    // failure.
    expect(out).toMatch(/earlier characters omitted/);
  });

  it('bounds the result regardless of input size', () => {
    // The real case: a failing test suite wrote 268 KB into one entry's reason,
    // and three of those made a 898 KB queue file that is rewritten on every
    // state transition.
    const huge = 'x'.repeat(268_000);
    expect(truncateReason(huge).length).toBeLessThan(4200);
  });
});
