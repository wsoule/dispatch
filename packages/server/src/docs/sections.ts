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
export function splitLines(body: string): string[] {
  if (body === '') return [];
  const lines = body.split('\n').map((line) => `${line}\n`);
  if (body.endsWith('\n')) lines.pop();
  else lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1);
  return lines;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

// A closing fence: up to three spaces, at least as many fence characters, then blanks.
function closesFence(text: string, char: string, length: number): boolean {
  const body = text.replace(/^ {0,3}/, '');
  let n = 0;
  while (n < body.length && body[n] === char) n++;
  return n >= length && body.slice(n).trim() === '';
}

// Which lines sit inside fenced code, the fence lines themselves included.
export function fencedLines(lines: readonly string[]): boolean[] {
  const fenced = new Array<boolean>(lines.length).fill(false);
  let open: { char: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].replace(/\n$/, '');
    if (open === null) {
      const match = FENCE_OPEN.exec(text);
      if (match !== null) {
        open = { char: match[1][0], length: match[1].length };
        fenced[i] = true;
      }
      continue;
    }
    fenced[i] = true;
    if (closesFence(text, open.char, open.length)) open = null;
  }
  return fenced;
}

const ATX = /^ {0,3}(#{1,3})(?:[ \t]+(.*?))?[ \t]*$/;

// An ATX h1-h3 heading line's level and text, or null.
function atxHeading(
  line: string
): { level: 1 | 2 | 3; heading: string } | null {
  const match = ATX.exec(line.replace(/\n$/, ''));
  if (match === null) return null;
  const heading = (match[2] ?? '').replace(/(?:^|[ \t]+)#+$/, '').trim();
  return { level: match[1].length as 1 | 2 | 3, heading };
}

// GitHub's anchor rule before de-duplication: lowercase, keep letters, digits,
// spaces, '-' and '_', and turn each space into '-'.
function anchorBase(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

export function outline(body: string): Section[] {
  const lines = splitLines(body);
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
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0 || wanted === '') {
    throw new DocsError(
      'invalid',
      `${field}: section "${trimmed}" not found`,
      field
    );
  }
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
