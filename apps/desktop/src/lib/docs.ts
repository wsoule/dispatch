import type {
  DocRead,
  DocRecord,
  DocRevisionInfo,
  DocSummary,
} from '@dispatch/client';

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

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,3})(?:[ \t]+(.*))?$/;

// The line a section's heading sits on, matched by level and text among the
// headings outside fenced code; null for the preamble or an anchor the doc lacks.
export function anchorLine(
  text: string,
  outline: DocRead['outline'],
  anchor: string
): number | null {
  const target = outline.find((e) => e.anchor === anchor);
  if (anchor === '' || target === undefined) return null;
  let skip = outline.filter(
    (e) =>
      e.ord < target.ord &&
      e.level === target.level &&
      e.heading === target.heading
  ).length;
  let fence: string | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]);
    if (fence !== null) {
      const closes =
        open !== null &&
        open[1][0] === fence[0] &&
        open[1].length >= fence.length &&
        lines[i].slice(open[0].length).trim() === '';
      if (closes) fence = null;
      continue;
    }
    if (open !== null) {
      fence = open[1];
      continue;
    }
    const head = ATX.exec(lines[i]);
    if (head === null || head[1].length !== target.level) continue;
    const heading = (head[2] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '');
    if (heading.trim() !== target.heading) continue;
    if (skip === 0) return i;
    skip -= 1;
  }
  return null;
}
