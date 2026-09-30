import type { DocFileMeta } from '@dispatch/core';
import {
  docBodyProblem,
  DOCS_LIMITS,
  docSlugProblem,
  docTitleProblem,
  normalizeDocText,
  parseDocFile,
  renderDocFile,
} from '@dispatch/core';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { ReceiptsStep } from '../receipts/exporter.js';
import { DocsError } from './errors.js';
import type { DocsService } from './service.js';

// Team docs in the receipt log: each written from its newest sealed head, and
// no file removed that the store cannot vouch for.

const DOCS_REL = join('.dispatch', 'docs');
const UNAVAILABLE = 'docs store unavailable; .dispatch/docs left as it was';

// How to clear a kept staging directory, named in the step's problem and the
// health route's restore report.
function clearHint(restoreDir: string): string {
  return `staged files are in ${restoreDir}; fix them and restart dispatchd to retry, or delete that directory once handled`;
}

// The staged restore's files, or none when nothing is staged.
function stagedFiles(restoreDir: string): string[] {
  if (!existsSync(restoreDir)) return [];
  return readdirSync(restoreDir).sort();
}

export function docsReceiptsStep(
  service: DocsService,
  restoreDir: string
): ReceiptsStep {
  return (dir) => {
    const docs = service.receiptsDocs();
    if (docs === null)
      return { changed: 0, removed: 0, problems: [UNAVAILABLE] };
    const out = join(dir, DOCS_REL);
    mkdirSync(out, { recursive: true });
    let changed = 0;
    const wanted = new Set<string>();
    for (const d of docs) {
      const file = `${d.row.handle}.md`;
      wanted.add(file);
      const meta: DocFileMeta = {
        id: d.row.id,
        slug: d.row.handle,
        title: d.head.title,
        status: d.row.status,
        rev: d.head.id,
        n: d.head.n ?? 0,
        parents: d.head.parents,
        author: d.head.author,
        cause: d.head.cause,
        createdAt: d.head.createdAt,
        hash: d.head.hash,
        links: d.links,
        authors: d.authors,
        updatedAt: d.row.updatedAt,
      };
      const text = renderDocFile(meta, d.head.body);
      const path = join(out, file);
      if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
        writeFileSync(path, text);
        changed++;
      }
    }
    const pending = stagedFiles(restoreDir);
    if (pending.length > 0) {
      return {
        changed,
        removed: 0,
        problems: [
          `a staged restore is pending (${pending.join(', ')}); nothing removed. ${clearHint(restoreDir)}`,
        ],
      };
    }
    const problems: string[] = [];
    let removed = 0;
    for (const file of readdirSync(out)) {
      if (wanted.has(file) || !file.endsWith('.md')) continue;
      const parsed = parseDocFile(readFileSync(join(out, file), 'utf8'));
      const id = 'error' in parsed ? null : parsed.meta.id;
      if (id !== null && service.knowsDoc(id)) {
        rmSync(join(out, file));
        removed++;
      } else {
        problems.push(
          `receipt file for unknown doc ${id ?? file}; run dispatch receipts restore, or delete the file`
        );
      }
    }
    return { changed, removed, problems };
  };
}

export interface RestoreReport {
  restored: number;
  skipped: number;
  problems: { file: string; detail: string }[];
  // Where the kept staging directory is and how to clear it; null once removed.
  pending: string | null;
  at: string;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ADDRESS = /^(human|run|agent):\S{1,200}$/;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

// Whether `id` is `<prefix>-` and a ULID, the shape the store mints.
function isId(id: string, prefix: 'doc' | 'rev'): boolean {
  return id.startsWith(`${prefix}-`) && ULID.test(id.slice(prefix.length + 1));
}

// A staged receipt file came from git, so its frontmatter says whatever its
// writer put there: the doc input rules apply before anything is inserted.
function restoreProblem(meta: DocFileMeta, body: string): string | null {
  if (!isId(meta.id, 'doc')) return `id ${meta.id} is not a doc- id`;
  if (!isId(meta.rev, 'rev')) return `rev ${meta.rev} is not a rev- id`;
  if (meta.parents.length > DOCS_LIMITS.revisionParents)
    return `parents must be at most ${DOCS_LIMITS.revisionParents}`;
  const badParent = meta.parents.find((p) => !isId(p, 'rev'));
  if (badParent !== undefined) return `parent ${badParent} is not a rev- id`;
  if (!ADDRESS.test(meta.author))
    return `author ${meta.author} is not an address`;
  if (
    !TIMESTAMP.test(meta.createdAt) ||
    Number.isNaN(Date.parse(meta.createdAt))
  )
    return `createdAt ${meta.createdAt} is not a timestamp`;
  const slug = docSlugProblem(meta.slug);
  if (slug !== null) return slug;
  const title = docTitleProblem(meta.title);
  if (title !== null) return title;
  if (normalizeDocText(body) !== body)
    return 'line endings must be LF with no leading BOM';
  return docBodyProblem(body);
}

// Applies the receipt files the CLI staged: a held or deleted id is skipped, a
// bad hash or a broken input rule is a problem, and the directory goes once
// every file applied. Null when nothing is staged or docs are unavailable.
export function applyStagedRestore(
  service: DocsService,
  restoreDir: string
): RestoreReport | null {
  if (!existsSync(restoreDir) || !service.available) return null;
  const report: RestoreReport = {
    restored: 0,
    skipped: 0,
    problems: [],
    pending: null,
    at: new Date().toISOString(),
  };
  for (const file of stagedFiles(restoreDir).filter((f) => f.endsWith('.md'))) {
    const path = join(restoreDir, file);
    const stat = lstatSync(path);
    if (!stat.isFile()) {
      report.problems.push({ file, detail: 'not a regular file' });
      continue;
    }
    if (stat.size > DOCS_LIMITS.receiptFileBytes) {
      report.problems.push({
        file,
        detail: `over ${DOCS_LIMITS.receiptFileBytes} bytes`,
      });
      continue;
    }
    const parsed = parseDocFile(readFileSync(path, 'utf8'));
    if ('error' in parsed) {
      report.problems.push({ file, detail: parsed.error });
      continue;
    }
    const hash = createHash('sha256').update(parsed.body).digest('hex');
    if (hash !== parsed.meta.hash) {
      report.problems.push({ file, detail: 'hash does not match the body' });
      continue;
    }
    const problem = restoreProblem(parsed.meta, parsed.body);
    if (problem !== null) {
      report.problems.push({ file, detail: problem });
      continue;
    }
    try {
      if (service.restoreDoc(parsed.meta, parsed.body) === 'restored')
        report.restored++;
      else report.skipped++;
    } catch (err) {
      if (!(err instanceof DocsError)) throw err;
      report.problems.push({ file, detail: err.message });
    }
  }
  if (report.problems.length === 0)
    rmSync(restoreDir, { recursive: true, force: true });
  else report.pending = clearHint(restoreDir);
  service.recordRestore(report);
  return report;
}
