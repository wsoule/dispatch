import { untrustedBlock, untrustedInline } from '@dispatch/core';
import { LINE_BREAK } from '@dispatch/protocol';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

import { cutUtf8, MEMORY_LIMITS, utf8Bytes } from './limits.js';
import type { RankContext } from './rank.js';
import { reachTags } from './render.js';
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
// A `[text](target)` link anywhere in a line. A `[` behind a backslash opens no
// link and link text holds no bare `[`, so no scan crosses another's start.
const LINK = /(?<!\\)\[((?:\\.|[^\\\][])*)\]\(([^()\s]*)\)/;
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

// Cut to the body limit on a line boundary, ending with a marker naming the bytes cut.
function cutBody(body: string): { body: string; truncated: boolean } {
  const limit = MEMORY_LIMITS.bodyBytes;
  const size = utf8Bytes(body);
  if (size <= limit) return { body, truncated: false };
  const marker = (n: number) =>
    `\n[truncated by Dispatch: ${n} bytes; long-form belongs in Docs]`;
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
  return { body: text + marker(size - utf8Bytes(text)), truncated: true };
}

// Title and body as ingest reads them: frontmatter is informational, the
// provenance line and untrustedBlock's escapes are removed. A MEMORY.md link's
// text titles the file before Claude's `name`, a filename slug.
export function parseMemoryFile(
  text: string,
  fileName: string,
  opts: { linkText?: string } = {}
): ParsedMemoryFile {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  let front: Record<string, unknown> = {};
  let rest = source;
  const match = FRONTMATTER.exec(source);
  if (match !== null) {
    try {
      front = record(
        parseYaml(match[1] ?? '', {
          logLevel: 'error',
          uniqueKeys: false,
        }) as unknown
      );
      rest = source.slice(match[0].length);
    } catch {
      // Unparseable frontmatter reads as body, never as a failed ingest.
    }
  }
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
  const { body, truncated } = cutBody(unescaped);
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
  };
}

export function parsedHash(
  p: Pick<ParsedMemoryFile, 'title' | 'body'>
): string {
  return createHash('sha256')
    .update(JSON.stringify([p.title, p.body]))
    .digest('hex');
}

// Lines Claude added to MEMORY.md that link to no file here, each read as one
// title: a link line keeps its link text, a plain line its text after the bullet.
export function newIndexLines(
  written: string,
  current: string,
  files: ReadonlySet<string>
): string[] {
  const split = (text: string) =>
    text
      .replace(BREAKS, '\n')
      .split('\n')
      .map((line) => line.trim());
  const known = new Set(split(written));
  const titles = new Set<string>();
  for (const line of split(current)) {
    if (line === '' || known.has(line) || HEADER_LINES.has(line)) continue;
    const link = LINK.exec(line);
    if (link !== null && files.has(link[2].replace(/^\.\//, ''))) continue;
    const text =
      link === null
        ? line.replace(/^[-*+][ \t]+/, '')
        : link[1].replace(/\\([\\[\]])/g, '$1');
    const title = cutUtf8(untrustedInline(text), MEMORY_LIMITS.titleBytes);
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
