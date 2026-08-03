import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PlanRecord } from '../src/api';
import { PATCHABLE_FINDING_VERDICTS, PLAN_ROLES } from '../src/api';

// api.ts's types are hand-copied from dispatchd, which this package cannot
// import, so these read the server source as text and fail on drift.
function serverSource(...segments: string[]): string {
  return readFileSync(
    join(import.meta.dir, '..', '..', 'server', 'src', ...segments),
    'utf8'
  );
}

// Pulls the string literals out of an array or union declaration. Returns null
// when the pattern is gone, which is itself a reason to re-check the mirror.
function literals(source: string, pattern: RegExp): string[] | null {
  const match = pattern.exec(source);
  if (match?.[1] === undefined) return null;
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('client types mirror dispatchd', () => {
  it('UpdateFindingPatch accepts exactly the verdicts the PATCH route does', () => {
    const found = literals(
      serverSource('api', 'findings.ts'),
      /const PATCHABLE_VERDICTS[^=]*=\s*\[([^\]]*)\]/
    );
    expect(found).not.toBeNull();
    expect(found).toEqual([...PATCHABLE_FINDING_VERDICTS]);
  });

  it('PlanRecord.role carries the same roles the server stores', () => {
    // Scoped to the interface body first: `role` is also a PlanMessage field
    // and a resolveModel parameter in the same file.
    const body = /export interface PlanRecord \{([\s\S]*?)\n\}/.exec(
      serverSource('orchestrator', 'plan.ts')
    )?.[1];
    expect(body).toBeDefined();
    const found = literals(body ?? '', /\n {2}role: ([^;]+);/);
    expect(found).not.toBeNull();
    expect(found).toEqual([...PLAN_ROLES]);
  });

  // A PlanRecord without `role` must not typecheck: `tsc` is the assertion
  // here, the runtime expectation only keeps the fixture from being elided.
  it('PlanRecord names role as a required field', () => {
    const record: Pick<PlanRecord, 'id' | 'role'> = {
      id: 'plan-abc123',
      role: 'enrich',
    };
    expect(record.role).toBe('enrich');
  });
});
