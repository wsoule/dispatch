import type { DocRecord, DocRevisionInfo, DocSummary } from '@dispatch/client';

import type { DocBuffer } from './docBuffer';

type DocBadge =
  | 'team'
  | 'personal'
  | 'draft'
  | 'accepted'
  | 'archived'
  | 'unreviewed'
  | 'conflicted'
  | 'restored';

export function docBadges(
  doc: Pick<
    DocRecord,
    'scope' | 'status' | 'unreviewed' | 'conflicted' | 'restored'
  >
): DocBadge[] {
  return [
    doc.scope,
    doc.status,
    ...(doc.unreviewed ? (['unreviewed'] as const) : []),
    ...(doc.conflicted ? (['conflicted'] as const) : []),
    ...(doc.restored !== null ? (['restored'] as const) : []),
  ];
}

export interface DocFilter {
  query: string;
  scope: 'all' | 'team' | 'personal';
  status: 'active' | 'archived';
  unreviewedOnly: boolean;
}

export function filterDocs(
  docs: readonly DocSummary[],
  f: DocFilter
): DocSummary[] {
  const q = f.query.trim().toLowerCase();
  return docs.filter(
    (d) =>
      (f.status === 'archived') === (d.status === 'archived') &&
      (f.scope === 'all' || d.scope === f.scope) &&
      (!f.unreviewedOnly || d.unreviewed) &&
      (q === '' || d.title.toLowerCase().includes(q) || d.handle.includes(q))
  );
}

// What "Mark reviewed" covers: the listed revisions (newest first) after the
// last reviewed one; a review older than the page leaves all of them.
export function revisionsSinceReview(
  revisions: readonly DocRevisionInfo[],
  reviewedRev: string | null
): DocRevisionInfo[] {
  const reviewedN = revisions.find((r) => r.id === reviewedRev)?.n ?? 0;
  return revisions.filter((r) => (r.n ?? 0) > reviewedN);
}

// Whether two revision lists name the same revisions at the same hashes, so a
// Confirm still covers exactly what its list showed.
export function sameRevisions(
  a: readonly DocRevisionInfo[],
  b: readonly DocRevisionInfo[]
): boolean {
  return (
    a.length === b.length &&
    a.every((r, i) => r.id === b[i].id && r.hash === b[i].hash)
  );
}

export function docStatusLine(b: DocBuffer | null): string {
  if (b === null) return '';
  if (b.buffer.status === 'saving') return 'Saving…';
  if (b.buffer.status === 'dirty') return 'Unsaved';
  if (b.buffer.status === 'error') return b.buffer.error ?? 'Save failed';
  return b.base.n === null ? 'Saved' : `Saved · rev ${b.base.n}`;
}
