import type {
  DocHit,
  DocLink,
  DocLinking,
  DocOp,
  DocRead,
  DocRecord,
  DocRevisionInfo,
  DocSaveResult,
  DocSaveStatus,
  DocsConfig,
  DocsConfigWarning,
  DocScope,
  DocsHealth,
  DocStatus,
  DocSummary,
  LinkRel,
  LinkTarget,
  RevisionCause,
} from '@dispatch/core';
import {
  docBodyProblem,
  DOCS_LIMITS,
  docSlug,
  docSlugProblem,
  docTitleProblem,
  LINK_RELS,
  LINK_TARGET_TYPES,
  normalizeDocText,
} from '@dispatch/core';
import type { Operator } from '@dispatch/memory';
import { isA2AAgent } from '@dispatch/memory';
import { createUlidFactory } from '@dispatch/protocol';
import { createHash } from 'node:crypto';

import type { Principal } from '../messaging/principal.js';
import { DocConflictError, DocsError } from './errors.js';
import type { DocChange, DocsHost } from './host.js';
import type { DiffChunk } from './merge.js';
import { diffChunks, merge3 } from './merge.js';
import { applyOps } from './ops.js';
import type { IndexLine, InlineSpec } from './prompt.js';
import { renderDocsSection } from './prompt.js';
import { carriesUnreviewed, unreviewedAtCreation } from './review.js';
import {
  cutUtf8,
  mentionsOf,
  outline,
  pageOf,
  resolveSection,
  sectionText,
  splitLines,
  summaryOf,
  utf8Bytes,
} from './sections.js';
import type {
  DocRow,
  LinkRow,
  RevisionMeta,
  RevisionRow,
  SectionRow,
  SqliteDocStore,
} from './store.js';
import type {
  ImportFile,
  ImportReport,
  ImportText,
  NamePlan,
} from './transfer.js';
import { nameKey, planImport } from './transfer.js';

// Every docs rule in one place: who may do what, the write path with open
// revisions and three-way merges, links, lifecycle, reads, lists and search.

export interface DocsActor {
  principal: Principal;
  address: string;
  kind: Principal['kind'] | 'overseer';
  decider: boolean;
  runKind: 'execute' | 'review' | 'verify' | null;
  // An execute run's task, the one task it may link docs to.
  taskId: string | null;
  // Any run's task, whatever its kind; an A2A run's reads are scoped to it.
  runTaskId: string | null;
  runId: string | null;
  operator: Operator | null;
  a2aRun: boolean;
}

export interface DocCreateInput {
  title: string;
  body: string;
  slug?: string;
  scope?: DocScope;
  links?: { target: LinkTarget; rel: LinkRel }[];
}

export interface DocBodyInput {
  baseRev: string | number;
  baseHash?: string;
  body: string;
  title?: string;
}

export interface DocListQuery {
  taskId?: string;
  scope?: DocScope;
  status?: DocStatus;
  unreviewed?: boolean;
  conflicted?: boolean;
  query?: string;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export interface DocSearchQuery {
  query: string;
  scope?: DocScope;
  includeArchived?: boolean;
  limit?: number;
}

export interface RankedDoc {
  row: DocRow;
  rel: LinkRel;
  depth: number;
  source: 'manual' | 'mention';
}

// Live notices, told of each revision a run reads so they cover its doc.
interface DocReadRecorder {
  recordRead(runId: string, docId: string, revId: string): void;
}

// What a live notice names about a team doc's head.
export interface DocNoticeFacts {
  handle: string;
  rev: string;
  n: number;
  author: string;
  summary: string;
  sealed: boolean;
}

export interface DocsServiceDeps {
  store: SqliteDocStore | null;
  unavailable?: string;
  host: DocsHost;
  ownerRef: string;
  config: () => { config: DocsConfig; warnings: DocsConfigWarning[] };
  // Other checkouts' docs.db files whose root is gone; they name other projects' paths, so decide tier only.
  orphans?: () => string[];
}

// One section a search matched, before visibility and the per-doc cap.
interface RawHit {
  docId: string;
  anchor: string;
  heading: string;
  snippet: string;
  score: number;
}

const HOUR_MS = 3_600_000;
const MAX_OPEN_AGE_MS = HOUR_MS;
const ANCESTOR_LEVELS = 8;
const HITS_PER_DOC = 3;
const NO_PERSONAL_SCOPE = 'no personal scope: this caller acts for no human';
// A high surrogate with no low one after it, or a low one with no high one before.
const UNPAIRED_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const OPEN_CAUSES: ReadonlySet<RevisionCause> = new Set([
  'create',
  'save',
  'edit',
]);

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');
const ulid = createUlidFactory();

function forbidden(message: string, field?: string): DocsError {
  return new DocsError('forbidden', message, field);
}

function archivedError(): DocsError {
  return new DocsError('conflict', 'archived; restore it first', 'doc');
}

// A page size from the caller, or `fallback` when missing or not a positive integer.
function clamp(
  value: number | undefined,
  fallback: number,
  max: number
): number {
  if (value === undefined || !Number.isInteger(value) || value < 1)
    return fallback;
  return Math.min(value, max);
}

// Byte offset of each line start, plus the end, for section rows and outlines.
function lineOffsets(lines: readonly string[]): number[] {
  const out = [0];
  for (const line of lines) out.push(out[out.length - 1] + utf8Bytes(line));
  return out;
}

// The namespaces a list or search scope filter keeps.
function scoped(ns: readonly string[], scope: DocScope | undefined): string[] {
  return ns.filter(
    (n) => scope === undefined || (scope === 'team') === (n === 'team')
  );
}

function bucketOf(c: RankedDoc): number {
  if (c.rel === 'spec') return c.depth === 0 ? 1 : 2;
  if (c.rel === 'plan') return 3;
  return c.depth === 0 ? 4 : 5;
}

// The index rank: the task's spec, ancestors' specs, plans, the task's context
// and mentions by recency, then ancestors' context; ties by id; each doc once.
function rankDocs(candidates: readonly RankedDoc[]): RankedDoc[] {
  const sorted = [...candidates].sort((x, y) => {
    const bx = bucketOf(x);
    const by = bucketOf(y);
    if (bx !== by) return bx - by;
    if (bx !== 4 && x.depth !== y.depth) return x.depth - y.depth;
    if (bx >= 4 && x.row.updatedAt !== y.row.updatedAt)
      return x.row.updatedAt < y.row.updatedAt ? 1 : -1;
    if (x.row.id === y.row.id) return 0;
    return x.row.id < y.row.id ? -1 : 1;
  });
  const seen = new Set<string>();
  return sorted.filter((c) => {
    if (seen.has(c.row.id)) return false;
    seen.add(c.row.id);
    return true;
  });
}

function toInfo(r: RevisionMeta): DocRevisionInfo {
  return {
    id: r.id,
    doc: r.docId,
    n: r.n,
    parents: r.parents,
    title: r.title,
    author: r.author,
    cause: r.cause,
    summary: r.summary,
    approval: r.approval,
    hash: r.hash,
    bytes: r.bytes,
    conflicted: r.conflicted,
    sealed: r.sealed,
    unreviewed: r.unreviewed,
    provisional: r.provisional,
    via: r.via,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// The origin an imported name's part k carries; part 1 is the name itself.
function importOrigin(key: string, k: number): string {
  return k === 1 ? `import:${key}` : `import:${key}/part-${k}`;
}

// Part k's slug, `<slug>-part-<k>`, with the slug cut so the whole fits 64 characters.
function partSlug(slug: string, k: number): string {
  const suffix = `-part-${k}`;
  const head = slug.slice(0, DOCS_LIMITS.slugChars - suffix.length);
  return `${head.replace(/-+$/, '')}${suffix}`;
}

// Part k's title, `<title> (part k of n)`, with the title cut so the whole fits 200 bytes.
function partTitle(title: string, k: number, n: number): string {
  const suffix = ` (part ${k} of ${n})`;
  const room = DOCS_LIMITS.titleBytes - utf8Bytes(suffix);
  return `${cutUtf8(title, room).trim()}${suffix}`;
}

// A stored `type:id` link target back into its parts.
function parseLinkText(text: string): LinkTarget {
  const colon = text.indexOf(':');
  return {
    type: text.slice(0, colon) as LinkTarget['type'],
    id: text.slice(colon + 1),
  };
}

// A handle as callers write it: ~slug for a personal doc.
function writtenHandle(row: DocRow): string {
  return row.scope === 'personal' ? `~${row.handle}` : row.handle;
}

function toLink(l: LinkRow): DocLink {
  return {
    doc: l.docId,
    target: { type: l.targetType, id: l.targetId },
    rel: l.rel,
    source: l.source,
    createdBy: l.createdBy,
    createdAt: l.createdAt,
  };
}

export class DocsService {
  private outbox: DocChange[] = [];
  // Attached once the daemon builds live notices.
  private notices: DocReadRecorder | null = null;

  constructor(private readonly deps: DocsServiceDeps) {}

  get available(): boolean {
    return this.deps.store !== null;
  }

  private get host(): DocsHost {
    return this.deps.host;
  }

  private store(): SqliteDocStore {
    const store = this.deps.store;
    if (store === null) {
      throw new DocsError(
        'unavailable',
        `docs are unavailable: ${this.deps.unavailable ?? 'docs.db did not open'}`
      );
    }
    return store;
  }

  private cfg(): DocsConfig {
    return this.deps.config().config;
  }

  private nowIso(): string {
    return this.host.now().toISOString();
  }

  private newId(prefix: 'doc' | 'rev'): string {
    return `${prefix}-${ulid(this.host.now().getTime())}`;
  }

  // Runs `fn` in one transaction, then hands the changes it queued to the host.
  private write<T>(fn: () => T): T {
    try {
      const out = this.store().transaction(fn);
      const changes = this.outbox;
      this.outbox = [];
      for (const change of changes) {
        try {
          this.host.changed(change);
        } catch (err) {
          console.error('docs: change hook failed', err);
        }
      }
      return out;
    } catch (err) {
      this.outbox = [];
      throw err;
    }
  }

  attachNotices(notices: DocReadRecorder): void {
    this.notices = notices;
  }

  // ---- actors and visibility ------------------------------------------------

  actorFor(principal: Principal): DocsActor {
    if (isA2AAgent(principal.address))
      throw forbidden('A2A clients cannot use docs');
    const runKind =
      principal.kind === 'run' ? this.host.runKind(principal) : null;
    const runTaskId =
      principal.kind === 'run' ? this.host.runTaskOf(principal) : null;
    // Any run of a task an A2A client asked for acts for nobody, so it has no personal scope.
    const a2aRun = runTaskId !== null && this.host.a2aOrigin(runTaskId);
    return {
      principal,
      address: principal.address,
      kind: principal.kind,
      decider: principal.kind === 'human' && principal.canDecide,
      runKind,
      taskId:
        runKind === 'execute' ? this.host.taskOfPrincipal(principal) : null,
      runTaskId,
      runId:
        principal.kind === 'run'
          ? principal.address.slice('run:'.length)
          : null,
      operator: a2aRun ? null : this.host.operatorOf(principal),
      a2aRun,
    };
  }

  // The owner's overseer: reads team docs, writes nothing.
  overseerActor(): DocsActor {
    const principal: Principal = {
      address: this.deps.ownerRef,
      canDecide: false,
      kind: 'human',
    };
    return {
      principal,
      address: this.deps.ownerRef,
      kind: 'overseer',
      decider: false,
      runKind: null,
      taskId: null,
      runTaskId: null,
      runId: null,
      operator: null,
      a2aRun: false,
    };
  }

  // The actor's operator's personal namespace; null when it acts for no human.
  private personalNs(actor: DocsActor): string | null {
    return actor.operator === null ? null : `p:${actor.operator.identity}`;
  }

  // Namespaces the actor may read: the team's, and its operator's personal one.
  private namespaces(actor: DocsActor): string[] {
    const mine = this.personalNs(actor);
    return mine === null ? ['team'] : ['team', mine];
  }

  // An A2A run sees only team docs linked by hand to its own task.
  private canSee(actor: DocsActor, row: DocRow): boolean {
    if (actor.a2aRun) {
      return (
        row.ns === 'team' &&
        this.store()
          .links({ docId: row.id })
          .some(
            (l) =>
              l.source === 'manual' &&
              l.targetType === 'task' &&
              l.targetId === actor.runTaskId
          )
      );
    }
    return this.namespaces(actor).includes(row.ns);
  }

  // Ids of the docs with a manual link to the actor's run's task.
  private ownTaskDocIds(actor: DocsActor): string[] {
    if (actor.runTaskId === null) return [];
    return this.store()
      .links({ target: { type: 'task', id: actor.runTaskId } })
      .filter((l) => l.source === 'manual')
      .map((l) => l.docId);
  }

  // A doc's links the actor may see: an A2A run sees only those to its own task
  // and run and to docs it can see, so no other id reaches it.
  private visibleLinks(actor: DocsActor, docId: string): DocLink[] {
    const store = this.store();
    return store
      .links({ docId })
      .filter((l) => {
        if (!actor.a2aRun) return true;
        if (l.targetType === 'task') return l.targetId === actor.runTaskId;
        if (l.targetType === 'run') return l.targetId === actor.runId;
        if (l.targetType !== 'doc') return false;
        const row = store.doc(l.targetId);
        return row !== null && this.canSee(actor, row);
      })
      .map(toLink);
  }

  private mayWriteDrafts(actor: DocsActor): boolean {
    if (actor.kind === 'overseer') return false;
    if (actor.kind === 'run')
      return actor.runKind === 'execute' && !actor.a2aRun;
    return true;
  }

  private requireDraftWriter(actor: DocsActor): void {
    if (this.mayWriteDrafts(actor)) return;
    if (actor.kind === 'overseer')
      throw forbidden('the overseer reads docs and never writes them');
    if (actor.a2aRun)
      throw forbidden(
        'a run of a task an A2A client asked for reads its linked docs and writes none'
      );
    throw forbidden('review and verify runs read docs and never write them');
  }

  // Whether the doc's status keeps direct changes to decide tier: an accepted
  // team doc. A personal doc's status is a label its owner's principals ignore.
  private gated(doc: DocRow): boolean {
    return doc.scope === 'team' && doc.status === 'accepted';
  }

  private requireWritable(actor: DocsActor, doc: DocRow): void {
    this.requireDraftWriter(actor);
    if (doc.status === 'archived') throw archivedError();
    if (this.gated(doc) && !actor.decider) {
      throw forbidden(
        'only decide-tier humans edit accepted docs directly',
        'doc'
      );
    }
  }

  // Whether the actor is a personal doc's owner, acting as a human.
  private isOwner(actor: DocsActor, doc: DocRow): boolean {
    return (
      actor.kind === 'human' &&
      doc.ownerIdentity !== null &&
      actor.operator?.identity === doc.ownerIdentity
    );
  }

  // Team docs' lifecycle is decide tier; a personal doc's is its owner's, as a human.
  private requireDecider(actor: DocsActor, doc: DocRow, what: string): void {
    if (doc.scope === 'team' ? actor.decider : this.isOwner(actor, doc)) return;
    throw forbidden(
      doc.scope === 'team'
        ? `only a decide-tier human may ${what}`
        : `only the owner may ${what}`,
      'doc'
    );
  }

  // doc-<id>, ~slug among the operator's docs, or a team handle or old slug. An
  // unseen personal id is 403 with the reason for decide tier, 404 for others.
  private resolve(actor: DocsActor, ref: string): DocRow {
    const store = this.store();
    let row: DocRow | null = null;
    if (ref.startsWith('doc-')) row = store.doc(ref);
    else if (ref.startsWith('~')) {
      const ns = this.personalNs(actor);
      const slug = ref.slice(1);
      row =
        ns === null
          ? null
          : (store.docByHandle(ns, slug) ?? store.docByAlias(ns, slug));
    } else
      row = store.docByHandle('team', ref) ?? store.docByAlias('team', ref);
    if (
      row !== null &&
      row.scope === 'personal' &&
      ref.startsWith('doc-') &&
      actor.decider &&
      !this.canSee(actor, row)
    ) {
      throw forbidden(
        actor.operator === null
          ? NO_PERSONAL_SCOPE
          : 'this personal doc belongs to another human',
        'doc'
      );
    }
    if (row === null || !this.canSee(actor, row))
      throw new DocsError('not-found', `doc ${ref} not found`, 'doc');
    return row;
  }

  // ---- revisions ------------------------------------------------------------

  private headOf(doc: DocRow): RevisionRow {
    const rev = this.store().revision(doc.headId);
    if (rev === null)
      throw new Error(`doc ${doc.id} has no head revision ${doc.headId}`);
    return rev;
  }

  // A numbered revision of `doc` by id or number (a digit string counts as a number).
  private revisionOf(
    doc: DocRow,
    ref: string | number,
    field: string
  ): RevisionRow {
    const store = this.store();
    let n: number | null = null;
    if (typeof ref === 'number') n = ref;
    else if (/^\d+$/.test(ref)) n = Number(ref);
    const rev =
      n === null ? store.revision(String(ref)) : store.revisionByN(doc.id, n);
    if (rev === null || rev.docId !== doc.id || rev.n === null) {
      throw new DocsError(
        'invalid',
        `${field}: not a revision of ${doc.handle}`,
        field
      );
    }
    return rev;
  }

  private expired(rev: RevisionMeta, now: Date, cfg: DocsConfig): boolean {
    const idle =
      now.getTime() - Date.parse(rev.updatedAt) >= cfg.coalesceMinutes * 60_000;
    return idle || now.getTime() - Date.parse(rev.createdAt) >= MAX_OPEN_AGE_MS;
  }

  // Whether `actor` may amend `head` in place instead of starting a revision.
  private isOpenTo(
    head: RevisionMeta,
    actor: DocsActor,
    now: Date,
    cfg: DocsConfig
  ): boolean {
    return (
      !head.sealed &&
      head.author === actor.address &&
      OPEN_CAUSES.has(head.cause) &&
      !this.expired(head, now, cfg)
    );
  }

  // A new revision row with its `unreviewed` flag computed from its parents.
  private makeRevision(
    docId: string,
    input: {
      parents: string[];
      title: string;
      body: string;
      author: string;
      cause: RevisionCause;
      summary: string;
      sealed: boolean;
      numbered: boolean;
      at: string;
      approval?: { by: string; policy?: { rung: number } };
      restores?: RevisionMeta;
    }
  ): RevisionRow {
    const store = this.store();
    const state = (meta: RevisionMeta | null) =>
      meta === null
        ? { unreviewed: false, reviewed: false }
        : { unreviewed: meta.unreviewed, reviewed: store.hasReview(meta.id) };
    const unreviewed = unreviewedAtCreation({
      author: input.author,
      cause: input.cause,
      approval: input.approval ?? null,
      unverifiedVia: false,
      parents: input.parents.map((id) => state(store.revisionMeta(id))),
      restores:
        input.restores === undefined ? undefined : state(input.restores),
    });
    return {
      id: this.newId('rev'),
      docId,
      n: input.numbered ? store.maxN(docId) + 1 : null,
      parents: input.parents,
      restoredParents: null,
      title: input.title,
      body: input.body,
      hash: sha256(input.body),
      bytes: utf8Bytes(input.body),
      author: input.author,
      cause: input.cause,
      summary: cutUtf8(input.summary, DOCS_LIMITS.summaryBytes),
      approval: input.approval ?? null,
      conflicted: false,
      sealed: input.sealed,
      unreviewed,
      provisional: false,
      via: null,
      createdAt: input.at,
      updatedAt: input.at,
    };
  }

  private setHead(
    doc: DocRow,
    rev: RevisionMeta,
    by: string,
    at: string
  ): void {
    doc.headId = rev.id;
    doc.title = rev.title;
    doc.unreviewed = carriesUnreviewed({
      unreviewed: rev.unreviewed,
      reviewed: this.store().hasReview(rev.id),
    });
    doc.conflicted = rev.conflicted;
    doc.updatedBy = by;
    doc.updatedAt = at;
  }

  // Rebuilds the section index and FTS rows from `rev` when they are stale.
  private reindex(doc: DocRow, rev: RevisionRow): void {
    if (doc.indexedHash === rev.hash) return;
    const lines = splitLines(rev.body);
    const offsets = lineOffsets(lines);
    const rows: SectionRow[] = outline(rev.body, lines).map((s) => ({
      ord: s.ord,
      level: s.level,
      heading: s.heading,
      anchor: s.anchor,
      startByte: offsets[s.line],
      endByte: offsets[s.end],
      text: lines.slice(s.ord === 0 ? 0 : s.line + 1, s.ownEnd).join(''),
    }));
    this.store().replaceSections(doc.id, rev.title, rows, rev.hash);
    doc.indexedHash = rev.hash;
  }

  // Derived `mention` links from a sealed head: [[slug]] names a team doc, and
  // [[~slug]] only inside a personal doc, one of its owner's.
  private rebuildMentions(doc: DocRow, rev: RevisionRow): void {
    const store = this.store();
    const rows: LinkRow[] = [];
    for (const m of mentionsOf(rev.body)) {
      if (m.personal && doc.scope !== 'personal') continue;
      const ns = m.personal ? doc.ns : 'team';
      const target =
        store.docByHandle(ns, m.slug) ?? store.docByAlias(ns, m.slug);
      if (target === null || target.id === doc.id) continue;
      rows.push({
        docId: doc.id,
        docNs: doc.ns,
        targetType: 'doc',
        targetId: target.id,
        rel: 'context',
        source: 'mention',
        createdBy: rev.author,
        createdAt: rev.updatedAt,
      });
    }
    const manual = store
      .links({ docId: doc.id })
      .filter((l) => l.source === 'manual').length;
    store.replaceMentions(
      doc.id,
      doc.ns,
      rows.slice(0, Math.max(0, DOCS_LIMITS.linksPerDoc - manual))
    );
  }

  // Seals an open revision; a sealed head gets its index and mentions rebuilt.
  private sealInTx(doc: DocRow, rev: RevisionMeta): void {
    if (rev.sealed) return;
    const store = this.store();
    store.sealRevision(rev.id);
    if (doc.headId === rev.id) {
      const full = this.headOf(doc);
      this.reindex(doc, full);
      this.rebuildMentions(doc, full);
      store.putDoc(doc);
    }
    this.outbox.push({
      doc: doc.id,
      scope: doc.scope,
      kind: 'sealed',
      author: rev.author,
      rev: rev.id,
      summary: rev.summary,
    });
  }

  // Once anyone but its author receives an open head's body, the head seals,
  // so the copy that reader holds can never go stale.
  private sealIfOtherReads(
    actor: DocsActor,
    doc: DocRow,
    rev: RevisionMeta
  ): void {
    if (rev.sealed || rev.author === actor.address || doc.headId !== rev.id)
      return;
    this.write(() => this.sealInTx(doc, rev));
  }

  record(doc: DocRow): DocRecord {
    const store = this.store();
    const head = store.revisionMeta(doc.headId);
    if (head === null)
      throw new Error(`doc ${doc.id} has no head revision ${doc.headId}`);
    return {
      id: doc.id,
      ns: doc.ns as DocRecord['ns'],
      slug: doc.slug,
      handle: doc.handle,
      title: doc.title,
      scope: doc.scope,
      owner:
        doc.ownerHuman === null || doc.ownerIdentity === null
          ? null
          : { human: doc.ownerHuman, identity: doc.ownerIdentity },
      status: doc.status,
      archivedFrom: doc.archivedFrom,
      restored:
        doc.restoredStatus === null || doc.restoredAt === null
          ? null
          : { status: doc.restoredStatus, at: doc.restoredAt },
      head: {
        id: head.id,
        n: head.n ?? 0,
        hash: head.hash,
        bytes: head.bytes,
        sealed: head.sealed,
      },
      reviewedRev: doc.reviewedRev,
      unreviewed: doc.unreviewed,
      conflicted: doc.conflicted,
      origin: doc.origin,
      published:
        doc.publishedPath === null ||
        doc.publishedRev === null ||
        doc.publishedTask === null
          ? null
          : {
              path: doc.publishedPath,
              rev: doc.publishedRev,
              n: store.revisionMeta(doc.publishedRev)?.n ?? null,
              task: doc.publishedTask,
              commit: doc.publishedCommit,
            },
      lastPublishPath: null,
      createdBy: doc.createdBy,
      createdAt: doc.createdAt,
      updatedBy: doc.updatedBy,
      updatedAt: doc.updatedAt,
    };
  }

  private result(
    doc: DocRow,
    rev: RevisionMeta,
    status: DocSaveStatus,
    extra: Partial<DocSaveResult> = {}
  ): DocSaveResult {
    return {
      doc: this.record(doc),
      handle: doc.handle,
      rev: { id: rev.id, n: rev.n, hash: rev.hash },
      status,
      ...extra,
    };
  }

  private checkTitle(title: unknown, field: string): string {
    const problem = docTitleProblem(title);
    if (problem !== null) throw new DocsError('invalid', problem, field);
    return (title as string).trim();
  }

  private checkBody(body: unknown, field: string): string {
    if (typeof body !== 'string')
      throw new DocsError('invalid', 'body must be a string', field);
    const normal = normalizeDocText(body);
    const problem = docBodyProblem(normal);
    if (problem !== null) throw new DocsError('invalid', problem, field);
    return normal;
  }

  // An explicit slug as given, or one derived from the title with -2, -3, …
  // until it is free in `ns`.
  private pickSlug(
    ns: string,
    explicit: string | undefined,
    title: string
  ): string {
    const store = this.store();
    if (explicit !== undefined) {
      const problem = docSlugProblem(explicit);
      if (problem !== null) throw new DocsError('invalid', problem, 'slug');
      if (store.slugTaken(ns, explicit))
        throw new DocsError('conflict', `slug ${explicit} is taken`, 'slug');
      return explicit;
    }
    const base = docSlug(title);
    if (!store.slugTaken(ns, base)) return base;
    for (let k = 2; ; k++) {
      const suffix = `-${k}`;
      const candidate = `${base.slice(0, DOCS_LIMITS.slugChars - suffix.length).replace(/-+$/, '')}${suffix}`;
      if (!store.slugTaken(ns, candidate)) return candidate;
    }
  }

  // ---- the write path -------------------------------------------------------

  create(actor: DocsActor, input: DocCreateInput): DocSaveResult {
    return this.createDoc(actor, input, null);
  }

  // A new doc; `origin` is set only by the service (promote), never from a
  // request. The first revision carries `carries`' unreviewed state, if given.
  private createDoc(
    actor: DocsActor,
    input: DocCreateInput,
    origin: string | null,
    carries?: RevisionMeta
  ): DocSaveResult {
    const store = this.store();
    this.requireDraftWriter(actor);
    const scope = input.scope ?? 'team';
    let ns = 'team';
    let owner: Operator | null = null;
    if (scope === 'personal') {
      if (actor.operator === null) throw forbidden(NO_PERSONAL_SCOPE, 'scope');
      ns = `p:${actor.operator.identity}`;
      owner = actor.operator;
    }
    const title = this.checkTitle(input.title, 'title');
    const body = this.checkBody(input.body, 'body');
    const now = this.host.now();
    const at = now.toISOString();
    const cfg = this.cfg();
    if (actor.kind === 'run' || actor.kind === 'agent') {
      const since = new Date(now.getTime() - HOUR_MS).toISOString();
      if (store.countCreatedSince(actor.address, since) >= cfg.createsPerHour) {
        throw new DocsError(
          'limited',
          `at most ${cfg.createsPerHour} doc creates per hour`,
          'doc'
        );
      }
    }
    const links =
      input.links ??
      (actor.kind === 'run' && actor.taskId !== null
        ? [
            {
              target: { type: 'task' as const, id: actor.taskId },
              rel: 'context' as const,
            },
          ]
        : []);
    if (links.length > DOCS_LIMITS.linksPerDoc)
      throw new DocsError(
        'invalid',
        `at most ${DOCS_LIMITS.linksPerDoc} links`,
        'links'
      );
    const slug = this.pickSlug(ns, input.slug, title);
    const doc: DocRow = {
      id: this.newId('doc'),
      ns,
      slug,
      handle: slug,
      title,
      scope,
      ownerIdentity: owner?.identity ?? null,
      ownerHuman: owner?.human ?? null,
      status: 'draft',
      archivedFrom: null,
      restoredStatus: null,
      restoredAt: null,
      headId: '',
      reviewedRev: null,
      unreviewed: false,
      conflicted: false,
      origin,
      publishedPath: null,
      publishedRev: null,
      publishedTask: null,
      publishedCommit: null,
      createdBy: actor.address,
      createdAt: at,
      updatedBy: actor.address,
      updatedAt: at,
      indexedHash: null,
    };
    const checked = links.map((l, i) =>
      this.checkLinkTarget(actor, doc, l.target, l.rel, `links[${i}]`)
    );
    checked.forEach((target, i) =>
      this.checkLinkAuthority(actor, doc, target, links[i].rel, `links[${i}]`)
    );
    return this.write(() => {
      const rev = this.makeRevision(doc.id, {
        parents: [],
        title,
        body,
        author: actor.address,
        cause: 'create',
        summary: 'created',
        sealed: cfg.coalesceMinutes === 0,
        numbered: true,
        restores: carries,
        at,
      });
      store.insertRevision(rev);
      this.setHead(doc, rev, actor.address, at);
      store.putDoc(doc);
      this.reindex(doc, rev);
      checked.forEach((target, i) =>
        this.putLink(actor, doc, target, links[i].rel, false, at)
      );
      if (rev.sealed) this.rebuildMentions(doc, rev);
      store.putDoc(doc);
      this.outbox.push({
        doc: doc.id,
        scope,
        kind: 'created',
        author: actor.address,
        rev: rev.id,
        summary: 'created',
      });
      return this.result(doc, rev, 'saved');
    });
  }

  // A new head from `next`, or an amend of the author's open head.
  private commitDirect(
    actor: DocsActor,
    doc: DocRow,
    next: {
      body: string;
      title: string;
      summary: string;
      cause: 'save' | 'edit' | 'revert';
      restores?: RevisionMeta;
    },
    extra: Partial<DocSaveResult> = {}
  ): DocSaveResult {
    const head = this.headOf(doc);
    if (next.body === head.body && next.title === head.title)
      return this.result(doc, head, 'unchanged', extra);
    const now = this.host.now();
    const at = now.toISOString();
    const cfg = this.cfg();
    const amend =
      next.cause !== 'revert' && this.isOpenTo(head, actor, now, cfg);
    return this.write(() => {
      const store = this.store();
      if (amend) {
        const summary = cutUtf8(
          `${head.summary}; ${next.summary}`,
          DOCS_LIMITS.summaryBytes
        );
        store.amendRevision(head.id, {
          title: next.title,
          body: next.body,
          hash: sha256(next.body),
          bytes: utf8Bytes(next.body),
          summary,
          updatedAt: at,
        });
        doc.title = next.title;
        doc.updatedBy = actor.address;
        doc.updatedAt = at;
        store.putDoc(doc);
        this.outbox.push({
          doc: doc.id,
          scope: doc.scope,
          kind: 'amended',
          author: actor.address,
          rev: head.id,
          summary,
        });
        const amended = store.revisionMeta(head.id);
        if (amended === null) throw new Error(`revision ${head.id} vanished`);
        return this.result(doc, amended, 'amended', extra);
      }
      this.sealInTx(doc, head);
      const rev = this.makeRevision(doc.id, {
        parents: [head.id],
        title: next.title,
        body: next.body,
        author: actor.address,
        cause: next.cause,
        summary: next.summary,
        sealed: next.cause === 'revert' || cfg.coalesceMinutes === 0,
        numbered: true,
        restores: next.restores,
        at,
      });
      store.insertRevision(rev);
      this.setHead(doc, rev, actor.address, at);
      this.reindex(doc, rev);
      if (rev.sealed) this.rebuildMentions(doc, rev);
      store.putDoc(doc);
      this.outbox.push({
        doc: doc.id,
        scope: doc.scope,
        kind: rev.sealed ? 'sealed' : 'revised',
        author: actor.address,
        rev: rev.id,
        summary: rev.summary,
      });
      return this.result(doc, rev, 'saved', extra);
    });
  }

  private baseChanged(head: RevisionRow): DocConflictError {
    return new DocConflictError({
      code: 'conflict',
      reason: 'base-changed',
      head: {
        id: head.id,
        n: head.n ?? 0,
        hash: head.hash,
        body: head.body,
        author: head.author,
      },
      base: null,
      hunks: [],
      marked: head.body,
    });
  }

  saveBody(actor: DocsActor, ref: string, input: DocBodyInput): DocSaveResult {
    const doc = this.resolve(actor, ref);
    this.requireWritable(actor, doc);
    const body = this.checkBody(input.body, 'body');
    const title =
      input.title === undefined
        ? undefined
        : this.checkTitle(input.title, 'title');
    const base = this.revisionOf(doc, input.baseRev, 'baseRev');
    let head = this.headOf(doc);
    if (input.baseHash !== undefined && base.hash !== input.baseHash) {
      this.sealIfOtherReads(actor, doc, head);
      throw this.baseChanged(head);
    }
    if (base.id === head.id) {
      return this.commitDirect(actor, doc, {
        body,
        title: title ?? head.title,
        summary: 'saved',
        cause: 'save',
      });
    }
    // The head moved past the base: seal it (the answer carries its body either way), then merge.
    if (!head.sealed) {
      const open = head;
      this.write(() => this.sealInTx(doc, open));
      head = this.headOf(doc);
    }
    const merged = merge3(base.body, head.body, body, {
      head: `head (rev ${head.n ?? 0}, ${head.author})`,
      base: `base (rev ${base.n ?? 0})`,
      mine: 'yours',
    });
    if (!merged.clean) {
      throw new DocConflictError({
        code: 'conflict',
        reason: 'merge-conflict',
        head: {
          id: head.id,
          n: head.n ?? 0,
          hash: head.hash,
          body: head.body,
          author: head.author,
        },
        base: { id: base.id, n: base.n ?? 0 },
        hunks: merged.hunks,
        marked: merged.marked,
      });
    }
    if (docBodyProblem(merged.body) !== null) {
      throw new DocsError(
        'invalid',
        'the merged body is over the limit; split the doc',
        'body'
      );
    }
    const mineTitle = title ?? base.title;
    const nextTitle = mineTitle !== base.title ? mineTitle : head.title;
    // The head gains nothing, so store nothing: a writer holding the head's text is
    // based on it now, and one who changed nothing reloads it or keeps its base.
    if (merged.body === head.body && nextTitle === head.title) {
      if (body === head.body) return this.result(doc, head, 'unchanged');
      if (body === base.body) {
        return this.result(doc, head, 'merged', {
          mine: { id: base.id, n: base.n, hash: base.hash },
        });
      }
    }
    const headRev = head;
    const at = this.nowIso();
    return this.write(() => {
      const store = this.store();
      const mine = this.makeRevision(doc.id, {
        parents: [base.id],
        title: mineTitle,
        body,
        author: actor.address,
        cause: 'save',
        summary: 'saved',
        sealed: true,
        numbered: true,
        at,
      });
      store.insertRevision(mine);
      const merge = this.makeRevision(doc.id, {
        parents: [headRev.id, mine.id],
        title: nextTitle,
        body: merged.body,
        author: actor.address,
        cause: 'merge',
        summary: `merged with rev ${headRev.n ?? 0} by ${headRev.author}`,
        sealed: true,
        numbered: true,
        at,
      });
      store.insertRevision(merge);
      this.setHead(doc, merge, actor.address, at);
      this.reindex(doc, merge);
      this.rebuildMentions(doc, merge);
      store.putDoc(doc);
      this.outbox.push({
        doc: doc.id,
        scope: doc.scope,
        kind: 'sealed',
        author: actor.address,
        rev: merge.id,
        summary: merge.summary,
      });
      return this.result(doc, merge, 'merged', {
        mine: { id: mine.id, n: mine.n, hash: mine.hash },
      });
    });
  }

  edit(
    actor: DocsActor,
    ref: string,
    input: { ops: DocOp[]; baseRev?: string | number }
  ): DocSaveResult {
    const doc = this.resolve(actor, ref);
    this.requireWritable(actor, doc);
    const head = this.headOf(doc);
    const out = applyOps({ body: head.body, title: head.title }, input.ops);
    const problem = docBodyProblem(out.body);
    if (problem !== null) throw new DocsError('invalid', problem, 'ops');
    let extra: Partial<DocSaveResult> = {};
    if (input.baseRev !== undefined) {
      const base = this.revisionOf(doc, input.baseRev, 'baseRev');
      const baseN = base.n ?? 0;
      if (base.id !== head.id) {
        // The revisions the agent's base did not include, oldest first.
        const since = this.store()
          .revisionMetas(doc.id, { limit: 200 })
          .filter((r) => (r.n ?? 0) > baseN)
          .reverse()
          .map((r) => ({ n: r.n ?? 0, author: r.author, summary: r.summary }));
        extra = { rebased: { since } };
      }
    }
    return this.commitDirect(
      actor,
      doc,
      { body: out.body, title: out.title, summary: out.summary, cause: 'edit' },
      extra
    );
  }

  revert(
    actor: DocsActor,
    ref: string,
    revRef: string | number
  ): DocSaveResult {
    const doc = this.resolve(actor, ref);
    this.requireWritable(actor, doc);
    const target = this.revisionOf(doc, revRef, 'rev');
    return this.commitDirect(actor, doc, {
      body: target.body,
      title: target.title,
      summary: `reverted to rev ${target.n ?? 0}`,
      cause: 'revert',
      restores: target,
    });
  }

  // ---- lifecycle ------------------------------------------------------------

  rename(actor: DocsActor, ref: string, slug: string): DocRecord {
    const doc = this.resolve(actor, ref);
    if (actor.kind !== 'human') throw forbidden('humans rename docs', 'slug');
    if (doc.status === 'archived') throw archivedError();
    const problem = docSlugProblem(slug);
    if (problem !== null) throw new DocsError('invalid', problem, 'slug');
    if (slug === doc.handle) return this.record(doc);
    if (this.store().slugTaken(doc.ns, slug, doc.id))
      throw new DocsError('conflict', `slug ${slug} is taken`, 'slug');
    const at = this.nowIso();
    return this.write(() => {
      this.sealInTx(doc, this.headOf(doc));
      this.store().addAlias(doc.ns, doc.handle, doc.id, at);
      doc.slug = slug;
      doc.handle = slug;
      doc.updatedBy = actor.address;
      doc.updatedAt = at;
      this.store().putDoc(doc);
      this.outbox.push({
        doc: doc.id,
        scope: doc.scope,
        kind: 'meta',
        author: actor.address,
        rev: null,
        summary: `renamed to ${slug}`,
      });
      return this.record(doc);
    });
  }

  setStatus(actor: DocsActor, ref: string, status: DocStatus): DocRecord {
    const doc = this.resolve(actor, ref);
    this.requireDecider(actor, doc, "change a doc's status");
    if (status === 'accepted' && doc.scope === 'team') {
      throw new DocsError(
        'invalid',
        'accepting needs the doc gate, which arrives in docs v1',
        'status'
      );
    }
    if (status === doc.status) return this.record(doc);
    const at = this.nowIso();
    return this.write(() => {
      this.applyStatus(actor, doc, status, at);
      return this.record(doc);
    });
  }

  // Seals the head and moves the doc to `status`, remembering what archive left.
  private applyStatus(
    actor: DocsActor,
    doc: DocRow,
    status: DocStatus,
    at: string
  ): void {
    this.sealInTx(doc, this.headOf(doc));
    if (status === 'archived') {
      doc.archivedFrom = doc.status === 'accepted' ? 'accepted' : 'draft';
      doc.status = 'archived';
    } else {
      doc.status = status;
      doc.archivedFrom = null;
    }
    doc.updatedBy = actor.address;
    doc.updatedAt = at;
    this.store().putDoc(doc);
    this.outbox.push({
      doc: doc.id,
      scope: doc.scope,
      kind: 'meta',
      author: actor.address,
      rev: null,
      summary: `status ${status}`,
    });
  }

  markReviewed(actor: DocsActor, ref: string): DocRecord {
    const doc = this.resolve(actor, ref);
    this.requireDecider(actor, doc, 'mark a doc reviewed');
    const at = this.nowIso();
    return this.write(() => {
      const head = this.headOf(doc);
      this.sealInTx(doc, head);
      this.store().addReview(doc.id, head.id, actor.address, at);
      doc.unreviewed = false;
      doc.reviewedRev = head.id;
      this.store().putDoc(doc);
      this.outbox.push({
        doc: doc.id,
        scope: doc.scope,
        kind: 'meta',
        author: actor.address,
        rev: head.id,
        summary: 'reviewed',
      });
      return this.record(doc);
    });
  }

  seal(actor: DocsActor, ref: string): DocRecord {
    const doc = this.resolve(actor, ref);
    const head = this.headOf(doc);
    if (head.sealed) return this.record(doc);
    if (head.author !== actor.address)
      throw forbidden("only the head revision's author saves a version", 'doc');
    this.write(() => this.sealInTx(doc, head));
    return this.record(doc);
  }

  remove(actor: DocsActor, ref: string): void {
    const doc = this.resolve(actor, ref);
    this.requireDecider(actor, doc, 'delete a doc');
    const at = this.nowIso();
    this.write(() => {
      this.store().putTombstone({
        docId: doc.id,
        ns: doc.ns,
        slug: doc.handle,
        origin: doc.origin,
        deletedBy: actor.address,
        at,
      });
      this.store().deleteDoc(doc.id);
      this.outbox.push({
        doc: doc.id,
        scope: doc.scope,
        kind: 'deleted',
        author: actor.address,
        rev: null,
        summary: 'deleted',
      });
    });
  }

  // A personal doc's head copied into a new team draft, with no history; the
  // owner does it once, as a human. The draft keeps any unreviewed agent text flagged.
  promote(actor: DocsActor, ref: string): DocSaveResult {
    const doc = this.resolve(actor, ref);
    if (doc.scope !== 'personal')
      throw new DocsError('invalid', 'only a personal doc is promoted', 'doc');
    if (!this.isOwner(actor, doc))
      throw forbidden('only the owner promotes a personal doc', 'doc');
    const origin = `promoted:${doc.id}`;
    const existing = this.store().docByOrigin(origin);
    if (existing !== null)
      throw new DocsError(
        'conflict',
        `already promoted as ${existing.handle}`,
        'doc'
      );
    this.write(() => this.sealInTx(doc, this.headOf(doc)));
    const head = this.headOf(doc);
    return this.createDoc(
      actor,
      { title: head.title, body: head.body, scope: 'team' },
      origin,
      head
    );
  }

  // ---- links ----------------------------------------------------------------

  // The target exists, the caller can see it, and it may be linked from `doc`.
  private checkLinkTarget(
    actor: DocsActor,
    doc: DocRow,
    target: LinkTarget,
    rel: LinkRel,
    field: string
  ): LinkTarget {
    if (
      !LINK_TARGET_TYPES.includes(target.type) ||
      typeof target.id !== 'string' ||
      target.id === ''
    ) {
      throw new DocsError(
        'invalid',
        'target must be task:, run:, thread:, memory: or doc:',
        `${field}.target`
      );
    }
    if (!LINK_RELS.includes(rel))
      throw new DocsError(
        'invalid',
        'rel must be spec, plan or context',
        `${field}.rel`
      );
    if (rel !== 'context' && target.type !== 'task')
      throw new DocsError(
        'invalid',
        `${rel} links point at tasks`,
        `${field}.rel`
      );
    if (target.type === 'doc') {
      let other: DocRow;
      try {
        other = this.resolve(actor, target.id);
      } catch {
        throw new DocsError(
          'invalid',
          `target doc:${target.id} not found`,
          `${field}.target`
        );
      }
      if (other.id === doc.id)
        throw new DocsError(
          'invalid',
          'a doc cannot link to itself',
          `${field}.target`
        );
      if (doc.scope === 'team' && other.scope === 'personal')
        throw forbidden(
          'a team doc cannot link to a personal doc',
          `${field}.target`
        );
      return { type: 'doc', id: other.id };
    }
    if (!this.host.exists(target) || !this.targetVisible(actor, target)) {
      throw new DocsError(
        'invalid',
        `target ${target.type}:${target.id} not found`,
        `${field}.target`
      );
    }
    if (
      target.type === 'memory' &&
      doc.scope === 'team' &&
      this.host.memoryScope(target.id) === 'personal'
    ) {
      throw forbidden(
        'a team doc cannot link to personal memory',
        `${field}.target`
      );
    }
    return target;
  }

  // A thread or memory entry the caller cannot see answers like a missing one,
  // so a link attempt never reveals that it exists.
  private targetVisible(actor: DocsActor, target: LinkTarget): boolean {
    if (target.type === 'thread')
      return (
        this.host.inThread(target.id, actor.principal) ||
        (actor.kind === 'human' && actor.decider)
      );
    if (target.type === 'memory')
      return this.host.memoryVisible(target.id, actor.principal);
    return true;
  }

  // Who may make a link: only decide tier touches an A2A-origin task's links; runs stay on their
  // own task, run and threads, plus docs (memory only on personal docs); agents add context only.
  private checkLinkAuthority(
    actor: DocsActor,
    doc: DocRow,
    target: LinkTarget,
    rel: LinkRel,
    field: string
  ): void {
    if (
      target.type === 'task' &&
      this.host.a2aOrigin(target.id) &&
      !actor.decider
    ) {
      throw forbidden(
        'only a decide-tier human links docs to a task an A2A client asked for',
        field
      );
    }
    if (!this.mayWriteDrafts(actor))
      throw forbidden('you may not change links', field);
    if (actor.kind === 'run') {
      if (target.type === 'memory' && doc.scope === 'team')
        throw forbidden(
          'a run links only its own task, run and threads, and docs',
          field
        );
      if (target.type === 'task' && target.id !== actor.taskId)
        throw forbidden('a run links only its own task', field);
      if (target.type === 'run' && target.id !== actor.runId)
        throw forbidden('a run links only its own run', field);
      if (
        target.type === 'thread' &&
        !this.host.inThread(target.id, actor.principal)
      ) {
        throw forbidden('a run links only threads it takes part in', field);
      }
    }
    if (actor.kind === 'agent' && rel !== 'context')
      throw forbidden('agents add context links only', field);
  }

  // Whether `actor` may move a task's spec link off `displaced`: a doc it
  // could write directly.
  private mayDisplace(actor: DocsActor, displaced: DocRow): boolean {
    return (
      actor.decider ||
      (displaced.status !== 'archived' &&
        !this.gated(displaced) &&
        this.mayWriteDrafts(actor))
    );
  }

  // Adds one manual link or changes its rel; a task has one spec per namespace.
  private putLink(
    actor: DocsActor,
    doc: DocRow,
    target: LinkTarget,
    rel: LinkRel,
    replace: boolean,
    at: string
  ): void {
    const store = this.store();
    const existing = store
      .links({ docId: doc.id })
      .find((l) => l.targetType === target.type && l.targetId === target.id);
    if (
      existing !== undefined &&
      existing.rel !== rel &&
      existing.rel !== 'context' &&
      this.gated(doc) &&
      !actor.decider
    ) {
      throw forbidden(
        `only a decide-tier human changes the ${existing.rel} link of an accepted doc`,
        'rel'
      );
    }
    if (rel === 'spec') {
      const spec = store.specFor(target.type, target.id, doc.ns);
      if (spec !== null && spec.docId !== doc.id) {
        const displaced = store.doc(spec.docId);
        const name = displaced?.handle ?? spec.docId;
        if (!replace)
          throw new DocsError(
            'conflict',
            `task ${target.id} already has a spec: ${name}`,
            'rel'
          );
        if (displaced !== null && !this.mayDisplace(actor, displaced)) {
          throw forbidden(
            `only a decide-tier human replaces ${name}; you could not edit it directly`,
            'replace'
          );
        }
        store.removeLink(spec.docId, target.type, target.id);
        if (displaced !== null)
          this.outbox.push({
            doc: displaced.id,
            scope: displaced.scope,
            kind: 'meta',
            author: actor.address,
            rev: null,
            summary: 'spec link moved',
          });
      }
    }
    if (
      existing === undefined &&
      store.links({ docId: doc.id }).length >= DOCS_LIMITS.linksPerDoc
    ) {
      throw new DocsError(
        'invalid',
        `a doc has at most ${DOCS_LIMITS.linksPerDoc} links`,
        'target'
      );
    }
    store.addLink({
      docId: doc.id,
      docNs: doc.ns,
      targetType: target.type,
      targetId: target.id,
      rel,
      source: 'manual',
      createdBy: actor.address,
      createdAt: at,
    });
  }

  link(
    actor: DocsActor,
    ref: string,
    input: { target: LinkTarget; rel: LinkRel; replace?: boolean }
  ): DocLink[] {
    const doc = this.resolve(actor, ref);
    if (doc.status === 'archived') throw archivedError();
    const target = this.checkLinkTarget(
      actor,
      doc,
      input.target,
      input.rel,
      'link'
    );
    this.checkLinkAuthority(actor, doc, target, input.rel, 'link');
    // Changing a link's rel drops the old one, so it needs the right to remove it, as unlink does.
    const existing = this.store()
      .links({ docId: doc.id })
      .find((l) => l.targetType === target.type && l.targetId === target.id);
    if (existing !== undefined && existing.rel !== input.rel)
      this.checkLinkAuthority(actor, doc, target, existing.rel, 'rel');
    const at = this.nowIso();
    return this.write(() => {
      this.sealInTx(doc, this.headOf(doc));
      this.putLink(actor, doc, target, input.rel, input.replace === true, at);
      this.outbox.push({
        doc: doc.id,
        scope: doc.scope,
        kind: 'meta',
        author: actor.address,
        rev: null,
        summary: `linked ${target.type}:${target.id}`,
      });
      return this.store().links({ docId: doc.id }).map(toLink);
    });
  }

  unlink(actor: DocsActor, ref: string, target: LinkTarget): DocLink[] {
    const doc = this.resolve(actor, ref);
    if (doc.status === 'archived') throw archivedError();
    const store = this.store();
    const targetId =
      target.type === 'doc' ? this.resolve(actor, target.id).id : target.id;
    const existing = store
      .links({ docId: doc.id })
      .find(
        (l) =>
          l.targetType === target.type &&
          l.targetId === targetId &&
          l.source === 'manual'
      );
    if (existing === undefined)
      throw new DocsError(
        'not-found',
        `no link to ${target.type}:${target.id}`,
        'target'
      );
    this.checkLinkAuthority(
      actor,
      doc,
      { type: target.type, id: targetId },
      existing.rel,
      'target'
    );
    if (existing.rel !== 'context' && this.gated(doc) && !actor.decider) {
      throw forbidden(
        `only a decide-tier human removes the ${existing.rel} link of an accepted doc`,
        'target'
      );
    }
    return this.write(() => {
      this.sealInTx(doc, this.headOf(doc));
      store.removeLink(doc.id, target.type, targetId);
      this.outbox.push({
        doc: doc.id,
        scope: doc.scope,
        kind: 'meta',
        author: actor.address,
        rev: null,
        summary: `unlinked ${target.type}:${targetId}`,
      });
      return store.links({ docId: doc.id }).map(toLink);
    });
  }

  // ---- import ---------------------------------------------------------------

  // Import backdates history and bypasses the create limit, so it is decide tier.
  private requireImporter(actor: DocsActor): void {
    if (!actor.decider)
      throw forbidden('import needs a decide-tier human', 'import');
  }

  // The session's link, checked as a context link from a new team doc.
  private checkImportLink(actor: DocsActor, target: LinkTarget): LinkTarget {
    const probe = this.importDocRow(actor, 'probe', 1, '', this.nowIso());
    const checked = this.checkLinkTarget(
      actor,
      probe,
      target,
      'context',
      'link'
    );
    this.checkLinkAuthority(actor, probe, checked, 'context', 'link');
    return checked;
  }

  // Opens a session (replacing this human's open one) and names the contents it still needs.
  openImport(
    actor: DocsActor,
    input: { files: ImportFile[]; link: LinkTarget | null }
  ): { id: string; need: string[] } {
    this.requireImporter(actor);
    const store = this.store();
    // A name keys its docs' origins, so it may not look like a path or a part.
    input.files.forEach((f, i) => {
      if (f.name === '' || f.name.includes('/'))
        throw new DocsError(
          'invalid',
          'expected a file name without a directory part',
          `files[${i}].name`
        );
    });
    const link =
      input.link === null ? null : this.checkImportLink(actor, input.link);
    const at = this.nowIso();
    const id = `imp-${ulid(this.host.now().getTime())}`;
    this.write(() => {
      for (const old of store.importSessionsBy(actor.address))
        store.deleteImportSession(old);
      store.putImportSession({
        id,
        createdBy: actor.address,
        createdAt: at,
        touchedAt: at,
        manifest: JSON.stringify(input.files),
        link: link === null ? null : `${link.type}:${link.id}`,
      });
    });
    const need = new Set<string>();
    for (const f of input.files) {
      const fits = f.bytes <= DOCS_LIMITS.importContentBytes;
      if (fits && !store.isImported('team', nameKey(f.name), f.hash))
        need.add(f.hash);
    }
    return { id, need: [...need] };
  }

  // The caller's own open session; anyone else's answers as missing.
  private importSessionOf(actor: DocsActor, id: string) {
    const s = this.store().importSession(id);
    if (s === null || s.createdBy !== actor.address)
      throw new DocsError(
        'not-found',
        `import session ${id} not found`,
        'import'
      );
    return s;
  }

  // Refuses an upload by who sends it and what it names, so the route can
  // answer before it reads the body.
  admitImportContent(actor: DocsActor, id: string, hash: string): void {
    this.requireImporter(actor);
    const s = this.importSessionOf(actor, id);
    const files = JSON.parse(s.manifest) as ImportFile[];
    if (!files.some((f) => f.hash === hash)) {
      throw new DocsError(
        'invalid',
        `content ${hash.slice(0, 64)} is not in this import`,
        'hash'
      );
    }
  }

  putImportContent(
    actor: DocsActor,
    id: string,
    hash: string,
    bytes: Uint8Array
  ): void {
    this.admitImportContent(actor, id, hash);
    const store = this.store();
    if (createHash('sha256').update(bytes).digest('hex') !== hash)
      throw new DocsError(
        'invalid',
        'the content does not match its sha256',
        'hash'
      );
    const held = store.importContentBytes(id, hash);
    if (held + bytes.byteLength > DOCS_LIMITS.importSessionBytes)
      throw new DocsError(
        'limited',
        'an import session holds at most 64 MiB',
        'import'
      );
    this.write(() => {
      store.putImportContent(id, hash, bytes);
      store.touchImportSession(id, this.nowIso());
    });
  }

  deleteImport(actor: DocsActor, id: string): void {
    this.requireImporter(actor);
    this.importSessionOf(actor, id);
    this.store().deleteImportSession(id);
  }

  // Plans the session and, unless a dry run, writes it all in one transaction
  // and closes it. A parity mismatch is a conflict and writes nothing.
  commitImport(actor: DocsActor, id: string, dryRun: boolean): ImportReport {
    this.requireImporter(actor);
    const store = this.store();
    const s = this.importSessionOf(actor, id);
    const files = JSON.parse(s.manifest) as ImportFile[];
    const texts = new Map<string, ImportText>();
    for (const hash of new Set(files.map((f) => f.hash))) {
      const bytes = store.importContent(id, hash);
      if (bytes === null) continue;
      let text: string;
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        text = normalizeDocText(decoder.decode(bytes));
      } catch {
        texts.set(hash, {
          error: 'not UTF-8',
          detail: 'the file is not UTF-8',
        });
        continue;
      }
      texts.set(
        hash,
        text.includes('\u0000')
          ? { error: 'invalid', detail: 'the file contains NUL' }
          : { text }
      );
    }
    const { names, report } = planImport(files, texts, {
      imported: (key, hash) => store.isImported('team', key, hash),
      tombstoned: (key) => store.tombstonedOrigin(importOrigin(key, 1)),
      archived: (key) =>
        store.docByOrigin(importOrigin(key, 1))?.status === 'archived',
      exists: (key) => store.docByOrigin(importOrigin(key, 1)) !== null,
      partExists: (key, k) => store.docByOrigin(importOrigin(key, k)) !== null,
    });
    report.dryRun = dryRun;
    if (!report.parity.files || !report.parity.names) {
      throw new DocsError(
        'conflict',
        `import parity mismatch: ${JSON.stringify(report.parity)}`,
        'import'
      );
    }
    if (dryRun) return report;
    const link =
      s.link === null
        ? null
        : this.checkImportLink(actor, parseLinkText(s.link));
    this.write(() => {
      for (const name of names) {
        if (name.contents.length > 0) this.writeImported(actor, name, link);
      }
      store.setMeta('import:last', JSON.stringify(report));
      store.deleteImportSession(id);
    });
    return report;
  }

  // One name's contents as revisions of its part docs, oldest first. The parts the
  // newest content fills are live and linked; any past them are archived.
  private writeImported(
    actor: DocsActor,
    name: NamePlan,
    link: LinkTarget | null
  ): void {
    const store = this.store();
    const total = Math.max(...name.contents.map((c) => c.parts.length));
    const live = name.contents[name.contents.length - 1].parts.length;
    const parts: { doc: DocRow; created: boolean }[] = [];
    for (let k = 1; k <= total; k++) {
      const origin = importOrigin(name.key, k);
      const found = store.docByOrigin(origin);
      if (found !== null) {
        // An open head the import builds on seals first, as any new head's parent does.
        this.sealInTx(found, this.headOf(found));
        parts.push({ doc: found, created: false });
        continue;
      }
      const doc = this.importDocRow(
        actor,
        name.slug,
        k,
        origin,
        name.contents[0].mtime
      );
      // Stored at once, so the next part's slug is picked against this one.
      store.putDoc(doc);
      parts.push({ doc, created: true });
    }
    for (const content of name.contents) {
      content.parts.forEach((body, i) => {
        const { doc } = parts[i];
        const rev = this.makeRevision(doc.id, {
          parents: doc.headId === '' ? [] : [doc.headId],
          title:
            i === 0
              ? name.title
              : partTitle(name.title, i + 1, content.parts.length),
          body,
          author: actor.address,
          cause: 'import',
          summary: `imported ${content.hash.slice(0, 12)}`,
          sealed: true,
          numbered: true,
          at: content.mtime,
        });
        store.insertRevision(rev);
        this.setHead(doc, rev, actor.address, content.mtime);
        store.putDoc(doc);
      });
      store.markImported(
        'team',
        name.key,
        content.hash,
        parts[0].doc.id,
        this.nowIso()
      );
    }
    const at = this.nowIso();
    // Parts an earlier, longer content made that this import did not reach.
    const leftovers = parts.slice(live).map((p) => p.doc);
    for (let k = total + 1; ; k++) {
      const extra = store.docByOrigin(importOrigin(name.key, k));
      if (extra === null) break;
      leftovers.push(extra);
    }
    for (const { doc } of parts.slice(0, live)) {
      if (doc.status === 'archived')
        this.applyStatus(actor, doc, doc.archivedFrom ?? 'draft', at);
    }
    for (const doc of leftovers) {
      if (doc.status !== 'archived')
        this.applyStatus(actor, doc, 'archived', at);
    }
    if (leftovers.length > 0)
      store.removeLink(parts[live - 1].doc.id, 'doc', leftovers[0].id);
    parts.forEach(({ doc, created }, i) => {
      const head = this.headOf(doc);
      this.reindex(doc, head);
      this.rebuildMentions(doc, head);
      const targets: LinkTarget[] = [];
      if (i > 0 && i < live)
        targets.push({ type: 'doc', id: parts[i - 1].doc.id });
      if (i + 1 < live) targets.push({ type: 'doc', id: parts[i + 1].doc.id });
      const own = link !== null && link.type === 'doc' && link.id === doc.id;
      if (link !== null && i < live && !own) targets.push(link);
      // A link that already exists keeps its rel, so a re-import never demotes a spec.
      const linked = store.links({ docId: doc.id });
      for (const target of targets) {
        const has = linked.some(
          (l) =>
            l.source === 'manual' &&
            l.targetType === target.type &&
            l.targetId === target.id
        );
        if (!has) this.putLink(actor, doc, target, 'context', false, at);
      }
      store.putDoc(doc);
      this.outbox.push({
        doc: doc.id,
        scope: 'team',
        kind: created ? 'created' : 'sealed',
        author: actor.address,
        rev: head.id,
        summary: 'imported',
      });
    });
  }

  // A new doc row for an import; its head is set by its first revision.
  private importDocRow(
    actor: DocsActor,
    slug: string,
    k: number,
    origin: string,
    at: string
  ): DocRow {
    // pickSlug derives from a "title" through docSlug, which leaves a valid slug as it is.
    const handle = this.pickSlug(
      'team',
      undefined,
      k === 1 ? slug : partSlug(slug, k)
    );
    return {
      id: this.newId('doc'),
      ns: 'team',
      slug: handle,
      handle,
      title: slug,
      scope: 'team',
      ownerIdentity: null,
      ownerHuman: null,
      status: 'draft',
      archivedFrom: null,
      restoredStatus: null,
      restoredAt: null,
      headId: '',
      reviewedRev: null,
      unreviewed: false,
      conflicted: false,
      origin,
      publishedPath: null,
      publishedRev: null,
      publishedTask: null,
      publishedCommit: null,
      createdBy: actor.address,
      createdAt: at,
      updatedBy: actor.address,
      updatedAt: at,
      indexedHash: null,
    };
  }

  // ---- reads ----------------------------------------------------------------

  read(
    actor: DocsActor,
    ref: string,
    opts: {
      rev?: string | number;
      section?: string;
      offset?: number;
      page?: boolean;
    } = {}
  ): DocRead {
    const doc = this.resolve(actor, ref);
    const rev =
      opts.rev === undefined
        ? this.headOf(doc)
        : this.revisionOf(doc, opts.rev, 'rev');
    // Recorded before the read seals the head, so no notice tells the run of it.
    if (actor.runId !== null)
      this.notices?.recordRead(actor.runId, doc.id, rev.id);
    this.sealIfOtherReads(actor, doc, rev);
    const store = this.store();
    const current = store.revisionMeta(rev.id) ?? rev;
    const lines = splitLines(rev.body);
    const offsets = lineOffsets(lines);
    const sections = outline(rev.body, lines);
    let text = rev.body;
    let section: DocRead['section'] = null;
    if (opts.section !== undefined) {
      const s = resolveSection(sections, opts.section, 'section');
      text = sectionText(lines, s);
      section = { anchor: s.anchor, heading: s.heading };
    }
    const paged =
      opts.page === true ||
      opts.offset !== undefined ||
      opts.section !== undefined;
    const page = paged
      ? pageOf(text, opts.offset ?? 0, DOCS_LIMITS.readPageBytes)
      : { text, offset: 0, nextOffset: null, total: utf8Bytes(text) };
    const fresh = store.doc(doc.id) ?? doc;
    return {
      doc: this.record(fresh),
      rev: toInfo(current),
      links: this.visibleLinks(actor, doc.id),
      outline: sections
        .filter((s) => s.ord > 0)
        .map((s) => ({
          ord: s.ord,
          level: s.level,
          heading: s.heading,
          anchor: s.anchor,
          bytes: offsets[s.end] - offsets[s.line],
          line: s.line,
        })),
      section,
      text: page.text,
      offset: page.offset,
      nextOffset: page.nextOffset,
      total: page.total,
      proposal: null,
    };
  }

  // Docs linked to a task and its ancestors (at most 8) plus [[slug]] mentions in its body, ranked;
  // an A2A run gets only the task's own links, and client text mentions nothing.
  taskDocs(
    actor: DocsActor,
    taskId: string,
    includeArchived = false
  ): RankedDoc[] {
    const store = this.store();
    const chain: { id: string; depth: number; body: string }[] = [];
    const levels = actor.a2aRun ? 0 : ANCESTOR_LEVELS;
    let cursor: string | null = taskId;
    for (let depth = 0; cursor !== null && depth <= levels; depth++) {
      const task = this.host.task(cursor);
      if (task === null) break;
      chain.push({ id: task.id, depth, body: task.body });
      cursor = task.parent;
    }
    if (chain.length === 0)
      throw new DocsError('not-found', `task ${taskId} not found`, 'taskId');
    const usable = (row: DocRow | null): row is DocRow =>
      row !== null &&
      this.canSee(actor, row) &&
      (includeArchived || row.status !== 'archived');
    const candidates: RankedDoc[] = [];
    for (const node of chain) {
      for (const link of store.links({
        target: { type: 'task', id: node.id },
      })) {
        const row = store.doc(link.docId);
        if (usable(row))
          candidates.push({
            row,
            rel: link.rel,
            depth: node.depth,
            source: link.source,
          });
      }
    }
    const mentions =
      actor.a2aRun || this.host.a2aOrigin(chain[0].id)
        ? []
        : mentionsOf(chain[0].body);
    for (const m of mentions) {
      if (m.personal) continue;
      const row =
        store.docByHandle('team', m.slug) ?? store.docByAlias('team', m.slug);
      if (usable(row))
        candidates.push({ row, rel: 'context', depth: 0, source: 'mention' });
    }
    return rankDocs(candidates);
  }

  // A team doc's head for a live notice; null for a personal or missing doc,
  // which never makes one.
  noticeFacts(docId: string): DocNoticeFacts | null {
    const store = this.deps.store;
    const doc = store?.doc(docId) ?? null;
    if (store === null || doc === null || doc.scope !== 'team') return null;
    const head = store.revisionMeta(doc.headId);
    if (head === null || head.n === null) return null;
    return {
      handle: doc.handle,
      rev: head.id,
      n: head.n,
      author: head.author,
      summary: head.summary,
      sealed: head.sealed,
    };
  }

  // Whether a live run hears of a doc's change: it may see the doc, and read it
  // or finds it among its task's docs (the task or an ancestor links it).
  runCaresAbout(
    runId: string,
    taskId: string,
    docId: string,
    read: boolean
  ): boolean {
    const doc = this.deps.store?.doc(docId) ?? null;
    if (doc === null) return false;
    const actor = this.actorFor({
      address: `run:${runId}`,
      canDecide: false,
      kind: 'run',
    });
    if (!this.canSee(actor, doc)) return false;
    if (read) return true;
    try {
      return this.taskDocs(actor, taskId).some((c) => c.row.id === docId);
    } catch (err) {
      if (err instanceof DocsError && err.code === 'not-found') return false;
      throw err;
    }
  }

  // The ## Docs lines a run of `taskId` acting as `actor` would get.
  indexLines(actor: DocsActor, taskId: string): IndexLine[] {
    return this.toIndexLines(this.taskDocs(actor, taskId));
  }

  private toIndexLines(ranked: readonly RankedDoc[]): IndexLine[] {
    return ranked.map((c) => {
      const head = this.headOf(c.row);
      let tag: string = c.rel;
      if (c.depth === 1) tag = `parent ${c.rel}`;
      else if (c.depth > 1) tag = `ancestor ${c.rel}`;
      return {
        tag,
        handle: writtenHandle(c.row),
        status: c.row.status,
        unreviewed: c.row.unreviewed,
        conflicted: c.row.conflicted,
        you: c.row.scope === 'personal',
        n: head.n ?? 0,
        bytes: head.bytes,
        title: c.row.title,
        summary: summaryOf(head.body),
        spec: c.depth === 0 && c.rel === 'spec',
      };
    });
  }

  // The section for a dispatch prompt; null when docs are unavailable or nothing links.
  promptSection(input: {
    runId: string;
    taskId: string;
    dispatchTools: boolean;
  }): string | null {
    if (!this.available) return null;
    const actor = this.actorFor({
      address: `run:${input.runId}`,
      canDecide: false,
      kind: 'run',
    });
    const ranked = this.taskDocs(actor, input.taskId);
    const cfg = this.cfg();
    let inline: InlineSpec | null = null;
    // taskDocs ranks the task's own spec before ancestors', so this is the nearest.
    const spec = input.dispatchTools
      ? undefined
      : ranked.find(
          (c) => c.rel === 'spec' && (c.depth === 0 || !actor.a2aRun)
        );
    if (spec !== undefined) {
      const head = this.headOf(spec.row);
      inline = {
        handle: writtenHandle(spec.row),
        n: head.n ?? 0,
        body: head.body,
        maxBytes: cfg.inlineSpecBytes,
      };
    }
    return renderDocsSection(this.toIndexLines(ranked), {
      indexTokens: cfg.indexTokens,
      dispatchTools: input.dispatchTools,
      inline,
    });
  }

  list(
    actor: DocsActor,
    q: DocListQuery
  ): { docs: DocSummary[]; total: number } {
    const store = this.store();
    const limit = clamp(q.limit, 50, 200);
    const offset =
      q.offset !== undefined && Number.isInteger(q.offset) && q.offset > 0
        ? q.offset
        : 0;
    let statuses: DocStatus[] = ['draft', 'accepted'];
    if (q.status !== undefined) statuses = [q.status];
    else if (q.includeArchived === true)
      statuses = ['draft', 'accepted', 'archived'];
    // doc_list from a run that names nothing lists its own task's docs, in index order.
    const bare =
      q.query === undefined && q.scope === undefined && q.status === undefined;
    const taskId =
      q.taskId ??
      (bare && actor.kind === 'run' && actor.taskId !== null
        ? actor.taskId
        : undefined);
    if (taskId !== undefined) {
      const ranked = this.taskDocs(actor, taskId, true).filter(
        (c) =>
          statuses.includes(c.row.status) &&
          (q.unreviewed !== true || c.row.unreviewed) &&
          (q.conflicted !== true || c.row.conflicted)
      );
      const docs = ranked.slice(offset, offset + limit).map((c) => ({
        ...this.record(c.row),
        rel: c.rel,
        fromParent: c.depth > 0,
      }));
      return { docs, total: ranked.length };
    }
    const page = store.listDocs({
      ns: scoped(this.namespaces(actor), q.scope),
      statuses,
      unreviewed: q.unreviewed,
      conflicted: q.conflicted,
      query: q.query,
      ...(actor.a2aRun ? { ids: this.ownTaskDocIds(actor) } : {}),
      limit,
      offset,
    });
    return {
      docs: page.rows.map((row) => ({
        ...this.record(row),
        rel: null,
        fromParent: false,
      })),
      total: page.total,
    };
  }

  linking(actor: DocsActor, target: LinkTarget): DocLinking[] {
    if (target.type === 'task') {
      return this.taskDocs(actor, target.id).map((c) => ({
        doc: this.record(c.row),
        rel: c.rel,
        source: c.source,
        fromParent: c.depth > 0,
      }));
    }
    const store = this.store();
    return store.links({ target }).flatMap((l) => {
      const row = store.doc(l.docId);
      return row !== null && this.canSee(actor, row)
        ? [
            {
              doc: this.record(row),
              rel: l.rel,
              source: l.source,
              fromParent: false,
            },
          ]
        : [];
    });
  }

  search(actor: DocsActor, q: DocSearchQuery): DocHit[] {
    const store = this.store();
    const query = q.query.trim();
    if (query === '' || utf8Bytes(query) > DOCS_LIMITS.queryBytes) {
      throw new DocsError('invalid', 'query must be 1-500 bytes', 'query');
    }
    // FTS5's parser fails on both; refusing them in every search mode keeps the answer a 400.
    if (query.includes('\u0000') || UNPAIRED_SURROGATE.test(query)) {
      throw new DocsError(
        'invalid',
        'query must not contain NUL or an unpaired surrogate',
        'query'
      );
    }
    const limit = clamp(q.limit, 10, 50);
    const includeArchived = q.includeArchived === true;
    const ns = scoped(this.namespaces(actor), q.scope);
    // Each hit's doc, or null when the actor may not see it; checked once per doc.
    const rows = new Map<string, DocRow | null>();
    const visible = (id: string): DocRow | null => {
      if (!rows.has(id)) {
        const row = store.doc(id);
        rows.set(id, row !== null && this.canSee(actor, row) ? row : null);
      }
      return rows.get(id) ?? null;
    };
    const raw: RawHit[] = store.fts
      ? store.search(query, ns, {
          includeArchived,
          limit: Math.min(500, limit * 10),
          ...(actor.a2aRun ? { ids: this.ownTaskDocIds(actor) } : {}),
        })
      : this.likeSearch(query, ns, includeArchived);
    const perDoc = new Map<string, number>();
    const hits: DocHit[] = [];
    for (const r of raw) {
      if (hits.length >= limit) break;
      const row = visible(r.docId);
      if (row === null) continue;
      const count = perDoc.get(row.id) ?? 0;
      if (count >= HITS_PER_DOC) continue;
      perDoc.set(row.id, count + 1);
      hits.push({
        doc: row.id,
        handle: row.handle,
        title: row.title,
        scope: row.scope,
        anchor: r.anchor,
        heading: r.heading,
        snippet: r.snippet,
        score: r.score,
      });
    }
    return hits;
  }

  // No FTS5: every term must appear in a section's title, heading or text; newest docs first.
  private likeSearch(
    query: string,
    ns: readonly string[],
    includeArchived: boolean
  ): RawHit[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t !== '');
    const out: RawHit[] = [];
    for (const { doc, body } of this.store().headBodies(ns, includeArchived)) {
      const lines = splitLines(body);
      for (const s of outline(body, lines)) {
        const own = lines
          .slice(s.ord === 0 ? 0 : s.line + 1, s.ownEnd)
          .join('');
        const hay = `${doc.title}\n${s.heading}\n${own}`.toLowerCase();
        if (terms.every((t) => hay.includes(t))) {
          out.push({
            docId: doc.id,
            anchor: s.anchor,
            heading: s.heading,
            snippet: cutUtf8(own.trim(), 160),
            score: 0,
          });
        }
      }
    }
    return out;
  }

  revisions(
    actor: DocsActor,
    ref: string,
    page: { before?: number; limit?: number }
  ): DocRevisionInfo[] {
    const doc = this.resolve(actor, ref);
    return this.store()
      .revisionMetas(doc.id, {
        before: page.before,
        limit: clamp(page.limit, 50, 200),
      })
      .map(toInfo);
  }

  revision(
    actor: DocsActor,
    ref: string,
    revRef: string | number
  ): DocRevisionInfo & { body: string } {
    const doc = this.resolve(actor, ref);
    const rev = this.revisionOf(doc, revRef, 'rev');
    this.sealIfOtherReads(actor, doc, rev);
    return {
      ...toInfo(this.store().revisionMeta(rev.id) ?? rev),
      body: rev.body,
    };
  }

  diff(
    actor: DocsActor,
    ref: string,
    from: string | number,
    to: string | number
  ): {
    from: DocRevisionInfo;
    to: DocRevisionInfo;
    chunks: DiffChunk[];
    spent: boolean;
  } {
    const doc = this.resolve(actor, ref);
    const a = this.revisionOf(doc, from, 'from');
    const b = this.revisionOf(doc, to, 'to');
    this.sealIfOtherReads(actor, doc, a);
    this.sealIfOtherReads(actor, doc, b);
    const { chunks, spent } = diffChunks(a.body, b.body);
    return { from: toInfo(a), to: toInfo(b), chunks, spent };
  }

  health(actor: DocsActor): DocsHealth {
    if (actor.kind !== 'human') throw forbidden('health is for humans');
    const warnings = this.deps.config().warnings.map((w) => w.message);
    const store = this.deps.store;
    // The orphan list names other projects' paths on this host: decide tier only.
    const decide = actor.decider
      ? { orphans: this.deps.orphans?.() ?? [] }
      : {};
    if (store === null) {
      return {
        available: false,
        reason: this.deps.unavailable ?? 'docs.db did not open',
        search: 'like',
        bytes: 0,
        warnings,
        lastSweep: null,
        ...decide,
      };
    }
    const bytes = store.fileBytes();
    if (bytes > 100 * 1024 * 1024)
      warnings.push(
        'docs.db is over 100 MB (the full-body history revisit trigger)'
      );
    return {
      available: true,
      reason: null,
      search: store.fts ? 'fts5' : 'like',
      bytes,
      warnings,
      lastSweep: store.meta('sweep:last'),
      ...decide,
    };
  }

  // Seals expired open heads and rebuilds stale section indexes; every 60 s and at boot.
  sweep(): { sealed: number; reindexed: number } {
    const store = this.deps.store;
    if (store === null) return { sealed: 0, reindexed: 0 };
    const now = this.host.now();
    const cfg = this.cfg();
    let sealed = 0;
    let reindexed = 0;
    for (const rev of store.openHeads()) {
      const doc = store.doc(rev.docId);
      if (doc === null || !this.expired(rev, now, cfg)) continue;
      this.write(() => this.sealInTx(doc, rev));
      sealed++;
    }
    for (const { docId, headId } of store.staleIndexes()) {
      const doc = store.doc(docId);
      const head = store.revision(headId);
      if (doc === null || head === null) continue;
      this.write(() => {
        this.reindex(doc, head);
        store.putDoc(doc);
      });
      reindexed++;
    }
    const dayAgo = new Date(now.getTime() - 24 * HOUR_MS).toISOString();
    for (const id of store.idleImportSessions(dayAgo))
      store.deleteImportSession(id);
    store.setMeta('sweep:last', now.toISOString());
    return { sealed, reindexed };
  }

  close(): void {
    this.deps.store?.close();
  }
}
