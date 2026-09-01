import type { RunClaim } from '@dispatch/client';
import { describe, expect, it } from 'bun:test';

import { findClaimOverlaps } from './claimOverlap';

function claim(runId: string, taskId: string, claims: string[]): RunClaim {
  return { runId, taskId, claims };
}

describe('findClaimOverlaps', () => {
  it('finds a glob-aware collision and names the overlapping claims', () => {
    const overlaps = findClaimOverlaps([
      claim('r-1', 't-1', ['packages/core/src/**', 'README.md']),
      claim('r-2', 't-2', ['packages/core/src/status.ts']),
    ]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].a.runId).toBe('r-1');
    expect(overlaps[0].b.runId).toBe('r-2');
    expect(overlaps[0].paths).toEqual(['packages/core/src/**']);
  });

  it('disjoint claims do not overlap', () => {
    expect(
      findClaimOverlaps([
        claim('r-1', 't-1', ['apps/desktop/**']),
        claim('r-2', 't-2', ['packages/server/**']),
      ])
    ).toHaveLength(0);
  });

  it('two runs of the same task are skipped', () => {
    expect(
      findClaimOverlaps([
        claim('r-1', 't-1', ['src/**']),
        claim('r-2', 't-1', ['src/**']),
      ])
    ).toHaveLength(0);
  });

  it('an empty claim set never collides', () => {
    expect(
      findClaimOverlaps([
        claim('r-1', 't-1', []),
        claim('r-2', 't-2', ['src/**']),
      ])
    ).toHaveLength(0);
  });
});
