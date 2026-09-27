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

const OP_FIELDS: Record<DocOp['op'], readonly string[]> = {
  replace_section: ['section', 'text'],
  replace: ['find', 'text'],
  insert: ['before', 'text'],
  append: ['text'],
  set_title: ['title'],
};

const invalid = (field: string, why: string): never => {
  throw new DocsError('invalid', `${field}: ${why}`, field);
};

// Checks the shape and sizes of an ops array read off the wire.
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
      invalid(
        `${field}.op`,
        'expected replace_section, replace, insert, append or set_title'
      );
    }
    for (const key of OP_FIELDS[kind as DocOp['op']]) {
      if (typeof op[key] !== 'string')
        invalid(`${field}.${key}`, 'expected a string');
    }
    if (op.section !== undefined && typeof op.section !== 'string')
      invalid(`${field}.section`, 'expected a string');
    if (kind === 'replace') {
      const bytes = utf8Bytes(op.find as string);
      if (bytes < 1 || bytes > DOCS_LIMITS.findMaxBytes)
        invalid(`${field}.find`, '1 byte to 8 KiB');
    }
    return op as unknown as DocOp;
  });
}

// Text an op adds as whole lines: a missing final newline is added.
function wholeLines(text: string): string {
  const normal = normalizeDocText(text);
  return normal === '' || normal.endsWith('\n') ? normal : `${normal}\n`;
}

// before + text + after, adding the newline a last line lacks when more follows.
function splice(
  before: readonly string[],
  text: string,
  after: readonly string[]
): string {
  let head = before.join('');
  if (head !== '' && !head.endsWith('\n') && (text !== '' || after.length > 0))
    head += '\n';
  return head + text + after.join('');
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
  const parts: string[] = [];
  ops.forEach((op, i) => {
    const field = `ops[${i}]`;
    switch (op.op) {
      case 'replace_section': {
        const s = resolveSection(outline(body), op.section, field);
        const lines = splitLines(body);
        body = splice(
          lines.slice(0, s.line + 1),
          wholeLines(op.text),
          lines.slice(s.end)
        );
        parts.push(`replaced ${quoted(s.level, s.heading)}`);
        break;
      }
      case 'replace': {
        const find = normalizeDocText(op.find);
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
        const s = resolveSection(outline(body), op.before, field);
        const lines = splitLines(body);
        body = splice(
          lines.slice(0, s.line),
          wholeLines(op.text),
          lines.slice(s.line)
        );
        parts.push(`inserted before ${quoted(s.level, s.heading)}`);
        break;
      }
      case 'append': {
        const lines = splitLines(body);
        if (op.section === undefined) {
          body = splice(lines, wholeLines(op.text), []);
          parts.push('appended');
        } else {
          const s = resolveSection(outline(body), op.section, field);
          body = splice(
            lines.slice(0, s.end),
            wholeLines(op.text),
            lines.slice(s.end)
          );
          parts.push(`appended to ${quoted(s.level, s.heading)}`);
        }
        break;
      }
      case 'set_title': {
        const problem = docTitleProblem(op.title);
        if (problem !== null) invalid(field, problem);
        title = op.title.trim();
        parts.push('set the title');
        break;
      }
    }
  });
  return {
    body,
    title,
    summary: cutUtf8(parts.join('; '), DOCS_LIMITS.summaryBytes),
  };
}
