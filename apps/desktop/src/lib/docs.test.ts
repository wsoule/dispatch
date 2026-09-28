import type { DocRevisionInfo, DocSummary } from '@dispatch/client';
import { describe, expect, it } from 'bun:test';

import { openDocBuffer } from './docBuffer';
import {
  anchorLine,
  docBadges,
  docDiffPatch,
  docStatusLine,
  filterDocs,
  revisionsSinceReview,
  sameRevisions,
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

  it('tells a revision list apart from one with a new or amended revision', () => {
    const one = { ...rev('rev-1', 1), hash: 'h1' };
    expect(sameRevisions([one], [{ ...one }])).toBe(true);
    expect(
      sameRevisions([one], [{ ...rev('rev-2', 2), hash: 'h2' }, one])
    ).toBe(false);
    expect(sameRevisions([one], [{ ...one, hash: 'h9' }])).toBe(false);
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

describe('anchorLine', () => {
  const entry = (anchor: string, line: number) => ({
    ord: line + 1,
    level: 2,
    heading: anchor,
    anchor,
    bytes: 0,
    line,
  });

  it('takes the line the outline gives the section a ref names', () => {
    const outline = [entry('api', 4), entry('api-1', 6)];
    expect(anchorLine(outline, 'api')).toBe(4);
    expect(anchorLine(outline, 'api-1')).toBe(6);
  });

  it('has no line for the preamble or an anchor the doc lacks', () => {
    const outline = [entry('title', 0)];
    expect(anchorLine(outline, '')).toBeNull();
    expect(anchorLine(outline, 'gone')).toBeNull();
  });
});

describe('docDiffPatch', () => {
  const lines = (from: number, to: number): string[] =>
    Array.from({ length: to - from + 1 }, (_, i) => `${from + i}\n`);

  it('cuts one hunk per change with three lines of context', () => {
    const patch = docDiffPatch('spec.md', [
      { equal: true, a: lines(1, 5), b: lines(1, 5) },
      { equal: false, a: ['6\n'], b: ['six\n'] },
      { equal: true, a: lines(7, 14), b: lines(7, 14) },
      { equal: false, a: [], b: ['15\n'] },
    ]);
    expect(patch).toBe(
      [
        'diff --git a/spec.md b/spec.md',
        '--- a/spec.md',
        '+++ b/spec.md',
        '@@ -3,7 +3,7 @@',
        ' 3',
        ' 4',
        ' 5',
        '-6',
        '+six',
        ' 7',
        ' 8',
        ' 9',
        '@@ -12,3 +12,4 @@',
        ' 12',
        ' 13',
        ' 14',
        '+15',
        '',
      ].join('\n')
    );
  });

  it('joins changes whose context would touch into one hunk', () => {
    const patch = docDiffPatch('spec.md', [
      { equal: false, a: ['1\n'], b: ['one\n'] },
      { equal: true, a: lines(2, 7), b: lines(2, 7) },
      { equal: false, a: ['8\n'], b: [] },
    ]);
    expect(patch.match(/^@@ .* @@$/gm)).toEqual(['@@ -1,8 +1,7 @@']);
  });

  it('marks a last line with no newline, and counts from 0 into an empty body', () => {
    expect(docDiffPatch('a.md', [{ equal: false, a: [], b: ['x'] }])).toBe(
      'diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -0,0 +1,1 @@\n+x\n\\ No newline at end of file\n'
    );
  });

  it('is empty when nothing changed', () => {
    expect(
      docDiffPatch('a.md', [{ equal: true, a: ['x\n'], b: ['x\n'] }])
    ).toBe('');
  });
});
