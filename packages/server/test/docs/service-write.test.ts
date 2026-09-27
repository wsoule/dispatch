import { beforeEach, describe, expect, it } from 'bun:test';

import { DocConflictError, DocsError } from '../../src/docs/errors.js';
import type { DocsService } from '../../src/docs/service.js';
import type { SqliteDocStore } from '../../src/docs/store.js';
import {
  A2A_AGENT,
  AGENT,
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
let store: SqliteDocStore;
beforeEach(() => {
  ({ service, host, store } = makeService());
});

const as = (p: Parameters<DocsService['actorFor']>[0]) => service.actorFor(p);

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof DocsError) return err.code;
    throw err;
  }
  return 'ok';
}

describe('create', () => {
  it('creates a team draft with a derived slug, suffixed on a clash', () => {
    const first = service.create(as(OWNER), {
      title: 'Auth refactor',
      body: '# Auth\r\n\uFEFFbody\n',
    });
    expect(first).toMatchObject({
      handle: 'auth-refactor',
      status: 'saved',
      rev: { n: 1 },
    });
    expect(first.doc).toMatchObject({
      scope: 'team',
      status: 'draft',
      unreviewed: false,
      head: { sealed: false },
    });
    expect(service.read(as(OWNER), 'auth-refactor').text).toBe(
      '# Auth\n\uFEFFbody\n'
    );
    expect(
      service.create(as(OWNER), { title: 'Auth refactor', body: 'x' }).handle
    ).toBe('auth-refactor-2');
  });

  it('refuses a taken, reserved or malformed explicit slug', () => {
    service.create(as(OWNER), { title: 'A', body: 'x', slug: 'plan' });
    expect(
      code(() =>
        service.create(as(OWNER), { title: 'B', body: 'x', slug: 'plan' })
      )
    ).toBe('conflict');
    expect(
      code(() =>
        service.create(as(OWNER), { title: 'B', body: 'x', slug: 'search' })
      )
    ).toBe('invalid');
    expect(
      code(() =>
        service.create(as(OWNER), { title: 'B', body: 'x', slug: 'doc-1' })
      )
    ).toBe('invalid');
  });

  it('refuses a body over the cap, with NUL, and a bad title', () => {
    expect(() =>
      service.create(as(OWNER), {
        title: 'A',
        body: 'x'.repeat(768 * 1024 + 1),
      })
    ).toThrow('split it into linked docs');
    expect(
      code(() => service.create(as(OWNER), { title: 'A', body: 'a\u0000' }))
    ).toBe('invalid');
    expect(
      code(() => service.create(as(OWNER), { title: 'a\nb', body: 'x' }))
    ).toBe('invalid');
  });

  it("links a run's new doc to its task by default", () => {
    const made = service.create(as(RUN), { title: 'Run notes', body: 'x' });
    expect(
      service.read(as(OWNER), made.doc.id).links.map((l) => [l.target, l.rel])
    ).toEqual([[{ type: 'task', id: 't-1' }, 'context']]);
    expect(made.doc.unreviewed).toBe(true);
  });

  it('limits creates per hour for runs and agents, not humans', () => {
    for (let i = 0; i < 20; i++)
      service.create(as(AGENT), { title: `n${i}`, body: 'x' });
    expect(
      code(() => service.create(as(AGENT), { title: 'one more', body: 'x' }))
    ).toBe('limited');
    for (let i = 0; i < 25; i++)
      service.create(as(OWNER), { title: `h${i}`, body: 'x' });
    host.advance(61);
    expect(
      service.create(as(AGENT), { title: 'next hour', body: 'x' }).status
    ).toBe('saved');
  });

  it('refuses personal docs until memory v1, review runs, the overseer and a2a. agents', () => {
    expect(() =>
      service.create(as(OWNER), { title: 'Mine', body: 'x', scope: 'personal' })
    ).toThrow('personal docs need memory v1');
    expect(
      code(() => service.create(as(REVIEW_RUN), { title: 'x', body: 'x' }))
    ).toBe('forbidden');
    expect(
      code(() =>
        service.create(service.overseerActor(), { title: 'x', body: 'x' })
      )
    ).toBe('forbidden');
    expect(code(() => service.actorFor(A2A_AGENT))).toBe('forbidden');
  });
});

describe('open revisions', () => {
  it("amends the author's open head in place, and anyone else's write seals it first", () => {
    const made = service.create(as(OWNER), { title: 'A', body: 'one\n' });
    const second = service.saveBody(as(OWNER), 'a', {
      baseRev: made.rev.id,
      body: 'one\ntwo\n',
    });
    expect(second).toMatchObject({
      status: 'amended',
      rev: { id: made.rev.id, n: 1 },
    });
    const other = service.edit(as(TEAMMATE), 'a', {
      ops: [{ op: 'append', text: 'three' }],
    });
    expect(other).toMatchObject({ status: 'saved', rev: { n: 2 } });
    expect(store.revision(made.rev.id)?.sealed).toBe(true);
  });

  it('seals when anyone else reads the body, but not for index lines or search', () => {
    const made = service.create(as(OWNER), { title: 'A', body: 'tokens\n' });
    service.search(as(TEAMMATE), { query: 'tokens' });
    service.list(as(TEAMMATE), {});
    expect(store.revision(made.rev.id)?.sealed).toBe(false);
    service.read(as(OWNER), 'a');
    expect(store.revision(made.rev.id)?.sealed).toBe(false);
    service.read(as(TEAMMATE), 'a');
    expect(store.revision(made.rev.id)?.sealed).toBe(true);
  });

  it('seals after 10 idle minutes or 60 minutes of age, from the sweep', () => {
    const made = service.create(as(OWNER), { title: 'A', body: 'x\n' });
    host.advance(9);
    expect(service.sweep().sealed).toBe(0);
    host.advance(2);
    expect(service.sweep().sealed).toBe(1);
    expect(store.revision(made.rev.id)?.sealed).toBe(true);

    const b = service.create(as(OWNER), { title: 'B', body: 'x\n' });
    for (let i = 0; i < 6; i++) {
      host.advance(9);
      service.saveBody(as(OWNER), 'b', {
        baseRev: b.rev.id,
        body: `x\n${i}\n`,
      });
    }
    host.advance(7); // idle 7 minutes, but 61 minutes old
    expect(service.sweep().sealed).toBe(1);
    expect(store.revision(b.rev.id)?.sealed).toBe(true);
  });

  it('seals every write when coalesceMinutes is 0', () => {
    ({ service, host, store } = makeService({ coalesceMinutes: 0 }));
    const made = service.create(service.actorFor(OWNER), {
      title: 'A',
      body: 'x\n',
    });
    expect(made.doc.head.sealed).toBe(true);
    expect(
      service.saveBody(service.actorFor(OWNER), 'a', {
        baseRev: made.rev.id,
        body: 'y\n',
      }).rev.n
    ).toBe(2);
  });

  it('saves a version only for the head author', () => {
    service.create(as(OWNER), { title: 'A', body: 'x\n' });
    expect(code(() => service.seal(as(TEAMMATE), 'a'))).toBe('forbidden');
    expect(service.seal(as(OWNER), 'a').head.sealed).toBe(true);
  });

  it('review focus 1: a second window of the same human gets base-changed, not an overwrite', () => {
    const made = service.create(as(OWNER), { title: 'A', body: 'v1\n' });
    const windowB = service.read(as(OWNER), 'a');
    service.saveBody(as(OWNER), 'a', {
      baseRev: made.rev.id,
      baseHash: windowB.rev.hash,
      body: 'v2 from window A\n',
    });
    let conflict: DocConflictError | null = null;
    try {
      service.saveBody(as(OWNER), 'a', {
        baseRev: made.rev.id,
        baseHash: windowB.rev.hash,
        body: 'v1 edited in window B\n',
      });
    } catch (err) {
      if (err instanceof DocConflictError) conflict = err;
    }
    expect(conflict?.conflict).toMatchObject({
      reason: 'base-changed',
      hunks: [],
      marked: 'v2 from window A\n',
      head: { body: 'v2 from window A\n' },
    });
    expect(service.read(as(OWNER), 'a').text).toBe('v2 from window A\n');
  });

  it('rebuilds the section index of an amended head from the sweep', () => {
    const made = service.create(as(OWNER), { title: 'A', body: '# A\nx\n' });
    service.saveBody(as(OWNER), 'a', {
      baseRev: made.rev.id,
      body: '# A\nx\n## Later heading\nfind me\n',
    });
    expect(service.search(as(OWNER), { query: 'later' })).toEqual([]);
    expect(service.sweep().reindexed).toBe(1);
    expect(
      service.search(as(OWNER), { query: 'later' }).map((h) => h.anchor)
    ).toEqual(['later-heading']);
  });
});

describe('whole-body saves against a moved head', () => {
  function seed(): { base: string } {
    const made = service.create(as(OWNER), {
      title: 'A',
      body: 'a\nb\nc\nd\ne\n',
    });
    service.seal(as(OWNER), 'a');
    return { base: made.rev.id };
  }

  it("stores the writer's revision and a merge revision on a clean merge", () => {
    const { base } = seed();
    service.edit(as(RUN), 'a', {
      ops: [{ op: 'replace', find: 'a\n', text: 'A\n' }],
    });
    const saved = service.saveBody(as(TEAMMATE), 'a', {
      baseRev: base,
      body: 'a\nb\nc\nd\nE\n',
    });
    expect(saved.status).toBe('merged');
    expect(saved.mine?.n).toBe(3);
    const read = service.read(as(TEAMMATE), 'a');
    expect(read.text).toBe('A\nb\nc\nd\nE\n');
    expect(read.rev).toMatchObject({
      cause: 'merge',
      author: 'human:alice',
      summary: 'merged with rev 2 by run:r-1',
    });
    const history = service.revisions(as(OWNER), 'a', {});
    expect(history.map((r) => [r.n, r.cause])).toEqual([
      [4, 'merge'],
      [3, 'save'],
      [2, 'edit'],
      [1, 'create'],
    ]);
    expect(history[1].parents).toEqual([base]);
  });

  it('answers a real conflict with 409 hunks and local labels, storing nothing', () => {
    const { base } = seed();
    service.edit(as(RUN), 'a', {
      ops: [{ op: 'replace', find: 'c\n', text: 'RUN\n' }],
    });
    const before = service.revisions(as(OWNER), 'a', {}).length;
    let conflict: DocConflictError | null = null;
    try {
      service.saveBody(as(TEAMMATE), 'a', {
        baseRev: base,
        body: 'a\nb\nHUMAN\nd\ne\n',
      });
    } catch (err) {
      if (err instanceof DocConflictError) conflict = err;
    }
    expect(conflict?.code).toBe('conflict');
    expect(conflict?.conflict.reason).toBe('merge-conflict');
    expect(conflict?.conflict.hunks).toEqual([
      { line: 3, base: ['c\n'], head: ['RUN\n'], mine: ['HUMAN\n'] },
    ]);
    expect(conflict?.conflict.marked).toContain(
      '<<<<<<< head (rev 2, run:r-1)\n'
    );
    expect(conflict?.conflict.marked).toContain('>>>>>>> yours\n');
    expect(service.revisions(as(OWNER), 'a', {}).length).toBe(before);
  });

  it("review focus 1: a stale autosave after an agent's ops merges, keeps both, and stays unreviewed", () => {
    const made = service.create(as(OWNER), {
      title: 'Spec',
      body: '# Spec\n## API\nold api\n## Risks\nnone\n',
    });
    const buffer = service.read(as(OWNER), 'spec');
    service.edit(as(AGENT), 'spec', {
      ops: [{ op: 'replace_section', section: 'API', text: 'agent api' }],
      baseRev: made.rev.id,
    });
    const saved = service.saveBody(as(OWNER), 'spec', {
      baseRev: buffer.rev.id,
      baseHash: buffer.rev.hash,
      body: '# Spec\n## API\nold api\n## Risks\nhuman risk\n',
    });
    expect(saved.status).toBe('merged');
    expect(service.read(as(OWNER), 'spec').text).toBe(
      '# Spec\n## API\nagent api\n## Risks\nhuman risk\n'
    );
    expect(saved.doc.unreviewed).toBe(true);
  });

  it('refuses a clean merge whose result is over the cap', () => {
    const big = 'x'.repeat(500 * 1024);
    const made = service.create(as(OWNER), { title: 'Big', body: `${big}\n` });
    service.seal(as(OWNER), 'big');
    service.edit(as(RUN), 'big', {
      ops: [{ op: 'append', text: 'y'.repeat(200 * 1024) }],
    });
    expect(() =>
      service.saveBody(as(TEAMMATE), 'big', {
        baseRev: made.rev.id,
        body: `z${'z'.repeat(100 * 1024)}\n${big}\n`,
      })
    ).toThrow('the merged body is over the limit; split the doc');
  });

  it("keeps a title changed on one side, and the writer's when both changed", () => {
    const { base } = seed();
    service.edit(as(RUN), 'a', {
      ops: [{ op: 'set_title', title: 'Run title' }],
    });
    expect(
      service.saveBody(as(TEAMMATE), 'a', {
        baseRev: base,
        body: 'a\nb\nc\nd\ne\nf\n',
      }).doc.title
    ).toBe('Run title');
    service.edit(as(RUN), 'a', {
      ops: [{ op: 'set_title', title: 'Run title 2' }],
    });
    expect(
      service.saveBody(as(TEAMMATE), 'a', {
        baseRev: base,
        body: 'a2\nb\nc\nd\ne\n',
        title: 'Mine',
      }).doc.title
    ).toBe('Mine');
  });

  it('says unchanged and stores nothing when nothing changed', () => {
    const made = service.create(as(OWNER), { title: 'A', body: 'x\n' });
    expect(
      service.saveBody(as(OWNER), 'a', { baseRev: made.rev.id, body: 'x\n' })
        .status
    ).toBe('unchanged');
  });

  it('says unchanged when the clean merge equals the head, storing nothing', () => {
    const made = service.create(as(OWNER), { title: 'A', body: 'a\nb\n' });
    service.seal(as(OWNER), 'a');
    const edited = service.edit(as(AGENT), 'a', {
      ops: [{ op: 'append', text: 'c' }],
    });
    const changesBefore = host.changes.length;
    const saved = service.saveBody(as(OWNER), 'a', {
      baseRev: made.rev.id,
      body: 'a\nb\n',
    });
    expect(saved).toMatchObject({
      status: 'unchanged',
      rev: { id: edited.rev.id, n: 2 },
      mine: { id: made.rev.id, n: 1 },
    });
    expect(saved.doc.updatedBy).toBe(AGENT.address);
    expect(service.revisions(as(OWNER), 'a', {})).toHaveLength(2);
    expect(service.read(as(OWNER), 'a').text).toBe('a\nb\nc\n');
    expect(
      host.changes.slice(changesBefore).map((c) => [c.kind, c.author])
    ).toEqual([['sealed', AGENT.address]]);
  });

  it('refuses a base that is not a revision of this doc', () => {
    service.create(as(OWNER), { title: 'A', body: 'x\n' });
    const other = service.create(as(OWNER), { title: 'B', body: 'y\n' });
    expect(
      code(() =>
        service.saveBody(as(OWNER), 'a', { baseRev: other.rev.id, body: 'z\n' })
      )
    ).toBe('invalid');
    expect(
      code(() => service.saveBody(as(OWNER), 'a', { baseRev: 9, body: 'z\n' }))
    ).toBe('invalid');
  });
});

describe('anchored edits', () => {
  it('applies to the head and reports what the agent did not read', () => {
    const made = service.create(as(OWNER), {
      title: 'A',
      body: '# A\n## API\nx\n',
    });
    service.seal(as(OWNER), 'a');
    service.edit(as(TEAMMATE), 'a', {
      ops: [{ op: 'append', text: 'teammate line' }],
    });
    const r = service.edit(as(RUN), 'a', {
      ops: [{ op: 'replace_section', section: '## API', text: 'run api' }],
      baseRev: made.rev.id,
    });
    expect(r.rebased).toEqual({
      since: [{ n: 2, author: 'human:alice', summary: 'appended' }],
    });
    expect(service.read(as(OWNER), 'a').text).toBe('# A\n## API\nrun api\n');
  });

  it('changes nothing when an op fails', () => {
    service.create(as(OWNER), { title: 'A', body: '# A\n' });
    expect(() =>
      service.edit(as(RUN), 'a', {
        ops: [
          { op: 'append', text: 'x' },
          { op: 'insert', before: 'Nope', text: 'y' },
        ],
      })
    ).toThrow('ops[1]');
    expect(service.read(as(OWNER), 'a').text).toBe('# A\n');
  });
});

describe('review state, revert and lifecycle', () => {
  it('lets only a decide-tier human mark reviewed, which seals and clears the flag', () => {
    service.create(as(AGENT), { title: 'A', body: 'x\n' });
    expect(code(() => service.markReviewed(as(TEAMMATE), 'a'))).toBe(
      'forbidden'
    );
    const reviewed = service.markReviewed(as(DECIDER), 'a');
    expect(reviewed).toMatchObject({
      unreviewed: false,
      head: { sealed: true },
    });
    expect(reviewed.reviewedRev).toBe(reviewed.head.id);
    expect(
      service.edit(as(OWNER), 'a', { ops: [{ op: 'append', text: 'human' }] })
        .doc.unreviewed
    ).toBe(false);
  });

  it('never flags a doc only humans wrote', () => {
    const made = service.create(as(OWNER), { title: 'A', body: 'x\n' });
    service.edit(as(TEAMMATE), 'a', { ops: [{ op: 'append', text: 'y' }] });
    expect(
      service.saveBody(as(OWNER), 'a', { baseRev: made.rev.id, body: 'z\nx\n' })
        .doc.unreviewed
    ).toBe(false);
  });

  it('reverts to an earlier revision as a new sealed one, carrying its flag', () => {
    service.create(as(OWNER), { title: 'A', body: 'human\n' });
    service.seal(as(OWNER), 'a');
    service.edit(as(RUN), 'a', {
      ops: [{ op: 'replace', find: 'human', text: 'agent' }],
    });
    service.edit(as(OWNER), 'a', {
      ops: [{ op: 'replace', find: 'agent', text: 'human again' }],
    });
    service.markReviewed(as(OWNER), 'a');
    const back = service.revert(as(OWNER), 'a', 2);
    expect(back.rev.n).toBe(4);
    expect(back.doc).toMatchObject({
      unreviewed: true,
      head: { sealed: true },
    });
    expect(service.read(as(OWNER), 'a').text).toBe('agent\n');
  });

  it('archives read-only, hides from the default list, and restores', () => {
    service.create(as(OWNER), { title: 'A', body: 'x\n' });
    expect(code(() => service.setStatus(as(TEAMMATE), 'a', 'archived'))).toBe(
      'forbidden'
    );
    service.setStatus(as(OWNER), 'a', 'archived');
    expect(() =>
      service.edit(as(OWNER), 'a', { ops: [{ op: 'append', text: 'y' }] })
    ).toThrow('archived; restore it first');
    expect(service.list(as(OWNER), {}).total).toBe(0);
    expect(service.list(as(OWNER), { includeArchived: true }).total).toBe(1);
    expect(service.setStatus(as(OWNER), 'a', 'draft').status).toBe('draft');
    expect(code(() => service.setStatus(as(OWNER), 'a', 'accepted'))).toBe(
      'invalid'
    );
  });

  it('renames, keeps the old slug resolving, and never gives it to another doc', () => {
    service.create(as(OWNER), { title: 'Old name', body: 'x\n' });
    service.rename(as(TEAMMATE), 'old-name', 'new-name');
    expect(service.read(as(OWNER), 'old-name').doc.handle).toBe('new-name');
    expect(
      code(() =>
        service.create(as(OWNER), { title: 'x', body: 'x', slug: 'old-name' })
      )
    ).toBe('conflict');
    expect(code(() => service.rename(as(RUN), 'new-name', 'third'))).toBe(
      'forbidden'
    );
  });

  it('renames a doc back to its own retired slug', () => {
    service.create(as(OWNER), { title: 'Old name', body: 'x\n' });
    service.create(as(OWNER), { title: 'Other', body: 'x\n' });
    service.rename(as(OWNER), 'old-name', 'new-name');
    expect(code(() => service.rename(as(OWNER), 'other', 'old-name'))).toBe(
      'conflict'
    );
    expect(service.rename(as(OWNER), 'new-name', 'old-name').handle).toBe(
      'old-name'
    );
    expect(service.read(as(OWNER), 'new-name').doc.handle).toBe('old-name');
    expect(code(() => service.rename(as(OWNER), 'other', 'new-name'))).toBe(
      'conflict'
    );
  });

  it('hard-deletes with a tombstone, decide tier only', () => {
    const made = service.create(as(OWNER), { title: 'A', body: 'x\n' });
    expect(code(() => service.remove(as(TEAMMATE), 'a'))).toBe('forbidden');
    service.remove(as(OWNER), 'a');
    expect(code(() => service.read(as(OWNER), made.doc.id))).toBe('not-found');
    expect(store.tombstone(made.doc.id)).toEqual({
      docId: made.doc.id,
      origin: null,
    });
  });

  it('emits changes after commit only', () => {
    service.create(as(OWNER), { title: 'A', body: 'x\n' });
    expect(host.changes.map((c) => c.kind)).toEqual(['created']);
    expect(() =>
      service.create(as(OWNER), { title: 'A', body: 'x\n', slug: 'a' })
    ).toThrow();
    expect(host.changes).toHaveLength(1);
  });

  it('drops the changes queued by a write that fails inside its transaction', () => {
    const spec = {
      target: { type: 'task' as const, id: 't-2' },
      rel: 'spec' as const,
    };
    service.create(as(OWNER), { title: 'Spec', body: 'x\n', links: [spec] });
    // The spec 409 comes from inside create()'s transaction: no half-made doc.
    expect(
      code(() =>
        service.create(as(OWNER), { title: 'B', body: 'x\n', links: [spec] })
      )
    ).toBe('conflict');
    expect(code(() => service.read(as(OWNER), 'b'))).toBe('not-found');
    const other = service.create(as(TEAMMATE), { title: 'C', body: 'x\n' });
    const queued = host.changes.length;
    // link() seals the open head, queuing 'sealed', then the 409 rolls it back.
    expect(code(() => service.link(as(OWNER), 'c', spec))).toBe('conflict');
    expect(store.revision(other.rev.id)?.sealed).toBe(false);
    expect(host.changes).toHaveLength(queued);
    service.edit(as(TEAMMATE), 'c', { ops: [{ op: 'append', text: 'y' }] });
    expect(host.changes.slice(queued).map((c) => c.kind)).toEqual(['amended']);
  });

  it('seals an open head when someone else reads it through revision or diff', () => {
    const made = service.create(as(OWNER), { title: 'A', body: 'x\n' });
    service.revision(as(OWNER), 'a', 1);
    service.diff(as(OWNER), 'a', 1, 1);
    expect(store.revision(made.rev.id)?.sealed).toBe(false);
    service.revision(as(TEAMMATE), 'a', 1);
    expect(store.revision(made.rev.id)?.sealed).toBe(true);

    const b = service.create(as(OWNER), { title: 'B', body: 'x\n' });
    service.diff(as(TEAMMATE), 'b', b.rev.id, 1);
    expect(store.revision(b.rev.id)?.sealed).toBe(true);
  });
});

describe('the second run of another task', () => {
  it('writes team drafts like any execute run', () => {
    service.create(as(OWNER), { title: 'A', body: 'x\n' });
    expect(
      service.edit(as(RUN2), 'a', { ops: [{ op: 'append', text: 'y' }] }).status
    ).toBe('saved');
  });
});
