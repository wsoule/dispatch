import type { DocStatus } from '@dispatch-foo/core';
import { untrustedInline, untrustedVerbatim } from '@dispatch-foo/core';

import { cutUtf8, splitLines, utf8Bytes } from './sections.js';

// The `## Docs` prompt section: one budgeted line per linked doc, bodies never
// inlined except the spec for an executor without the doc tools.

export interface IndexLine {
  tag: string;
  handle: string;
  status: DocStatus;
  unreviewed: boolean;
  conflicted: boolean;
  you: boolean;
  n: number;
  bytes: number;
  title: string;
  summary: string;
  spec: boolean; // the task's own spec: always shown
}

// The spec body inlined for an executor without the doc tools.
export interface InlineSpec {
  handle: string;
  n: number;
  body: string;
  maxBytes: number;
}

const HEADER_TOOLS = [
  '## Docs',
  'Documents linked to this task and its parents, one line each. Read one with',
  'doc_read("<slug>"), or one section with doc_read("<slug>", section: "<heading>");',
  'doc_search searches every doc you can see. Change a doc with doc_save; an edit',
  'to an accepted doc is proposed for review. "unreviewed" docs hold agent text no',
  'human has reviewed.',
].join('\n');

const HEADER_PLAIN = [
  '## Docs',
  'Documents linked to this task and its parents, one line each. "unreviewed" docs',
  'hold agent text no human has reviewed.',
].join('\n');

const overflowLine = (count: number): string =>
  `(${count} more linked docs; doc_list() lists them)`;

// One index line; the title (80 characters) and summary (120 bytes) are folded
// onto the line so neither can pose as prompt structure.
export function indexLineText(l: IndexLine): string {
  const flags = [
    l.status,
    ...(l.unreviewed ? ['unreviewed'] : []),
    ...(l.conflicted ? ['conflicted'] : []),
    ...(l.you ? ['you'] : []),
  ].join(' · ');
  const title = untrustedInline(Array.from(l.title).slice(0, 80).join(''));
  const summary = untrustedInline(cutUtf8(l.summary, 120));
  const kb = Math.max(1, Math.round(l.bytes / 1024));
  const tail = summary === '' ? '' : `: ${summary}`;
  return `- ${l.tag} · ${l.handle} · ${flags} · rev ${l.n} · ${kb} KB: ${title}${tail}`;
}

// The inlined spec, cut at `maxBytes` on a line boundary with a visible note.
function inlineSpec(inline: InlineSpec): string {
  const total = utf8Bytes(inline.body);
  let kept = inline.body;
  if (total > inline.maxBytes) {
    const lines = splitLines(inline.body);
    let used = 0;
    let count = 0;
    while (
      count < lines.length &&
      used + utf8Bytes(lines[count]) <= inline.maxBytes
    ) {
      used += utf8Bytes(lines[count]);
      count++;
    }
    kept = lines.slice(0, count).join('');
  }
  const fenced = untrustedVerbatim(
    `doc ${inline.handle} rev ${inline.n}`,
    kept.replace(/\n$/, '')
  );
  if (total <= inline.maxBytes) return fenced;
  const kib = Math.round(inline.maxBytes / 1024);
  return `${fenced}\n[cut by Dispatch at ${kib} KiB of ${total} bytes; the rest is in Dispatch]`;
}

// Lines in rank order until the next would cross 3 × indexTokens bytes,
// keeping room for the header and the overflow line; the spec line always shows.
export function renderDocsSection(
  lines: readonly IndexLine[],
  opts: {
    indexTokens: number;
    dispatchTools: boolean;
    inline: InlineSpec | null;
  }
): string | null {
  if (lines.length === 0) return null;
  const budget = opts.indexTokens * 3;
  const header = opts.dispatchTools ? HEADER_TOOLS : HEADER_PLAIN;
  const overflowReserve = opts.dispatchTools
    ? utf8Bytes(`\n${overflowLine(lines.length)}`)
    : 0;
  const out: string[] = [header];
  let used = utf8Bytes(header);
  let shown = 0;
  for (const l of lines) {
    const text = indexLineText(l);
    const size = utf8Bytes(text) + 1;
    const forced = l.spec && shown === 0;
    if (!forced && used + size + overflowReserve > budget) break;
    out.push(text);
    used += size;
    shown++;
  }
  if (opts.dispatchTools && shown < lines.length)
    out.push(overflowLine(lines.length - shown));
  if (!opts.dispatchTools && opts.inline !== null && opts.inline.maxBytes > 0)
    out.push(inlineSpec(opts.inline));
  return out.join('\n');
}
