import { beforeEach, describe, expect, it } from 'bun:test';

import { DocsError } from '../../src/docs/errors.js';
import type { DocsService } from '../../src/docs/service.js';
import type { FakeDocsHost } from './fakeHost.js';
import {
  AGENT,
  DECIDER,
  makeService,
  OWNER,
  RUN,
  TEAMMATE,
} from './fakeHost.js';

let service: DocsService;
let host: FakeDocsHost;
beforeEach(() => {
  ({ service, host } = makeService());
  host.operators.set('human:wyat', {
    human: 'human:wyat',
    identity: 'id-wyat',
  });
  host.operators.set('human:alice', {
    human: 'human:alice',
    identity: 'id-alice',
  });
  host.operators.set('human:bob', { human: 'human:bob', identity: 'id-bob' });
  host.operators.set('agent:wyat/claude-code.mac', {
    human: 'human:wyat',
    identity: 'id-wyat',
  });
  host.runs.set('run:r-1', {
    kind: 'execute',
    taskId: 't-1',
    operator: { human: 'human:wyat', identity: 'id-wyat' },
  });
});
const as = (p: Parameters<DocsService['actorFor']>[0]) => service.actorFor(p);
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof DocsError) return err.code;
    throw err;
  }
  return 'ok';
};

describe('review focus 5: personal docs never leave their owner', () => {
  it("resolves ~slug for the owner's principals only, and never from a bare slug", () => {
    const mine = service.create(as(OWNER), {
      title: 'Notes',
      body: 'private tokens\n',
      scope: 'personal',
    });
    expect(mine.handle).toBe('notes');
    expect(mine.doc).toMatchObject({
      scope: 'personal',
      ns: 'p:id-wyat',
      owner: { human: 'human:wyat', identity: 'id-wyat' },
    });
    expect(service.read(as(OWNER), '~notes').text).toBe('private tokens\n');
    expect(service.read(as(RUN), '~notes').text).toBe('private tokens\n');
    expect(service.read(as(AGENT), '~notes').text).toBe('private tokens\n');
    expect(code(() => service.read(as(OWNER), 'notes'))).toBe('not-found');
    expect(code(() => service.read(as(TEAMMATE), '~notes'))).toBe('not-found');
    expect(code(() => service.read(as(TEAMMATE), mine.doc.id))).toBe(
      'not-found'
    );
    expect(() => service.read(as(DECIDER), mine.doc.id)).toThrow(
      'belongs to another human'
    );
    expect(code(() => service.read(as(DECIDER), mine.doc.id))).toBe(
      'forbidden'
    );
  });

  it('lets a team doc take a slug a personal doc holds, revealing nothing', () => {
    service.create(as(OWNER), {
      title: 'Notes',
      body: 'x\n',
      scope: 'personal',
    });
    expect(
      service.create(as(TEAMMATE), { title: 'Notes', body: 'y\n' }).handle
    ).toBe('notes');
    expect(
      service.create(as(TEAMMATE), {
        title: 'Notes',
        body: 'z\n',
        scope: 'personal',
      }).handle
    ).toBe('notes');
  });

  it("lets a rename take a slug another human's personal doc holds, revealing nothing", () => {
    service.create(as(OWNER), {
      title: 'Notes',
      body: 'x\n',
      scope: 'personal',
    });
    service.create(as(TEAMMATE), { title: 'Scratch', body: 'y\n' });
    expect(service.rename(as(TEAMMATE), 'scratch', 'notes').handle).toBe(
      'notes'
    );
    service.create(as(TEAMMATE), {
      title: 'Mine',
      body: 'z\n',
      scope: 'personal',
    });
    expect(service.rename(as(TEAMMATE), '~mine', 'notes').handle).toBe('notes');
    expect(service.read(as(TEAMMATE), 'notes').text).toBe('y\n');
    expect(service.read(as(TEAMMATE), '~notes').text).toBe('z\n');
    expect(service.read(as(OWNER), '~notes').text).toBe('x\n');
  });

  it('tells a decide-tier owner with no identity why their own doc is out of reach', () => {
    const mine = service.create(as(OWNER), {
      title: 'Notes',
      body: 'x\n',
      scope: 'personal',
    });
    host.operators.delete('human:wyat');
    expect(() => service.read(as(OWNER), mine.doc.id)).toThrow(
      'acts for no human'
    );
    expect(code(() => service.read(as(OWNER), mine.doc.id))).toBe('forbidden');
  });

  it("keeps personal docs out of teammates' lists, searches and linking views", () => {
    service.create(as(OWNER), {
      title: 'Secret plan',
      body: 'zanzibar\n',
      scope: 'personal',
      links: [{ target: { type: 'task', id: 't-1' }, rel: 'spec' }],
    });
    service.sweep();
    expect(service.list(as(TEAMMATE), {}).docs).toEqual([]);
    expect(service.search(as(TEAMMATE), { query: 'zanzibar' })).toEqual([]);
    expect(service.linking(as(TEAMMATE), { type: 'task', id: 't-1' })).toEqual(
      []
    );
    expect(
      service.search(as(OWNER), { query: 'zanzibar' }).map((h) => h.scope)
    ).toEqual(['personal']);
  });

  it("puts the operator's personal spec in their run's index as ~handle, marked you, beside the team spec", () => {
    service.create(as(OWNER), {
      title: 'My spec',
      body: 'mine\n',
      scope: 'personal',
      links: [{ target: { type: 'task', id: 't-1' }, rel: 'spec' }],
    });
    service.create(as(TEAMMATE), {
      title: 'Team spec',
      body: 'team\n',
      links: [{ target: { type: 'task', id: 't-1' }, rel: 'spec' }],
    });
    const lines = service
      .indexLines(as(RUN), 't-1')
      .map((l) => `${l.tag} ${l.handle} ${l.you}`);
    expect(lines).toContain('spec ~my-spec true');
    expect(lines).toContain('spec team-spec false');
    host.runs.set('run:r-1', {
      kind: 'execute',
      taskId: 't-1',
      operator: { human: 'human:alice', identity: 'id-alice' },
    });
    expect(service.indexLines(as(RUN), 't-1').map((l) => l.handle)).toEqual([
      'team-spec',
    ]);
  });

  it("inlines the operator's personal spec for a run without the tools as ~handle", () => {
    service.create(as(OWNER), {
      title: 'My spec',
      body: 'mine\n',
      scope: 'personal',
      links: [{ target: { type: 'task', id: 't-1' }, rel: 'spec' }],
    });
    const section = service.promptSection({
      runId: 'r-1',
      taskId: 't-1',
      dispatchTools: false,
    });
    expect(section).toContain('doc ~my-spec rev 1');
    expect(section).toContain('mine');
  });

  it('refuses a personal doc for a caller that acts for no one', () => {
    host.runs.set('run:r-1', {
      kind: 'execute',
      taskId: 't-1',
      operator: null,
    });
    expect(() =>
      service.create(as(RUN), { title: 'x', body: 'x\n', scope: 'personal' })
    ).toThrow('acts for no human');
  });
});

describe('owner rules', () => {
  it('lets only the owner, as a human, change status or delete', () => {
    service.create(as(OWNER), {
      title: 'Mine',
      body: 'x\n',
      scope: 'personal',
    });
    expect(code(() => service.setStatus(as(RUN), '~mine', 'archived'))).toBe(
      'forbidden'
    );
    expect(code(() => service.remove(as(RUN), '~mine'))).toBe('forbidden');
    expect(service.setStatus(as(OWNER), '~mine', 'accepted').status).toBe(
      'accepted'
    );
    expect(
      service.edit(as(RUN), '~mine', {
        ops: [{ op: 'append', text: 'still writable: a label only' }],
      }).status
    ).toBe('saved');
  });

  it("treats an accepted personal doc's status as a label for a request-tier owner's edits and links", () => {
    service.create(as(TEAMMATE), {
      title: 'Hers',
      body: 'x\n',
      scope: 'personal',
      links: [{ target: { type: 'task', id: 't-1' }, rel: 'spec' }],
    });
    expect(service.setStatus(as(TEAMMATE), '~hers', 'accepted').status).toBe(
      'accepted'
    );
    expect(
      service.edit(as(TEAMMATE), '~hers', {
        ops: [{ op: 'append', text: 'more' }],
      }).status
    ).toBe('saved');
    const t1 = { type: 'task', id: 't-1' } as const;
    expect(
      service
        .link(as(TEAMMATE), '~hers', { target: t1, rel: 'plan' })
        .map((l) => l.rel)
    ).toEqual(['plan']);
    expect(service.unlink(as(TEAMMATE), '~hers', t1)).toEqual([]);
    service.link(as(TEAMMATE), '~hers', { target: t1, rel: 'spec' });
    service.create(as(TEAMMATE), {
      title: 'Newer',
      body: 'y\n',
      scope: 'personal',
    });
    expect(
      service
        .link(as(TEAMMATE), '~newer', {
          target: t1,
          rel: 'spec',
          replace: true,
        })
        .map((l) => l.rel)
    ).toEqual(['spec']);
    expect(service.read(as(TEAMMATE), '~hers').links).toEqual([]);
  });

  it("links [[~slug]] inside a personal doc to the same owner's docs, never from a team doc", () => {
    service.create(as(OWNER), {
      title: 'Other',
      body: 'x\n',
      scope: 'personal',
    });
    service.create(as(OWNER), {
      title: 'Mine',
      body: 'see [[~other]]\n',
      scope: 'personal',
    });
    service.seal(as(OWNER), '~mine');
    expect(service.read(as(OWNER), '~mine').links.map((l) => l.source)).toEqual(
      ['mention']
    );
    service.create(as(OWNER), { title: 'Team', body: 'see [[~other]]\n' });
    service.seal(as(OWNER), 'team');
    expect(service.read(as(OWNER), 'team').links).toEqual([]);
    const team = service.create(as(OWNER), { title: 'Team two', body: 'x\n' });
    expect(
      code(() =>
        service.link(as(OWNER), team.doc.id, {
          target: { type: 'doc', id: '~other' },
          rel: 'context',
        })
      )
    ).toBe('forbidden');
  });

  it("never links another human's personal memory entry, answering as if it were missing", () => {
    host.memoryScopes.set('mem-alice', 'personal');
    host.existing.add('memory:mem-alice');
    host.memoryOwners.set('mem-alice', new Set(['human:alice']));
    host.memoryOwners.get('mem-mine')?.add('run:r-1');
    const mine = service.create(as(OWNER), {
      title: 'Mine',
      body: 'x\n',
      scope: 'personal',
    });
    expect(() =>
      service.link(as(OWNER), mine.doc.id, {
        target: { type: 'memory', id: 'mem-alice' },
        rel: 'context',
      })
    ).toThrow('target memory:mem-alice not found');
    expect(
      service.link(as(OWNER), mine.doc.id, {
        target: { type: 'memory', id: 'mem-mine' },
        rel: 'context',
      }).length
    ).toBe(1);
    expect(
      service.link(as(RUN), mine.doc.id, {
        target: { type: 'memory', id: 'mem-mine' },
        rel: 'context',
      }).length
    ).toBe(1);
  });

  it('promotes a personal doc into a new team draft, owner only, once', () => {
    service.create(as(OWNER), {
      title: 'Draft idea',
      body: 'v1\n',
      scope: 'personal',
    });
    service.edit(as(OWNER), '~draft-idea', {
      ops: [{ op: 'append', text: 'v2' }],
    });
    expect(code(() => service.promote(as(RUN), '~draft-idea'))).toBe(
      'forbidden'
    );
    const promoted = service.promote(as(OWNER), '~draft-idea');
    expect(promoted.doc).toMatchObject({
      scope: 'team',
      status: 'draft',
      handle: 'draft-idea',
      unreviewed: false,
    });
    expect(promoted.doc.origin?.startsWith('promoted:doc-')).toBe(true);
    expect(service.revisions(as(TEAMMATE), 'draft-idea', {}).length).toBe(1);
    expect(service.read(as(TEAMMATE), 'draft-idea').text).toBe('v1\nv2\n');
    expect(code(() => service.promote(as(OWNER), '~draft-idea'))).toBe(
      'conflict'
    );
  });

  it("carries a personal head's unreviewed agent text into the promoted draft", () => {
    service.create(as(OWNER), {
      title: 'Ideas',
      body: 'v1\n',
      scope: 'personal',
    });
    service.edit(as(RUN), '~ideas', {
      ops: [{ op: 'append', text: 'from a run' }],
    });
    expect(service.promote(as(OWNER), '~ideas').doc.unreviewed).toBe(true);
    service.create(as(OWNER), {
      title: 'Checked',
      body: 'v1\n',
      scope: 'personal',
    });
    service.edit(as(RUN), '~checked', {
      ops: [{ op: 'append', text: 'from a run' }],
    });
    service.markReviewed(as(OWNER), '~checked');
    expect(service.promote(as(OWNER), '~checked').doc.unreviewed).toBe(false);
  });
});
