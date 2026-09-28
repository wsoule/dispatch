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

// The client's own source, read as text like the server's: the overseer mirrors
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

// The `type: '…'` discriminants of the `export type ServerEvent =` union, in
// declaration order. The block ends at the first `};` — members' own `;`s
// always follow a field, never a closing brace.
function eventTypes(source: string): string[] | null {
  const body = /export type ServerEvent =([\s\S]*?\});/.exec(source)?.[1];
  if (body === undefined) return null;
  return [...body.matchAll(/type: '([^']+)'/g)].map((m) => m[1]);
}

describe('events mirror dispatchd', () => {
  it('ServerEvent carries the same variants the daemon broadcasts', () => {
    const server = eventTypes(serverSource('events.ts'));
    const client = eventTypes(clientSource());
    expect(server).not.toBeNull();
    expect(client).not.toBeNull();
    const byName = (a: string, b: string): number => a.localeCompare(b);
    expect([...(client ?? [])].sort(byName)).toEqual(
      [...(server ?? [])].sort(byName)
    );
  });

  it('epic.paused declares the same fields with the same optionality', () => {
    const member = (source: string): string[] | null => {
      const body = /\{\n {6}type: 'epic\.paused';([\s\S]*?)\n {4}\}/.exec(
        source
      )?.[1];
      if (body === undefined) return null;
      return [...body.matchAll(/\n {6}(\w+\??):/g)].map((m) => m[1]);
    };
    const server = member(serverSource('events.ts'));
    const client = member(clientSource());
    expect(server).not.toBeNull();
    expect(client).toEqual(server);
  });
});

describe('plan types mirror dispatchd', () => {
  it('PlanSummary carries the fields the server list() map emits', () => {
    // The server's PlanSummary is defined by what list() actually maps, so
    // the pin is against that object literal rather than the interface.
    const listBody = /list\(\): PlanSummary\[\] \{([\s\S]*?)\n {2}\}/.exec(
      serverSource('orchestrator', 'plan.ts')
    )?.[1];
    expect(listBody).toBeDefined();
    const mapped = [...(listBody ?? '').matchAll(/\n {8}(\w+): r\./g)].map(
      (m) => m[1]
    );
    expect(mapped.length).toBeGreaterThan(0);
    const client = fields(clientSource(), 'PlanSummary');
    expect(client?.map((f) => f.replace('?', ''))).toEqual(mapped);
    const server = fields(
      serverSource('orchestrator', 'plan.ts'),
      'PlanSummary'
    );
    expect(client).toEqual(server);
  });

  it('PlanRecord.epicId is optional on both sides', () => {
    const server = fields(
      serverSource('orchestrator', 'plan.ts'),
      'PlanRecord'
    );
    const client = fields(clientSource(), 'PlanRecord');
    expect(server).toContain('epicId?');
    expect(client).toContain('epicId?');
  });
});

describe('epic types mirror dispatchd', () => {
  for (const [iface, file] of [
    ['EpicSession', 'epic.ts'],
    ['EpicProgress', 'epic.ts'],
    ['EpicSpend', 'epicPhase.ts'],
    ['EpicProgressChild', 'epicPhase.ts'],
    ['EpicWave', 'epicPhase.ts'],
  ] as const) {
    it(`${iface} declares the same fields with the same optionality`, () => {
      const server = fields(serverSource('orchestrator', file), iface);
      const client = fields(clientSource(), iface);
      expect(server).not.toBeNull();
      expect(client).toEqual(server);
    });
  }

  for (const [name, file] of [
    ['EpicSessionState', 'epic.ts'],
    ['EpicPauseReason', 'epic.ts'],
    ['EpicChildPhase', 'epicPhase.ts'],
  ] as const) {
    it(`${name} carries the same literals as the server`, () => {
      // The server keeps a union file-private once nothing else in the daemon
      // imports it; the client still mirrors it, so `export` is optional here.
      const pattern = new RegExp(`(?:export )?type ${name} =([^;]+);`);
      const server = literals(serverSource('orchestrator', file), pattern);
      const client = literals(clientSource(), pattern);
      expect(server).not.toBeNull();
      expect(client).toEqual(server);
    });
  }
});

describe('overseer types mirror dispatchd', () => {
  it('OverseerRecord declares the same fields with the same optionality', () => {
    const server = fields(
      serverSource('orchestrator', 'overseer.ts'),
      'OverseerRecord'
    );
    const client = fields(clientSource(), 'OverseerRecord');
    expect(server).not.toBeNull();
    expect(client).toEqual(server);
  });

  it('OverseerMessage declares the same fields with the same optionality', () => {
    const server = fields(
      serverSource('orchestrator', 'overseer.ts'),
      'OverseerMessage'
    );
    const client = fields(clientSource(), 'OverseerMessage');
    expect(server).not.toBeNull();
    expect(client).toEqual(server);
  });

  it('OverseerAction declares the same fields with the same optionality', () => {
    const server = fields(
      serverSource('orchestrator', 'overseerTools.ts'),
      'OverseerAction'
    );
    const client = fields(clientSource(), 'OverseerAction');
    expect(server).not.toBeNull();
    expect(client).toEqual(server);
  });

  it('OverseerState carries the same states the server stores', () => {
    const pattern = /type OverseerState = ([^;]+);/;
    const server = literals(
      serverSource('orchestrator', 'overseer.ts'),
      pattern
    );
    const client = literals(clientSource(), pattern);
    expect(server).not.toBeNull();
    expect(client).toEqual(server);
  });

  // The three inline literal unions inside the interfaces (message role,
  // action lifecycle outcome, action status) — field-name parity above says
  // nothing about their members.
  for (const [iface, field] of [
    ['OverseerMessage', 'role'],
    ['OverseerMessage', 'outcome?'],
    ['OverseerAction', 'status'],
  ] as const) {
    it(`${iface}.${field} carries the same literals as the server`, () => {
      const file =
        iface === 'OverseerAction' ? 'overseerTools.ts' : 'overseer.ts';
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

  it('ExecutorInfo carries the same fields the daemon reports', () => {
    const fields = (source: string): string[] | undefined =>
      /export interface ExecutorInfo \{([\s\S]*?)\n\}/
        .exec(source)?.[1]
        .split('\n')
        .map((line) => /^ {2}(\w+):/.exec(line)?.[1])
        .filter((name): name is string => name !== undefined);
    const server = fields(serverSource('orchestrator', 'types.ts'));
    const client = fields(
      readFileSync(join(import.meta.dir, '..', 'src', 'api.ts'), 'utf8')
    );
    expect(server).toBeDefined();
    expect(client).toEqual(server);
  });
});

describe('A2A types mirror dispatchd', () => {
  // The daemon keeps ListenerStatus file-private, so `export` is optional.
  const fieldsOf = (source: string, name: string): string[] | null => {
    const body = new RegExp(
      `(?:export )?interface ${name} \\{([\\s\\S]*?)\\n\\}`
    ).exec(source)?.[1];
    if (body === undefined) return null;
    return [...body.matchAll(/\n {2}(\w+\??):/g)].map((m) => m[1]);
  };

  for (const [client, server, file] of [
    ['A2AListenerSettings', 'ListenerSettings', ['a2a', 'settings.ts']],
    ['A2AListenerStatus', 'ListenerStatus', ['a2a', 'bridge.ts']],
  ] as const) {
    it(`${client} declares the fields of the server's ${server}`, () => {
      const theirs = fieldsOf(serverSource(...file), server);
      expect(theirs).not.toBeNull();
      expect(fieldsOf(clientSource(), client)).toEqual(theirs);
    });
  }

  it("A2ATaskSummary declares the fields of @dispatch/a2a's TaskRow", () => {
    const theirs = fieldsOf(
      readFileSync(
        join(import.meta.dir, '..', '..', 'a2a', 'src', 'store', 'sqlite.ts'),
        'utf8'
      ),
      'TaskRow'
    );
    expect(theirs).not.toBeNull();
    expect(fieldsOf(clientSource(), 'A2ATaskSummary')).toEqual(theirs);
  });
});
