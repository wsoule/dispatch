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
import { carriesUnreviewed, unreviewedAtCreation } from './review.js';
import {
  cutUtf8,
  mentionsOf,
  outline,
  pageOf,
  resolveSection,
  sectionText,
  splitLines,
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

// Every docs rule in one place: who may do what, the write path with open
// revisions and three-way merges, links, lifecycle, reads, lists and search.

export interface DocsActor {
  principal: Principal;
  address: string;
  kind: Principal['kind'] | 'overseer';
  decider: boolean;
  runKind: 'execute' | 'review' | 'verify' | null;
  taskId: string | null;
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

  // ---- actors and visibility ------------------------------------------------

  actorFor(principal: Principal): DocsActor {
    if (isA2AAgent(principal.address))
      throw forbidden('A2A clients cannot use docs');
    const runKind =
      principal.kind === 'run' ? this.host.runKind(principal) : null;
    return {
      principal,
      address: principal.address,
      kind: principal.kind,
      decider: principal.kind === 'human' && principal.canDecide,
      runKind,
      taskId:
        runKind === 'execute' ? this.host.taskOfPrincipal(principal) : null,
      runId:
        principal.kind === 'run'
          ? principal.address.slice('run:'.length)
          : null,
      operator: this.host.operatorOf(principal),
      a2aRun: false,
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
      runId: null,
      operator: null,
      a2aRun: false,
    };
  }

  // Namespaces the actor may read: the team's only, until personal docs exist.
  private namespaces(_actor: DocsActor): string[] {
    return ['team'];
  }

  private canSee(actor: DocsActor, row: DocRow): boolean {
    return this.namespaces(actor).includes(row.ns);
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
    throw forbidden('review and verify runs read docs and never write them');
  }

  private requireWritable(actor: DocsActor, doc: DocRow): void {
    this.requireDraftWriter(actor);
    if (doc.status === 'archived') throw archivedError();
    if (doc.status === 'accepted' && !actor.decider) {
      throw forbidden(
        'only decide-tier humans edit accepted docs directly',
        'doc'
      );
    }
  }

  private requireDecider(actor: DocsActor, doc: DocRow, what: string): void {
    if (doc.scope === 'team' && actor.decider) return;
    throw forbidden(`only a decide-tier human may ${what}`, 'doc');
  }

  // A doc argument: doc-<id>, or a team handle and then a retired slug. A
  // ~slug names a personal doc, which no one has yet.
  private resolve(actor: DocsActor, ref: string): DocRow {
    const store = this.store();
    let row: DocRow | null = null;
    if (ref.startsWith('doc-')) row = store.doc(ref);
    else if (!ref.startsWith('~'))
      row = store.docByHandle('team', ref) ?? store.docByAlias('team', ref);
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

  // Derived `mention` links from [[slug]] in a sealed head, team docs only.
  private rebuildMentions(doc: DocRow, rev: RevisionRow): void {
    const store = this.store();
    const rows: LinkRow[] = [];
    for (const m of mentionsOf(rev.body)) {
      if (m.personal) continue;
      const target =
        store.docByHandle('team', m.slug) ?? store.docByAlias('team', m.slug);
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
    const store = this.store();
    this.requireDraftWriter(actor);
    const scope = input.scope ?? 'team';
    if (scope !== 'team')
      throw forbidden('personal docs need memory v1', 'scope');
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
    const slug = this.pickSlug('team', input.slug, title);
    const doc: DocRow = {
      id: this.newId('doc'),
      ns: 'team',
      slug,
      handle: slug,
      title,
      scope,
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
      origin: null,
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
      this.checkLinkAuthority(actor, target, links[i].rel, `links[${i}]`)
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
    if (this.store().slugTaken(doc.ns, slug))
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
    if (status === 'accepted') {
      throw new DocsError(
        'invalid',
        'accepting needs the doc gate, which arrives in docs v1',
        'status'
      );
    }
    if (status === doc.status) return this.record(doc);
    const at = this.nowIso();
    return this.write(() => {
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
      return this.record(doc);
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

  // Who may make a link: runs stay on their own task, run and threads; agents add context only.
  private checkLinkAuthority(
    actor: DocsActor,
    target: LinkTarget,
    rel: LinkRel,
    field: string
  ): void {
    if (!this.mayWriteDrafts(actor))
      throw forbidden('you may not change links', field);
    if (actor.kind === 'run') {
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

  // Whether `actor` may move a task's spec link off `displaced`.
  private mayDisplace(actor: DocsActor, displaced: DocRow): boolean {
    return (
      actor.decider ||
      (displaced.scope === 'team' &&
        displaced.status === 'draft' &&
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
      doc.status === 'accepted' &&
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
    this.checkLinkAuthority(actor, target, input.rel, 'link');
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
      { type: target.type, id: targetId },
      existing.rel,
      'target'
    );
    if (
      existing.rel !== 'context' &&
      doc.status === 'accepted' &&
      !actor.decider
    ) {
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
      links: store.links({ docId: doc.id }).map(toLink),
      outline: sections
        .filter((s) => s.ord > 0)
        .map((s) => ({
          ord: s.ord,
          level: s.level,
          heading: s.heading,
          anchor: s.anchor,
          bytes: offsets[s.end] - offsets[s.line],
        })),
      section,
      text: page.text,
      offset: page.offset,
      nextOffset: page.nextOffset,
      total: page.total,
      proposal: null,
    };
  }

  // Docs linked to a task and its ancestors (at most 8 levels) plus [[slug]]
  // mentions in the task's own body, in index rank order.
  taskDocs(
    actor: DocsActor,
    taskId: string,
    includeArchived = false
  ): RankedDoc[] {
    const store = this.store();
    const chain: { id: string; depth: number; body: string }[] = [];
    let cursor: string | null = taskId;
    for (let depth = 0; cursor !== null && depth <= ANCESTOR_LEVELS; depth++) {
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
    for (const m of mentionsOf(chain[0].body)) {
      if (m.personal) continue;
      const row =
        store.docByHandle('team', m.slug) ?? store.docByAlias('team', m.slug);
      if (usable(row))
        candidates.push({ row, rel: 'context', depth: 0, source: 'mention' });
    }
    return rankDocs(candidates);
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
    if (q.taskId !== undefined) {
      const ranked = this.taskDocs(actor, q.taskId, true).filter(
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
    const limit = clamp(q.limit, 10, 50);
    const includeArchived = q.includeArchived === true;
    const ns = scoped(this.namespaces(actor), q.scope);
    const rows = new Map<string, DocRow | null>();
    const docOf = (id: string): DocRow | null => {
      if (!rows.has(id)) rows.set(id, store.doc(id));
      return rows.get(id) ?? null;
    };
    const raw: RawHit[] = store.fts
      ? store.search(query, ns, {
          includeArchived,
          limit: Math.min(500, limit * 10),
        })
      : this.likeSearch(query, ns, includeArchived);
    const perDoc = new Map<string, number>();
    const hits: DocHit[] = [];
    for (const r of raw) {
      if (hits.length >= limit) break;
      const row = docOf(r.docId);
      if (row === null || !this.canSee(actor, row)) continue;
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
    store.setMeta('sweep:last', now.toISOString());
    return { sealed, reindexed };
  }

  close(): void {
    this.deps.store?.close();
  }
}
