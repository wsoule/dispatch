import type { DocRevisionInfo, DocSummary } from '@dispatch/client';
import { describe, expect, it } from 'bun:test';

import { openDocBuffer } from './docBuffer';
import {
  docBadges,
  docStatusLine,
  filterDocs,
  revisionsSinceReview,
} from './docs';

const doc = (over: Partial<DocSummary>): DocSummary =>
  ({
    id: 'doc-1',
    handle: 'a',
    title: 'Alpha',
    scope: 'team',
    status: 'draft',
    unreviewed: false,
    conflicted: false,
    restored: null,
    rel: null,
    fromParent: false,
    ...over,
  }) as DocSummary;

const rev = (id: string, n: number): DocRevisionInfo =>
  ({ id, n, author: 'run:r-1', summary: 'saved' }) as DocRevisionInfo;

describe('docs helpers', () => {
  it('badges scope, status and review state', () => {
    expect(
      docBadges(
        doc({ unreviewed: true, restored: { status: 'accepted', at: 'x' } })
      )
    ).toEqual(['team', 'draft', 'unreviewed', 'restored']);
    expect(docBadges(doc({ conflicted: true }))).toEqual([
      'team',
      'draft',
      'conflicted',
    ]);
  });

  it('filters by text, scope, archived and unreviewed', () => {
    const docs = [
      doc({}),
      doc({ id: 'doc-2', handle: 'b', title: 'Beta', unreviewed: true }),
      doc({ id: 'doc-3', handle: 'c', title: 'Gamma', status: 'archived' }),
    ];
    const base = {
      query: '',
      scope: 'all',
      status: 'active',
      unreviewedOnly: false,
    } as const;
    expect(filterDocs(docs, base).map((d) => d.handle)).toEqual(['a', 'b']);
    expect(
      filterDocs(docs, { ...base, query: 'bet' }).map((d) => d.handle)
    ).toEqual(['b']);
    expect(
      filterDocs(docs, { ...base, unreviewedOnly: true }).map((d) => d.handle)
    ).toEqual(['b']);
    expect(
      filterDocs(docs, { ...base, status: 'archived' }).map((d) => d.handle)
    ).toEqual(['c']);
    expect(filterDocs(docs, { ...base, scope: 'personal' })).toEqual([]);
  });

  it('lists the revisions after the last review, newest first', () => {
    const revisions = [rev('rev-3', 3), rev('rev-2', 2), rev('rev-1', 1)];
    expect(revisionsSinceReview(revisions, 'rev-1').map((r) => r.n)).toEqual([
      3, 2,
    ]);
    expect(revisionsSinceReview(revisions, null).map((r) => r.n)).toEqual([
      3, 2, 1,
    ]);
    // A review older than the page leaves every listed revision after it.
    expect(revisionsSinceReview(revisions, 'rev-0').map((r) => r.n)).toEqual([
      3, 2, 1,
    ]);
  });

  it('says where the buffer stands against its base', () => {
    expect(docStatusLine(null)).toBe('');
    expect(
      docStatusLine(
        openDocBuffer('doc-1', 'a', { rev: 'rev-2', n: 2, hash: 'h' })
      )
    ).toBe('Saved · rev 2');
  });
});
