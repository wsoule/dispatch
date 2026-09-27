import { beforeEach, describe, expect, it } from 'bun:test';

import { DocsError } from '../../src/docs/errors.js';
import { A2A_PROVENANCE, DaemonDocsHost } from '../../src/docs/host.js';
import type { DocsService } from '../../src/docs/service.js';
import {
  DECIDER,
  FakeDocsHost,
  makeService,
  OWNER,
  RUN,
  RUN2,
  TEAMMATE,
} from './fakeHost.js';

let service: DocsService;
let host: FakeDocsHost;
beforeEach(() => {
  ({ service, host } = makeService());
  host.a2aTasks.add('t-1');
  host.tasks.set('t-1', {
    id: 't-1',
    title: 'Asked over A2A',
    body: 'Please read [[team-notes]].',
    parent: 'e-1',
    risk: 'critical',
    labels: ['a2a'],
  });
});
const as = (p: Parameters<DocsService['actorFor']>[0]) => service.actorFor(p);

// Owner-made docs: one linked as t-1's spec, one as its epic's spec, one unlinked.
function seed(): void {
  service.create(as(OWNER), {
    title: 'Own spec',
    body: 'x\n',
    links: [{ target: { type: 'task', id: 't-1' }, rel: 'spec' }],
  });
  service.create(as(OWNER), {
    title: 'Epic spec',
    body: 'x\n',
    links: [{ target: { type: 'task', id: 'e-1' }, rel: 'spec' }],
  });
  service.create(as(OWNER), { title: 'Team notes', body: 'x\n' });
}

describe('A2A-provenance runs', () => {
  it('read only team docs linked to their own task: no ancestors, no mentions, no personal docs, and write nothing', () => {
    seed();
    const run = as(RUN);
    expect(run.a2aRun).toBe(true);
    expect(run.operator).toBeNull();
    expect(as(RUN2).a2aRun).toBe(false);
    expect(service.indexLines(run, 't-1').map((l) => l.handle)).toEqual([
      'own-spec',
    ]);
    expect(service.list(run, {}).docs.map((d) => d.handle)).toEqual([
      'own-spec',
    ]);
    expect(() => service.read(run, 'team-notes')).toThrow('not found');
    expect([
      ...new Set(service.search(run, { query: 'x' }).map((h) => h.handle)),
    ]).toEqual(['own-spec']);
    expect(() =>
      service.edit(run, 'own-spec', { ops: [{ op: 'append', text: 'y' }] })
    ).toThrow(DocsError);
    expect(() => service.create(run, { title: 'Mine', body: 'y\n' })).toThrow(
      'A2A'
    );
  });

  it('lists by title query only the docs linked to their own task', () => {
    seed();
    const listed = service.list(as(RUN), { query: 'spec' });
    expect(listed.docs.map((d) => d.handle)).toEqual(['own-spec']);
    expect(listed.total).toBe(1);
  });

  it('never inlines an ancestor spec for an A2A run without the MCP server', () => {
    service.create(as(OWNER), {
      title: 'Epic spec',
      body: 'EPIC\n',
      links: [{ target: { type: 'task', id: 'e-1' }, rel: 'spec' }],
    });
    expect(
      service.promptSection({
        runId: 'r-1',
        taskId: 't-1',
        dispatchTools: false,
      })
    ).toBeNull();
  });
});

describe('A2A-origin tasks', () => {
  it('take links only from decide tier: a request-tier human and a run are refused', () => {
    const doc = service.create(as(TEAMMATE), { title: 'Notes', body: 'x\n' });
    const target = { type: 'task' as const, id: 't-1' };
    expect(() =>
      service.link(as(TEAMMATE), doc.doc.id, { target, rel: 'context' })
    ).toThrow('A2A client asked for');
    expect(() =>
      service.link(as(RUN), doc.doc.id, { target, rel: 'context' })
    ).toThrow(DocsError);
    expect(
      service.link(as(DECIDER), doc.doc.id, { target, rel: 'context' }).length
    ).toBe(1);
    expect(() => service.unlink(as(TEAMMATE), doc.doc.id, target)).toThrow(
      'A2A client asked for'
    );
  });

  it("ignore [[slug]] mentions in the task's body, for every reader", () => {
    seed();
    expect(service.indexLines(as(OWNER), 't-1').map((l) => l.handle)).toEqual([
      'own-spec',
      'epic-spec',
    ]);
  });
});

describe('a2aOrigin fails closed', () => {
  it('reads the label and the provenance line with no bridge bound', () => {
    const events = { broadcast: () => undefined } as never;
    const tasks = new Map<
      string,
      { meta: Record<string, unknown>; body: string }
    >([
      [
        't-lab',
        {
          meta: { title: 'x', parent: null, risk: 'routine', labels: ['a2a'] },
          body: '',
        },
      ],
      [
        't-line',
        {
          meta: { title: 'x', parent: null, risk: 'routine', labels: [] },
          body: 'Requested over A2A by acme (message m-01K00000000000000000000000)\n',
        },
      ],
      [
        't-plain',
        {
          meta: { title: 'x', parent: null, risk: 'routine', labels: [] },
          body: 'local',
        },
      ],
    ]);
    const daemon = new DaemonDocsHost({
      store: { get: (id: string) => tasks.get(id) ?? null } as never,
      events,
    });
    expect(
      ['t-lab', 't-line', 't-plain', 't-missing'].map((id) =>
        daemon.a2aOrigin(id)
      )
    ).toEqual([true, true, false, false]);
  });

  it('matches only a whole provenance line', () => {
    expect(
      A2A_PROVENANCE.test(
        'Intro\nRequested over A2A by acme (message m-01K0ABC)\nMore'
      )
    ).toBe(true);
    expect(
      A2A_PROVENANCE.test('Requested over A2A by acme (message m-01K0ABC) ok')
    ).toBe(false);
  });
});
