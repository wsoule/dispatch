import {
  DOCS_LIMITS,
  docSlug,
  docTitleProblem,
  jsonEscapedBytes,
} from '@dispatch/core';

import { cutUtf8, fencedLines, splitLines, utf8Bytes } from './sections.js';

// The staged import's pure half: files grouped by name, contents ordered and
// split to fit the body cap, and a report whose two identities must hold.

export interface ImportFile {
  path: string;
  name: string;
  mtime: string;
  bytes: number;
  hash: string;
}

type ImportErrorReason =
  | 'invalid'
  | 'too-large'
  | 'not UTF-8'
  | 'missing'
  | 'archived';
export type ImportText =
  | { text: string }
  | { error: ImportErrorReason; detail: string };

export interface ImportReport {
  dryRun: boolean;
  files: number;
  names: number;
  distinctContents: number;
  docsCreated: number;
  docsExisting: number;
  partDocsCreated: number;
  contentsImported: number;
  splitContents: number;
  revisionsCreated: number;
  duplicates: number;
  alreadyPresent: number;
  tombstoned: number;
  tombstonedNames: number;
  failedNames: number;
  errors: { path: string; reason: ImportErrorReason; detail: string }[];
  parity: { files: boolean; names: boolean };
}

export interface NamePlan {
  // The file name without `.md`, which keys the name's origin and `imported` rows.
  key: string;
  // The handle the name's doc is created with, before collisions.
  slug: string;
  title: string;
  state: 'new' | 'existing' | 'tombstoned' | 'failed';
  contents: { hash: string; mtime: string; parts: string[] }[];
}

export interface ImportPlanState {
  imported(key: string, hash: string): boolean;
  tombstoned(key: string): boolean;
  archived(key: string): boolean;
  exists(key: string): boolean;
  partExists(key: string, k: number): boolean;
}

// Orders strings by code unit, the order ISO timestamps and hashes sort in.
function byText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// Files group by this key, so names that share a slug stay distinct docs.
export function nameKey(fileName: string): string {
  return fileName.replace(/\.md$/i, '');
}

export function nameSlug(fileName: string): string {
  return docSlug(nameKey(fileName));
}

// The first `# ` heading outside fenced code, cut to the title limit; the slug
// when there is none or it is not a valid title.
export function importTitle(text: string, slug: string): string {
  const lines = splitLines(text);
  const fenced = fencedLines(lines);
  for (let i = 0; i < lines.length; i++) {
    const m = /^# (.+?)\s*$/.exec(lines[i].replace(/\n$/, ''));
    if (fenced[i] || m === null) continue;
    const title = cutUtf8(m[1], DOCS_LIMITS.titleBytes).trim();
    return docTitleProblem(title) === null ? title : slug;
  }
  return slug;
}

// Whether `bytes` raw and `escaped` JSON-escaped bytes are within the body limits.
function withinCap(bytes: number, escaped: number): boolean {
  return (
    bytes <= DOCS_LIMITS.bodyBytes && escaped <= DOCS_LIMITS.escapedBodyBytes
  );
}

// The longest prefix of one over-long line within both byte limits, on a code point.
function cutLine(line: string): number {
  let bytes = 0;
  let escaped = 0;
  let at = 0;
  for (const ch of line) {
    const b = utf8Bytes(ch);
    const e = jsonEscapedBytes(ch);
    if (!withinCap(bytes + b, escaped + e)) break;
    bytes += b;
    escaped += e;
    at += ch.length;
  }
  return at;
}

// The line count of the longest prefix of `lines` within the body limits.
function fittingLines(lines: readonly string[]): number {
  let bytes = 0;
  let escaped = 0;
  let fits = 0;
  while (fits < lines.length) {
    const b = utf8Bytes(lines[fits]);
    const e = jsonEscapedBytes(lines[fits]);
    if (!withinCap(bytes + b, escaped + e)) break;
    bytes += b;
    escaped += e;
    fits++;
  }
  return fits;
}

// Cuts over-cap text before the last fitting `## ` outside fences, else `### `,
// else after a blank line, else at a line break; nothing is added.
export function splitForCap(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (!withinCap(utf8Bytes(rest), jsonEscapedBytes(rest))) {
    const lines = splitLines(rest);
    const fenced = fencedLines(lines);
    const fits = fittingLines(lines);
    // The largest cut in 1..fits where `pred` holds, else 0.
    const lastWhere = (pred: (i: number) => boolean): number => {
      for (let i = fits; i > 0; i--) if (pred(i)) return i;
      return 0;
    };
    const headingAt = (i: number, mark: string): boolean =>
      i < lines.length && !fenced[i] && lines[i].startsWith(mark);
    let cut = lastWhere((i) => headingAt(i, '## '));
    if (cut === 0) cut = lastWhere((i) => headingAt(i, '### '));
    if (cut === 0) cut = lastWhere((i) => lines[i - 1].trim() === '');
    if (cut === 0) cut = fits;
    const head =
      cut > 0 ? lines.slice(0, cut).join('') : rest.slice(0, cutLine(lines[0]));
    parts.push(head);
    rest = rest.slice(head.length);
  }
  if (rest !== '' || parts.length === 0) parts.push(rest);
  return parts;
}

// Groups files by name, puts each file in exactly one bucket and each name in
// exactly one state, and plans the contents each live name writes.
export function planImport(
  files: readonly ImportFile[],
  texts: ReadonlyMap<string, ImportText>,
  state: ImportPlanState
): { names: NamePlan[]; report: ImportReport } {
  const report: ImportReport = {
    dryRun: false,
    files: files.length,
    names: 0,
    distinctContents: 0,
    docsCreated: 0,
    docsExisting: 0,
    partDocsCreated: 0,
    contentsImported: 0,
    splitContents: 0,
    revisionsCreated: 0,
    duplicates: 0,
    alreadyPresent: 0,
    tombstoned: 0,
    tombstonedNames: 0,
    failedNames: 0,
    errors: [],
    parity: { files: false, names: false },
  };
  const groups = new Map<string, ImportFile[]>();
  for (const f of files) {
    const key = nameKey(f.name);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [f]);
    else group.push(f);
  }
  const distinct = new Set<string>();
  const names: NamePlan[] = [];
  const textOf = (hash: string): string => {
    const t = texts.get(hash);
    if (t === undefined || 'error' in t) throw new Error(`no text for ${hash}`);
    return t.text;
  };
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) =>
    byText(a, b)
  )) {
    const slug = nameSlug(group[0].name);
    const ordered = [...group].sort((a, b) => {
      const byMtime = byText(a.mtime, b.mtime);
      return byMtime !== 0 ? byMtime : byText(a.path, b.path);
    });
    const tombstoned = state.tombstoned(key);
    // An archived doc is read-only, so its new contents are errors, as a save's would be.
    const archived = !tombstoned && state.archived(key);
    // Each content's newest mtime among the files that import it.
    const newest = new Map<string, string>();
    let failed = 0;
    for (const f of ordered) {
      const t = texts.get(f.hash);
      // Already-imported content is never asked for, so its text is not needed.
      const present = state.imported(key, f.hash);
      const fail = (reason: ImportErrorReason, detail: string): void => {
        report.errors.push({ path: f.path, reason, detail });
        failed++;
      };
      if (f.bytes > DOCS_LIMITS.importContentBytes) {
        fail('too-large', `${f.bytes} bytes; imports take 8 MiB per file`);
      } else if (t === undefined && !present) {
        fail('missing', 'the content was never uploaded');
      } else if (t !== undefined && 'error' in t) {
        fail(t.error, t.detail);
      } else if (archived && !present) {
        fail('archived', 'the doc is archived; restore it first');
      } else {
        distinct.add(f.hash);
        if (tombstoned) report.tombstoned++;
        else if (present) report.alreadyPresent++;
        else if (newest.has(f.hash)) report.duplicates++;
        else report.contentsImported++;
        if (!tombstoned && !present) newest.set(f.hash, f.mtime);
      }
    }
    let stateOf: NamePlan['state'] = 'new';
    if (failed === ordered.length) stateOf = 'failed';
    else if (tombstoned) stateOf = 'tombstoned';
    else if (state.exists(key)) stateOf = 'existing';
    if (stateOf === 'failed') report.failedNames++;
    else if (stateOf === 'tombstoned') report.tombstonedNames++;
    else if (stateOf === 'existing') report.docsExisting++;
    else report.docsCreated++;
    // Only a name that will be written plans contents, ordered by their newest file.
    const live = stateOf === 'new' || stateOf === 'existing';
    const contents = (live ? [...newest.entries()] : [])
      .sort(([ha, ma], [hb, mb]) => {
        const byMtime = byText(ma, mb);
        return byMtime !== 0 ? byMtime : byText(ha, hb);
      })
      .map(([hash, mtime]) => {
        const parts = splitForCap(textOf(hash));
        if (parts.length > 1) report.splitContents++;
        report.revisionsCreated += parts.length;
        return { hash, mtime, parts };
      });
    const maxParts = Math.max(1, ...contents.map((c) => c.parts.length));
    for (let k = 2; k <= maxParts; k++)
      if (!state.partExists(key, k)) report.partDocsCreated++;
    const last = contents.at(-1);
    const title =
      last === undefined ? slug : importTitle(textOf(last.hash), slug);
    names.push({ key, slug, title, state: stateOf, contents });
  }
  report.names = groups.size;
  report.distinctContents = distinct.size;
  report.parity = {
    files:
      report.files ===
      report.duplicates +
        report.contentsImported +
        report.alreadyPresent +
        report.tombstoned +
        report.errors.length,
    names:
      report.names ===
      report.docsCreated +
        report.docsExisting +
        report.tombstonedNames +
        report.failedNames,
  };
  return { names, report };
}
