import { beforeEach, describe, expect, it } from 'bun:test';

import { DocsError } from '../../src/docs/errors.js';
import type { DocsService } from '../../src/docs/service.js';
import {
  AGENT,
  DECIDER,
  FakeDocsHost,
  makeService,
  OWNER,
  REVIEW_RUN,
  RUN,
  TEAMMATE,
} from './fakeHost.js';

let service: DocsService;
let host: FakeDocsHost;
beforeEach(() => {
  ({ service, host } = makeService());
});
const as = (p: Parameters<DocsService['actorFor']>[0]) => service.actorFor(p);
function denied(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof DocsError) return `${err.code}: ${err.message}`;
    throw err;
  }
  return 'ok';
}

describe('review focus 4: link rules', () => {
  beforeEach(() => {
    service.create(as(OWNER), {
      title: 'Accepted-ish spec',
      body: 'x\n',
      slug: 'spec',
      links: [{ target: { type: 'task', id: 't-2' }, rel: 'spec' }],
    });
  });

  it('refuses an agent adding a spec or plan link', () => {
    const draft = service.create(as(AGENT), {
      title: 'Agent draft',
      body: 'x\n',
    });
    expect(
      denied(() =>
        service.link(as(AGENT), draft.doc.id, {
          target: { type: 'task', id: 't-2' },
          rel: 'spec',
          replace: true,
        })
      )
    ).toBe('forbidden: agents add context links only');
  });

  it('refuses a run linking a doc to another task', () => {
    const mine = service.create(as(RUN), { title: 'Run draft', body: 'x\n' });
    expect(
      denied(() =>
        service.link(as(RUN), mine.doc.id, {
          target: { type: 'task', id: 't-2' },
          rel: 'spec',
        })
      )
    ).toBe('forbidden: a run links only its own task');
    expect(
      service
        .link(as(RUN), mine.doc.id, {
          target: { type: 'task', id: 't-1' },
          rel: 'plan',
        })
        .map((l) => l.rel)
    ).toContain('plan');
  });

  it('answers 409 naming the spec a task already has, and replace moves it off a draft the caller could write', () => {
    const other = service.create(as(TEAMMATE), { title: 'Other', body: 'x\n' });
    expect(
      denied(() =>
        service.link(as(TEAMMATE), other.doc.id, {
          target: { type: 'task', id: 't-2' },
          rel: 'spec',
        })
      )
    ).toBe('conflict: task t-2 already has a spec: spec');
    service.link(as(TEAMMATE), other.doc.id, {
      target: { type: 'task', id: 't-2' },
      rel: 'spec',
      replace: true,
    });
    expect(
      service
        .list(as(OWNER), { taskId: 't-2' })
        .docs.map((d) => [d.handle, d.rel])
    ).toEqual([['other', 'spec']]);
  });

  it('needs decide tier to displace a spec the caller could not write directly', () => {
    service.setStatus(as(OWNER), 'spec', 'archived');
    const other = service.create(as(TEAMMATE), { title: 'Other', body: 'x\n' });
    expect(
      denied(() =>
        service.link(as(TEAMMATE), other.doc.id, {
          target: { type: 'task', id: 't-2' },
          rel: 'spec',
          replace: true,
        })
      )
    ).toContain('forbidden: only a decide-tier human replaces spec');
    expect(
      service
        .link(as(DECIDER), other.doc.id, {
          target: { type: 'task', id: 't-2' },
          rel: 'spec',
          replace: true,
        })
        .map((l) => l.rel)
    ).toEqual(['spec']);
  });

  it('refuses a team doc linking to personal memory, and unknown targets', () => {
    expect(
      denied(() =>
        service.link(as(OWNER), 'spec', {
          target: { type: 'memory', id: 'mem-mine' },
          rel: 'context',
        })
      )
    ).toBe('forbidden: a team doc cannot link to personal memory');
    // Another human's personal entry answers like a missing one: no existence oracle.
    expect(
      denied(() =>
        service.link(as(TEAMMATE), 'spec', {
          target: { type: 'memory', id: 'mem-mine' },
          rel: 'context',
        })
      )
    ).toBe('invalid: target memory:mem-mine not found');
    expect(
      service.link(as(OWNER), 'spec', {
        target: { type: 'memory', id: 'mem-team' },
        rel: 'context',
      }).length
    ).toBe(2);
    expect(
      denied(() =>
        service.link(as(OWNER), 'spec', {
          target: { type: 'task', id: 't-404' },
          rel: 'context',
        })
      )
    ).toBe('invalid: target task:t-404 not found');
    expect(
      denied(() =>
        service.link(as(OWNER), 'spec', {
          target: { type: 'run', id: 'r-1' },
          rel: 'spec',
        })
      )
    ).toBe('invalid: spec links point at tasks');
  });

  it('limits a run to its own run and threads it takes part in', () => {
    const mine = service.create(as(RUN), { title: 'Run draft', body: 'x\n' });
    expect(
      denied(() =>
        service.link(as(RUN), mine.doc.id, {
          target: { type: 'run', id: 'r-2' },
          rel: 'context',
        })
      )
    ).toBe('forbidden: a run links only its own run');
    // A thread the run is not in is invisible to it, so it answers like a missing one.
    expect(
      denied(() =>
        service.link(as(RUN), mine.doc.id, {
          target: { type: 'thread', id: 'm-2' },
          rel: 'context',
        })
      )
    ).toBe('invalid: target thread:m-2 not found');
    expect(
      service.link(as(RUN), mine.doc.id, {
        target: { type: 'thread', id: 'm-1' },
        rel: 'context',
      }).length
    ).toBe(2);
  });

  it('refuses a run linking a memory entry it can see', () => {
    const mine = service.create(as(RUN), { title: 'Run draft', body: 'x\n' });
    expect(
      denied(() =>
        service.link(as(RUN), mine.doc.id, {
          target: { type: 'memory', id: 'mem-team' },
          rel: 'context',
        })
      )
    ).toBe(
      'forbidden: a run links only its own task, run and threads, and docs'
    );
    expect(
      denied(() =>
        service.create(as(RUN), {
          title: 'Run notes',
          body: 'x\n',
          links: [
            { target: { type: 'memory', id: 'mem-team' }, rel: 'context' },
          ],
        })
      )
    ).toBe(
      'forbidden: a run links only its own task, run and threads, and docs'
    );
  });

  it("refuses an agent turning a draft's spec link into context, as unlink does", () => {
    expect(
      denied(() =>
        service.unlink(as(AGENT), 'spec', { type: 'task', id: 't-2' })
      )
    ).toBe('forbidden: agents add context links only');
    expect(
      denied(() =>
        service.link(as(AGENT), 'spec', {
          target: { type: 'task', id: 't-2' },
          rel: 'context',
        })
      )
    ).toBe('forbidden: agents add context links only');
    expect(
      service
        .list(as(OWNER), { taskId: 't-2' })
        .docs.map((d) => [d.handle, d.rel])
    ).toEqual([['spec', 'spec']]);
  });

  it('refuses link and unlink for the overseer and review runs', () => {
    for (const actor of [service.overseerActor(), as(REVIEW_RUN)]) {
      expect(
        denied(() =>
          service.link(actor, 'spec', {
            target: { type: 'task', id: 't-1' },
            rel: 'context',
          })
        )
      ).toBe('forbidden: you may not change links');
      expect(
        denied(() => service.unlink(actor, 'spec', { type: 'task', id: 't-2' }))
      ).toBe('forbidden: you may not change links');
    }
    expect(
      service
        .list(as(OWNER), { taskId: 't-2' })
        .docs.map((d) => [d.handle, d.rel])
    ).toEqual([['spec', 'spec']]);
  });

  it('links a thread only for its participants and decide-tier humans', () => {
    const notes = service.create(as(TEAMMATE), { title: 'Notes', body: 'x\n' });
    expect(
      denied(() =>
        service.link(as(TEAMMATE), notes.doc.id, {
          target: { type: 'thread', id: 'm-1' },
          rel: 'context',
        })
      )
    ).toBe('invalid: target thread:m-1 not found');
    host.threads.get('m-1')?.add('human:alice');
    expect(
      service.link(as(TEAMMATE), notes.doc.id, {
        target: { type: 'thread', id: 'm-1' },
        rel: 'context',
      }).length
    ).toBe(1);
    expect(
      service.link(as(DECIDER), notes.doc.id, {
        target: { type: 'thread', id: 'm-2' },
        rel: 'context',
      }).length
    ).toBe(2);
  });

  it('keeps links on an archived doc read-only', () => {
    service.setStatus(as(OWNER), 'spec', 'archived');
    expect(
      denied(() =>
        service.unlink(as(OWNER), 'spec', { type: 'task', id: 't-2' })
      )
    ).toBe('conflict: archived; restore it first');
  });
});

describe('mentions', () => {
  it('rebuilds [[slug]] links from a sealed revision, outside code, never to itself', () => {
    service.create(as(OWNER), { title: 'Target', body: 'x\n' });
    service.create(as(OWNER), {
      title: 'Source',
      body: 'See [[target]] and [[source]].\n```\n[[target-2]]\n```\n',
    });
    expect(service.read(as(OWNER), 'source').links).toEqual([]);
    service.seal(as(OWNER), 'source');
    expect(
      service
        .read(as(OWNER), 'source')
        .links.map((l) => [l.target.type, l.rel, l.source])
    ).toEqual([['doc', 'context', 'mention']]);
  });
});

describe('docs of a task', () => {
  it('ranks the spec, parent specs, plans, context and body mentions, each once', () => {
    host.tasks.set('t-1', {
      id: 't-1',
      title: 'Task one',
      body: 'Also read [[mentioned]].',
      parent: 'e-1',
      risk: 'routine',
      labels: [],
    });
    // One minute apart, so "newest update first" has something to order.
    const mk = (
      title: string,
      links: {
        target: { type: 'task'; id: string };
        rel: 'spec' | 'plan' | 'context';
      }[]
    ) => {
      host.advance(1);
      return service.create(as(OWNER), { title, body: 'x\n', links });
    };
    mk('Epic spec', [{ target: { type: 'task', id: 'e-1' }, rel: 'spec' }]);
    mk('Root spec', [{ target: { type: 'task', id: 'e-root' }, rel: 'spec' }]);
    mk('Own context', [
      { target: { type: 'task', id: 't-1' }, rel: 'context' },
    ]);
    mk('Own spec', [
      { target: { type: 'task', id: 't-1' }, rel: 'spec' },
      { target: { type: 'task', id: 'e-1' }, rel: 'context' },
    ]);
    mk('Epic plan', [{ target: { type: 'task', id: 'e-1' }, rel: 'plan' }]);
    mk('Mentioned', []);
    const ranked = service
      .list(as(OWNER), { taskId: 't-1' })
      .docs.map((d): [string, string | null, boolean] => [
        d.handle,
        d.rel,
        d.fromParent,
      ]);
    expect(ranked).toEqual([
      ['own-spec', 'spec', false],
      ['epic-spec', 'spec', true],
      ['root-spec', 'spec', true],
      ['epic-plan', 'plan', true],
      ['mentioned', 'context', false],
      ['own-context', 'context', false],
    ]);
    expect(
      service
        .linking(as(OWNER), { type: 'task', id: 't-1' })
        .map((l) => l.doc.handle)
    ).toEqual(ranked.map((r) => r[0]));
  });
});
