import type { DocOp } from '@dispatch-foo/core';
import { DOCS_LIMITS, docTitleProblem } from '@dispatch-foo/core';

import { DocsError } from './errors.js';
import {
  cutUtf8,
  FENCE_START,
  HEADING_START,
  outline,
  resolveSection,
  splitLines,
  utf8Bytes,
} from './sections.js';

// Anchored edits applied to the head, so an agent's edit re-applies over a
// human's newer text instead of conflicting with it (spec "Anchored edits").

export interface OpsResult {
  body: string;
  title: string;
  summary: string;
}

// Outlining and find scans one call may spend, in units of about 100 ns: 50
// section ops on a cap-sized prose doc, and about half a second on the
// daemon's one thread.
const OPS_WORK = 5_000_000;
const LINE_WORK = 4;
const CHARS_PER_WORK = 64;
const FENCE_WORK = 5;
const HEADING_WORK = 30;
const FIND_CHARS_PER_WORK = 12;

const OP_FIELDS: Record<DocOp['op'], readonly string[]> = {
  replace_section: ['section', 'text'],
  replace: ['find', 'text'],
  insert: ['before', 'text'],
  append: ['text'],
  set_title: ['title'],
};

const OP_KINDS =
  'expected replace_section, replace, insert, append or set_title';

const invalid = (field: string, why: string): never => {
  throw new DocsError('invalid', `${field}: ${why}`, field);
};

// Refuses an op kind parseOps would have refused. Typing `_op` as never makes
// the compiler reject a switch that misses a kind.
function unknownOp(field: string, _op: never): never {
  return invalid(`${field}.op`, OP_KINDS);
}

// Checks the shape and sizes of an ops array read off the wire, keeping only
// the fields each op takes.
export function parseOps(value: unknown): DocOp[] {
  if (!Array.isArray(value)) invalid('ops', 'expected a list of ops');
  const list = value as unknown[];
  if (list.length === 0) invalid('ops', 'at least one op');
  if (list.length > DOCS_LIMITS.opsPerCall)
    invalid('ops', `at most ${DOCS_LIMITS.opsPerCall} per call`);
  return list.map((raw, i) => {
    const field = `ops[${i}]`;
    if (typeof raw !== 'object' || raw === null)
      invalid(field, 'expected an object');
    const op = raw as Record<string, unknown>;
    const kind = op.op;
    if (typeof kind !== 'string' || !Object.hasOwn(OP_FIELDS, kind)) {
      invalid(`${field}.op`, OP_KINDS);
    }
    const out: Record<string, string> = { op: kind as string };
    for (const key of OP_FIELDS[kind as DocOp['op']]) {
      if (typeof op[key] !== 'string')
        invalid(`${field}.${key}`, 'expected a string');
      out[key] = op[key] as string;
    }
    if (op.section !== undefined && typeof op.section !== 'string')
      invalid(`${field}.section`, 'expected a string');
    if (kind === 'append' && op.section !== undefined)
      out.section = op.section as string;
    if (kind === 'replace') {
      const bytes = utf8Bytes(out.find);
      if (bytes < 1 || bytes > DOCS_LIMITS.findMaxBytes)
        invalid(`${field}.find`, '1 byte to 8 KiB');
    }
    return out as unknown as DocOp;
  });
}

// Op text with CRLF and lone CR as LF. A BOM in it is text like any other,
// since the text may land anywhere in the body.
function foldLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// Text an op adds as whole lines: a missing final newline is added.
function wholeLines(text: string): string {
  const folded = foldLineEndings(text);
  return folded === '' || folded.endsWith('\n') ? folded : `${folded}\n`;
}

// How many BOMs `text` starts with.
function byteOrderMarks(text: string): number {
  let n = 0;
  while (text.charCodeAt(n) === 0xfeff) n++;
  return n;
}

// head + text + tail, adding the newline head's last line lacks when more follows.
function splice(head: string, text: string, tail: string): string {
  const more = text !== '' || tail !== '';
  const gap = head !== '' && !head.endsWith('\n') && more ? '\n' : '';
  return head + gap + text + tail;
}

function quoted(level: number, heading: string): string {
  return `"${'#'.repeat(level)} ${heading}"`;
}

// Overlapping occurrences of `find` in `body`, counted up to `cap`. A
// Knuth-Morris-Pratt scan stays linear on repetitive text, where indexOf can
// compare most of `find` at every offset.
function occurrences(body: string, find: string, cap: number): number[] {
  const fallback = new Int32Array(find.length);
  for (let i = 1, k = 0; i < find.length; i++) {
    while (k > 0 && find.charCodeAt(i) !== find.charCodeAt(k))
      k = fallback[k - 1];
    if (find.charCodeAt(i) === find.charCodeAt(k)) k++;
    fallback[i] = k;
  }
  const at: number[] = [];
  for (let i = 0, k = 0; i < body.length && at.length < cap; i++) {
    const c = body.charCodeAt(i);
    while (k > 0 && c !== find.charCodeAt(k)) k = fallback[k - 1];
    if (c === find.charCodeAt(k)) k++;
    if (k === find.length) {
      at.push(i - k + 1);
      k = fallback[k - 1];
    }
  }
  return at;
}

// Prices outlining and splicing `body` against OPS_WORK: LINE_WORK per line and
// one per CHARS_PER_WORK characters, FENCE_WORK more for a line that could open
// a fence, and HEADING_WORK plus one per character more for a heading-shaped
// line, since anchoring costs far more per character than prose does.
function outlineWork(body: string, lines: readonly string[]): number {
  let work = lines.length * LINE_WORK + Math.ceil(body.length / CHARS_PER_WORK);
  for (const line of lines) {
    if (HEADING_START.test(line)) work += HEADING_WORK + line.length;
    else if (FENCE_START.test(line)) work += FENCE_WORK;
  }
  return work;
}

// Applies ops in order, each to the body the previous one produced; throws
// before returning anything if any op fails, so the call is atomic.
export function applyOps(
  doc: { body: string; title: string },
  ops: readonly DocOp[]
): OpsResult {
  if (ops.length === 0) invalid('ops', 'at least one op');
  if (ops.length > DOCS_LIMITS.opsPerCall)
    invalid('ops', `at most ${DOCS_LIMITS.opsPerCall} per call`);
  let body = doc.body;
  let title = doc.title;
  let work = 0;
  const parts: string[] = [];
  ops.forEach((op, i) => {
    const field = `ops[${i}]`;
    // Charges `cost` to the call, refusing this op once it passes OPS_WORK.
    const spend = (cost: number): void => {
      work += cost;
      if (work > OPS_WORK) {
        invalid(
          field,
          'these ops scan too much of a long doc; send fewer section ops, or save the whole body'
        );
      }
    };
    // The body's lines, once the call can afford to outline them.
    const outlined = (): string[] => {
      const lines = splitLines(body);
      spend(outlineWork(body, lines));
      return lines;
    };
    switch (op.op) {
      case 'replace_section': {
        const lines = outlined();
        const s = resolveSection(outline(body, lines), op.section, field);
        body = splice(
          lines.slice(0, s.line + 1).join(''),
          wholeLines(op.text),
          lines.slice(s.end).join('')
        );
        parts.push(`replaced ${quoted(s.level, s.heading)}`);
        break;
      }
      case 'replace': {
        const find = foldLineEndings(op.find);
        if (find === '') invalid(`${field}.find`, '1 byte to 8 KiB');
        spend(Math.ceil(body.length / FIND_CHARS_PER_WORK));
        const hits = occurrences(body, find, 1000);
        if (hits.length === 0)
          throw new DocsError(
            'invalid',
            `${field}: find: not found`,
            `${field}.find`
          );
        if (hits.length > 1) {
          const count =
            hits.length === 1000 ? 'at least 1000' : String(hits.length);
          throw new DocsError(
            'invalid',
            `${field}: find: found ${count} times`,
            `${field}.find`
          );
        }
        body =
          body.slice(0, hits[0]) +
          foldLineEndings(op.text) +
          body.slice(hits[0] + find.length);
        parts.push('replaced text');
        break;
      }
      case 'insert': {
        const lines = outlined();
        const s = resolveSection(outline(body, lines), op.before, field);
        body = splice(
          lines.slice(0, s.line).join(''),
          wholeLines(op.text),
          lines.slice(s.line).join('')
        );
        parts.push(`inserted before ${quoted(s.level, s.heading)}`);
        break;
      }
      case 'append': {
        if (op.section === undefined) {
          body = splice(body, wholeLines(op.text), '');
          parts.push('appended');
          break;
        }
        const lines = outlined();
        const s = resolveSection(outline(body, lines), op.section, field);
        body = splice(
          lines.slice(0, s.end).join(''),
          wholeLines(op.text),
          lines.slice(s.end).join('')
        );
        parts.push(`appended to ${quoted(s.level, s.heading)}`);
        break;
      }
      case 'set_title': {
        const problem = docTitleProblem(op.title);
        if (problem !== null) invalid(field, problem);
        title = op.title.trim();
        parts.push('set the title');
        break;
      }
      default:
        unknownOp(field, op);
    }
    if (Buffer.byteLength(body, 'utf8') > DOCS_LIMITS.bodyBytes)
      invalid(
        field,
        'the body would be over 768 KiB; split it into linked docs'
      );
  });
  return {
    // Like any write, the leading BOMs the ops added go; the head's stay.
    body: body.slice(
      Math.max(0, byteOrderMarks(body) - byteOrderMarks(doc.body))
    ),
    title,
    summary: cutUtf8(parts.join('; '), DOCS_LIMITS.summaryBytes),
  };
}
