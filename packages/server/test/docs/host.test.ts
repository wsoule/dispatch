import { describe, expect, it } from 'bun:test';

import type { DocChange } from '../../src/docs/host.js';
import { AMEND_DEBOUNCE_MS, DaemonDocsHost } from '../../src/docs/host.js';

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
