import type { DocBody } from '@dispatch/protocol/federation';
import { beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';

import type { DocsService } from '../../../src/docs/service.js';
import type { SqliteDocStore } from '../../../src/docs/store.js';
import { DocOpHandler, foldPair } from '../../../src/team/federation/docs.js';
import type { FakeDocsHost } from '../../docs/fakeHost.js';
import { makeService, OWNER, RUN, TEAMMATE } from '../../docs/fakeHost.js';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const ID = (n: number, prefix: 'doc' | 'rev' = 'rev'): string =>
  `${prefix}-01K3Z9R${String(n).padStart(19, '0')}`;
const DOC = ID(1, 'doc');
const DOC2 = ID(2, 'doc');
// rep-1 speaks for human:wyat (this machine's owner); rep-2 for human:ada.
const SPEAKS = new Map([
  ['rep-1', new Set(['human:wyat'])],
  ['rep-2', new Set(['human:ada'])],
]);
const speaksFor = (replica: string, address: string): boolean =>
  SPEAKS.get(replica)?.has(address) ?? false;
const meta = (replica: string, seq: number, clock = seq) => ({
  replica,
  seq,
  hlc: `1758880000000.${String(clock).padStart(4, '0')}.${replica}`,
  speaksFor: (a: string) => speaksFor(replica, a),
});

interface RevInput {
  id: string;
  parents: string[];
  body: string;
  author: string;
  cause?: string;
  approval?: { by: string; policy?: { rung: number } };
  task?: string;
}
function put(doc: string, rev: RevInput, over: Partial<DocBody> = {}): DocBody {
  return {
    doc,
    kind: 'put',
    by: rev.author,
    revision: {
      id: rev.id,
      parents: rev.parents,
      title: 'Spec',
      body: rev.body,
      hash: sha(rev.body),
      author: rev.author,
      cause: (rev.cause ?? 'save') as never,
      summary: 'x',
      createdAt: '2026-09-26T10:00:00.000Z',
      ...(rev.approval === undefined ? {} : { approval: rev.approval }),
      ...(rev.task === undefined ? {} : { task: rev.task }),
    },
    meta: { slug: 'spec', title: 'Spec', status: 'draft' },
    ...over,
  } as DocBody;
}
const json = (b: DocBody) => b as never;

let service: DocsService;
let store: SqliteDocStore;
let host: FakeDocsHost;
let handler: DocOpHandler;
let rereads: { replica: string; seqs: number[] }[];
beforeEach(() => {
  ({ service, store, host } = makeService());
  host.operators.set('human:wyat', {
    human: 'human:wyat',
    identity: 'id-wyat',
  });
  rereads = [];
  handler = new DocOpHandler({ service, policyAllows: () => false });
  handler.bindFederation({
    speaksFor,
    rereadOps: (replica, seqs) => rereads.push({ replica, seqs: [...seqs] }),
  });
});
const owner = () => service.actorFor(OWNER);

describe('applying doc ops', () => {
  it("adapts federation's (op, { speaksFor }) to the inner rules", () => {
    const body = put(DOC, {
      id: ID(1),
      parents: [],
      body: 'v1\n',
      author: 'human:ada',
    });
    const m = meta('rep-2', 1);
    expect(
      handler.applyDocOp(
        { replica: m.replica, seq: m.seq, hlc: m.hlc, body },
        { speaksFor }
      )
    ).toBe('applied');
    expect(store.revision(ID(1))?.author).toBe('human:ada');
  });

  it('creates a team doc from a root revision, and marks one the publisher cannot speak for via <replica> and unreviewed', () => {
    expect(
      handler.apply(
        json(
          put(DOC, {
            id: ID(1),
            parents: [],
            body: 'v1\n',
            author: 'human:ada',
          })
        ),
        meta('rep-2', 1)
      )
    ).toBe('applied');
    expect(service.read(owner(), 'spec')).toMatchObject({
      doc: { id: DOC },
      text: 'v1\n',
    });
    expect(
      handler.apply(
        json(
          put(DOC, {
            id: ID(2),
            parents: [ID(1)],
            body: 'v2\n',
            author: 'human:wyat',
          })
        ),
        meta('rep-2', 2)
      )
    ).toBe('applied');
    expect(store.revisionMeta(ID(2))).toMatchObject({
      via: 'rep-2',
      unreviewed: true,
    });
  });

  it('drops a malformed body', () => {
    expect(
      handler.apply({ doc: DOC, kind: 'put', n: 1 }, meta('rep-2', 1))
    ).toBe('dropped');
  });

  it('keeps the stored revision when its id arrives with another hash, as a sync problem', () => {
    handler.apply(
      json(
        put(DOC, { id: ID(1), parents: [], body: 'v1\n', author: 'human:ada' })
      ),
      meta('rep-2', 1)
    );
    expect(
      handler.apply(
        json(
          put(DOC, {
            id: ID(1),
            parents: [],
            body: 'forged\n',
            author: 'human:ada',
          })
        ),
        meta('rep-2', 2)
      )
    ).toBe('dropped');
    expect(store.revision(ID(1))?.body).toBe('v1\n');
    expect(service.syncProblems(DOC).at(-1)).toContain(
      `${ID(1)} arrived with a different hash`
    );
  });

  it('refuses a sync merge whose id does not follow from its parents', () => {
    handler.apply(
      json(
        put(DOC, { id: ID(1), parents: [], body: 'v1\n', author: 'human:ada' })
      ),
      meta('rep-2', 1)
    );
    handler.apply(
      json(
        put(DOC, {
          id: ID(2),
          parents: [ID(1)],
          body: 'v1\nada\n',
          author: 'human:ada',
        })
      ),
      meta('rep-2', 2)
    );
    handler.apply(
      json(
        put(DOC, {
          id: ID(3),
          parents: [ID(1)],
          body: 'wyat\nv1\n',
          author: 'human:wyat',
        })
      ),
      meta('rep-1', 1)
    );
    const forged = put(DOC, {
      id: ID(4),
      parents: [ID(2), ID(3)],
      body: 'anything at all\n',
      author: 'agent:dispatch',
      cause: 'sync',
    });
    handler.passComplete();
    expect(handler.apply(json(forged), meta('rep-2', 3))).toBe('dropped');
    expect(service.syncProblems(DOC).at(-1)).toContain('sync merge');
    expect(service.read(owner(), 'spec').text).toBe('wyat\nv1\nada\n');
  });

  it('parks a revision whose parent has not arrived, and applies it once the parent does', () => {
    const child = put(DOC, {
      id: ID(2),
      parents: [ID(1)],
      body: 'v2\n',
      author: 'human:ada',
    });
    expect(handler.apply(json(child), meta('rep-2', 2))).toBe('parked');
    expect(
      handler.apply(
        json(
          put(DOC, {
            id: ID(1),
            parents: [],
            body: 'v1\n',
            author: 'human:ada',
          })
        ),
        meta('rep-2', 1)
      )
    ).toBe('applied');
    expect(handler.apply(json(child), meta('rep-2', 2))).toBe('applied');
    expect(service.read(owner(), 'spec').text).toBe('v2\n');
  });

  it('folds concurrent heads into one sync merge, as a teammate folding them would', () => {
    handler.apply(
      json(
        put(DOC, {
          id: ID(1),
          parents: [],
          body: 'a\nb\nc\n',
          author: 'human:ada',
        })
      ),
      meta('rep-2', 1)
    );
    handler.apply(
      json(
        put(DOC, {
          id: ID(2),
          parents: [ID(1)],
          body: 'A\nb\nc\n',
          author: 'human:ada',
        })
      ),
      meta('rep-2', 2)
    );
    handler.apply(
      json(
        put(DOC, {
          id: ID(3),
          parents: [ID(1)],
          body: 'a\nb\nC\n',
          author: 'human:wyat',
        })
      ),
      meta('rep-1', 1)
    );
    // Heads wait for the end of the pass, then fold once.
    expect(service.read(owner(), 'spec').text).toBe('A\nb\nc\n');
    handler.passComplete();
    const read = service.read(owner(), 'spec');
    expect(read.text).toBe('A\nb\nC\n');
    const head = store.revisionMeta(read.doc.head.id);
    expect(head).toMatchObject({
      cause: 'sync',
      author: 'agent:dispatch',
      parents: [ID(2), ID(3)],
    });
    // The same merge from a teammate is a duplicate, not a problem.
    const theirs = put(DOC, {
      id: read.doc.head.id,
      parents: [ID(2), ID(3)],
      body: 'A\nb\nC\n',
      author: 'agent:dispatch',
      cause: 'sync',
    });
    expect(handler.apply(json(theirs), meta('rep-2', 3))).toBe('applied');
    expect(service.syncProblems(DOC)).toEqual([]);
  });

  it('drops a status change from a human the publisher cannot speak for', () => {
    handler.apply(
      json(
        put(DOC, { id: ID(1), parents: [], body: 'v1\n', author: 'human:ada' })
      ),
      meta('rep-2', 1)
    );
    expect(
      handler.apply(
        {
          doc: DOC,
          kind: 'put',
          by: 'human:bob',
          meta: { status: 'accepted' },
        },
        meta('rep-2', 2)
      )
    ).toBe('dropped');
    expect(service.read(owner(), 'spec').doc.status).toBe('draft');
    expect(service.syncProblems(DOC).at(-1)).toContain('human:bob');
  });

  it('merges meta last-writer-wins per field on the op clock, with aliases as a union', () => {
    handler.apply(
      json(
        put(
          DOC,
          { id: ID(1), parents: [], body: 'v1\n', author: 'human:wyat' },
          { meta: { slug: 'old', title: 'Spec', status: 'draft', aliases: [] } }
        )
      ),
      meta('rep-1', 1, 1)
    );
    handler.apply(
      {
        doc: DOC,
        kind: 'put',
        by: 'human:wyat',
        meta: { slug: 'new', aliases: ['old'] },
      },
      meta('rep-1', 2, 3)
    );
    handler.apply(
      {
        doc: DOC,
        kind: 'put',
        by: 'human:ada',
        meta: { slug: 'stale', aliases: ['older'] },
      },
      meta('rep-2', 1, 2)
    );
    expect(service.read(owner(), 'new').doc).toMatchObject({
      id: DOC,
      slug: 'new',
    });
    expect(service.read(owner(), 'old').doc.id).toBe(DOC);
    expect(service.read(owner(), 'older').doc.id).toBe(DOC);
  });

  it('gives a contested slug to the lower id, deriving the same handles in any arrival order', () => {
    handler.apply(
      json(
        put(DOC2, { id: ID(20), parents: [], body: 'b\n', author: 'human:ada' })
      ),
      meta('rep-2', 1)
    );
    handler.apply(
      json(
        put(DOC, { id: ID(10), parents: [], body: 'a\n', author: 'human:wyat' })
      ),
      meta('rep-1', 1)
    );
    expect(service.read(owner(), 'spec').doc.id).toBe(DOC);
    expect(service.read(owner(), DOC2).doc.handle).toBe(
      `spec-${DOC2.slice(-6).toLowerCase()}`
    );
  });

  it('applies a review only from a human the publisher speaks for', () => {
    handler.apply(
      json(
        put(DOC, { id: ID(1), parents: [], body: 'v1\n', author: 'run:r-9' })
      ),
      meta('rep-2', 1)
    );
    expect(service.read(owner(), 'spec').doc.unreviewed).toBe(true);
    expect(
      handler.apply(
        { doc: DOC, kind: 'put', by: 'human:bob', review: { rev: ID(1) } },
        meta('rep-2', 2)
      )
    ).toBe('dropped');
    expect(
      handler.apply(
        { doc: DOC, kind: 'put', by: 'human:ada', review: { rev: ID(1) } },
        meta('rep-2', 3)
      )
    ).toBe('applied');
    expect(service.read(owner(), 'spec').doc.unreviewed).toBe(false);
  });

  it('removes a doc on a later removal, and a later revision revives it', () => {
    handler.apply(
      json(
        put(DOC, { id: ID(1), parents: [], body: 'v1\n', author: 'human:ada' })
      ),
      meta('rep-2', 1, 1)
    );
    expect(
      handler.apply(
        { doc: DOC, kind: 'remove', by: 'human:ada' },
        meta('rep-2', 2, 2)
      )
    ).toBe('applied');
    expect(store.doc(DOC)).toBeNull();
    // Older than the removal: spent.
    handler.apply(
      json(
        put(DOC, {
          id: ID(2),
          parents: [ID(1)],
          body: 'old\n',
          author: 'human:wyat',
        })
      ),
      meta('rep-1', 1, 1)
    );
    expect(store.doc(DOC)).toBeNull();
    handler.apply(
      json(
        put(DOC, {
          id: ID(3),
          parents: [ID(1)],
          body: 'later\n',
          author: 'human:wyat',
        })
      ),
      meta('rep-1', 2, 5)
    );
    expect(service.read(owner(), 'spec').text).toBe('later\n');
    expect(store.revisionMeta(ID(3))).toMatchObject({
      parents: [],
      restoredParents: [ID(1)],
    });
  });
});

describe('restored revisions', () => {
  const restored = (parents: string[]) =>
    service.restoreDoc(
      {
        id: DOC,
        slug: 'spec',
        title: 'Spec',
        status: 'draft',
        rev: ID(2),
        n: 2,
        parents,
        author: 'human:ada',
        cause: 'save',
        createdAt: '2026-09-26T09:00:00.000Z',
        hash: sha('restored\n'),
        links: [],
        authors: ['human:ada'],
        updatedAt: '2026-09-26T09:00:00.000Z',
      },
      'restored\n'
    );

  it('are replaced by the signed revision of the same id, with a problem when the bodies differ, and are never published until then', () => {
    restored([ID(1)]);
    expect(handler.pendingDocOps().some((b) => b.doc === DOC)).toBe(false);
    handler.apply(
      json(
        put(DOC, { id: ID(1), parents: [], body: 'v1\n', author: 'human:ada' })
      ),
      meta('rep-2', 1)
    );
    expect(
      handler.apply(
        json(
          put(DOC, {
            id: ID(2),
            parents: [ID(1)],
            body: 'signed\n',
            author: 'human:ada',
          })
        ),
        meta('rep-2', 2)
      )
    ).toBe('applied');
    expect(store.revision(ID(2))).toMatchObject({
      body: 'signed\n',
      provisional: false,
      author: 'human:ada',
    });
    expect(service.read(owner(), 'spec').text).toBe('signed\n');
    expect(service.syncProblems(DOC).at(-1)).toContain(
      'differs from the restored copy'
    );
  });

  it('are adopted after one complete pass when no replica supplied them, keeping the dropped parents for history', () => {
    restored([ID(1)]);
    handler.passComplete();
    expect(store.revision(ID(2))).toMatchObject({
      provisional: false,
      parents: [],
      restoredParents: [ID(1)],
    });
    expect(handler.pendingDocOps().map((b) => b.revision?.id)).toContain(ID(2));
  });
});

describe('accepted docs keep their gate across replicas', () => {
  function acceptedHere(): void {
    handler.apply(
      json(
        put(DOC, {
          id: ID(1),
          parents: [],
          body: 'l1\nl2\n',
          author: 'human:wyat',
        })
      ),
      meta('rep-1', 1)
    );
    service.setStatus(owner(), 'spec', 'accepted');
  }
  const runEdit = () =>
    put(DOC, {
      id: ID(2),
      parents: [ID(1)],
      body: 'l1\nl2\nagent\n',
      author: 'run:r-9',
      cause: 'edit',
      task: 't-1',
    });

  it('holds back an uncovered revision as one sync: proposal, and approving here applies it and travels', () => {
    acceptedHere();
    expect(handler.apply(json(runEdit()), meta('rep-2', 7))).toBe('applied');
    expect(service.read(owner(), 'spec').text).toBe('l1\nl2\n');
    const [p] = service.proposals(owner(), { state: ['open'] });
    expect(p).toMatchObject({
      rev: ID(2),
      origin: 'sync:rep-2',
      state: 'open',
    });
    expect(host.gatesRaised).toHaveLength(1);
    expect(service.approveProposal(p.rev, 'human:wyat', null)).toEqual({
      ok: true,
    });
    expect(service.read(owner(), 'spec').text).toBe('l1\nl2\nagent\n');
    const head = service.revisions(owner(), 'spec', {})[0];
    expect(head).toMatchObject({ cause: 'approve', parents: [ID(1), ID(2)] });
    expect(handler.pendingDocOps().map((b) => b.revision?.id)).toContain(
      head.id
    );
  });

  it('rejecting here writes a reject revision whose body is this head, and it travels', () => {
    acceptedHere();
    handler.apply(json(runEdit()), meta('rep-2', 7));
    service.rejectProposal(ID(2), 'human:wyat', 'keep it as is');
    const head = service.revisions(owner(), 'spec', {})[0];
    expect(head).toMatchObject({
      cause: 'reject',
      parents: [ID(1), ID(2)],
      author: 'human:wyat',
    });
    expect(service.read(owner(), 'spec').text).toBe('l1\nl2\n');
    expect(
      handler
        .pendingDocOps()
        .some(
          (b) => b.revision?.id === head.id && b.revision?.cause === 'reject'
        )
    ).toBe(true);
  });

  it('releases the held change when an approval by a human the publisher speaks for arrives', () => {
    acceptedHere();
    handler.apply(json(runEdit()), meta('rep-2', 7));
    const approve = put(DOC, {
      id: ID(3),
      parents: [ID(1), ID(2)],
      body: 'l1\nl2\nagent\n',
      author: 'human:ada',
      cause: 'approve',
      approval: { by: 'human:ada' },
    });
    expect(handler.apply(json(approve), meta('rep-2', 8))).toBe('applied');
    expect(service.read(owner(), 'spec').text).toBe('l1\nl2\nagent\n');
    expect(service.proposals(owner(), { state: ['open'] })).toEqual([]);
  });

  it('lets a revision by a human the publisher speaks for join the head', () => {
    acceptedHere();
    handler.apply(
      json(
        put(DOC, {
          id: ID(2),
          parents: [ID(1)],
          body: 'l1\nl2\nada\n',
          author: 'human:ada',
        })
      ),
      meta('rep-2', 8)
    );
    expect(service.read(owner(), 'spec').text).toBe('l1\nl2\nada\n');
    expect(service.proposals(owner(), { state: ['open'] })).toEqual([]);
  });
});

describe('overflow drops and the re-read', () => {
  it('records an overflow drop in sync_missing, and re-reads it when a later op names the missing parent', () => {
    handler.apply(
      json(
        put(DOC, { id: ID(1), parents: [], body: 'v1\n', author: 'human:ada' })
      ),
      meta('rep-2', 1)
    );
    handler.parkedDropped(
      { replica: 'rep-2', seq: 2, reason: 'overflow' },
      json(
        put(DOC, {
          id: ID(2),
          parents: [ID(1)],
          body: 'v2\n',
          author: 'human:ada',
        })
      )
    );
    expect(store.syncMissing()).toEqual([
      {
        revId: ID(2),
        docId: DOC,
        replica: 'rep-2',
        seq: 2,
        droppedAt: expect.any(String),
      },
    ]);
    expect(
      handler.apply(
        json(
          put(DOC, {
            id: ID(3),
            parents: [ID(2)],
            body: 'v3\n',
            author: 'human:ada',
          })
        ),
        meta('rep-2', 3)
      )
    ).toBe('parked');
    expect(rereads).toEqual([{ replica: 'rep-2', seqs: [2] }]);
  });

  it('treats a drop for revocation as final', () => {
    handler.parkedDropped(
      { replica: 'rep-2', seq: 2, reason: 'revoked' },
      json(
        put(DOC, {
          id: ID(2),
          parents: [ID(1)],
          body: 'v2\n',
          author: 'human:ada',
        })
      )
    );
    expect(store.syncMissing()).toEqual([]);
  });

  it("repairs every recorded drop, or one doc's, decide tier only through the service", () => {
    handler.apply(
      json(
        put(DOC, { id: ID(1), parents: [], body: 'a\n', author: 'human:ada' })
      ),
      meta('rep-2', 1)
    );
    handler.parkedDropped(
      { replica: 'rep-2', seq: 5, reason: 'overflow' },
      json(
        put(DOC, {
          id: ID(2),
          parents: [ID(1)],
          body: 'b\n',
          author: 'human:ada',
        })
      )
    );
    handler.parkedDropped(
      { replica: 'rep-1', seq: 9, reason: 'overflow' },
      json(
        put(DOC2, {
          id: ID(30),
          parents: [ID(29)],
          body: 'c\n',
          author: 'human:wyat',
        })
      )
    );
    expect(() => service.syncRepair(owner())).toThrow('team sync is not on');
    service.bindSync(handler);
    expect(() => service.syncRepair(service.actorFor(TEAMMATE))).toThrow(
      'decide-tier'
    );
    expect(service.syncRepair(owner(), 'spec')).toEqual({ reread: 1 });
    expect(service.syncRepair(owner())).toEqual({ reread: 2 });
    expect(rereads).toEqual([
      { replica: 'rep-2', seqs: [5] },
      { replica: 'rep-1', seqs: [9] },
      { replica: 'rep-2', seqs: [5] },
    ]);
  });
});

describe('what is published', () => {
  it('never publishes personal docs or open revisions, and nothing twice', () => {
    service.create(owner(), {
      title: 'Mine',
      body: 'private\n',
      scope: 'personal',
    });
    service.seal(owner(), '~mine');
    const team = service.create(owner(), { title: 'Team', body: 'shared\n' });
    expect(handler.pendingDocOps()).toEqual([]);
    service.seal(owner(), 'team');
    const pending = handler.pendingDocOps();
    expect([...new Set(pending.map((b) => b.doc))]).toEqual([team.doc.id]);
    expect(JSON.stringify(pending)).not.toContain('private');
    handler.published(pending);
    expect(handler.pendingDocOps()).toEqual([]);
  });

  it('publishes a status change by a human after the root, and a removal', () => {
    const team = service.create(owner(), { title: 'Team', body: 'shared\n' });
    service.seal(owner(), 'team');
    handler.published(handler.pendingDocOps(), [
      '1758880000000.0001.me-00000001',
    ]);
    service.setStatus(owner(), 'team', 'accepted');
    const status = handler.pendingDocOps();
    expect(status.filter((b) => b.meta !== undefined)).toEqual([
      {
        doc: team.doc.id,
        kind: 'put',
        by: 'human:wyat',
        meta: { status: 'accepted' },
      },
    ]);
    handler.published(handler.pendingDocOps());
    service.remove(owner(), 'team');
    expect(handler.pendingDocOps()).toEqual([
      { doc: team.doc.id, kind: 'remove', by: 'human:wyat' },
    ]);
  });
});

describe('sync problems a human can see', () => {
  it('shows a sync problem on the doc and in the conflicted list until a human reviews it', () => {
    handler.apply(
      json(
        put(DOC, { id: ID(1), parents: [], body: 'v1\n', author: 'human:ada' })
      ),
      meta('rep-2', 1)
    );
    handler.apply(
      json(
        put(DOC, {
          id: ID(1),
          parents: [],
          body: 'forged\n',
          author: 'human:ada',
        })
      ),
      meta('rep-2', 2)
    );
    const doc = service.read(owner(), 'spec').doc;
    expect(doc.problem).toContain('Team sync problem');
    expect(doc.problem).toContain('arrived with a different hash');
    expect(
      service.list(owner(), { conflicted: true }).docs.map((d) => d.id)
    ).toEqual([DOC]);
    service.markReviewed(owner(), 'spec');
    expect(service.read(owner(), 'spec').doc.problem).toBeUndefined();
    expect(service.list(owner(), { conflicted: true }).docs).toEqual([]);
  });
});

describe('a local removal not yet published', () => {
  // An op clock at a wall time, as a teammate's replica stamps it.
  const at = (iso: string, replica = 'rep-2') =>
    `${Date.parse(iso)}.0000.${replica}`;
  function removedHere(): void {
    handler.apply(
      json(
        put(DOC, { id: ID(1), parents: [], body: 'v1\n', author: 'human:ada' })
      ),
      meta('rep-2', 1)
    );
    host.clock = new Date('2026-09-26T11:00:00.000Z');
    service.remove(owner(), 'spec');
  }

  it('is clocked at the time it was made, on its tombstone', () => {
    removedHere();
    expect(store.tombstoneFull(DOC)?.hlc).toBe(
      `${Date.parse('2026-09-26T11:00:00.000Z')}.0000.local`
    );
  });

  it('spends a revision older than the removal and revives on a later one, by that clock', () => {
    removedHere();
    const older = put(DOC, {
      id: ID(2),
      parents: [ID(1)],
      body: 'older\n',
      author: 'human:ada',
    });
    expect(
      handler.apply(json(older), {
        ...meta('rep-2', 2),
        hlc: at('2026-09-26T10:30:00.000Z'),
      })
    ).toBe('applied');
    expect(store.doc(DOC)).toBeNull();
    const later = put(DOC, {
      id: ID(3),
      parents: [ID(1)],
      body: 'later\n',
      author: 'human:ada',
    });
    expect(
      handler.apply(json(later), {
        ...meta('rep-2', 3),
        hlc: at('2026-09-26T11:30:00.000Z'),
      })
    ).toBe('applied');
    expect(service.read(owner(), 'spec').text).toBe('later\n');
  });

  it('keeps its own clock when the removal is published', () => {
    removedHere();
    handler.published(
      handler.pendingDocOps().filter((b) => b.kind === 'remove'),
      [at('2026-09-26T12:00:00.000Z', 'rep-1')]
    );
    expect(store.tombstoneFull(DOC)?.hlc).toBe(
      `${Date.parse('2026-09-26T11:00:00.000Z')}.0000.local`
    );
  });
});

describe('what a pass reads', () => {
  it('looks only at docs changed since they were last found clean', () => {
    const team = service.create(owner(), { title: 'Team', body: 'shared\n' });
    service.seal(owner(), 'team');
    handler.published(handler.pendingDocOps());
    expect(handler.pendingDocOps()).toEqual([]);
    expect(store.metaKeys('sync:dirty:')).toEqual([]);
    service.setStatus(owner(), 'team', 'accepted');
    expect(store.metaKeys('sync:dirty:')).toEqual([
      `sync:dirty:${team.doc.id}`,
    ]);
    expect(handler.pendingDocOps().map((b) => b.meta?.status)).toContain(
      'accepted'
    );
  });
});

// FW-R38: the docs team-sync review's reproductions.
describe('what a teammate cannot slip in (FW-R38)', () => {
  const base = () => {
    handler.apply(
      json(
        put(DOC, {
          id: ID(1),
          parents: [],
          body: 'a\nb\nc\n',
          author: 'human:ada',
        })
      ),
      meta('rep-2', 1)
    );
    handler.apply(
      json(
        put(DOC, {
          id: ID(2),
          parents: [ID(1)],
          body: 'A\nb\nc\n',
          author: 'human:ada',
        })
      ),
      meta('rep-2', 2)
    );
    handler.apply(
      json(
        put(DOC, {
          id: ID(3),
          parents: [ID(1)],
          body: 'a\nb\nC\n',
          author: 'human:wyat',
        })
      ),
      meta('rep-1', 1)
    );
  };
  // The fold a replica computes for ID(2) and ID(3).
  const fold = () => {
    const get = (id: string) => {
      const r = store.revision(id);
      return r === null ? null : { ...r };
    };
    return foldPair(get(ID(2)) as never, get(ID(3)) as never, get);
  };
  const merge = (over: { title?: string; createdAt?: string } = {}) => {
    const f = fold();
    const body = put(DOC, {
      id: f.id,
      parents: [...f.parents],
      body: f.body,
      author: 'agent:dispatch',
      cause: 'sync',
    });
    const rev = body.revision as NonNullable<DocBody['revision']>;
    rev.title = over.title ?? f.title;
    rev.createdAt = over.createdAt ?? f.createdAt;
    delete body.meta;
    return body;
  };

  it('drops a sync merge whose title or time is not the fold of its parents', () => {
    base();
    expect(
      handler.apply(json(merge({ title: 'PWNED TITLE' })), meta('rep-2', 3))
    ).toBe('dropped');
    expect(
      handler.apply(
        json(merge({ createdAt: '2099-01-01T00:00:00.000Z' })),
        meta('rep-2', 4)
      )
    ).toBe('dropped');
    expect(handler.apply(json(merge()), meta('rep-2', 5))).toBe('applied');
    handler.passComplete();
    const read = service.read(owner(), 'spec');
    expect(read.doc.title).toBe('Spec');
    expect(store.revisionMeta(fold().id)?.createdAt).toBe(fold().createdAt);
  });

  function accepted(allows: boolean): DocOpHandler {
    const h = new DocOpHandler({ service, policyAllows: () => allows });
    h.bindFederation({ speaksFor, rereadOps: () => {} });
    h.apply(
      json(
        put(DOC, {
          id: ID(1),
          parents: [],
          body: 'l1\nl2\n',
          author: 'human:wyat',
        })
      ),
      meta('rep-1', 1)
    );
    service.setStatus(owner(), 'spec', 'accepted');
    return h;
  }

  it('holds a policy approval that sits on no held change, whatever the policy says', () => {
    const h = accepted(true);
    const sneak = put(DOC, {
      id: ID(2),
      parents: [ID(1)],
      body: 'fresh text\n',
      author: 'agent:dispatch',
      cause: 'approve',
      approval: { by: 'agent:dispatch', policy: { rung: 0 } },
      task: 't-easy',
    });
    expect(h.apply(json(sneak), meta('rep-2', 2))).toBe('applied');
    expect(service.read(owner(), 'spec').text).toBe('l1\nl2\n');
    expect(service.proposals(owner(), { state: ['open'] })).toHaveLength(1);
  });

  it('lets a policy approval of the held change join when this replica would approve it too', () => {
    const h = accepted(true);
    h.apply(
      json(
        put(DOC, {
          id: ID(2),
          parents: [ID(1)],
          body: 'l1\nl2\nagent\n',
          author: 'run:r-9',
          cause: 'edit',
          task: 't-1',
        })
      ),
      meta('rep-2', 2)
    );
    const approve = put(DOC, {
      id: ID(3),
      parents: [ID(1), ID(2)],
      body: 'l1\nl2\nagent\n',
      author: 'agent:dispatch',
      cause: 'approve',
      approval: { by: 'agent:dispatch', policy: { rung: 4 } },
      task: 't-1',
    });
    expect(h.apply(json(approve), meta('rep-2', 3))).toBe('applied');
    expect(service.read(owner(), 'spec').text).toBe('l1\nl2\nagent\n');
  });

  it('rules an approval for a task unknown here as elevated', () => {
    expect(service.syncPolicyAllows('t-nowhere')).toBe(false);
    host.ruling = (risk) =>
      risk === 'elevated'
        ? { mode: 'block' }
        : { mode: 'auto', gate: 'doc', rung: 4, authorizedBy: 'rung' };
    expect(service.syncPolicyAllows('t-1')).toBe(true);
    expect(service.syncPolicyAllows('t-nowhere')).toBe(false);
    expect(service.syncPolicyAllows(null)).toBe(false);
  });

  it('keeps a removed doc removed against a later revision no human covers', () => {
    handler.apply(
      json(
        put(DOC, { id: ID(1), parents: [], body: 'v1\n', author: 'human:ada' })
      ),
      meta('rep-2', 1, 1)
    );
    handler.apply(
      { doc: DOC, kind: 'remove', by: 'human:ada' },
      meta('rep-2', 2, 2)
    );
    handler.apply(
      json(
        put(DOC, {
          id: ID(3),
          parents: [ID(1)],
          body: 'run\n',
          author: 'run:r-9',
        })
      ),
      meta('rep-2', 3, 5)
    );
    expect(store.doc(DOC)).toBeNull();
    expect(service.syncProblems(DOC).at(-1)).toContain('run:r-9');
  });

  it('drops a slug change from a human the publisher cannot speak for', () => {
    handler.apply(
      json(
        put(DOC, { id: ID(1), parents: [], body: 'v1\n', author: 'human:ada' })
      ),
      meta('rep-2', 1)
    );
    expect(
      handler.apply(
        { doc: DOC, kind: 'put', by: 'human:bob', meta: { slug: 'hijack' } },
        meta('rep-2', 2)
      )
    ).toBe('dropped');
    expect(service.read(owner(), 'spec').doc.slug).toBe('spec');
  });

  it('caps new docs per publisher per hour, parking the rest with a note', () => {
    const h = new DocOpHandler({
      service,
      policyAllows: () => false,
      limits: { newDocsPerHour: 1, heldPerPublisher: 10 },
    });
    h.bindFederation({ speaksFor, rereadOps: () => {} });
    expect(
      h.apply(
        json(
          put(DOC, { id: ID(1), parents: [], body: 'a\n', author: 'human:ada' })
        ),
        meta('rep-2', 1)
      )
    ).toBe('applied');
    expect(
      h.apply(
        json(
          put(DOC2, {
            id: ID(20),
            parents: [],
            body: 'b\n',
            author: 'human:ada',
          })
        ),
        meta('rep-2', 2)
      )
    ).toBe('parked');
    expect(service.health(owner()).warnings.join('\n')).toContain('rep-2');
    host.advance(61);
    expect(
      h.apply(
        json(
          put(DOC2, {
            id: ID(20),
            parents: [],
            body: 'b\n',
            author: 'human:ada',
          })
        ),
        meta('rep-2', 2)
      )
    ).toBe('applied');
  });

  it('caps held proposals per publisher, parking the rest with a note', () => {
    const h = new DocOpHandler({
      service,
      policyAllows: () => false,
      limits: { newDocsPerHour: 100, heldPerPublisher: 1 },
    });
    h.bindFederation({ speaksFor, rereadOps: () => {} });
    for (const [doc, root] of [
      [DOC, ID(1)],
      [DOC2, ID(20)],
    ] as const) {
      h.apply(
        json(
          put(
            doc,
            { id: root, parents: [], body: 'l1\n', author: 'human:wyat' },
            {
              meta: {
                slug: doc === DOC ? 'spec' : 'other',
                title: 'Spec',
                status: 'draft',
              },
            }
          )
        ),
        meta('rep-1', doc === DOC ? 1 : 2)
      );
      service.setStatus(owner(), doc, 'accepted');
    }
    const edit = (doc: string, id: string, parent: string) =>
      put(
        doc,
        {
          id,
          parents: [parent],
          body: 'l1\nrun\n',
          author: 'run:r-9',
          cause: 'edit',
          task: 't-1',
        },
        { meta: undefined }
      );
    expect(h.apply(json(edit(DOC, ID(2), ID(1))), meta('rep-2', 1))).toBe(
      'applied'
    );
    expect(h.apply(json(edit(DOC2, ID(21), ID(20))), meta('rep-2', 2))).toBe(
      'parked'
    );
    expect(service.health(owner()).warnings.join('\n')).toContain('held');
  });

  it("clamps a revision's time to its op clock", () => {
    const body = put(DOC, {
      id: ID(1),
      parents: [],
      body: 'v1\n',
      author: 'human:ada',
    });
    (body.revision as NonNullable<DocBody['revision']>).createdAt =
      '2099-01-01T00:00:00.000Z';
    handler.apply(json(body), meta('rep-2', 1));
    expect(store.revisionMeta(ID(1))?.createdAt).toBe(
      new Date(1758880000000).toISOString()
    );
  });

  it("publishes an agent's link change as the agent's, never the owner's", () => {
    const team = service.create(owner(), { title: 'Team', body: 'shared\n' });
    service.seal(owner(), 'team');
    handler.published(handler.pendingDocOps());
    service.link(service.actorFor(RUN), 'team', {
      target: { type: 'task', id: 't-1' },
      rel: 'context',
    });
    const linked = handler
      .pendingDocOps()
      .filter((b) => b.meta?.links !== undefined);
    expect(linked).toEqual([
      expect.objectContaining({ doc: team.doc.id, by: 'run:r-1' }),
    ]);
  });
});

describe('meta changes travel as whoever made them', () => {
  it("sends a human's status change and a run's link change as two ops, the latest actor last", () => {
    const team = service.create(owner(), { title: 'Team', body: 'shared\n' });
    service.seal(owner(), 'team');
    handler.published(handler.pendingDocOps());
    service.setStatus(owner(), 'team', 'accepted');
    service.link(service.actorFor(RUN), 'team', {
      target: { type: 'task', id: 't-1' },
      rel: 'context',
    });
    const metas = handler.pendingDocOps().filter((b) => b.meta !== undefined);
    expect(metas).toEqual([
      {
        doc: team.doc.id,
        kind: 'put',
        by: 'human:wyat',
        meta: { status: 'accepted' },
      },
      {
        doc: team.doc.id,
        kind: 'put',
        by: 'run:r-1',
        meta: {
          links: [{ target: { type: 'task', id: 't-1' }, rel: 'context' }],
        },
      },
    ]);
    // A teammate replica speaking for human:wyat applies both, status included.
    const other = makeService();
    const there = new DocOpHandler({
      service: other.service,
      policyAllows: () => false,
    });
    there.bindFederation({ speaksFor, rereadOps: () => {} });
    handler.published([]);
    const all = handler.pendingDocOps();
    const root = put(team.doc.id, {
      id: store.revisionMetas(team.doc.id, { limit: 1 })[0].id,
      parents: [],
      body: 'shared\n',
      author: 'human:wyat',
    });
    root.revision = {
      ...(root.revision as NonNullable<DocBody['revision']>),
      title: 'Team',
    };
    root.meta = { slug: 'team', title: 'Team', status: 'draft' };
    there.apply(json(root), meta('rep-1', 1));
    all
      .filter((b) => b.meta !== undefined)
      .forEach((b, i) => there.apply(json(b), meta('rep-1', 2 + i)));
    const read = other.service.read(other.service.actorFor(OWNER), 'team');
    expect(read.doc.status).toBe('accepted');
    expect(other.service.syncProblems(team.doc.id)).toEqual([]);
  });
});

describe('a held chain has a length', () => {
  it('parks a held revision past the chain cap of its open proposal, with a note', () => {
    const h = new DocOpHandler({
      service,
      policyAllows: () => false,
      limits: { newDocsPerHour: 100, heldPerPublisher: 10, heldChain: 2 },
    });
    h.bindFederation({ speaksFor, rereadOps: () => {} });
    h.apply(
      json(
        put(DOC, { id: ID(1), parents: [], body: 'l1\n', author: 'human:wyat' })
      ),
      meta('rep-1', 1)
    );
    service.setStatus(owner(), 'spec', 'accepted');
    const edit = (n: number) =>
      put(
        DOC,
        {
          id: ID(n),
          parents: [ID(n - 1)],
          body: `l1\n${n}\n`,
          author: 'run:r-9',
          cause: 'edit',
          task: 't-1',
        },
        { meta: undefined }
      );
    expect(h.apply(json(edit(2)), meta('rep-2', 1))).toBe('applied');
    expect(h.apply(json(edit(3)), meta('rep-2', 2))).toBe('applied');
    expect(h.apply(json(edit(4)), meta('rep-2', 3))).toBe('parked');
    expect(service.health(owner()).warnings.join('\n')).toContain('chain');
  });
});
