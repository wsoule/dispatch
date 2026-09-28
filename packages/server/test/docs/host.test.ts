import { describe, expect, it } from 'bun:test';

import type { DocChange } from '../../src/docs/host.js';
import {
  AMEND_DEBOUNCE_MS,
  DaemonDocsHost,
  docsMemoryPort,
} from '../../src/docs/host.js';
import {
  IDENTITIES_DOWN_IDENTITY,
  REUSED_HANDLE_IDENTITY,
} from '../../src/memory/host.js';

const change = (
  kind: DocChange['kind'],
  scope: DocChange['scope'] = 'team'
): DocChange => ({
  doc: 'doc-1',
  scope,
  kind,
  author: 'human:wyat',
  rev: 'rev-1',
  summary: 's',
});

describe('doc.changed', () => {
  it('coalesces amends of one doc within the debounce window into one event, and never delays other kinds', async () => {
    expect(AMEND_DEBOUNCE_MS).toBe(2_000);
    const sent: unknown[] = [];
    const host = new DaemonDocsHost({
      store: {} as never,
      events: { broadcast: (e: unknown) => sent.push(e) } as never,
      debounceMs: 40,
    });
    host.changed(change('amended'));
    host.changed(change('amended'));
    expect(sent).toEqual([]);
    await new Promise((r) => setTimeout(r, 120));
    expect(sent).toEqual([{ type: 'doc.changed', scope: 'team', id: 'doc-1' }]);
    host.changed(change('sealed'));
    host.changed(change('amended', 'personal'));
    await new Promise((r) => setTimeout(r, 120));
    expect(sent.slice(1)).toEqual([
      { type: 'doc.changed', scope: 'team', id: 'doc-1' },
      { type: 'doc.changed', scope: 'personal' },
    ]);
  });
});

describe('runs', () => {
  it("resolve any run's task, while only an execute run has a task to link", () => {
    const host = new DaemonDocsHost({
      store: {} as never,
      events: { broadcast: () => undefined } as never,
    });
    const run = (id: string) =>
      ({ address: `run:${id}`, canDecide: false, kind: 'run' }) as const;
    expect(host.runTaskOf(run('r-rev'))).toBeNull();
    host.bindRuns({
      list: () =>
        [
          { id: 'r-1', kind: 'execute', taskId: 't-1' },
          { id: 'r-rev', kind: 'review', taskId: 't-1' },
        ] as never,
      taskIdOfRun: (id) => (id === 'r-1' ? 't-1' : null),
    });
    expect(host.runTaskOf(run('r-rev'))).toBe('t-1');
    expect(host.runTaskOf(run('r-1'))).toBe('t-1');
    expect(host.runTaskOf(run('r-gone'))).toBeNull();
    expect(host.taskOfPrincipal(run('r-rev'))).toBeNull();
    expect(host.runKind(run('r-rev'))).toBe('review');
  });
});

describe('memory', () => {
  it('knows no operator or entry until memory binds, and never scopes a shared sentinel identity', () => {
    const host = new DaemonDocsHost({
      store: {} as never,
      events: { broadcast: () => undefined } as never,
    });
    const human = (name: string) =>
      ({ address: `human:${name}`, canDecide: false, kind: 'human' }) as const;
    expect(host.operatorOf(human('wyat'))).toBeNull();
    expect(host.exists({ type: 'memory', id: 'mem-team' })).toBe(false);
    const identities = new Map([
      ['human:wyat', 'self'],
      ['human:alice', 'pid-01J8ZQ4Y9W7E2C6V1N3K5M8P0R'],
      ['human:down', IDENTITIES_DOWN_IDENTITY],
      ['human:reused', REUSED_HANDLE_IDENTITY],
    ]);
    host.bindMemory(
      docsMemoryPort({
        host: {
          operatorOf: (p) => {
            const identity = identities.get(p.address);
            return identity === undefined
              ? null
              : { human: p.address, identity };
          },
        },
        shared: {
          getEntry: (id) =>
            id === 'mem-team' ? ({ scope: 'team' } as never) : null,
        },
        stores: {
          locatePersonal: (id) => (id === 'mem-mine' ? 'self' : null),
        },
      })
    );
    expect(host.operatorOf(human('wyat'))).toEqual({
      human: 'human:wyat',
      identity: 'self',
    });
    expect(host.operatorOf(human('down'))).toBeNull();
    expect(host.operatorOf(human('reused'))).toBeNull();
    expect(host.memoryScope('mem-team')).toBe('team');
    expect(host.memoryScope('mem-mine')).toBe('personal');
    expect(host.memoryScope('mem-gone')).toBeNull();
    expect(host.exists({ type: 'memory', id: 'mem-mine' })).toBe(true);
    expect(host.exists({ type: 'memory', id: 'mem-gone' })).toBe(false);
    expect(host.memoryVisible('mem-team', human('alice'))).toBe(true);
    expect(host.memoryVisible('mem-mine', human('wyat'))).toBe(true);
    expect(host.memoryVisible('mem-mine', human('alice'))).toBe(false);
    expect(host.memoryVisible('mem-gone', human('wyat'))).toBe(false);
  });
});
