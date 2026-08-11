import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PlanRecord } from '../src/api';
import {
  IMPACT_SUBJECT_KINDS,
  PATCHABLE_FINDING_VERDICTS,
  PLAN_ROLES,
} from '../src/api';

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

  it('IMPACT_SUBJECT_KINDS accepts exactly the subjects GET /api/impact does', () => {
    const found = literals(
      serverSource('api', 'impact.ts'),
      /const SUBJECT_KINDS[^=]*=\s*\[([^\]]*)\]/
    );
    expect(found).not.toBeNull();
    expect(found).toEqual([...IMPACT_SUBJECT_KINDS]);
  });
});

// The client's own source, read as text like the server's: the warden mirrors
// are inline literal unions on both sides (no exported const arrays), so
// parity is checked source-to-source.
function clientSource(): string {
  return readFileSync(join(import.meta.dir, '..', 'src', 'api.ts'), 'utf8');
}

// Field names (with their `?` optionality marker) of one exported interface,
// in declaration order. Returns null when the interface is gone.
function fields(source: string, name: string): string[] | null {
  const body = new RegExp(
    `export interface ${name} \\{([\\s\\S]*?)\\n\\}`
  ).exec(source)?.[1];
  if (body === undefined) return null;
  return [...body.matchAll(/\n {2}(\w+\??):/g)].map((m) => m[1]);
}

describe('warden types mirror dispatchd', () => {
  it('WardenRecord declares the same fields with the same optionality', () => {
    const server = fields(
      serverSource('orchestrator', 'warden.ts'),
      'WardenRecord'
    );
    const client = fields(clientSource(), 'WardenRecord');
    expect(server).not.toBeNull();
    expect(client).toEqual(server);
  });

  it('WardenMessage declares the same fields with the same optionality', () => {
    const server = fields(
      serverSource('orchestrator', 'warden.ts'),
      'WardenMessage'
    );
    const client = fields(clientSource(), 'WardenMessage');
    expect(server).not.toBeNull();
    expect(client).toEqual(server);
  });

  it('WardenAction declares the same fields with the same optionality', () => {
    const server = fields(
      serverSource('orchestrator', 'wardenTools.ts'),
      'WardenAction'
    );
    const client = fields(clientSource(), 'WardenAction');
    expect(server).not.toBeNull();
    expect(client).toEqual(server);
  });

  it('WardenState carries the same states the server stores', () => {
    const pattern = /type WardenState = ([^;]+);/;
    const server = literals(serverSource('orchestrator', 'warden.ts'), pattern);
    const client = literals(clientSource(), pattern);
    expect(server).not.toBeNull();
    expect(client).toEqual(server);
  });

  // The three inline literal unions inside the interfaces (message role,
  // action lifecycle outcome, action status) — field-name parity above says
  // nothing about their members.
  for (const [iface, field] of [
    ['WardenMessage', 'role'],
    ['WardenMessage', 'outcome?'],
    ['WardenAction', 'status'],
  ] as const) {
    it(`${iface}.${field} carries the same literals as the server`, () => {
      const file = iface === 'WardenAction' ? 'wardenTools.ts' : 'warden.ts';
      const bodyOf = (source: string): string | undefined =>
        new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`).exec(
          source
        )?.[1];
      const pattern = new RegExp(
        `\\n {2}${field.replace('?', '\\?')}: ([^;]+);`
      );
      const server = literals(
        bodyOf(serverSource('orchestrator', file)) ?? '',
        pattern
      );
      const client = literals(bodyOf(clientSource()) ?? '', pattern);
      expect(server).not.toBeNull();
      expect(client).toEqual(server);
    });
  }
});
