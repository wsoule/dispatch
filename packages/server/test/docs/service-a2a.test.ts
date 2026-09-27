import { TaskParseError } from '@dispatch/core';
import { beforeEach, describe, expect, it } from 'bun:test';

import { DocsError } from '../../src/docs/errors.js';
import { DaemonDocsHost } from '../../src/docs/host.js';
import type { DocsService } from '../../src/docs/service.js';
import type { Principal } from '../../src/messaging/principal.js';
import {
  DECIDER,
  FakeDocsHost,
  makeService,
  OWNER,
  REVIEW_RUN,
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

  it('hold for review and verify runs of the task too', () => {
    seed();
    const verify: Principal = {
      address: 'run:r-ver',
      canDecide: false,
      kind: 'run',
    };
    const op = { human: 'human:wyat', identity: 'wyat' } as never;
    host.runs.set('run:r-ver', { kind: 'verify', taskId: 't-1', operator: op });
    host.operators.set('run:r-rev', op);
    for (const p of [REVIEW_RUN, verify]) {
      const run = as(p);
      expect(run.a2aRun).toBe(true);
      expect(run.operator).toBeNull();
      expect(service.list(run, {}).docs.map((d) => d.handle)).toEqual([
        'own-spec',
      ]);
      expect(() => service.read(run, 'team-notes')).toThrow('not found');
      expect([
        ...new Set(service.search(run, { query: 'x' }).map((h) => h.handle)),
      ]).toEqual(['own-spec']);
      expect(service.indexLines(run, 't-1').map((l) => l.handle)).toEqual([
        'own-spec',
      ]);
    }
  });

  it('find their own doc in search however many other team docs rank above it', () => {
    for (let i = 0; i < 12; i++) {
      service.create(as(OWNER), {
        title: `Alpha ${i}`,
        body: 'alpha alpha alpha\n',
      });
    }
    service.create(as(OWNER), {
      title: 'Own spec',
      body: 'alpha\n',
      links: [{ target: { type: 'task', id: 't-1' }, rel: 'spec' }],
    });
    expect(
      service.search(as(RUN), { query: 'alpha', limit: 1 }).map((h) => h.handle)
    ).toEqual(['own-spec']);
  });

  it("see only their own task's links when reading their doc", () => {
    seed();
    const own = service.read(as(OWNER), 'own-spec').doc.id;
    const notes = service.read(as(OWNER), 'team-notes').doc.id;
    for (const target of [
      { type: 'task' as const, id: 'e-1' },
      { type: 'thread' as const, id: 'm-1' },
      { type: 'doc' as const, id: notes },
      { type: 'run' as const, id: 'r-2' },
    ]) {
      service.link(as(OWNER), own, { target, rel: 'context' });
    }
    expect(service.read(as(OWNER), 'own-spec').links.length).toBe(5);
    expect(
      service.read(as(RUN), 'own-spec').links.map((l) => l.target)
    ).toEqual([{ type: 'task', id: 't-1' }]);
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
  it('reads the label, the provenance line the bridge writes, and an unreadable task file as A2A, with no bridge bound', () => {
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
          body: 'Client text.\n\nRequested over A2A by agent:wyat/a2a.acme (message m-01k3a7b2c9d4e5f6g8h0j1k2m3).\n',
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
      store: {
        get: (id: string) => {
          if (id === 't-bad') throw new TaskParseError('bad front matter');
          return tasks.get(id) ?? null;
        },
      } as never,
      events,
    });
    expect(
      ['t-lab', 't-line', 't-bad', 't-plain', 't-missing'].map((id) =>
        daemon.a2aOrigin(id)
      )
    ).toEqual([true, true, true, false, false]);
  });
});
