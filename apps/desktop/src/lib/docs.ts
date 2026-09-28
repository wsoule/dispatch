import type {
  DocDiff,
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

// The line a section's heading sits on, as the daemon's outline gives it; null
// for the preamble or an anchor the doc lacks.
export function anchorLine(
  outline: DocRead['outline'],
  anchor: string
): number | null {
  if (anchor === '') return null;
  return outline.find((e) => e.anchor === anchor)?.line ?? null;
}

// Unchanged lines kept around each change in a doc diff, as git keeps them.
const DIFF_CONTEXT = 3;

// One unified diff line: ' ' kept, '-' only in the older, '+' only in the newer.
interface PatchLine {
  mark: ' ' | '-' | '+';
  text: string;
}

// A hunk header's range: from 0 when it holds no lines, git's convention.
function hunkRange(before: number, count: number): string {
  return `${count === 0 ? before : before + 1},${count}`;
}

// The daemon's line chunks for two revisions as a one-file unified diff, the
// patch DiffSurface renders; empty when the two bodies are equal.
export function docDiffPatch(name: string, chunks: DocDiff['chunks']): string {
  const lines: PatchLine[] = [];
  for (const c of chunks) {
    if (c.equal) {
      for (const text of c.a) lines.push({ mark: ' ', text });
      continue;
    }
    for (const text of c.a) lines.push({ mark: '-', text });
    for (const text of c.b) lines.push({ mark: '+', text });
  }
  const changed = lines.flatMap((l, i) => (l.mark === ' ' ? [] : [i]));
  if (changed.length === 0) return '';
  // Changes at most two contexts apart share a hunk, as their context touches.
  const hunks: { start: number; end: number }[] = [];
  for (const i of changed) {
    const last = hunks[hunks.length - 1];
    if (last !== undefined && i - DIFF_CONTEXT <= last.end) {
      last.end = Math.min(lines.length, i + 1 + DIFF_CONTEXT);
    } else {
      hunks.push({
        start: Math.max(0, i - DIFF_CONTEXT),
        end: Math.min(lines.length, i + 1 + DIFF_CONTEXT),
      });
    }
  }
  let out = `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n`;
  let olds = 0;
  let news = 0;
  let at = 0;
  for (const { start, end } of hunks) {
    for (; at < start; at += 1) {
      if (lines[at].mark !== '+') olds += 1;
      if (lines[at].mark !== '-') news += 1;
    }
    const body = lines.slice(start, end);
    const oldCount = body.filter((l) => l.mark !== '+').length;
    const newCount = body.filter((l) => l.mark !== '-').length;
    out += `@@ -${hunkRange(olds, oldCount)} +${hunkRange(news, newCount)} @@\n`;
    for (const l of body) {
      out += l.text.endsWith('\n')
        ? `${l.mark}${l.text}`
        : `${l.mark}${l.text}\n\\ No newline at end of file\n`;
    }
  }
  return out;
}
