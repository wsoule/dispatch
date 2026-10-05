import { describe, expect, it } from 'bun:test';

import type { FoldRevision } from '../../../src/team/federation/docs.js';
import {
  claimHandles,
  covered,
  foldHeads,
  foldPair,
  mergeRevisionId,
} from '../../../src/team/federation/docs.js';

const rev = (
  id: string,
  parents: string[],
  body: string,
  createdAt: string,
  cause: FoldRevision['cause'] = 'save'
): FoldRevision => ({ id, parents, cause, title: 'Spec', body, createdAt });

// A replica: every revision it holds, the merges it folded, and its heads.
// A batch is stored whole before one fold, as an apply pass does.
class Replica {
  readonly revs = new Map<string, FoldRevision>();
  receive(...batch: FoldRevision[]): void {
    for (const r of batch) this.revs.set(r.id, r);
    this.fold();
  }
  heads(): FoldRevision[] {
    const children = new Set([...this.revs.values()].flatMap((r) => r.parents));
    return [...this.revs.values()]
      .filter((r) => !children.has(r.id))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  private fold(): void {
    for (const f of foldHeads(
      this.heads(),
      (id) => this.revs.get(id) ?? null
    )) {
      this.revs.set(f.id, {
        id: f.id,
        parents: [...f.parents],
        cause: 'sync',
        title: f.title,
        body: f.body,
        createdAt: f.createdAt,
      });
    }
  }
}

const BASE = rev(
  'rev-00BASE',
  [],
  'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n',
  '2026-09-26T10:00:00.000Z'
);
const A = rev(
  'rev-01A',
  ['rev-00BASE'],
  'L1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n',
  '2026-09-26T10:01:00.000Z'
);
const B = rev(
  'rev-01B',
  ['rev-00BASE'],
  'l1\nl2\nl3\nl4\nL5\nl6\nl7\nl8\nl9\n',
  '2026-09-26T10:02:00.000Z'
);
const C = rev(
  'rev-01C',
  ['rev-00BASE'],
  'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nL9\n',
  '2026-09-26T10:03:00.000Z'
);

describe('the doc fold', () => {
  it('names a merge by its algorithm, base and sorted parents only', () => {
    const id = mergeRevisionId('rev-00BASE', ['rev-01B', 'rev-01A']);
    expect(id).toMatch(/^rev-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(mergeRevisionId('rev-00BASE', ['rev-01A', 'rev-01B'])).toBe(id);
    expect(mergeRevisionId('-', ['rev-01A', 'rev-01B'])).not.toBe(id);
  });

  it('converges three replicas to one head id and bytes whatever the arrival order', () => {
    const orders = [
      [A, B, C],
      [C, B, A],
      [B, C, A],
    ];
    const replicas = orders.map((order) => {
      const r = new Replica();
      r.receive(BASE);
      for (const x of order) r.receive(x);
      return r;
    });
    // Every sync merge is published: exchange everything until nothing new arrives.
    for (let round = 0; round < 4; round++) {
      const all = replicas.flatMap((r) => [...r.revs.values()]);
      for (const r of replicas)
        r.receive(...all.filter((v) => !r.revs.has(v.id)));
    }
    const heads = replicas.map((r) => r.heads());
    for (const h of heads) expect(h).toHaveLength(1);
    expect(new Set(heads.map((h) => h[0].id)).size).toBe(1);
    expect(heads[0][0].body).toBe('L1\nl2\nl3\nl4\nL5\nl6\nl7\nl8\nL9\n');
  });

  it('flags a conflict everywhere with id-labelled markers and identical bytes', () => {
    const X = rev(
      'rev-02X',
      ['rev-00BASE'],
      'X\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n',
      '2026-09-26T10:05:00.000Z'
    );
    const Y = rev(
      'rev-02Y',
      ['rev-00BASE'],
      'Y\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n',
      '2026-09-26T10:06:00.000Z'
    );
    const get = (id: string) => [BASE, X, Y].find((r) => r.id === id) ?? null;
    const one = foldPair(X, Y, get);
    const two = foldPair(Y, X, get);
    expect(one).toEqual(two);
    expect(one.conflicted).toBe(true);
    expect(
      one.body.startsWith(
        '<<<<<<< rev-02X\nX\n||||||| rev-00BASE\nl1\n=======\nY\n>>>>>>> rev-02Y\n'
      )
    ).toBe(true);
  });

  it('keeps an oversize fold within one op, identically in either order', () => {
    const big = (id: string, fill: string) =>
      rev(
        id,
        ['rev-00BASE'],
        `${fill.repeat(500 * 1024)}\nl2\n`,
        '2026-09-26T11:00:00.000Z'
      );
    const P = big('rev-03P', 'p');
    const Q = big('rev-03Q', 'q');
    const get = (id: string) => [BASE, P, Q].find((r) => r.id === id) ?? null;
    const f = foldPair(P, Q, get);
    expect(f).toEqual(foldPair(Q, P, get));
    expect(f.conflicted).toBe(true);
    expect(
      f.body.startsWith(
        '<<<<<<< rev-03P\n=======\n>>>>>>> rev-03Q (too large to merge; read it with doc_read(rev: "rev-03Q"))\n'
      )
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(f.body))).toBeLessThanOrEqual(
      960 * 1024 + 2
    );
  });

  it('converges a concurrent approve and reject of one held change on the reject', () => {
    const head = rev(
      'rev-04H',
      ['rev-00BASE'],
      'l1\nhuman\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n',
      '2026-09-26T12:00:00.000Z'
    );
    const tip = rev(
      'rev-04T',
      ['rev-00BASE'],
      'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nagent\n',
      '2026-09-26T11:59:00.000Z',
      'proposal'
    );
    const approve = rev(
      'rev-05A',
      ['rev-04H', 'rev-04T'],
      'l1\nhuman\nl3\nl4\nl5\nl6\nl7\nl8\nagent\n',
      '2026-09-26T12:01:00.000Z',
      'approve'
    );
    const reject = rev(
      'rev-05R',
      ['rev-04H', 'rev-04T'],
      head.body,
      '2026-09-26T12:02:00.000Z',
      'reject'
    );
    const get = (id: string) =>
      [BASE, head, tip, approve, reject].find((r) => r.id === id) ?? null;
    expect(foldPair(approve, reject, get).body).toBe(head.body);
  });

  it('gives a contested slug to the lower id and derives the other handle the same way everywhere', () => {
    const handles = claimHandles([
      { id: 'doc-01Z0Z0Z0Z0Z0Z0Z0Z0Z07K3M9P', slug: 'spec', aliases: [] },
      { id: 'doc-01A0A0A0A0A0A0A0A0A08F4G2H', slug: 'spec', aliases: [] },
    ]);
    expect(handles.get('doc-01A0A0A0A0A0A0A0A0A08F4G2H')).toBe('spec');
    expect(handles.get('doc-01Z0Z0Z0Z0Z0Z0Z0Z0Z07K3M9P')).toBe('spec-7k3m9p');
    expect(
      claimHandles([
        { id: 'doc-01B', slug: 'old', aliases: [] },
        { id: 'doc-01A', slug: 'new', aliases: ['old'] },
      ]).get('doc-01B')
    ).toBe('old');
  });

  it('holds back an uncovered revision to an accepted doc', () => {
    const speaks = (replica: string, address: string) =>
      replica === 'rep-1' && address === 'human:wyat';
    expect(
      covered(
        { author: 'human:wyat', cause: 'save', approval: null, task: null },
        { publisher: 'rep-1', speaksFor: speaks, policyAllows: () => false }
      )
    ).toBe(true);
    expect(
      covered(
        { author: 'run:r-9', cause: 'edit', approval: null, task: 't-1' },
        { publisher: 'rep-1', speaksFor: speaks, policyAllows: () => true }
      )
    ).toBe(false);
    expect(
      covered(
        {
          author: 'agent:dispatch',
          cause: 'approve',
          approval: { by: 'human:wyat' },
          task: null,
        },
        { publisher: 'rep-1', speaksFor: speaks, policyAllows: () => false }
      )
    ).toBe(true);
    expect(
      covered(
        {
          author: 'agent:dispatch',
          cause: 'approve',
          approval: { by: 'agent:dispatch', policy: { rung: 4 } },
          task: 't-1',
        },
        { publisher: 'rep-1', speaksFor: speaks, policyAllows: () => false }
      )
    ).toBe(false);
  });
});
