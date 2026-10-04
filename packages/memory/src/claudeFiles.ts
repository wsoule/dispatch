import { untrustedBlock, untrustedInline } from '@dispatch/core';
import { LINE_BREAK } from '@dispatch/protocol';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

import { cutUtf8, MEMORY_LIMITS, utf8Bytes } from './limits.js';
import type { RankContext } from './rank.js';
import { reachTags } from './render.js';
import { displayState, MEMORY_KINDS, MEMORY_SCOPES } from './types.js';
import type { MemoryEntry, MemoryKind } from './types.js';

type ClaudeType = 'feedback' | 'project' | 'reference';

export const CLAUDE_TYPE_FOR_KIND: Record<MemoryKind, ClaudeType> = {
  preference: 'feedback',
  convention: 'project',
  constraint: 'project',
  hazard: 'project',
  decision: 'project',
  fact: 'project',
  reference: 'reference',
};

export const CLAUDE_INDEX_HEADER = [
  'Managed by Dispatch. Add a memory as a new file here. Changes to team and project entries become proposals, which a human reviews',
  'unless policy approves them. Lines marked unreviewed were written by an agent.',
].join('\n');

export interface ParsedMemoryFile {
  title: string;
  body: string;
  type: string | undefined;
  modified: string | undefined;
  truncated: boolean;
  // The whole body before the cut, when `truncated`: a personal doc may take it.
  fullBody?: string;
}

// One exported file of a lineage directory, as written: `parsedHash` is what
// parseMemoryFile reads back from it, so a frontmatter-only touch matches.
export interface ManifestRow {
  lineage: string;
  file: string;
  store: string;
  memoryId: string;
  rev: number;
  parsedHash: string;
}

export interface ScannedFile {
  file: string;
  parsed: ParsedMemoryFile;
  hash: string;
}

export type ExportChange =
  | { type: 'new'; file: string; parsed: ParsedMemoryFile }
  | { type: 'changed'; row: ManifestRow; parsed: ParsedMemoryFile }
  | { type: 'deleted'; row: ManifestRow }
  | { type: 'renamed'; row: ManifestRow; file: string };

const BREAKS = new RegExp(LINE_BREAK.source, 'g');
const FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
const PROVENANCE = /^> Dispatch memory #[0-9A-Z]{8} /;
// A heading or fence line behind backslashes: parse strips one, so render adds
// one to a body line already shaped like this and the round trip is exact.
const ESCAPED_STRUCTURE = /^\\+\s*(?:#{1,6}[ \t]|~{4,})/;
// Every `[text](target)` link in a line. A `[` behind a backslash opens no
// link and link text holds no bare `[`, so no scan crosses another's start.
const LINKS = /(?<!\\)\[((?:\\.|[^\\\][])*)\]\(([^()\s]*)\)/g;
const BULLET = /^(?:[-*+]|\d+[.)])[ \t]+/;
const HEADING = /^#{1,6}(?:[ \t]|$)/;
const HEADER_LINES = new Set(CLAUDE_INDEX_HEADER.split('\n'));

// user and feedback notes become preferences; project and anything unknown are facts.
export function kindFromClaudeType(type: string | undefined): MemoryKind {
  switch (type?.trim().toLowerCase()) {
    case 'user':
    case 'feedback':
      return 'preference';
    case 'reference':
      return 'reference';
    default:
      return 'fact';
  }
}

// Claude keeps project and reference notes per repository, so they stay in this project.
export function projectOnlyForClaudeType(type: string | undefined): boolean {
  const t = type?.trim().toLowerCase();
  return t === 'project' || t === 'reference';
}

export function topicFileName(entry: Pick<MemoryEntry, 'id'>): string {
  return `${entry.id}.md`;
}

function trustNote(e: MemoryEntry): string {
  if (e.trust === 'agent')
    return 'unreviewed: an agent wrote this and no human has checked it.';
  if (e.trust === 'confirmed')
    return `confirmed by ${e.decidedBy ?? 'a human'}.`;
  return 'written by a human.';
}

// Claude Code's own layout (type nested under metadata), plus Dispatch's
// informational block; ingest never trusts any of it.
export function renderTopicFile(e: MemoryEntry): string {
  return renderEntryFile(e, []);
}

// The state a receipt shows: active, stale, or retired with its reason.
function receiptStatus(e: MemoryEntry): string {
  const state = displayState(e);
  if (state !== 'retired') return state;
  return `retired (${e.statusReason ?? 'expired'})`;
}

// The receipt log's copy of a team entry: the topic file plus its state.
export function renderReceiptFile(e: MemoryEntry): string {
  return renderEntryFile(e, [`    status: ${receiptStatus(e)}`]);
}

function renderEntryFile(e: MemoryEntry, extra: readonly string[]): string {
  return [
    '---',
    `name: ${e.id}`,
    `description: ${JSON.stringify(untrustedInline(e.title))}`,
    'metadata:',
    '  node_type: memory',
    `  type: ${CLAUDE_TYPE_FOR_KIND[e.kind]}`,
    '  dispatch:',
    `    handle: "${e.handle}"`,
    `    scope: ${e.scope}`,
    `    kind: ${e.kind}`,
    `    trust: ${e.trust}`,
    `    rev: ${e.rev}`,
    ...extra,
    '---',
    '',
    `> Dispatch memory ${e.handle} · ${e.scope} ${e.kind} · by ${untrustedInline(e.author)} · ${trustNote(e)}`,
    '',
    untrustedBlock(
      e.body
        .replace(BREAKS, '\n')
        .split('\n')
        .map((line) => (ESCAPED_STRUCTURE.test(line) ? `\\${line}` : line))
        .join('\n')
    ),
    '',
  ].join('\n');
}

function claudeIndexLine(e: MemoryEntry, ctx: RankContext): string {
  const tags = [
    e.kind,
    ...reachTags(e, ctx),
    ...(e.trust === 'agent' ? ['unreviewed'] : []),
  ];
  const text = untrustedInline(e.title).replace(/[\\[\]]/g, (c) => `\\${c}`);
  return `- [${text}](${topicFileName(e)}) — ${tags.join(' · ')}`;
}

// The header, then ranked link lines until the next would cross the budget; never skips ahead.
export function renderClaudeIndex(
  ranked: readonly MemoryEntry[],
  ctx: RankContext,
  budgetTokens: number
): { text: string; included: MemoryEntry[] } {
  const budget = budgetTokens * 3;
  const lines = [CLAUDE_INDEX_HEADER];
  let used = utf8Bytes(CLAUDE_INDEX_HEADER);
  const included: MemoryEntry[] = [];
  for (const entry of ranked) {
    const line = claudeIndexLine(entry, ctx);
    const cost = utf8Bytes(line) + 1;
    if (used + cost > budget) break;
    lines.push(line);
    used += cost;
    included.push(entry);
  }
  return { text: lines.join('\n'), included };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** `body` cut to the memory body limit on a line boundary, ending with
 *  `marker(n)` for the n bytes cut; unchanged when it already fits. */
export function cutMemoryBody(
  body: string,
  marker: (n: number) => string
): string {
  const limit = MEMORY_LIMITS.bodyBytes;
  const size = utf8Bytes(body);
  if (size <= limit) return body;
  const room = limit - utf8Bytes(marker(size));
  const lines = body.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = utf8Bytes(line) + (kept.length > 0 ? 1 : 0);
    if (used + cost > room) break;
    kept.push(line);
    used += cost;
  }
  // A first line longer than the room is cut mid-line rather than lost.
  if (kept.length === 0) kept.push(cutUtf8(lines[0], room));
  const text = kept.join('\n');
  return text + marker(size - utf8Bytes(text));
}

const PLAIN_MARKER = (n: number): string =>
  `\n[truncated by Dispatch: ${n} bytes; long-form belongs in Docs]`;

const DOC_MARKER =
  /\n\[truncated by Dispatch: (\d+) bytes; full text in doc (doc-[0-9A-Z]{26}) of project [^\]\n]+\]$/;

/** A personal entry's body and refs as a shared copy may carry them: an
 *  overflow marker naming its human's personal doc becomes the plain one, and
 *  that doc's ref is dropped, so a shared entry never points at a personal doc. */
export function withoutPersonalDoc<R extends { type: string; id: string }>(
  body: string,
  refs: readonly R[]
): { body: string; refs: R[] } {
  const m = DOC_MARKER.exec(body);
  if (m === null) return { body, refs: [...refs] };
  return {
    body: body.slice(0, m.index) + PLAIN_MARKER(Number(m[1])),
    refs: refs.filter((r) => !(r.type === 'doc' && r.id === m[2])),
  };
}

// Frontmatter past this size, or flow collections nested past this depth, is
// refused before YAML sees it: crafted input can cost the parser seconds.
const FRONTMATTER_MAX_BYTES = 4096;
const FRONTMATTER_MAX_DEPTH = 16;

// Why `yaml` is refused unparsed; null when it is small and shallow enough.
function frontmatterRefusal(yaml: string): string | null {
  if (utf8Bytes(yaml) > FRONTMATTER_MAX_BYTES)
    return `over ${FRONTMATTER_MAX_BYTES} bytes`;
  let depth = 0;
  let quote: string | null = null;
  for (const ch of yaml) {
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') {
      depth += 1;
      if (depth > FRONTMATTER_MAX_DEPTH)
        return `nested deeper than ${FRONTMATTER_MAX_DEPTH}`;
    } else if ((ch === ']' || ch === '}') && depth > 0) depth -= 1;
  }
  return null;
}

// A frontmatter refused unparsed, or one YAML could not read.
class FrontmatterRefused extends Error {}

// Parses are cached by content hash: a watched directory is re-read often.
const PARSE_CACHE_SIZE = 512;
const parseCache = new Map<string, { value: unknown } | { error: string }>();

// Frontmatter YAML, refused when oversized or deeply nested; throws on either
// refusal or a parse error, with the reason as the message's first line.
function parseFrontmatterYaml(yaml: string, uniqueKeys: boolean): unknown {
  const key = `${uniqueKeys ? 'u' : 'l'}:${createHash('sha256').update(yaml).digest('hex')}`;
  let hit = parseCache.get(key);
  if (hit === undefined) {
    const refusal = frontmatterRefusal(yaml);
    if (refusal !== null) hit = { error: refusal };
    else {
      try {
        hit = { value: parseYaml(yaml, { logLevel: 'error', uniqueKeys }) };
      } catch (err) {
        hit = {
          error:
            err instanceof Error ? err.message.split('\n')[0] : 'unreadable',
        };
      }
    }
    parseCache.set(key, hit);
    if (parseCache.size > PARSE_CACHE_SIZE) {
      const oldest = parseCache.keys().next().value;
      if (oldest !== undefined) parseCache.delete(oldest);
    }
  }
  if ('error' in hit) throw new FrontmatterRefused(hit.error);
  return hit.value;
}

// The parsed frontmatter and the text after it; unparseable YAML reads as body,
// and frontmatter refused unparsed is dropped.
function splitFrontmatter(text: string): {
  front: Record<string, unknown>;
  rest: string;
} {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const match = FRONTMATTER.exec(source);
  if (match === null) return { front: {}, rest: source };
  const rest = source.slice(match[0].length);
  if (frontmatterRefusal(match[1] ?? '') !== null) return { front: {}, rest };
  try {
    const front = record(parseFrontmatterYaml(match[1] ?? '', false));
    return { front, rest };
  } catch {
    // Unparseable frontmatter reads as body, never as a failed ingest.
    return { front: {}, rest: source };
  }
}

// Title and body as ingest reads them: frontmatter is informational, the
// provenance line and untrustedBlock's escapes are removed. A MEMORY.md link's
// text titles the file before Claude's `name`, a filename slug.
export function parseMemoryFile(
  text: string,
  fileName: string,
  opts: { linkText?: string } = {}
): ParsedMemoryFile {
  const { front, rest } = splitFrontmatter(text);
  const meta = record(front.metadata);
  const lines = rest.replace(BREAKS, '\n').split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  if (lines.length > 0 && PROVENANCE.test(lines[0])) {
    lines.shift();
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  }
  const unescaped = lines
    .map((line) => (ESCAPED_STRUCTURE.test(line) ? line.slice(1) : line))
    .join('\n')
    .trimEnd();
  const body = cutMemoryBody(unescaped, PLAIN_MARKER);
  const truncated = body !== unescaped;
  // A frontmatter fence left in the body by unparseable YAML is never the title.
  const firstLine = body
    .split('\n')
    .find((line) => line.trim() !== '' && line.trim() !== '---');
  const title = cutUtf8(
    untrustedInline(
      nonEmpty(front.description) ??
        nonEmpty(opts.linkText) ??
        nonEmpty(front.name) ??
        firstLine ??
        fileName.replace(/\.md$/, '')
    ),
    MEMORY_LIMITS.titleBytes
  );
  return {
    title,
    body,
    type: nonEmpty(meta.type) ?? nonEmpty(front.type),
    modified: nonEmpty(meta.modified) ?? nonEmpty(front.modified),
    truncated,
    ...(truncated ? { fullBody: unescaped } : {}),
  };
}

// The frontmatter's `metadata.dispatch` block read strictly: a duplicated key
// or unreadable YAML is a problem rather than a value picked silently.
function strictDispatch(text: string): {
  dispatch: Record<string, unknown>;
  problem: string | null;
} {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const match = FRONTMATTER.exec(source);
  if (match === null)
    return {
      dispatch: {},
      problem: 'frontmatter: missing or not terminated by ---',
    };
  try {
    const front = record(parseFrontmatterYaml(match[1] ?? '', true));
    return { dispatch: record(record(front.metadata).dispatch), problem: null };
  } catch (err) {
    const why =
      err instanceof Error ? err.message.split('\n')[0] : 'unreadable';
    return { dispatch: {}, problem: `frontmatter: ${why}` };
  }
}

// A receipt file as restore reads it: the kind is kept only when Dispatch
// knows it; the status is trimmed and lower-cased, and must be one string.
export function parseReceiptFile(
  text: string,
  fileName: string
): ParsedMemoryFile & {
  kind: MemoryKind;
  status: string | undefined;
  problem: string | null;
} {
  const { dispatch, problem } = strictDispatch(text);
  const kind = MEMORY_KINDS.find((k) => k === dispatch.kind) ?? 'fact';
  const raw = dispatch.status;
  const status = typeof raw === 'string' ? raw.trim().toLowerCase() : undefined;
  // A receipt always carries both; a file without them is damaged, not a lesson.
  const fieldProblem =
    typeof dispatch.scope !== 'string' ||
    !MEMORY_SCOPES.some((s) => s === dispatch.scope)
      ? 'scope: missing or unknown'
      : raw === undefined || status === ''
        ? 'status: missing'
        : typeof raw === 'string'
          ? null
          : 'status: expected a string';
  return {
    ...parseMemoryFile(text, fileName),
    kind,
    status: status === '' ? undefined : status,
    problem: problem ?? fieldProblem,
  };
}

export function parsedHash(
  p: Pick<ParsedMemoryFile, 'title' | 'body'>
): string {
  return createHash('sha256')
    .update(JSON.stringify([p.title, p.body]))
    .digest('hex');
}

// A MEMORY.md link target as a path relative to the notes directory.
function linkTarget(raw: string): string {
  const bare = raw.replace(/^<|>$/g, '').replace(/#.*$/, '');
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // A malformed escape is matched as written.
  }
  return decoded.replace(/^\.\//, '');
}

const unescapeLinkText = (text: string): string =>
  text.replace(/\\([\\[\]])/g, '$1');

/**
 * Reads MEMORY.md, for the import and export ingest alike: each file's first
 * link text titles it, and every other line (linking to no file here, not
 * blank, not a heading) is a fact.
 */
export function readClaudeIndex(
  text: string,
  files: ReadonlySet<string>
): { linkText: Map<string, string>; lines: string[] } {
  const linkText = new Map<string, string>();
  const lines = new Set<string>();
  for (const raw of text.split(LINE_BREAK)) {
    const line = raw.trim();
    if (line === '' || HEADING.test(line)) continue;
    let linked = false;
    for (const match of line.matchAll(LINKS)) {
      const file = linkTarget(match[2]);
      if (!files.has(file)) continue;
      linked = true;
      if (!linkText.has(file)) linkText.set(file, unescapeLinkText(match[1]));
    }
    if (!linked) lines.add(line);
  }
  return { linkText, lines: [...lines] };
}

/** A MEMORY.md line as a title: no bullet, each link reduced to its text. */
export function claudeIndexLineTitle(line: string): string {
  const text = line
    .replace(BULLET, '')
    .replace(LINKS, (_, label: string) => unescapeLinkText(label));
  return cutUtf8(untrustedInline(text), MEMORY_LIMITS.titleBytes).trim();
}

// Lines Claude added to MEMORY.md that link to no file here, each as a title.
export function newIndexLines(
  written: string,
  current: string,
  files: ReadonlySet<string>
): string[] {
  const known = new Set(
    written
      .replace(BREAKS, '\n')
      .split('\n')
      .map((line) => line.trim())
  );
  const titles = new Set<string>();
  for (const line of readClaudeIndex(current, files).lines) {
    if (known.has(line) || HEADER_LINES.has(line)) continue;
    const title = claudeIndexLineTitle(line);
    if (title !== '') titles.add(title);
  }
  return [...titles];
}

// Manifest rows against a scan: a missing file whose parsed hash reappears
// under a new name is a rename (one per row), otherwise a delete.
export function diffExport(
  manifest: readonly ManifestRow[],
  scanned: readonly ScannedFile[]
): ExportChange[] {
  const byFile = new Map(manifest.map((row) => [row.file, row]));
  const present = new Set(scanned.map((s) => s.file));
  const missing = manifest.filter((row) => !present.has(row.file));
  const missingByHash = new Map<string, ManifestRow[]>();
  for (const row of missing) {
    const same = missingByHash.get(row.parsedHash);
    if (same === undefined) missingByHash.set(row.parsedHash, [row]);
    else same.push(row);
  }
  const renamed = new Set<ManifestRow>();
  const changes: ExportChange[] = [];
  for (const s of scanned) {
    const row = byFile.get(s.file);
    if (row !== undefined) {
      if (row.parsedHash !== s.hash)
        changes.push({ type: 'changed', row, parsed: s.parsed });
      continue;
    }
    const from = missingByHash.get(s.hash)?.shift();
    if (from === undefined) {
      changes.push({ type: 'new', file: s.file, parsed: s.parsed });
      continue;
    }
    renamed.add(from);
    changes.push({ type: 'renamed', row: from, file: s.file });
  }
  for (const row of missing)
    if (!renamed.has(row)) changes.push({ type: 'deleted', row });
  return changes;
}
