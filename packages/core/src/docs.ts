// Docs wire types, limits and input checks shared by the daemon, the client,
// the CLI and the MCP tools. Pure, so the desktop can import it.

export type DocScope = 'personal' | 'team';
export type DocNamespace = 'team' | `p:${string}`;
export type DocStatus = 'draft' | 'accepted' | 'archived';
export const DOC_STATUSES: readonly DocStatus[] = [
  'draft',
  'accepted',
  'archived',
];

export type RevisionCause =
  | 'create'
  | 'save'
  | 'edit'
  | 'merge'
  | 'revert'
  | 'import'
  | 'restore'
  | 'proposal'
  | 'approve'
  | 'reject'
  | 'sync';

export type LinkRel = 'spec' | 'plan' | 'context';
export const LINK_RELS: readonly LinkRel[] = ['spec', 'plan', 'context'];
export type LinkTargetType = 'task' | 'run' | 'thread' | 'memory' | 'doc';
export const LINK_TARGET_TYPES: readonly LinkTargetType[] = [
  'task',
  'run',
  'thread',
  'memory',
  'doc',
];

export interface LinkTarget {
  type: LinkTargetType;
  id: string;
}

export interface DocHead {
  id: string;
  n: number;
  hash: string;
  bytes: number;
  sealed: boolean;
}

export interface DocRecord {
  id: string;
  ns: DocNamespace;
  slug: string;
  handle: string;
  title: string;
  scope: DocScope;
  owner: { human: string; identity: string } | null;
  status: DocStatus;
  archivedFrom: 'draft' | 'accepted' | null;
  restored: { status: DocStatus; at: string } | null;
  head: DocHead;
  reviewedRev: string | null;
  unreviewed: boolean;
  conflicted: boolean;
  origin: string | null;
  published: {
    path: string;
    rev: string;
    n: number | null;
    task: string;
    commit: string | null;
  } | null;
  // The path the newest publish asked for, so the publish dialog can offer it again.
  lastPublishPath: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface DocRevisionInfo {
  id: string;
  doc: string;
  n: number | null;
  parents: string[];
  title: string;
  author: string;
  cause: RevisionCause;
  summary: string;
  approval: { by: string; policy?: { rung: number } } | null;
  hash: string;
  bytes: number;
  conflicted: boolean;
  sealed: boolean;
  unreviewed: boolean;
  provisional: boolean;
  via: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocLink {
  doc: string;
  target: LinkTarget;
  rel: LinkRel;
  source: 'manual' | 'mention';
  createdBy: string;
  createdAt: string;
}

export interface DocOutlineEntry {
  ord: number;
  level: number;
  heading: string;
  anchor: string;
  bytes: number;
  // The heading's line in the whole body, counted from 0.
  line: number;
}

export type DocOp =
  | { op: 'replace_section'; section: string; text: string }
  | { op: 'replace'; find: string; text: string }
  | { op: 'insert'; before: string; text: string }
  | { op: 'append'; text: string; section?: string }
  | { op: 'set_title'; title: string };

export type DocSaveStatus =
  | 'saved'
  | 'amended'
  | 'merged'
  | 'proposed'
  | 'unchanged';

export interface DocSaveResult {
  doc: DocRecord;
  handle: string;
  rev: { id: string; n: number | null; hash: string };
  status: DocSaveStatus;
  rebased?: { since: { n: number; author: string; summary: string }[] };
  proposal?: string;
  gate?: string;
  // Merged only: a revision holding the text the writer sent (its own, or its base if it
  // changed nothing), which an editor still typing bases its next save on.
  mine?: { id: string; n: number | null; hash: string };
}

export interface DocConflict {
  code: 'conflict';
  reason: 'merge-conflict' | 'base-changed';
  head: { id: string; n: number; hash: string; body: string; author: string };
  base: { id: string; n: number } | null;
  hunks: { line: number; base: string[]; head: string[]; mine: string[] }[];
  marked: string;
}

export interface DocRead {
  doc: DocRecord;
  rev: DocRevisionInfo;
  links: DocLink[];
  outline: DocOutlineEntry[];
  section: { anchor: string; heading: string } | null;
  text: string;
  offset: number;
  nextOffset: number | null;
  total: number;
  proposal: string | null;
}

export interface DocSummary extends DocRecord {
  rel: LinkRel | null;
  fromParent: boolean;
}

export interface DocHit {
  doc: string;
  handle: string;
  title: string;
  scope: DocScope;
  anchor: string;
  heading: string;
  snippet: string;
  score: number;
}

export interface DocLinking {
  doc: DocRecord;
  rel: LinkRel;
  source: 'manual' | 'mention';
  fromParent: boolean;
}

export interface DocsHealth {
  available: boolean;
  reason: string | null;
  search: 'fts5' | 'like';
  bytes: number;
  warnings: string[];
  lastSweep: string | null;
  restore?: unknown;
  orphans?: string[];
}

export const DOCS_LIMITS = {
  titleBytes: 200,
  slugChars: 64,
  bodyBytes: 768 * 1024,
  escapedBodyBytes: 960 * 1024,
  linksPerDoc: 200,
  opsPerCall: 50,
  findMaxBytes: 8 * 1024,
  queryBytes: 500,
  readPageBytes: 32 * 1024,
  requestBytes: 2 * 1024 * 1024,
  importContentBytes: 8 * 1024 * 1024,
  importSessionBytes: 64 * 1024 * 1024,
  imageBytes: 25 * 1024 * 1024,
  summaryBytes: 200,
} as const;

// Route segments under /api/docs, so no slug can shadow one.
export const RESERVED_DOC_SLUGS: readonly string[] = [
  'search',
  'index',
  'links',
  'proposals',
  'imports',
  'health',
];

const LINE_BREAK = /[\r\n\v\f\u0085\u2028\u2029]/;
// Control characters (C0, DEL, C1) other than tab, which a terminal would act on.
const CONTROL = /(?!\t)\p{Cc}/u;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const encoder = new TextEncoder();

// Every write's line endings: CRLF and lone CR become LF, a leading BOM goes.
export function normalizeDocText(text: string): string {
  const stripped = text.startsWith('\uFEFF') ? text.slice(1) : text;
  return stripped.replace(/\r\n?/g, '\n');
}

// UTF-8 bytes of the body as a JSON string, without its two quotes.
export function jsonEscapedBytes(text: string): number {
  return encoder.encode(JSON.stringify(text)).byteLength - 2;
}

// Why a title is refused, or null: one non-blank line of at most 200 UTF-8
// bytes, free of control characters other than tab.
export function docTitleProblem(title: unknown): string | null {
  if (typeof title !== 'string') return 'title must be a string';
  if (title.trim() === '') return 'title must not be empty';
  if (LINE_BREAK.test(title)) return 'title must be one line';
  if (CONTROL.test(title)) return 'title must not contain control characters';
  if (encoder.encode(title).byteLength > DOCS_LIMITS.titleBytes)
    return 'title must be at most 200 bytes (UTF-8)';
  return null;
}

// Why a slug is refused, or null: the grammar, the id prefixes and the route words.
export function docSlugProblem(slug: unknown): string | null {
  if (typeof slug !== 'string') return 'slug must be a string';
  if (slug.length < 1 || slug.length > DOCS_LIMITS.slugChars)
    return 'slug must be 1-64 characters';
  if (!/^[a-z0-9-]+$/.test(slug)) return 'slug must use only [a-z0-9-]';
  if (!SLUG.test(slug)) return 'slug must start with a letter or digit';
  if (slug.startsWith('doc-') || slug.startsWith('rev-'))
    return 'slug must not start with doc- or rev-';
  if (RESERVED_DOC_SLUGS.includes(slug)) return `slug ${slug} is reserved`;
  return null;
}

// Why a body is refused, or null: no NUL, 768 KiB raw and 960 KiB JSON-escaped.
export function docBodyProblem(body: unknown): string | null {
  if (typeof body !== 'string') return 'body must be a string';
  if (body.includes('\u0000')) return 'body must not contain NUL';
  if (encoder.encode(body).byteLength > DOCS_LIMITS.bodyBytes)
    return 'body is over 768 KiB; split it into linked docs';
  if (jsonEscapedBytes(body) > DOCS_LIMITS.escapedBodyBytes) {
    return 'body is over 960 KiB once JSON-escaped; split it into linked docs';
  }
  return null;
}

// A derived slug held to 64 characters, cut back to its last whole word.
function fitSlug(slug: string): string {
  if (slug.length <= DOCS_LIMITS.slugChars) return slug;
  const cut = slug.slice(0, DOCS_LIMITS.slugChars);
  const dash = cut.lastIndexOf('-');
  return (dash > 0 ? cut.slice(0, dash) : cut).replace(/-+$/, '');
}

// A new doc's slug from its title. `slugify` cuts at 40, too short for dated
// names; a cut slug on an id prefix or a route word gets `the-` to stay valid.
export function docSlug(title: string): string {
  const base = fitSlug(
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  );
  if (base === '') return 'untitled';
  const refused =
    base.startsWith('doc-') ||
    base.startsWith('rev-') ||
    RESERVED_DOC_SLUGS.includes(base);
  return refused ? fitSlug(`the-${base}`) : base;
}

// A doc as a markdown file: frontmatter whose values are JSON scalars and
// arrays (valid YAML 1.2, so they round-trip exactly), then the body verbatim.
export interface DocFileMeta {
  id: string;
  slug: string;
  title: string;
  status: DocStatus;
  rev: string;
  n: number;
  parents: string[];
  author: string;
  cause: RevisionCause;
  createdAt: string;
  hash: string;
  links: { target: string; rel: LinkRel }[];
  authors: string[];
  updatedAt: string;
}

const DOC_FILE_FIELDS: readonly (keyof DocFileMeta)[] = [
  'id',
  'slug',
  'title',
  'status',
  'rev',
  'n',
  'parents',
  'author',
  'cause',
  'createdAt',
  'hash',
  'links',
  'authors',
  'updatedAt',
];

const DOC_FILE_ARRAYS: ReadonlySet<keyof DocFileMeta> = new Set([
  'parents',
  'links',
  'authors',
]);

// Every revision cause, so a parsed file can name only one of them.
const REVISION_CAUSES: Record<RevisionCause, true> = {
  create: true,
  save: true,
  edit: true,
  merge: true,
  revert: true,
  import: true,
  restore: true,
  proposal: true,
  approve: true,
  reject: true,
  sync: true,
};

// Whether a parsed link entry is `{ target, rel }` with a known rel.
function isFileLink(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const link = value as Record<string, unknown>;
  return (
    typeof link.target === 'string' && LINK_RELS.some((r) => r === link.rel)
  );
}

// Why typed frontmatter still holds a value outside its set or an array
// element of the wrong shape; null when it has none.
function docFileValueProblem(
  fields: ReadonlyMap<string, unknown>
): string | null {
  const status = fields.get('status');
  if (!DOC_STATUSES.some((s) => s === status))
    return 'status must be draft, accepted or archived';
  if (!Object.hasOwn(REVISION_CAUSES, fields.get('cause') as string))
    return 'cause is not a revision cause';
  const n = fields.get('n') as number;
  if (!Number.isInteger(n) || n < 0) return 'n must be a whole number';
  for (const key of ['parents', 'authors']) {
    const values = fields.get(key) as unknown[];
    if (!values.every((v) => typeof v === 'string'))
      return `${key} must hold strings`;
  }
  if (!(fields.get('links') as unknown[]).every(isFileLink))
    return 'links must hold { target, rel } with rel spec, plan or context';
  return null;
}

export function renderDocFile(meta: DocFileMeta, body: string): string {
  const lines = DOC_FILE_FIELDS.map((k) => `${k}: ${JSON.stringify(meta[k])}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

// The inverse of renderDocFile: every field present with its type and in its
// set, or why not.
export function parseDocFile(
  text: string
): { meta: DocFileMeta; body: string } | { error: string } {
  if (!text.startsWith('---\n')) return { error: 'no frontmatter' };
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) return { error: 'unterminated frontmatter' };
  const fields = new Map<string, unknown>();
  for (const line of text.slice(4, end).split('\n')) {
    const colon = line.indexOf(': ');
    if (colon === -1)
      return { error: `bad frontmatter line: ${line.slice(0, 40)}` };
    try {
      fields.set(line.slice(0, colon), JSON.parse(line.slice(colon + 2)));
    } catch {
      return { error: `${line.slice(0, colon)} is not JSON` };
    }
  }
  for (const key of DOC_FILE_FIELDS) {
    const value = fields.get(key);
    let want = 'string';
    if (key === 'n') want = 'number';
    else if (DOC_FILE_ARRAYS.has(key)) want = 'array';
    const is = Array.isArray(value) ? 'array' : typeof value;
    if (is !== want)
      return {
        error: `${key} must be ${want === 'array' ? 'an' : 'a'} ${want}`,
      };
  }
  const problem = docFileValueProblem(fields);
  if (problem !== null) return { error: problem };
  const meta = Object.fromEntries(
    DOC_FILE_FIELDS.map((k) => [k, fields.get(k)])
  ) as unknown as DocFileMeta;
  meta.links = meta.links.map(({ target, rel }) => ({ target, rel }));
  return { meta, body: text.slice(end + 5) };
}
