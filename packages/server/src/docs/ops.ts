import type { DocOp } from '@dispatch/core';
import { DOCS_LIMITS, docTitleProblem, normalizeDocText } from '@dispatch/core';

import { DocsError } from './errors.js';
import {
  cutUtf8,
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

// Outline work one call may spend, in units of about half a microsecond, so a
// call stays well under a second on the daemon's one thread.
const OPS_WORK = 1_000_000;
const HEADING_WORK = 5;
const CHARS_PER_WORK = 32;
const HEADING_START = /^ {0,3}#/;

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

// Text an op adds as whole lines: a missing final newline is added.
function wholeLines(text: string): string {
  const normal = normalizeDocText(text);
  return normal === '' || normal.endsWith('\n') ? normal : `${normal}\n`;
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

// Overlapping occurrences of `find` in `body`, counted up to `cap`.
function occurrences(body: string, find: string, cap: number): number[] {
  const at: number[] = [];
  let from = body.indexOf(find);
  while (from !== -1 && at.length < cap) {
    at.push(from);
    from = body.indexOf(find, from + 1);
  }
  return at;
}

// What outlining `body` costs against OPS_WORK: one per line, HEADING_WORK
// more per heading-shaped line, and one per CHARS_PER_WORK characters.
function outlineWork(body: string, lines: readonly string[]): number {
  let work = lines.length + Math.ceil(body.length / CHARS_PER_WORK);
  for (const line of lines) if (HEADING_START.test(line)) work += HEADING_WORK;
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
    // The body's lines, once the call can afford to outline them.
    const outlined = (): string[] => {
      const lines = splitLines(body);
      work += outlineWork(body, lines);
      if (work > OPS_WORK) {
        invalid(
          field,
          'these ops scan too much of a long doc; send fewer section ops, or save the whole body'
        );
      }
      return lines;
    };
    switch (op.op) {
      case 'replace_section': {
        const lines = outlined();
        const s = resolveSection(outline(body), op.section, field);
        body = splice(
          lines.slice(0, s.line + 1).join(''),
          wholeLines(op.text),
          lines.slice(s.end).join('')
        );
        parts.push(`replaced ${quoted(s.level, s.heading)}`);
        break;
      }
      case 'replace': {
        const find = op.find.replace(/\r\n?/g, '\n');
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
          normalizeDocText(op.text) +
          body.slice(hits[0] + find.length);
        parts.push('replaced text');
        break;
      }
      case 'insert': {
        const lines = outlined();
        const s = resolveSection(outline(body), op.before, field);
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
        const s = resolveSection(outline(body), op.section, field);
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
    body: body.replace(/^\uFEFF+/, ''),
    title,
    summary: cutUtf8(parts.join('; '), DOCS_LIMITS.summaryBytes),
  };
}
