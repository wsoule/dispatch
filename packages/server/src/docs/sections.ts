import { DocsError } from './errors.js';

// Markdown structure for docs, pure: lines, the ATX h1-h3 outline outside
// fenced code, GitHub anchors, section references, mentions, summaries, pages.

export interface Section {
  ord: number; // 0 is the preamble
  level: 0 | 1 | 2 | 3;
  heading: string; // as written, trimmed, without the # run; '' for the preamble
  anchor: string; // '' for the preamble
  line: number; // the heading line (the preamble starts at 0)
  ownEnd: number; // exclusive: the next heading of any level
  end: number; // exclusive: the next heading of the same or a higher level
}

export interface Mention {
  personal: boolean;
  slug: string;
  anchor: string | null;
}

export interface Page {
  text: string;
  offset: number;
  nextOffset: number | null;
  total: number;
}

const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

// The longest prefix of `text` within `maxBytes` UTF-8 bytes, cut between code points.
export function cutUtf8(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  let used = 0;
  let out = '';
  for (const ch of text) {
    const size = utf8Bytes(ch);
    if (used + size > maxBytes) break;
    used += size;
    out += ch;
  }
  return out;
}

// Lines of `body`, each keeping its '\n'; the last may lack one. '' has none.
// Slicing shares the body's storage instead of copying each line.
export function splitLines(body: string): string[] {
  const lines: string[] = [];
  for (let start = 0; start < body.length; ) {
    const newline = body.indexOf('\n', start);
    const end = newline === -1 ? body.length : newline + 1;
    lines.push(body.slice(start, end));
    start = end;
  }
  return lines;
}

function withoutNewline(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

// A fence run, after up to 8 list markers that open items on the same line. Each
// marker takes all 1-4 spaces after it, so the pattern cannot backtrack widely.
const FENCE_OPEN =
  /^ {0,3}((?:(?:[-+*]|\d{1,9}[.)]) {1,4}(?! )){0,8})(`{3,}|~{3,})/;

// What every line FENCE_OPEN or an ATX heading could match starts with. Both
// are tested first, so other lines skip the costlier patterns.
export const FENCE_START = /^ {0,3}(?:[-+*`~]|\d{1,9}[.)])/;
export const HEADING_START = /^ {0,3}#/;

// Columns of leading spaces and tabs (tab stops every 4) and the text after
// them, counting no further than `limit` columns.
function indentOf(
  text: string,
  limit: number
): { columns: number; rest: string } {
  let columns = 0;
  let i = 0;
  for (; i < text.length && columns < limit; i++) {
    if (text[i] === ' ') columns += 1;
    else if (text[i] === '\t') columns += 4 - (columns % 4);
    else break;
  }
  return { columns, rest: text.slice(i) };
}

// A closing fence: at least as many fence characters, then only blanks.
function closesFence(rest: string, char: string, length: number): boolean {
  let n = 0;
  while (n < rest.length && rest[n] === char) n++;
  return n >= length && rest.slice(n).trim() === '';
}

// Which lines sit inside fenced code, the fence lines themselves included. A
// fence opened in a list item also ends at the first line indented less than it.
export function fencedLines(lines: readonly string[]): boolean[] {
  const fenced = new Array<boolean>(lines.length).fill(false);
  let open: { char: string; length: number; indent: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const text = withoutNewline(lines[i]);
    if (open !== null) {
      // Past indent + 3 columns a line is fenced and cannot close the fence.
      const { columns, rest } = indentOf(text, open.indent + 4);
      if (rest === '' || columns >= open.indent) {
        fenced[i] = true;
        const closes =
          columns - open.indent <= 3 &&
          closesFence(rest, open.char, open.length);
        if (closes) open = null;
        continue;
      }
      open = null;
    }
    if (!FENCE_START.test(text)) continue;
    const match = FENCE_OPEN.exec(text);
    if (match === null) continue;
    const run = match[2];
    const info = text.slice(match[0].length);
    if (run[0] === '`' && info.includes('`')) continue;
    const indent = match[1] === '' ? 0 : match[0].length - run.length;
    open = { char: run[0], length: run.length, indent };
    fenced[i] = true;
  }
  return fenced;
}

const ATX = /^ {0,3}(#{1,3})(?:[ \t]+(.*))?$/;
const LINE_BREAK = /[\n\r\u2028\u2029]/;

// An ATX h1-h3 heading line's level and text, or null. The closing # run is
// found by a scan from the end, since a regex for it backtracks over blanks.
function atxHeading(
  line: string
): { level: 1 | 2 | 3; heading: string } | null {
  if (!HEADING_START.test(line)) return null;
  const text = withoutNewline(line);
  if (LINE_BREAK.test(text)) return null;
  const match = ATX.exec(text);
  if (match === null) return null;
  const content = match[2] ?? '';
  const isBlank = (at: number): boolean =>
    content[at] === ' ' || content[at] === '\t';
  let end = content.length;
  while (end > 0 && isBlank(end - 1)) end--;
  let hashes = end;
  while (hashes > 0 && content[hashes - 1] === '#') hashes--;
  if (hashes < end && (hashes === 0 || isBlank(hashes - 1))) end = hashes;
  const heading = content.slice(0, end).trim();
  return { level: match[1].length as 1 | 2 | 3, heading };
}

// GitHub's anchor rule before de-duplication: lowercase, keep letters, marks,
// digits, connector punctuation, spaces and '-', and turn each space into '-'.
function anchorBase(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

// The outline of `body`, whose lines a caller that already split it may pass.
export function outline(
  body: string,
  lines: readonly string[] = splitLines(body)
): Section[] {
  const fenced = fencedLines(lines);
  const heads: { line: number; level: 1 | 2 | 3; heading: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const head = atxHeading(lines[i]);
    if (head !== null) heads.push({ line: i, ...head });
  }
  const used = new Set<string>();
  const counts = new Map<string, number>();
  const unique = (base: string): string => {
    let n = counts.get(base) ?? 0;
    let candidate = n === 0 ? base : `${base}-${n}`;
    while (used.has(candidate)) {
      n += 1;
      candidate = `${base}-${n}`;
    }
    counts.set(base, n + 1);
    used.add(candidate);
    return candidate;
  };
  const firstHead = heads.length > 0 ? heads[0].line : lines.length;
  const sections: Section[] = [
    {
      ord: 0,
      level: 0,
      heading: '',
      anchor: '',
      line: 0,
      ownEnd: firstHead,
      end: firstHead,
    },
  ];
  heads.forEach((head, idx) => {
    let end = lines.length;
    for (let j = idx + 1; j < heads.length; j++) {
      if (heads[j].level <= head.level) {
        end = heads[j].line;
        break;
      }
    }
    const ownEnd = idx + 1 < heads.length ? heads[idx + 1].line : lines.length;
    sections.push({
      ord: idx + 1,
      level: head.level,
      heading: head.heading,
      anchor: unique(anchorBase(head.heading)),
      line: head.line,
      ownEnd,
      end,
    });
  });
  return sections;
}

// A section's text: through its subsections, or only its own lines when `own`.
export function sectionText(
  lines: readonly string[],
  s: Section,
  own = false
): string {
  return lines.slice(s.line, own ? s.ownEnd : s.end).join('');
}

// A section reference: heading text as written (optionally with its # run and a
// space, "## API") or "#<anchor>". The preamble is never an edit anchor.
export function resolveSection(
  sections: readonly Section[],
  ref: string,
  field: string
): Section {
  const trimmed = ref.trim();
  const byAnchor = /^#[^#\s]/.test(trimmed);
  const wanted = byAnchor
    ? trimmed.slice(1)
    : trimmed.replace(/^#{1,6}[ \t]+/, '').trim();
  const candidates = sections.filter(
    (s) => s.ord > 0 && (byAnchor ? s.anchor === wanted : s.heading === wanted)
  );
  if (wanted === '' || candidates.length === 0) {
    throw new DocsError(
      'invalid',
      `${field}: section "${trimmed}" not found`,
      field
    );
  }
  if (candidates.length === 1) return candidates[0];
  throw new DocsError(
    'invalid',
    `${field}: ambiguous: ${candidates.map((s) => `#${s.anchor}`).join(', ')}`,
    field
  );
}

const MENTION = /\[\[(~?)([a-z0-9][a-z0-9-]{0,63})(?:#([^\]\s]{1,200}))?\]\]/g;

// [[slug]], [[slug#anchor]] and [[~slug]] outside fenced code, first use of each doc.
export function mentionsOf(body: string): Mention[] {
  const lines = splitLines(body);
  const fenced = fencedLines(lines);
  const seen = new Set<string>();
  const out: Mention[] = [];
  lines.forEach((line, i) => {
    if (fenced[i]) return;
    for (const match of line.matchAll(MENTION)) {
      const key = `${match[1]}${match[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        personal: match[1] === '~',
        slug: match[2],
        anchor: match[3] ?? null,
      });
    }
  });
  return out;
}

const ANY_HEADING = /^#{1,6}([ \t]|$)/;

// The first paragraph that is not a heading or fenced code, joined and cut.
export function summaryOf(body: string, maxBytes = 120): string {
  const lines = splitLines(body);
  const fenced = fencedLines(lines);
  const paragraph: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].replace(/\n$/, '').trim();
    if (text === '' || fenced[i] || ANY_HEADING.test(text)) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(text);
  }
  return cutUtf8(paragraph.join(' '), maxBytes);
}

// Steps back from `at` to the start of the UTF-8 character it falls in.
function charStart(bytes: Uint8Array, at: number): number {
  let i = at;
  while (i > 0 && (bytes[i] & 0xc0) === 0x80) i--;
  return i;
}

// One page of `text` from byte `offset`, ending on a line boundary unless a
// single line is longer than a page, which is cut on a character boundary.
export function pageOf(text: string, offset: number, maxBytes: number): Page {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) {
    throw new RangeError('maxBytes: a page must hold a 4-byte character');
  }
  const bytes = Buffer.from(text, 'utf8');
  const total = bytes.byteLength;
  const insideChar = offset < total && (bytes[offset] & 0xc0) === 0x80;
  if (!Number.isInteger(offset) || offset < 0 || offset > total || insideChar) {
    throw new DocsError(
      'invalid',
      `offset: expected a line or character boundary in 0..${total}`,
      'offset'
    );
  }
  let end = Math.min(total, offset + maxBytes);
  if (end < total) {
    const lastNewline = bytes.lastIndexOf(0x0a, end - 1);
    end = lastNewline >= offset ? lastNewline + 1 : charStart(bytes, end);
  }
  return {
    text: bytes.subarray(offset, end).toString('utf8'),
    offset,
    nextOffset: end < total ? end : null,
    total,
  };
}
