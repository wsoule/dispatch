import type {
  DocFileMeta,
  DocHit,
  DocLink,
  DocLinking,
  DocOp,
  DocProposal,
  DocProposalView,
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
  PolicyRuling,
  ProposalState,
  RevisionCause,
} from '@dispatch/core';
import {
  ASSET_NAME,
  assetNames,
  DOC_STATUSES,
  docBodyProblem,
  DOCS_LIMITS,
  docSlug,
  docSlugProblem,
  docTitleProblem,
  LINK_RELS,
  LINK_TARGET_TYPES,
  normalizeDocText,
  parseDocFile,
  rewriteAssetLinks,
  untrustedInline,
} from '@dispatch/core';
import type { Operator } from '@dispatch/memory';
import { isA2AAgent } from '@dispatch/memory';
import { createUlidFactory, SYSTEM_ADDRESS } from '@dispatch/protocol';
import { compareHlc, parseOpHlc } from '@dispatch/protocol/federation';
import type { DocBody } from '@dispatch/protocol/federation';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

import { LINEAR_REQUEST_TIMEOUT_MS } from '../linear/client.js';
import type { Principal } from '../messaging/principal.js';
import {
  assetFilePath,
  MAX_ASSET_BYTES,
  readAssetFile,
  removeAssetDir,
  sniffImage,
  storeAssetFile,
} from './assets.js';
import { DocConflictError, DocsError } from './errors.js';
import type { DocChange, DocsHost } from './host.js';
import type { LinearText } from './linear.js';
import { linearText } from './linear.js';
import type { DiffChunk } from './merge.js';
import { diffChunks, merge3 } from './merge.js';
import { applyOps } from './ops.js';
import type { IndexLine, InlineSpec } from './prompt.js';
import { indexLineText, renderDocsSection } from './prompt.js';
import {
  publishAssetsDir,
  seedAsset,
  seedFile,
  validatePublishPath,
} from './publish.js';
import type { RestoreReport } from './receipts.js';
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
  LinearDocRow,
  LinkRow,
  PublishRow,
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
import { nameKey, planImport, splitForCap } from './transfer.js';

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
  // docs-assets/: where images live (v1); without it uploads answer unavailable.
  assetsDir?: string;
  // Caps on stored images, per doc and for the project; the defaults are 200
  // files and 256 MiB a doc, 2 GiB in all.
  assetLimits?: { files: number; bytes: number; projectBytes: number };
}

// A team doc as the receipt log writes it: its newest sealed head, the
// distinct authors of that head's ancestry and its manual links.
interface ReceiptsDoc {
  row: DocRow;
  head: RevisionRow;
  authors: string[];
  links: { target: string; rel: LinkRel }[];
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
const DAY_MS = 24 * HOUR_MS;
// Per-doc image caps, and how long an image no revision links is kept.
const DEFAULT_ASSET_LIMITS = {
  files: 200,
  bytes: 256 * 1024 * 1024,
  projectBytes: 2 * 1024 * 1024 * 1024,
};
const ASSET_TTL_DAYS = 30;
// A gap since the last image sweep past this reads as a clock jump.
const ASSET_MAX_SWEEP_GAP_DAYS = 7;
// A doc line to a run, as live notices are: at most 160 characters.
const RUN_LINE_CHARS = 160;
// Mergeability answers kept, per (proposal body, head).
const MERGEABLE_CACHE = 256;
const REOPENED = 'the doc was reopened as a draft; write to it directly';
const MAX_OPEN_AGE_MS = HOUR_MS;
const ANCESTOR_LEVELS = 8;
const HITS_PER_DOC = 3;
const RECEIPT_AUTHORS = 20;
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
const sha256Bytes = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const ulid = createUlidFactory();

function forbidden(message: string, field?: string): DocsError {
  return new DocsError('forbidden', message, field);
}

// Why the clock cannot be trusted to age images: over a week since the last
// sweep (a daemon stopped for a weekend is a pause, not a jump), or a stamp
// in the future. Null when sound.
function assetClockAnomaly(
  lastSweep: string | null,
  newest: string | null,
  now: Date
): string | null {
  const limit = now.getTime() + 5 * 60_000;
  if (lastSweep !== null) {
    const last = Date.parse(lastSweep);
    if (last > limit) return `clock anomaly: the last sweep is in the future`;
    if (now.getTime() - last > ASSET_MAX_SWEEP_GAP_DAYS * DAY_MS)
      return `clock anomaly: ${lastSweep} was the last sweep`;
  }
  if (newest !== null && Date.parse(newest) > limit)
    return `clock anomaly: an image is stamped ${newest}, in the future`;
  return null;
}

// A publish task's title; recovery finds a crash's orphan task by it.
function publishTitle(handle: string, n: number, path: string): string {
  return `Publish doc ${handle} (rev ${n}) to ${path}`;
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

// Whether `body` holds a diff3 conflict: a `<<<<<<< ` line, then `=======`, then `>>>>>>> `.
function hasConflictMarkers(body: string): boolean {
  let stage = 0;
  for (const line of body.split('\n')) {
    if (stage === 0 && line.startsWith('<<<<<<< ')) stage = 1;
    else if (stage === 1 && line === '=======') stage = 2;
    else if (stage === 2 && line.startsWith('>>>>>>> ')) return true;
  }
  return false;
}

// One direct save's new head.
interface DirectCommit {
  body: string;
  title: string;
  summary: string;
  cause: 'save' | 'edit' | 'revert';
  restores?: RevisionMeta;
}

const problemKey = (docId: string): string => `problem:${docId}`;
const syncProblemsKey = (docId: string): string => `sync-problems:${docId}`;
const SYNC_PROBLEMS_KEPT = 20;
const SYNC_DIRTY = 'sync:dirty:';
const syncDirtyKey = (docId: string): string => `${SYNC_DIRTY}${docId}`;

/** What `docs sync repair` reaches: the bound team sync handler. */
export interface SyncRepairPort {
  repair(docId?: string): { reread: number };
}

/** A teammate's revision as the sync handler stores it. */
export interface SyncedRevision {
  id: string;
  docId: string;
  parents: string[];
  restoredParents: string[] | null;
  title: string;
  body: string;
  hash: string;
  author: string;
  cause: RevisionCause;
  summary: string;
  createdAt: string;
  approval: { by: string; policy?: { rung: number } } | null;
  // Arrived from a publisher that cannot speak for its author.
  via: string | null;
  // In history (numbered), or held back out of it.
  numbered: boolean;
  // Its text counts as unreviewed whatever its cause.
  taint: boolean;
  conflicted: boolean;
}

/** The meta fields team sync carries, last writer wins per field. */
export interface SyncMeta {
  slug: string;
  aliases: string[];
  status: DocStatus;
  links: { target: LinkTarget; rel: LinkRel }[];
}

/** What this replica knows a teammate's log already holds. */
export type SyncKnown =
  | { kind: 'rev'; rev: string }
  | { kind: 'review'; doc: string; rev: string; by: string }
  | { kind: 'remove'; doc: string };

function syncKnownKey(k: SyncKnown): string {
  if (k.kind === 'rev') return `sync:pub:${k.rev}`;
  if (k.kind === 'remove') return `sync:rm:${k.doc}`;
  return `sync:rv:${k.doc}:${k.rev}:${k.by}`;
}

/** A local change's op clock, at the wall time it was made: what a teammate's
 *  later revision is compared with before the change is published. */
function localClock(atIso: string): string {
  return `${String(Date.parse(atIso)).padStart(13, '0')}.0000.local`;
}

const linksKey = (links: SyncMeta['links']): string =>
  links
    .map((l) => `${l.target.type}:${l.target.id}:${l.rel}`)
    .sort()
    .join('\n');

/** Whether op clock `a` is later than `b` (or `b` is unset). */
export function laterClock(a: string, b: string | undefined): boolean {
  if (b === undefined) return true;
  const pa = parseOpHlc(a);
  const pb = parseOpHlc(b);
  if (pa === null || pb === null) return a > b;
  const c = compareHlc(pa, pb);
  return c !== 0 ? c > 0 : pa.replica > pb.replica;
}
const heldKey = (docId: string): string => `held:${docId}`;
const shareClaimKey = (docId: string): string => `linear-share:${docId}`;
// A share is one Linear call; its claim outlives that call's timeout threefold.
const SHARE_CLAIM_MS = 3 * LINEAR_REQUEST_TIMEOUT_MS;

// A doc's stored sync problem as DocRecord carries it, or nothing.
// A sync problem (a Linear edit a push overwrote) leads; a hold note follows.
function problemOf(store: SqliteDocStore, docId: string): { problem?: string } {
  const problem = store.meta(problemKey(docId));
  if (problem !== null) return { problem: `Linear sync problem: ${problem}` };
  const team = store.meta(syncProblemsKey(docId));
  const latest =
    team === null ? undefined : (JSON.parse(team) as string[]).at(-1);
  if (latest !== undefined) return { problem: `Team sync problem: ${latest}` };
  const held = store.meta(heldKey(docId));
  return held === null ? {} : { problem: `Linear sync held: ${held}` };
}

export class DocsService {
  private outbox: DocChange[] = [];
  // Attached once the daemon builds live notices.
  private notices: DocReadRecorder | null = null;
  // Whether a proposal merges cleanly onto a head, keyed by both bodies' revisions.
  private readonly mergeable = new Map<string, boolean>();
  // Team sync (v2): the bound handler, and what a sync write queued for after it.
  private syncPort: SyncRepairPort | null = null;
  private readonly syncAfter: (() => void)[] = [];

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
      const out = this.store().transaction(() => {
        const result = fn();
        this.markSyncDirty();
        return result;
      });
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

  // Team sync reads only docs a write touched since it last found them clean.
  private markSyncDirty(): void {
    const store = this.store();
    for (const change of this.outbox) {
      if (change.scope !== 'team') continue;
      store.setMeta(syncDirtyKey(change.doc), '1');
      // Who made a meta change is who it travels as (FW-R38 minor).
      if (change.kind === 'meta')
        store.setMeta(`sync:by:${change.doc}`, change.author);
    }
  }

  // The docs a pass looks at; the first ever pass looks at every team doc.
  private syncDirty(): string[] {
    const store = this.store();
    if (store.meta('sync:seeded') === null) {
      const { rows } = store.listDocs({
        ns: ['team'],
        statuses: DOC_STATUSES,
        limit: Number.MAX_SAFE_INTEGER,
        offset: 0,
      });
      for (const doc of rows) store.setMeta(syncDirtyKey(doc.id), '1');
      store.setMeta('sync:seeded', '1');
    }
    return store.metaKeys(SYNC_DIRTY).map((k) => k.slice(SYNC_DIRTY.length));
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

  // Draft writers may write any live doc; on an accepted team doc anyone below
  // decide tier writes through a proposal.
  private requireWritable(actor: DocsActor, doc: DocRow): void {
    this.requireDraftWriter(actor);
    if (doc.status === 'archived') throw archivedError();
  }

  // Whether the actor's writes to `doc` become proposals rather than revisions.
  private proposes(actor: DocsActor, doc: DocRow): boolean {
    return this.gated(doc) && !actor.decider;
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

  // A numbered revision of `doc` by id or number (a digit string counts as a
  // number). With a `viewer`, a proposal revision it may see counts too; one it
  // may not see is not found.
  private revisionOf(
    doc: DocRow,
    ref: string | number,
    field: string,
    viewer: DocsActor | null = null
  ): RevisionRow {
    const store = this.store();
    let n: number | null = null;
    if (typeof ref === 'number') n = ref;
    else if (/^\d+$/.test(ref)) n = Number(ref);
    const rev =
      n === null ? store.revision(String(ref)) : store.revisionByN(doc.id, n);
    if (
      rev !== null &&
      rev.docId === doc.id &&
      rev.n === null &&
      viewer !== null
    ) {
      const p = store.proposalRows({ rev: rev.id })[0];
      if (p !== undefined) {
        if (this.canSeeProposal(viewer, p)) return rev;
        throw new DocsError('not-found', `${field}: revision not found`, field);
      }
    }
    if (rev === null || rev.docId !== doc.id || rev.n === null) {
      throw new DocsError(
        'invalid',
        `${field}: not a revision of ${doc.handle}`,
        field
      );
    }
    return rev;
  }

  // A head stamped after `now` (the clock stepped back) counts as expired, so
  // the next save starts a revision instead of overwriting it.
  private expired(rev: RevisionMeta, now: Date, cfg: DocsConfig): boolean {
    if (now.getTime() < Date.parse(rev.updatedAt)) return true;
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
      // Text from outside Dispatch (Linear): unreviewed whoever it maps to.
      external?: string;
    }
  ): RevisionRow {
    const store = this.store();
    const state = (meta: RevisionMeta | null) =>
      meta === null
        ? { unreviewed: false, reviewed: false }
        : { unreviewed: meta.unreviewed, reviewed: store.hasReview(meta.id) };
    const unreviewed =
      input.external !== undefined ||
      unreviewedAtCreation({
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
      via: input.external ?? null,
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
      lastPublishPath: store.publishRows({ doc: doc.id })[0]?.path ?? null,
      ...problemOf(store, doc.id),
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
    carries?: RevisionMeta,
    external?: string
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
        ...(external === undefined ? {} : { external }),
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
  // A direct save, then the doc's Linear hold note brought up to date.
  private commitDirect(
    actor: DocsActor,
    doc: DocRow,
    next: DirectCommit,
    extra: Partial<DocSaveResult> = {}
  ): DocSaveResult {
    const out = this.commitDirectTx(actor, doc, next, extra);
    this.refreshLinearHold(doc.id);
    return out;
  }

  private commitDirectTx(
    actor: DocsActor,
    doc: DocRow,
    next: DirectCommit,
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
      // A human's own save settles a sync problem.
      if (actor.kind === 'human') {
        store.deleteMeta(problemKey(doc.id));
        store.deleteMeta(syncProblemsKey(doc.id));
      }
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

  // An accepted team doc takes direct writes from decide-tier humans only;
  // anyone else's computed change becomes (or extends) their proposal.
  private directOrPropose(
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
    if (!this.proposes(actor, doc))
      return this.commitDirect(actor, doc, next, extra);
    const store = this.store();
    const head = this.headOf(doc);
    const now = this.host.now();
    const at = now.toISOString();
    const own = this.ownOpenProposal(actor, doc);
    if (own !== null)
      return this.amendProposal(doc, head, own, next, at, extra);
    if (next.body === head.body && next.title === head.title)
      return this.result(doc, head, 'unchanged', extra);
    // A body equal to another open proposal's is a conflict naming it only when
    // the caller may see that proposal; otherwise it is stored, revealing nothing.
    const nextHash = sha256(next.body);
    const twin = store
      .proposalRows({ doc: doc.id, states: ['open'] })
      .find((o) => store.revisionMeta(o.rev)?.hash === nextHash);
    if (twin !== undefined && this.canSeeProposal(actor, twin)) {
      throw new DocsError(
        'conflict',
        `the same change is already proposed as ${twin.rev}`,
        'doc'
      );
    }
    this.checkProposalLimits(actor, now);
    const rev = this.makeRevision(doc.id, {
      parents: [head.id],
      title: next.title,
      body: next.body,
      author: actor.address,
      cause: 'proposal',
      summary: next.summary,
      sealed: false,
      numbered: false,
      restores: next.restores,
      at,
    });
    const p: DocProposal = {
      rev: rev.id,
      doc: doc.id,
      base: head.id,
      author: actor.address,
      operator: actor.operator?.human ?? null,
      runId: actor.runId,
      taskId: actor.taskId,
      origin: 'local',
      gate: null,
      state: 'open',
      decidedBy: null,
      decidedByPolicy: null,
      reason: null,
      result: null,
      createdAt: at,
      decidedAt: null,
    };
    // The base seals, so no amend in place can change what the proposal diffs against.
    this.write(() => {
      this.sealInTx(doc, head);
      store.insertRevision(rev);
      store.putProposal(p);
      this.proposalChanged(doc, p, actor.address, 'opened');
    });
    const task = p.taskId === null ? null : this.host.task(p.taskId);
    const ruling = this.host.rule(task === null ? 'elevated' : task.risk);
    if (ruling.mode === 'auto') {
      const out = this.approveProposal(p.rev, SYSTEM_ADDRESS, {
        rung: ruling.rung,
        authorizedBy: ruling.authorizedBy,
      });
      if (!out.ok) {
        throw new DocsError(
          'conflict',
          `proposal ${p.rev} was approved by policy but failed: ${out.reason}`,
          'doc'
        );
      }
      this.recordPolicyApproval(p.rev, ruling);
      const fresh = store.doc(doc.id) ?? doc;
      return this.result(fresh, this.headOf(fresh), 'saved', extra);
    }
    return {
      ...this.result(doc, head, 'proposed', extra),
      rev: { id: rev.id, n: null, hash: rev.hash },
      proposal: rev.id,
    };
  }

  // Rewrites the author's open proposal in place; its gate stays.
  private amendProposal(
    doc: DocRow,
    head: RevisionRow,
    own: DocProposal,
    next: { body: string; title: string; summary: string },
    at: string,
    extra: Partial<DocSaveResult>
  ): DocSaveResult {
    const store = this.store();
    const rev = this.proposalRevision(own);
    const hash = sha256(next.body);
    if (next.body !== rev.body || next.title !== rev.title) {
      this.write(() =>
        store.amendRevision(rev.id, {
          title: next.title,
          body: next.body,
          hash,
          bytes: utf8Bytes(next.body),
          summary: cutUtf8(
            `${rev.summary}; ${next.summary}`,
            DOCS_LIMITS.summaryBytes
          ),
          updatedAt: at,
        })
      );
    }
    return {
      ...this.result(doc, head, 'proposed', extra),
      rev: { id: rev.id, n: null, hash },
      proposal: rev.id,
      ...(own.gate === null ? {} : { gate: own.gate }),
    };
  }

  // Proposals per author per hour, and open proposals per project.
  private checkProposalLimits(actor: DocsActor, now: Date): void {
    const store = this.store();
    const cfg = this.cfg();
    const since = new Date(now.getTime() - HOUR_MS).toISOString();
    if (
      store.countProposalsSince(actor.address, since) >= cfg.proposalsPerHour
    ) {
      throw new DocsError(
        'limited',
        `at most ${cfg.proposalsPerHour} proposals per hour`,
        'doc'
      );
    }
    if (
      store.proposalRows({ states: ['open'] }).length >= cfg.maxOpenProposals
    ) {
      throw new DocsError(
        'limited',
        `this project holds at most ${cfg.maxOpenProposals} open proposals`,
        'doc'
      );
    }
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
    // A proposer's own open proposal is a base too: saving on it extends it.
    const own = this.proposes(actor, doc)
      ? this.ownOpenProposal(actor, doc)
      : null;
    const base =
      own !== null && input.baseRev === own.rev
        ? this.proposalRevision(own)
        : this.revisionOf(doc, input.baseRev, 'baseRev');
    let head = this.headOf(doc);
    if (input.baseHash !== undefined && base.hash !== input.baseHash) {
      this.sealIfOtherReads(actor, doc, head);
      throw this.baseChanged(head);
    }
    if (own !== null && base.id !== own.rev)
      return this.saveOntoProposal(actor, doc, own, base, body, title);
    if (base.id === head.id || base.id === own?.rev) {
      return this.directOrPropose(actor, doc, {
        body,
        title: title ?? base.title,
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
    if (this.proposes(actor, doc)) {
      return this.directOrPropose(actor, doc, {
        body: merged.body,
        title: nextTitle,
        summary: 'saved',
        cause: 'save',
      });
    }
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

  // A proposer's save based elsewhere than its open proposal merges onto it:
  // diff3(base, proposal, body), so the proposal's earlier edits survive.
  private saveOntoProposal(
    actor: DocsActor,
    doc: DocRow,
    own: DocProposal,
    base: RevisionRow,
    body: string,
    title: string | undefined
  ): DocSaveResult {
    const prop = this.proposalRevision(own);
    const merged = merge3(base.body, prop.body, body, {
      head: `your open proposal ${prop.id}`,
      base: `base (rev ${base.n ?? 0})`,
      mine: 'yours',
    });
    if (!merged.clean) {
      throw new DocConflictError({
        code: 'conflict',
        reason: 'merge-conflict',
        head: {
          id: prop.id,
          n: base.n ?? 0,
          hash: prop.hash,
          body: prop.body,
          author: prop.author,
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
    return this.directOrPropose(actor, doc, {
      body: merged.body,
      title: mineTitle !== base.title ? mineTitle : prop.title,
      summary: 'saved',
      cause: 'save',
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
    // A proposer's ops extend its open proposal; everyone else's apply to the head.
    const own = this.proposes(actor, doc)
      ? this.ownOpenProposal(actor, doc)
      : null;
    const start = own === null ? head : this.proposalRevision(own);
    const out = applyOps({ body: start.body, title: start.title }, input.ops);
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
    return this.directOrPropose(
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
    return this.directOrPropose(actor, doc, {
      body: target.body,
      title: target.title,
      summary: `reverted to rev ${target.n ?? 0}`,
      cause: 'revert',
      restores: target,
    });
  }

  // ---- proposals and the doc gate -------------------------------------------

  // The actor's open proposal on `doc`, which its next write extends.
  private ownOpenProposal(actor: DocsActor, doc: DocRow): DocProposal | null {
    return (
      this.store().proposalRows({
        doc: doc.id,
        author: actor.address,
        states: ['open'],
      })[0] ?? null
    );
  }

  private proposalRevision(p: DocProposal): RevisionRow {
    const rev = this.store().revision(p.rev);
    if (rev === null) throw new Error(`proposal ${p.rev} has no revision`);
    return rev;
  }

  // Decide tier sees every proposal; others their own, and a human also those
  // of the runs and agents acting for them.
  private canSeeProposal(actor: DocsActor, p: DocProposal): boolean {
    if (actor.decider || p.author === actor.address) return true;
    return (
      actor.kind === 'human' &&
      p.operator !== null &&
      p.operator === actor.address
    );
  }

  private proposalRow(rev: string): DocProposal {
    const p = this.store().proposalRows({ rev })[0];
    if (p === undefined)
      throw new DocsError('not-found', `proposal ${rev} not found`, 'rev');
    return p;
  }

  // For the gate handler: the proposal row with no actor or visibility filter.
  proposalForGate(rev: string): DocProposal | null {
    return this.deps.store?.proposalRows({ rev })[0] ?? null;
  }

  proposals(
    actor: DocsActor,
    filter: { doc?: string; state?: ProposalState[] }
  ): DocProposal[] {
    const docId =
      filter.doc === undefined ? undefined : this.resolve(actor, filter.doc).id;
    return this.store()
      .proposalRows({ doc: docId, states: filter.state })
      .filter((p) => this.canSeeProposal(actor, p));
  }

  // A proposal's text, its diff against its base, and whether it merges onto the head.
  proposal(actor: DocsActor, rev: string): DocProposalView {
    const store = this.store();
    const p = store.proposalRows({ rev })[0];
    const doc = p === undefined ? null : store.doc(p.doc);
    if (
      p === undefined ||
      doc === null ||
      !this.canSee(actor, doc) ||
      !this.canSeeProposal(actor, p)
    )
      throw new DocsError('not-found', `proposal ${rev} not found`, 'rev');
    const prop = this.proposalRevision(p);
    const base = store.revision(prop.parents[0]);
    const head = this.headOf(doc);
    const clean = this.mergesCleanly(prop, base, head);
    return {
      proposal: p,
      title: prop.title,
      body: prop.body,
      chunks: diffChunks(base?.body ?? '', prop.body).chunks,
      mergeable: {
        clean,
        headN: head.n ?? 0,
        headRev: head.id,
        headHash: head.hash,
      },
      marked: clean ? null : this.markedMerge(prop, base, head),
    };
  }

  // What the merge view resolves for a conflicting proposal: diff3 of base,
  // head and proposal with markers; null when there is nothing to mark.
  private markedMerge(
    prop: RevisionRow,
    base: RevisionRow | null,
    head: RevisionRow
  ): string | null {
    if (base === null) return null;
    const merged = merge3(base.body, head.body, prop.body, {
      head: head.id,
      base: base.id,
      mine: prop.id,
    });
    return merged.clean ? null : merged.marked;
  }

  // One merge per (proposal body, head) pair, kept in a small LRU.
  private mergesCleanly(
    prop: RevisionRow,
    base: RevisionRow | null,
    head: RevisionRow
  ): boolean {
    if (base === null) return false;
    if (base.id === head.id) return true;
    const key = `${prop.id}:${prop.hash}:${head.id}`;
    const hit = this.mergeable.get(key);
    if (hit !== undefined) {
      this.mergeable.delete(key);
      this.mergeable.set(key, hit);
      return hit;
    }
    const merged = merge3(base.body, head.body, prop.body, {
      head: head.id,
      base: base.id,
      mine: prop.id,
    });
    const clean = merged.clean && docBodyProblem(merged.body) === null;
    this.mergeable.set(key, clean);
    if (this.mergeable.size > MERGEABLE_CACHE) {
      const oldest = this.mergeable.keys().next().value;
      if (oldest !== undefined) this.mergeable.delete(oldest);
    }
    return clean;
  }

  // Approves an open proposal: an `approve` revision with parents [head,
  // proposal] and body diff3(base, head, proposal). A conflict or an
  // over-limit result fails the proposal instead, with notices.
  approveProposal(
    revId: string,
    by: string,
    policy: { rung: number; authorizedBy: 'rung' | 'override' } | null
  ): { ok: true } | { ok: false; reason: string } {
    const store = this.store();
    const p = this.proposalRow(revId);
    if (p.state !== 'open')
      return { ok: false, reason: `the proposal is ${p.state}` };
    const doc = store.doc(p.doc);
    const fail = (reason: string): { ok: false; reason: string } => {
      this.write(() =>
        store.putProposal({
          ...p,
          state: 'failed',
          reason,
          decidedBy: by,
          decidedAt: this.nowIso(),
        })
      );
      this.tell(
        by === SYSTEM_ADDRESS ? this.deps.ownerRef : by,
        p.gate,
        `The doc edit could not be applied: ${reason}.`
      );
      this.tellRun(p, doc, `your proposal failed: ${reason}`);
      return { ok: false, reason };
    };
    if (doc === null) return fail('the doc was deleted');
    if (doc.status === 'archived') return fail('the doc was archived');
    const open = this.headOf(doc);
    if (!open.sealed) this.write(() => this.sealInTx(doc, open));
    const head = this.headOf(doc);
    const prop = store.revision(p.rev);
    // A held sync chain's base is below its first held revision (Team sync).
    const base = prop === null ? null : store.revision(p.base);
    if (prop === null || base === null)
      return fail('the proposal lost its base');
    let body = prop.body;
    if (head.id !== base.id) {
      const merged = merge3(base.body, head.body, prop.body, {
        head: head.id,
        base: base.id,
        mine: prop.id,
      });
      if (!merged.clean) return fail(`conflicts with rev ${head.n ?? 0}`);
      body = merged.body;
    }
    if (docBodyProblem(body) !== null)
      return fail('merged body over the limit');
    const at = this.nowIso();
    const approver = policy === null ? by : SYSTEM_ADDRESS;
    this.write(() => {
      if (p.origin.startsWith('sync:'))
        for (const id of this.heldChain(prop.id)) this.syncNumber(id);
      else {
        store.setRevisionN(prop.id, store.maxN(doc.id) + 1);
        store.sealRevision(prop.id);
      }
      const a = this.makeRevision(doc.id, {
        parents: [head.id, prop.id],
        title: prop.title,
        body,
        author: approver,
        cause: 'approve',
        summary: `approved: ${prop.summary}`,
        sealed: true,
        numbered: true,
        at,
        approval:
          policy === null
            ? { by }
            : { by: SYSTEM_ADDRESS, policy: { rung: policy.rung } },
      });
      store.insertRevision(a);
      this.setHead(doc, a, approver, at);
      this.reindex(doc, a);
      this.rebuildMentions(doc, a);
      store.putDoc(doc);
      store.putProposal({
        ...p,
        state: 'approved',
        decidedBy: by,
        decidedByPolicy: policy,
        result: a.id,
        decidedAt: at,
      });
      this.outbox.push({
        doc: doc.id,
        scope: doc.scope,
        kind: 'sealed',
        author: approver,
        rev: a.id,
        summary: a.summary,
      });
    });
    if (p.gate !== null && policy !== null)
      this.closeGateQuietly(p.gate, 'approved by policy');
    return { ok: true };
  }

  // The answer's body is the reason; the author's live run hears it. A held
  // sync change is rejected with a `reject` revision [head, tip] that keeps
  // this head's body, so it travels and removes the change for everyone.
  rejectProposal(revId: string, by: string, reason: string): void {
    const store = this.store();
    const p = this.proposalRow(revId);
    if (p.state !== 'open') return;
    const doc = store.doc(p.doc);
    this.write(() => {
      let result: string | null = null;
      if (doc !== null && p.origin.startsWith('sync:')) {
        this.sealInTx(doc, this.headOf(doc));
        const head = this.headOf(doc);
        const tip = store.revisionMeta(p.rev);
        for (const id of this.heldChain(p.rev)) this.syncNumber(id);
        const at = this.nowIso();
        const r = this.makeRevision(doc.id, {
          parents: [head.id, p.rev],
          title: head.title,
          body: head.body,
          author: by,
          cause: 'reject',
          summary: `rejected: ${tip?.summary ?? p.rev}`,
          sealed: true,
          numbered: true,
          at,
        });
        store.insertRevision(r);
        this.setHead(doc, r, by, at);
        this.reindex(doc, r);
        this.rebuildMentions(doc, r);
        store.putDoc(doc);
        this.outbox.push({
          doc: doc.id,
          scope: doc.scope,
          kind: 'sealed',
          author: by,
          rev: r.id,
          summary: r.summary,
        });
        result = r.id;
      }
      store.putProposal({
        ...p,
        state: 'rejected',
        reason,
        decidedBy: by,
        result,
        decidedAt: this.nowIso(),
      });
      if (doc !== null) this.proposalChanged(doc, p, by, 'rejected');
    });
    this.tellRun(p, doc, `your proposal was rejected by ${by}: ${reason}`);
  }

  // Queues a meta change for a proposal's state, so doc.changed refreshes open
  // pages and gate cards; the summary names the proposal, never its text.
  private proposalChanged(
    doc: DocRow,
    p: DocProposal,
    author: string,
    what: 'opened' | 'rejected' | 'expired'
  ): void {
    this.outbox.push({
      doc: doc.id,
      scope: doc.scope,
      kind: 'meta',
      author,
      rev: null,
      summary: `proposal ${p.rev} ${what}`,
    });
  }

  // Marks every open proposal of `doc` withdrawn, inside the caller's write.
  private withdrawInTx(doc: DocRow, reason: string, at: string): DocProposal[] {
    const store = this.store();
    const open = store.proposalRows({ doc: doc.id, states: ['open'] });
    for (const p of open)
      store.putProposal({ ...p, state: 'withdrawn', reason, decidedAt: at });
    return open;
  }

  // After the withdrawal committed: close each gate and tell each author's run.
  private afterWithdraw(
    withdrawn: readonly DocProposal[],
    doc: DocRow,
    reason: string
  ): void {
    for (const p of withdrawn) {
      if (p.gate !== null) this.closeGateQuietly(p.gate, reason);
      this.tellRun(p, doc, `your proposal was withdrawn: ${reason}`);
    }
  }

  // Expires open proposals older than proposalTtlDays: docs.db first, then the gate.
  private expireProposals(now: Date): void {
    const store = this.store();
    const cutoff = now.getTime() - this.cfg().proposalTtlDays * DAY_MS;
    for (const p of store.proposalRows({ states: ['open'] })) {
      if (Date.parse(p.createdAt) > cutoff) continue;
      const reason = 'proposal expired';
      const doc = store.doc(p.doc);
      this.write(() => {
        store.putProposal({
          ...p,
          state: 'expired',
          reason,
          decidedAt: now.toISOString(),
        });
        if (doc !== null)
          this.proposalChanged(doc, p, SYSTEM_ADDRESS, 'expired');
      });
      if (p.gate !== null) this.closeGateQuietly(p.gate, reason);
      this.tellRun(p, store.doc(p.doc), 'your proposal expired');
    }
  }

  // Raises a gate for an open proposal with none, and records it.
  async ensureGate(rev: string): Promise<string | null> {
    const store = this.deps.store;
    if (store === null) return null;
    const p = store.proposalRows({ rev })[0];
    if (p === undefined || p.state !== 'open') return null;
    if (p.gate !== null) return p.gate;
    let id: string;
    try {
      id = await this.host.raiseGate(p);
    } catch (err) {
      // The proposal stays open with no gate; boot reconcile retries.
      console.error(`docs: could not raise the gate for ${rev}`, err);
      return null;
    }
    const now = store.proposalRows({ rev })[0];
    if (now === undefined || now.state !== 'open') {
      this.closeGateQuietly(id, `this doc proposal is ${now?.state ?? 'gone'}`);
      return null;
    }
    // A concurrent call recorded its gate first; this one would never apply.
    if (now.gate !== null) {
      if (now.gate !== id)
        this.closeGateQuietly(id, 'this doc proposal is held by another gate');
      return now.gate;
    }
    this.write(() => store.putProposal({ ...now, gate: id }));
    return id;
  }

  // Clears the recorded gate and raises a fresh one that records its own id.
  async regate(rev: string): Promise<void> {
    const p = this.proposalRow(rev);
    if (p.state !== 'open') return;
    this.write(() => this.store().putProposal({ ...p, gate: null }));
    await this.ensureGate(rev);
  }

  // Boot, after messaging.recover(): raise gates for open proposals with none,
  // then close doc gates whose proposal is not open or records another gate.
  async reconcileGates(): Promise<{ raised: number; closed: number }> {
    const store = this.deps.store;
    if (store === null) return { raised: 0, closed: 0 };
    let raised = 0;
    let closed = 0;
    for (const p of store.proposalRows({ states: ['open'] })) {
      if (p.gate !== null) continue;
      if ((await this.ensureGate(p.rev)) !== null) raised++;
    }
    for (const g of this.host.openDocGates()) {
      const p = store.proposalRows({ rev: g.proposal })[0];
      if (p !== undefined && p.state === 'open' && p.gate === g.id) continue;
      const reason =
        p === undefined
          ? 'this doc proposal no longer exists'
          : `this doc proposal is ${p.state === 'open' ? 'held by another gate' : p.state}`;
      if (this.closeGateQuietly(g.id, reason)) closed++;
    }
    return { raised, closed };
  }

  // The ledger receipt of a policy approval; a failure never undoes the write.
  private recordPolicyApproval(
    rev: string,
    ruling: Extract<PolicyRuling, { mode: 'auto' }>
  ): void {
    try {
      this.host.recordPolicyApproval(this.proposalRow(rev), ruling);
    } catch (err) {
      console.error(
        `docs: could not record the policy approval of ${rev}`,
        err
      );
    }
  }

  private closeGateQuietly(gate: string, reason: string): boolean {
    try {
      return this.host.closeGate(gate, reason);
    } catch (err) {
      console.error(`docs: could not close gate ${gate}`, err);
      return false;
    }
  }

  // A system notice that can fail without failing the decision it reports.
  private tell(to: string, replyTo: string | null, body: string): void {
    try {
      this.host.notice(to, replyTo, body);
    } catch (err) {
      console.error('docs: notice failed', err);
    }
  }

  // One line to the proposal's author run, if it is still live; else dropped.
  private tellRun(p: DocProposal, doc: DocRow | null, text: string): void {
    if (p.runId === null) return;
    const handle = untrustedInline(doc?.handle ?? p.doc);
    const line = `📄 doc · ${handle}: ${untrustedInline(text)}`;
    try {
      this.host.notifyRun(
        p.runId,
        Array.from(line).slice(0, RUN_LINE_CHARS).join('')
      );
    } catch {
      // Not live, stopping, or an executor without mid-run input.
    }
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

  // Accept seals and reviews the head and clears a restored mark; leaving
  // accepted withdraws open proposals in docs.db, then closes their gates.
  setStatus(actor: DocsActor, ref: string, status: DocStatus): DocRecord {
    const doc = this.resolve(actor, ref);
    this.requireDecider(actor, doc, "change a doc's status");
    const restored = doc.restoredStatus !== null;
    if (status === doc.status && !(status === 'accepted' && restored))
      return this.record(doc);
    if (status === 'accepted') this.requireAcceptable(doc);
    const at = this.nowIso();
    let reason: string | null = null;
    if (status === 'archived') reason = 'the doc was archived';
    else if (status === 'draft') reason = REOPENED;
    const withdrawn: DocProposal[] = [];
    const out = this.write(() => {
      if (reason !== null)
        withdrawn.push(...this.withdrawInTx(doc, reason, at));
      this.applyStatus(actor, doc, status, at);
      if (status === 'accepted') this.acceptInTx(actor, doc, at);
      return this.record(doc);
    });
    if (reason !== null) this.afterWithdraw(withdrawn, doc, reason);
    return out;
  }

  // An accepted head is what every linked run reads: never one with unresolved conflicts.
  private requireAcceptable(doc: DocRow): void {
    if (doc.conflicted)
      throw new DocsError(
        'conflict',
        'the doc is conflicted; resolve it in the merge view before accepting',
        'status'
      );
    if (hasConflictMarkers(this.headOf(doc).body))
      throw new DocsError(
        'conflict',
        'the text holds conflict markers; resolve them before accepting',
        'status'
      );
  }

  // Reviews the (sealed) head as the accepting human and drops a restored mark.
  private acceptInTx(actor: DocsActor, doc: DocRow, at: string): void {
    const head = this.headOf(doc);
    this.store().addReview(doc.id, head.id, actor.address, at);
    doc.unreviewed = false;
    doc.reviewedRev = head.id;
    doc.restoredStatus = null;
    doc.restoredAt = null;
    this.store().putDoc(doc);
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
      // A human's review settles a sync problem too.
      this.store().deleteMeta(problemKey(doc.id));
      this.store().deleteMeta(syncProblemsKey(doc.id));
      this.refreshLinearHold(doc.id);
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

  // Withdraws open proposals and closes their gates while their rows still
  // exist, so a replayed answer finds nothing; then removes every row.
  remove(actor: DocsActor, ref: string): void {
    const doc = this.resolve(actor, ref);
    this.requireDecider(actor, doc, 'delete a doc');
    const at = this.nowIso();
    const reason = 'the doc was deleted';
    const withdrawn = this.write(() => this.withdrawInTx(doc, reason, at));
    this.afterWithdraw(withdrawn, doc, reason);
    this.write(() => {
      this.store().putTombstone({
        docId: doc.id,
        ns: doc.ns,
        slug: doc.handle,
        origin: doc.origin,
        deletedBy: actor.address,
        at,
        hlc: localClock(at),
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
    // Its images go once the rows are gone; a failure leaves files no row reaches.
    if (this.deps.assetsDir !== undefined) {
      try {
        removeAssetDir(this.deps.assetsDir, doc.id);
      } catch (err) {
        console.error(`docs: removing ${doc.id}'s images failed`, err);
      }
    }
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
    const out = this.createDoc(
      actor,
      { title: head.title, body: head.body, scope: 'team' },
      origin,
      head
    );
    try {
      this.copyAssets(doc, out.doc.id, head.body, actor.address);
    } catch (err) {
      // An image that cannot be copied takes the new draft back out.
      this.dropDoc(out.doc.id, actor.address);
      throw err;
    }
    return out;
  }

  // Removes a doc this call just made, rows and images, leaving no tombstone.
  private dropDoc(docId: string, by: string): void {
    const store = this.store();
    const doc = store.doc(docId);
    if (doc === null) return;
    this.write(() => {
      store.deleteDoc(docId);
      this.outbox.push({
        doc: docId,
        scope: doc.scope,
        kind: 'deleted',
        author: by,
        rev: null,
        summary: 'deleted',
      });
    });
    if (this.deps.assetsDir !== undefined)
      removeAssetDir(this.deps.assetsDir, docId);
  }

  // Copies the images `body` links from `from` to the doc `to`, row and file,
  // so a copy of its text shows them too.
  private copyAssets(from: DocRow, to: string, body: string, by: string): void {
    const root = this.deps.assetsDir;
    if (root === undefined) return;
    const store = this.store();
    for (const name of this.storedAssets(from, body)) {
      const row = store.assetRow(from.id, name);
      if (row === null) continue;
      const bytes = readAssetFile(root, from.id, name);
      storeAssetFile(root, to, name, bytes);
      this.write(() =>
        store.putAsset({
          ...row,
          doc: to,
          createdBy: by,
          createdAt: this.nowIso(),
        })
      );
    }
  }

  // Why an imported file must not be imported: an export of a personal doc
  // (its frontmatter says so, or its id names a personal doc, live or deleted),
  // or export-shaped frontmatter that does not parse. Null for any other file.
  private exportRefusal(text: string): string | null {
    const personal =
      'the file is an export of a personal doc, which is never imported';
    if (!text.startsWith('---\n')) return null;
    const end = text.indexOf('\n---\n', 3);
    const front = text.slice(4, end === -1 ? Math.min(text.length, 8192) : end);
    const idLine = /^id: "?(doc-[0-9A-Za-z]{26})"?$/m.exec(front);
    const parsed = parseDocFile(text);
    if ('error' in parsed)
      return idLine === null
        ? null
        : `the file looks like an exported doc but its frontmatter does not parse (${parsed.error})`;
    if (parsed.meta.scope === 'personal') return personal;
    const raw = idLine?.[1] ?? parsed.meta.id;
    if (!/^doc-[0-9A-Za-z]{26}$/i.test(raw)) return null;
    const id = `doc-${raw.slice(4).toUpperCase()}`;
    const store = this.store();
    if (store.doc(id)?.scope === 'personal') return personal;
    if (store.tombstone(id)?.ns.startsWith('p:') === true) return personal;
    return null;
  }

  // ---- Linear documents (v2) -----------------------------------------------

  // The actor a Linear change writes as: the mapped person's address, or
  // agent:linear, as a draft writer of team docs and never anyone's personal ones.
  private linearActor(author: string): DocsActor {
    return {
      principal: { address: author, canDecide: false, kind: 'human' },
      address: author,
      kind: 'human',
      decider: false,
      runKind: null,
      taskId: null,
      runTaskId: null,
      runId: null,
      operator: null,
      a2aRun: false,
    };
  }

  // The doc a Linear document syncs into, or null for none.
  linearDocFor(documentId: string): string | null {
    return this.store().linearDocByDocument(documentId)?.docId ?? null;
  }

  // Folds a Linear document into docs: a new one becomes a team draft linked
  // to its task, a later edit merges against the head (diff3 from the last
  // synced revision), and an accepted doc takes it as a proposal. Linear text
  // is never a Dispatch human's, so every revision it makes reads unreviewed.
  linearUpsert(
    incoming: { id: string; title: string; content: string; updatedAt: string },
    taskId: string | null,
    author: string
  ): 'created' | 'merged' | 'conflicted' | 'proposed' | 'unchanged' {
    const store = this.store();
    const origin = `linear:${incoming.id}`;
    const text = linearText(incoming.content);
    const state = store.linearDocByDocument(incoming.id);
    if (state === null) {
      if (store.tombstonedOrigin(origin)) return 'unchanged';
      const title = this.linearTitle(incoming.title);
      const made = this.createDoc(
        this.linearActor(author),
        {
          title,
          body: text.body,
          scope: 'team',
          links:
            taskId !== null && this.host.exists({ type: 'task', id: taskId })
              ? [{ target: { type: 'task', id: taskId }, rel: 'context' }]
              : [],
        },
        origin,
        undefined,
        'linear'
      );
      const doc = store.doc(made.doc.id);
      if (doc === null) throw new Error(`doc ${made.doc.id} vanished`);
      this.write(() => {
        this.sealInTx(doc, this.headOf(doc));
        // Markers typed in Linear make the doc conflicted, as a merge's would.
        if (hasConflictMarkers(text.body)) {
          store.setRevisionConflicted(doc.headId);
          doc.conflicted = true;
          store.putDoc(doc);
        }
        store.putLinearDoc({
          docId: doc.id,
          documentId: incoming.id,
          baseRev: doc.headId,
          remoteUpdatedAt: incoming.updatedAt,
          remoteBody: text.cut,
          remoteHash: text.hash,
        });
      });
      return 'created';
    }
    const doc = store.doc(state.docId);
    // Gone, personal (never synced) or archived: nothing to fold into.
    if (doc === null || doc.scope !== 'team' || doc.status === 'archived')
      return 'unchanged';
    if (state.remoteUpdatedAt === incoming.updatedAt) return 'unchanged';
    if (text.hash === this.linearRemoteHash(state)) {
      this.write(() =>
        store.putLinearDoc({ ...state, remoteUpdatedAt: incoming.updatedAt })
      );
      return 'unchanged';
    }
    const out = this.gated(doc)
      ? this.linearPropose(doc, state, text, author, origin, incoming)
      : this.linearMerge(doc, state, text, author, incoming.updatedAt);
    this.refreshLinearHold(doc.id);
    return out;
  }

  // A Linear title as a doc title: one line within the limit.
  private linearTitle(title: string): string {
    const line = cutUtf8(
      title.replace(/\s+/g, ' ').trim(),
      DOCS_LIMITS.titleBytes
    ).trim();
    return line !== '' ? line : 'Linear document';
  }

  // Linear's own last text, and its hash; rows from before both fall back to
  // the base revision's body.
  private linearRemote(state: LinearDocRow): string {
    return state.remoteBody ?? this.store().revision(state.baseRev)?.body ?? '';
  }

  private linearRemoteHash(state: LinearDocRow): string {
    return state.remoteHash ?? linearText(this.linearRemote(state)).hash;
  }

  // Merges incoming Linear text into an editable head: a clean result is a
  // sync revision, a conflict a conflicted head with markers, and a result over
  // the limits a conflicted head that keeps the local text with a note.
  private linearMerge(
    doc: DocRow,
    state: LinearDocRow,
    text: LinearText,
    author: string,
    remoteUpdatedAt: string
  ): 'merged' | 'conflicted' {
    const store = this.store();
    const at = this.nowIso();
    return this.write(() => {
      this.sealInTx(doc, this.headOf(doc));
      const head = this.headOf(doc);
      // The base is Linear's own last text, never a conflicted head's markers.
      const merged = merge3(this.linearRemote(state), head.body, text.body, {
        head: head.id,
        base: state.baseRev,
        mine: `linear:${state.documentId}`,
      });
      let body: string;
      let conflicted = false;
      if (merged.clean && docBodyProblem(merged.body) === null) {
        body = merged.body;
        // Markers typed in Linear itself conflict the doc too.
        conflicted = hasConflictMarkers(body);
      } else if (!merged.clean && docBodyProblem(merged.marked) === null) {
        body = merged.marked;
        conflicted = true;
      } else {
        body = `${head.body}${head.body.endsWith('\n') || head.body === '' ? '' : '\n'}[Linear's version of this doc is over the size limit and was not merged; see linear:${state.documentId}]\n`;
        conflicted = true;
      }
      const rev = this.makeRevision(doc.id, {
        parents: [head.id],
        title: head.title,
        body,
        author,
        cause: 'sync',
        summary: conflicted ? 'Linear edit, conflicted' : 'Linear edit',
        sealed: true,
        numbered: true,
        at,
        external: 'linear',
      });
      rev.conflicted = conflicted;
      store.insertRevision(rev);
      this.setHead(doc, rev, author, at);
      this.reindex(doc, rev);
      this.rebuildMentions(doc, rev);
      store.putDoc(doc);
      store.putLinearDoc({
        ...state,
        baseRev: rev.id,
        remoteUpdatedAt,
        remoteBody: text.cut,
        remoteHash: text.hash,
      });
      this.outbox.push({
        doc: doc.id,
        scope: doc.scope,
        kind: 'sealed',
        author,
        rev: rev.id,
        summary: rev.summary,
      });
      return conflicted ? 'conflicted' : 'merged';
    });
  }

  // A Linear edit to an accepted doc waits as a proposal against the last
  // synced revision, one per Linear document (amended in place), exempt from
  // the per-author limits: Linear's editors are not decide-tier humans.
  private linearPropose(
    doc: DocRow,
    state: LinearDocRow,
    text: LinearText,
    author: string,
    origin: string,
    incoming: { updatedAt: string }
  ): 'proposed' {
    const body = text.body;
    const store = this.store();
    const at = this.nowIso();
    const open = store
      .proposalRows({ doc: doc.id, states: ['open'] })
      .find((p) => p.origin === origin);
    let created: string | null = null;
    this.write(() => {
      if (open !== undefined) {
        store.amendRevision(open.rev, {
          title: doc.title,
          body,
          hash: sha256(body),
          bytes: utf8Bytes(body),
          summary: 'Linear edit',
          updatedAt: at,
        });
      } else {
        const rev = this.makeRevision(doc.id, {
          parents: [state.baseRev],
          title: doc.title,
          body,
          author,
          cause: 'proposal',
          summary: 'Linear edit',
          sealed: true,
          numbered: false,
          at,
          external: 'linear',
        });
        store.insertRevision(rev);
        store.putProposal({
          rev: rev.id,
          doc: doc.id,
          base: state.baseRev,
          author,
          operator: null,
          runId: null,
          taskId: null,
          origin,
          gate: null,
          state: 'open',
          decidedBy: null,
          decidedByPolicy: null,
          reason: null,
          result: null,
          createdAt: at,
          decidedAt: null,
        });
        created = rev.id;
      }
      // Linear holds this text now; pushes wait while the proposal is open.
      store.putLinearDoc({
        ...state,
        remoteUpdatedAt: incoming.updatedAt,
        remoteBody: text.cut,
        remoteHash: text.hash,
      });
      this.outbox.push({
        doc: doc.id,
        scope: doc.scope,
        kind: 'meta',
        author,
        rev: null,
        summary: 'Linear edit proposed',
      });
    });
    if (created !== null) void this.ensureGate(created);
    return 'proposed';
  }

  // A Linear-origin team doc's sealed head and its sync state, for a push;
  // null for any other doc (only docs that came from Linear push back).
  // `held` says the head must not go out yet (see linearHold).
  linearPushSource(docId: string): {
    state: LinearDocRow & { remoteHash: string };
    head: RevisionRow;
    held: boolean;
  } | null {
    const store = this.store();
    const state = store.linearDoc(docId);
    const doc = store.doc(docId);
    if (state === null || doc === null || doc.scope !== 'team') return null;
    if (doc.origin !== `linear:${state.documentId}`) return null;
    this.write(() => this.sealInTx(doc, this.headOf(doc)));
    const { held } = this.linearPending(doc, state);
    return {
      state: { ...state, remoteHash: this.linearRemoteHash(state) },
      head: this.headOf(doc),
      held: held !== null,
    };
  }

  // Why a Linear-origin head may not be pushed, or null: markers never go to
  // Linear, a cut copy would drop the rest of Linear's text, a Linear edit may
  // wait as a proposal, and unreviewed text (the review flag decides) waits for
  // a human's review.
  private linearHoldReason(doc: DocRow, state: LinearDocRow): string | null {
    const store = this.store();
    if (doc.status === 'archived') return 'the doc is archived';
    if (doc.conflicted) return 'the doc is conflicted; resolve it first';
    const remote = this.linearRemote(state);
    if (linearText(remote).hash !== this.linearRemoteHash(state))
      return "Linear's version is over the size limit, so ours would drop the rest";
    const origin = `linear:${state.documentId}`;
    if (
      store
        .proposalRows({ doc: doc.id, states: ['open'] })
        .some((p) => p.origin === origin)
    )
      return 'a Linear edit waits as a proposal for a decider';
    if (this.unreviewedAgentText(doc))
      return 'it carries agent text no human has reviewed; mark it reviewed to push';
    return null;
  }

  // Whether the head carries agent text no human reviewed: a walk from the
  // head back through every parent, stopping at reviewed revisions, finds an
  // agent's revision. Linear's text (via linear) and humans' are not agent
  // text. A walk that cannot finish falls back to the doc's review flag.
  private unreviewedAgentText(doc: DocRow): boolean {
    if (!doc.unreviewed) return false;
    const store = this.store();
    const seen = new Set<string>();
    const queue = [doc.headId];
    while (queue.length > 0) {
      const id = queue.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      if (seen.size > 2000) return true;
      if (id === doc.reviewedRev || store.hasReview(id)) continue;
      const rev = store.revisionMeta(id);
      if (rev === null) return true;
      if (!rev.author.startsWith('human:') && rev.via !== 'linear') return true;
      queue.push(...rev.parents);
    }
    return false;
  }

  // Whether a Linear-origin doc has local changes and what holds them, kept in
  // a `held:` note the doc and the Inbox show until the hold is released.
  private linearPending(
    doc: DocRow,
    state: LinearDocRow
  ): { pending: boolean; held: string | null } {
    const store = this.store();
    const head = store.revision(doc.headId);
    const pending =
      head !== null &&
      linearText(head.body).hash !== this.linearRemoteHash(state);
    const held = pending ? this.linearHoldReason(doc, state) : null;
    if (store.meta(heldKey(doc.id)) !== held)
      this.write(() => {
        if (held === null) store.deleteMeta(heldKey(doc.id));
        else store.setMeta(heldKey(doc.id), held);
      });
    return { pending, held };
  }

  // Refreshes the hold note of a doc that syncs with Linear; others are untouched.
  private refreshLinearHold(docId: string): void {
    const store = this.store();
    const state = store.linearDoc(docId);
    const doc = store.doc(docId);
    if (state === null || doc === null) return;
    this.linearPending(doc, state);
  }

  // Linear-origin team docs with local changes ready to push; none while docs are down.
  linearOutstanding(): string[] {
    if (!this.available) return [];
    const store = this.store();
    return store.linearDocs().flatMap((state) => {
      const doc = store.doc(state.docId);
      if (doc === null || doc.scope !== 'team') return [];
      if (doc.origin !== `linear:${state.documentId}`) return [];
      const { pending, held } = this.linearPending(doc, state);
      return pending && held === null ? [doc.id] : [];
    });
  }

  // After a push: Linear holds the pushed revision's text.
  linearPushed(
    docId: string,
    revId: string,
    body: string,
    remoteUpdatedAt: string
  ): void {
    const store = this.store();
    const state = store.linearDoc(docId);
    if (state === null) return;
    const text = linearText(body);
    this.write(() =>
      store.putLinearDoc({
        ...state,
        baseRev: revId,
        remoteUpdatedAt,
        remoteBody: text.cut,
        remoteHash: text.hash,
      })
    );
    this.refreshLinearHold(docId);
  }

  // A sync problem a human must see; it lists the doc as conflicted until a
  // human's save or review clears it.
  recordProblem(docId: string, detail: string): void {
    const store = this.store();
    const doc = store.doc(docId);
    if (doc === null) return;
    this.write(() => {
      store.setMeta(problemKey(docId), cutUtf8(detail, 500));
      this.outbox.push({
        doc: doc.id,
        scope: doc.scope,
        kind: 'meta',
        author: SYSTEM_ADDRESS,
        rev: null,
        summary: 'sync problem',
      });
    });
  }

  // What "Share to Linear" sends: a decide-tier human's live team doc linked to
  // a task. Refused before any Linear call otherwise.
  linearShareSource(
    actor: DocsActor,
    ref: string
  ): { docId: string; title: string; body: string; taskIds: string[] } {
    const doc = this.resolve(actor, ref);
    if (doc.scope !== 'team')
      throw forbidden('personal docs never go to Linear', 'doc');
    if (!actor.decider)
      throw forbidden('only a decide-tier human shares a doc to Linear', 'doc');
    if (doc.status === 'archived') throw archivedError();
    if (doc.status !== 'accepted' && doc.unreviewed)
      throw new DocsError(
        'conflict',
        'review it first: agent text no human checked never goes to Linear',
        'doc'
      );
    const store = this.store();
    if (
      store.linearDoc(doc.id) !== null ||
      doc.origin?.startsWith('linear:') === true
    )
      throw new DocsError('conflict', 'the doc is already in Linear', 'doc');
    // One share at a time per doc: a claim, stale after ten minutes, stands
    // until the share lands or fails.
    const claim = store.meta(shareClaimKey(doc.id));
    if (
      claim !== null &&
      this.host.now().getTime() - Date.parse(claim) < SHARE_CLAIM_MS
    )
      throw new DocsError(
        'conflict',
        'the doc is already being shared to Linear',
        'doc'
      );
    this.write(() => {
      store.setMeta(shareClaimKey(doc.id), this.nowIso());
      this.sealInTx(doc, this.headOf(doc));
    });
    const head = this.headOf(doc);
    // A link a mention made is not a choice of container; only manual links are.
    const taskIds = store
      .links({ docId: doc.id })
      .filter((l) => l.targetType === 'task' && l.source === 'manual')
      .map((l) => l.targetId);
    return { docId: doc.id, title: head.title, body: head.body, taskIds };
  }

  // A share Linear refused, or one refused before Linear: frees its claim.
  linearShareFailed(docId: string): void {
    const store = this.store();
    this.write(() => store.deleteMeta(shareClaimKey(docId)));
  }

  // After a share: the doc is Linear-origin, synced at its head.
  linearShared(
    docId: string,
    documentId: string,
    remoteUpdatedAt: string,
    sent: string
  ): void {
    const store = this.store();
    const doc = store.doc(docId);
    if (doc === null) return;
    const text = linearText(sent);
    this.write(() => {
      store.deleteMeta(shareClaimKey(docId));
      doc.origin = `linear:${documentId}`;
      store.putDoc(doc);
      store.putLinearDoc({
        docId,
        documentId,
        baseRev: doc.headId,
        remoteUpdatedAt,
        remoteBody: text.cut,
        remoteHash: text.hash,
      });
      this.outbox.push({
        doc: doc.id,
        scope: doc.scope,
        kind: 'meta',
        author: SYSTEM_ADDRESS,
        rev: null,
        summary: 'shared to Linear',
      });
    });
  }

  // ---- memory overflow (v1) -------------------------------------------------

  // The personal doc holding a memory entry's full text, owned by the entry's
  // human but written as the entry's author (an agent or run), so its text
  // reads unreviewed. One doc per entry (origin memory:<id>), kept current by
  // new sealed revisions; null when its doc was deleted or archived.
  // Memory calls it only for that human's own project-keyed personal entries.
  overflowFromMemory(input: {
    entryId: string;
    human: string;
    identity: string;
    author: string;
    title: string;
    body: string;
  }): string | null {
    const { entryId, human, identity, author } = input;
    if (!/^mem-[0-9A-Za-z]+$/.test(entryId))
      throw new DocsError('invalid', 'not a memory entry id', 'entryId');
    if (!human.startsWith('human:') || identity === '')
      throw new DocsError(
        'invalid',
        'overflow needs the entry’s human',
        'human'
      );
    if (!/^(?:agent|run|human):\S+$/.test(author))
      throw new DocsError(
        'invalid',
        'overflow needs the entry’s author',
        'author'
      );
    const store = this.store();
    const origin = `memory:${entryId}`;
    // A doc its owner deleted stays deleted.
    if (store.tombstonedOrigin(origin)) return null;
    // Writes as the author, owned by the human. A human-kind actor: the
    // owner's own notes are exempt from the agent create limit.
    const actor: DocsActor = {
      principal: { address: author, canDecide: false, kind: 'human' },
      address: author,
      kind: 'human',
      decider: false,
      runKind: null,
      taskId: null,
      runTaskId: null,
      runId: null,
      operator: { human, identity },
      a2aRun: false,
    };
    const ns = `p:${identity}`;
    const body = splitForCap(normalizeDocText(input.body))[0] ?? '';
    const oneLine = cutUtf8(
      input.title.replace(/\s+/g, ' ').trim(),
      DOCS_LIMITS.titleBytes
    ).trim();
    const title = oneLine !== '' ? oneLine : 'Memory note';
    const existing = store.docByOrigin(origin);
    let docId: string;
    if (existing === null) {
      docId = this.createDoc(
        actor,
        { title, body, scope: 'personal', links: [] },
        origin
      ).doc.id;
    } else {
      // An entry's doc is its own human's; it never moves to anyone else.
      if (
        existing.scope !== 'personal' ||
        existing.ns !== ns ||
        existing.ownerHuman !== human
      )
        throw forbidden('that memory entry’s doc belongs to someone else');
      // The owner archived it: not written, and not pointed at.
      if (existing.status === 'archived') return null;
      docId = existing.id;
      // A new revision, never an amend of anyone's open head.
      this.write(() => this.sealInTx(existing, this.headOf(existing)));
      this.commitDirect(actor, existing, {
        body,
        title,
        summary: `memory ${entryId} changed`,
        cause: 'save',
      });
    }
    const doc = store.doc(docId);
    if (doc !== null) this.write(() => this.sealInTx(doc, this.headOf(doc)));
    return docId;
  }

  // ---- images (v1) -----------------------------------------------------------

  private assetsRoot(): string {
    const dir = this.deps.assetsDir;
    if (dir === undefined)
      throw new DocsError('unavailable', 'images are not set up for docs');
    return dir;
  }

  // Whether the caller may upload an image to the doc at all, checked before
  // the route reads the body: a writer of a visible, live doc under its caps.
  assetUploadAllowed(actor: DocsActor, ref: string): void {
    const doc = this.resolve(actor, ref);
    this.requireWritable(actor, doc);
    this.assetsRoot();
    this.requireAssetRoom(doc, 0, null);
  }

  // Refuses one more image that would take the doc past its file or byte cap;
  // the same bytes again (`name` already stored) take no room.
  private requireAssetRoom(
    doc: DocRow,
    bytes: number,
    name: string | null
  ): void {
    const store = this.store();
    if (name !== null && store.assetRow(doc.id, name) !== null) return;
    const limits = this.deps.assetLimits ?? DEFAULT_ASSET_LIMITS;
    const used = store.assetUsage(doc.id);
    if (used.files + 1 > limits.files)
      throw new DocsError(
        'limited',
        `a doc stores at most ${limits.files} images`,
        'body'
      );
    if (used.bytes + bytes > limits.bytes)
      throw new DocsError(
        'limited',
        `a doc stores at most ${limits.bytes} bytes of images`,
        'body'
      );
    if (store.assetBytesTotal() + bytes > limits.projectBytes)
      throw new DocsError(
        'limited',
        `the project stores at most ${limits.projectBytes} bytes of images`,
        'body'
      );
  }

  // Stores an image a writer of the doc pasted, named by its hash and typed by
  // its bytes; the same bytes are the same asset.
  putAsset(
    actor: DocsActor,
    ref: string,
    bytes: Uint8Array
  ): { name: string; markdown: string } {
    const doc = this.resolve(actor, ref);
    this.requireWritable(actor, doc);
    if (bytes.byteLength === 0)
      throw new DocsError('invalid', 'the image is empty', 'body');
    if (bytes.byteLength > MAX_ASSET_BYTES)
      throw new DocsError('invalid', 'images are at most 25 MiB', 'body');
    const kind = sniffImage(bytes);
    if (kind === null)
      throw new DocsError(
        'invalid',
        'only png, jpeg, gif or webp images are stored (SVG is refused)',
        'body'
      );
    const name = `${sha256Bytes(bytes)}.${kind.ext}`;
    this.requireAssetRoom(doc, bytes.byteLength, name);
    const root = this.assetsRoot();
    storeAssetFile(root, doc.id, name, bytes);
    this.write(() =>
      this.store().putAsset({
        doc: doc.id,
        name,
        bytes: bytes.byteLength,
        mime: kind.mime,
        createdBy: actor.address,
        createdAt: this.nowIso(),
      })
    );
    return { name, markdown: `![](asset:${name})` };
  }

  // An image's bytes and type for the caller, read through readAssetFile
  // (no symlink, one hard link) after asset()'s checks.
  assetBytes(
    actor: DocsActor,
    ref: string,
    name: string
  ): { bytes: Uint8Array; mime: string } {
    const { mime } = this.asset(actor, ref, name);
    const doc = this.resolve(actor, ref);
    return { bytes: readAssetFile(this.assetsRoot(), doc.id, name), mime };
  }

  // An image of a doc the caller can see: the name is checked before any
  // lookup, then the doc, then its row; only then is the path built.
  asset(
    actor: DocsActor,
    ref: string,
    name: string
  ): { path: string; mime: string } {
    if (!ASSET_NAME.test(name))
      throw new DocsError('invalid', 'not an asset name', 'name');
    const doc = this.resolve(actor, ref);
    const row = this.store().assetRow(doc.id, name);
    if (row === null)
      throw new DocsError('not-found', `asset ${name} not found`, 'name');
    return {
      path: assetFilePath(this.assetsRoot(), doc.id, name),
      mime: row.mime,
    };
  }

  // Drops images 30 days old that no revision or proposal of their doc links:
  // the row first, then the file.
  private sweepAssets(now: Date): void {
    const root = this.deps.assetsDir;
    const store = this.deps.store;
    if (root === undefined || store === null) return;
    const anomaly = assetClockAnomaly(
      store.meta('assets:last'),
      store.newestAssetAt(),
      now
    );
    store.setMeta('assets:last', now.toISOString());
    // After a clock jump nothing is deleted until a full TTL of clock passes.
    if (anomaly !== null) {
      const until = new Date(now.getTime() + ASSET_TTL_DAYS * DAY_MS);
      store.setMeta('assets:hold-until', until.toISOString());
      console.error(
        `docs: image sweep held until ${until.toISOString()}: ${anomaly}`
      );
      return;
    }
    const hold = store.meta('assets:hold-until');
    if (hold !== null && now.toISOString() < hold) return;
    const cutoff = new Date(
      now.getTime() - ASSET_TTL_DAYS * DAY_MS
    ).toISOString();
    for (const a of store.assetsToCheck(cutoff)) {
      if (store.assetReferenced(a.doc, a.name)) {
        this.write(() =>
          store.markAssetChecked(a.doc, a.name, now.toISOString())
        );
        continue;
      }
      this.write(() => store.deleteAsset(a.doc, a.name));
      try {
        rmSync(assetFilePath(root, a.doc, a.name), { force: true });
      } catch (err) {
        if (!(err instanceof DocsError && err.code === 'not-found'))
          console.error(`docs: removing image ${a.name} failed`, err);
      }
    }
  }

  // The images `body` references that are stored for `doc`; none without an asset store.
  private storedAssets(doc: DocRow, body: string): string[] {
    if (this.deps.assetsDir === undefined) return [];
    const store = this.store();
    return assetNames(body).filter((n) => store.assetRow(doc.id, n) !== null);
  }

  // ---- publish to the repo (v1) --------------------------------------------

  // Seals the head and creates the elevated task that writes it to `path`: a
  // human asks, and a human merges, since elevated risk caps the merge rung.
  // A pending row goes down before the task, so a crash between them is found
  // at boot; the same doc, revision and path (or key) returns that publish.
  publish(
    actor: DocsActor,
    ref: string,
    input: {
      path: string;
      idempotencyKey?: string;
      dispatchAs?: { actor: string; operator: string | null };
    }
  ): { task: string; doc: DocRecord; existing: boolean } {
    const doc = this.resolve(actor, ref);
    if (actor.kind !== 'human') throw forbidden('humans publish docs', 'doc');
    if (doc.scope === 'personal')
      throw forbidden('personal docs are never published', 'doc');
    const store = this.store();
    const key = input.idempotencyKey;
    const keyed =
      key === undefined || key === ''
        ? undefined
        : store
            .publishRows({ doc: doc.id, idemKey: key })
            .find((r) => r.state !== 'pending');
    if (keyed !== undefined)
      return { task: keyed.task, doc: this.record(doc), existing: true };
    if (doc.status === 'archived') throw archivedError();
    if (doc.status !== 'accepted' && doc.unreviewed)
      throw new DocsError(
        'conflict',
        'review it first: agent text no human checked never heads for the repo',
        'doc'
      );
    const path = validatePublishPath(this.host.rootDir, input.path);
    const open = store.publishRows({ doc: doc.id, state: 'open' })[0];
    if (open !== undefined) {
      if (open.path === path && open.rev === doc.headId)
        return { task: open.task, doc: this.record(doc), existing: true };
      throw new DocsError(
        'conflict',
        `already publishing: ${open.task}`,
        'doc'
      );
    }
    this.write(() => this.sealInTx(doc, this.headOf(doc)));
    const head = this.headOf(doc);
    const n = head.n ?? 0;
    const pending: PublishRow = {
      task: `pending:${randomUUID()}`,
      doc: doc.id,
      rev: head.id,
      path,
      state: 'pending',
      commit: null,
      createdAt: this.nowIso(),
      reason: null,
      idemKey: key === '' ? null : (key ?? null),
      dispatchAs: input.dispatchAs ?? null,
    };
    this.write(() => store.putPublish(pending));
    const images = this.storedAssets(doc, head.body).length > 0;
    const task = this.host.createPublishTask({
      title: publishTitle(doc.handle, n, path),
      body: `Dispatch has written revision ${n} of doc ${doc.handle} to ${path} in this worktree${images ? `, with its images under ${publishAssetsDir(path)}/` : ''}. Format and lint it with the repository's own tools, fix only formatting, and commit it as "docs: publish ${doc.handle} rev ${n}". Do not rewrite its content.`,
      writes: images ? [path, `${publishAssetsDir(path)}/**`] : [path],
      risk: 'elevated',
    });
    const at = this.nowIso();
    this.write(() => {
      this.putLink(
        actor,
        doc,
        { type: 'task', id: task },
        'context',
        false,
        at
      );
      store.deletePublish(pending.task);
      store.putPublish({ ...pending, task, state: 'open', createdAt: at });
      this.outbox.push({
        doc: doc.id,
        scope: doc.scope,
        kind: 'meta',
        author: actor.address,
        rev: null,
        summary: `publishing to ${path}`,
      });
    });
    return { task, doc: this.record(doc), existing: false };
  }

  // Boot, before anything dispatches: a pending row is a publish a crash cut
  // short. The task it created, if any, closes; then the row goes.
  recoverPublishes(): void {
    if (!this.available) return;
    const store = this.store();
    const owned = new Set(store.publishRows({}).map((r) => r.task));
    for (const row of store.publishRows({ state: 'pending' })) {
      const doc = store.doc(row.doc);
      const n = store.revisionMeta(row.rev)?.n ?? 0;
      const orphans =
        doc === null
          ? []
          : this.host.findPublishTasks(publishTitle(doc.handle, n, row.path));
      for (const task of orphans) {
        if (owned.has(task)) continue;
        try {
          this.host.closePublishTask(
            task,
            'the daemon stopped before this publish was recorded; publish the doc again'
          );
        } catch (err) {
          console.error(`docs: closing publish task ${task} failed`, err);
        }
      }
      this.write(() => store.deletePublish(row.task));
    }
  }

  // Open publishes that asked for a run, with who it starts as; the boot
  // dispatches each one that has no run yet.
  publishesToDispatch(): {
    task: string;
    actor: string;
    operator: string | null;
  }[] {
    if (!this.available) return [];
    return this.store()
      .publishRows({ state: 'open' })
      .flatMap((r) =>
        r.dispatchAs === null || r.dispatchAs === undefined
          ? []
          : [{ task: r.task, ...r.dispatchAs }]
      );
  }

  // Whether `taskId` runs an open publish; with docs.db closed it cannot be
  // ruled out, so it fails closed (callers guard the task's risk on it).
  publishing(taskId: string): boolean {
    if (!this.available) return true;
    return this.store().publishRows({ task: taskId, state: 'open' }).length > 0;
  }

  // The text a publish writes at `path`: the revision with the links of the
  // images copied beside it pointed at their copies.
  private seededBody(
    path: string,
    body: string,
    copied: readonly string[]
  ): string {
    const stem = publishAssetsDir(path).split('/').at(-1) ?? '';
    const linked = new Set(copied);
    return rewriteAssetLinks(body, (n) =>
      linked.has(n) ? `${stem}/${n}` : `asset:${n}`
    );
  }

  // What a publish wrote into its run's worktree, to check a landing against;
  // null when its revision is gone.
  private seededText(row: PublishRow): string | null {
    const store = this.store();
    const rev = store.revision(row.rev);
    const doc = store.doc(row.doc);
    if (rev === null || doc === null) return null;
    return this.seededBody(
      row.path,
      rev.body,
      this.storedAssets(doc, rev.body)
    );
  }

  // A synced change tried to move an open publish's risk: the publish fails for
  // good (whatever the risk reads later) and its task closes.
  riskChangedDuringPublish(taskId: string): void {
    if (!this.available) return;
    const store = this.store();
    const row = store.publishRows({ task: taskId, state: 'open' })[0];
    if (row === undefined) return;
    const reason =
      "a teammate's synced change tried to move the task's risk while it published";
    this.write(() => store.putPublish({ ...row, state: 'failed', reason }));
    try {
      this.host.closePublishTask(taskId, reason);
    } catch (err) {
      console.error(`docs: closing publish task ${taskId} failed`, err);
    }
  }

  // Writes an open publish's recorded revision into its run's worktree; a no-op
  // for any other task. A throw fails the dispatch and marks the publish failed.
  seedFor(taskId: string, worktree: string): void {
    if (!this.available) return;
    const store = this.store();
    const row = store.publishRows({ task: taskId })[0];
    if (row === undefined) return;
    // A rerun of a publish that already ended would run with no seeded file.
    if (row.state !== 'open')
      throw new Error(
        `publish task ${taskId} is ${row.state}; publish the doc again`
      );
    try {
      // Lowering the risk would let policy merge it with no human.
      if (this.host.task(taskId)?.risk === 'routine')
        throw new Error(
          `publish task ${taskId}'s risk was lowered; publish the doc again`
        );
      const rev = store.revision(row.rev);
      if (rev === null)
        throw new Error(`publish ${taskId}: revision ${row.rev} is gone`);
      const doc = store.doc(row.doc);
      const copied = doc === null ? [] : this.storedAssets(doc, rev.body);
      for (const name of copied) {
        seedAsset(
          worktree,
          row.path,
          name,
          readAssetFile(this.assetsRoot(), row.doc, name)
        );
      }
      seedFile(worktree, row.path, this.seededBody(row.path, rev.body, copied));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.write(() => store.putPublish({ ...row, state: 'failed', reason }));
      try {
        this.host.closePublishTask(taskId, reason);
      } catch (closeErr) {
        console.error(`docs: closing publish task ${taskId} failed`, closeErr);
      }
      throw err;
    }
  }

  // Records each open publish whose task has landed or been dropped; returns
  // how many changed. A landing counts only as the host verifies it (a merged
  // run, not a status alone) and only while the task is still elevated.
  syncPublishes(): number {
    if (!this.available) return 0;
    const store = this.store();
    let changed = 0;
    for (const row of store.publishRows({ state: 'open' })) {
      const outcome = this.host.publishOutcome(
        row.task,
        row.path,
        this.seededText(row)
      );
      if (outcome === null) continue;
      if (outcome.state === 'dropped') {
        this.write(() => store.putPublish({ ...row, state: 'dropped' }));
        changed += 1;
        continue;
      }
      // A routine risk let policy merge it with no human: never recorded, and a
      // new publish may start.
      const reason =
        outcome.state === 'failed'
          ? outcome.reason
          : this.host.task(row.task)?.risk === 'routine'
            ? 'the task landed after its risk was lowered to routine, so no human merged it'
            : null;
      if (reason !== null) {
        this.write(() => store.putPublish({ ...row, state: 'failed', reason }));
        changed += 1;
        continue;
      }
      const commit = outcome.state === 'landed' ? outcome.commit : null;
      const doc = store.doc(row.doc);
      this.write(() => {
        store.putPublish({ ...row, state: 'landed', commit });
        if (doc === null) return;
        doc.publishedPath = row.path;
        doc.publishedRev = row.rev;
        doc.publishedTask = row.task;
        doc.publishedCommit = commit;
        store.putDoc(doc);
        this.outbox.push({
          doc: doc.id,
          scope: doc.scope,
          kind: 'meta',
          author: SYSTEM_ADDRESS,
          rev: null,
          summary: `published to ${row.path}`,
        });
      });
      changed += 1;
    }
    return changed;
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
      // An export or receipt file: its body, and never someone's personal doc.
      const refusal = this.exportRefusal(text);
      if (refusal !== null) {
        texts.set(hash, { error: 'invalid', detail: refusal });
        continue;
      }
      const exported = parseDocFile(text);
      if (!('error' in exported)) text = exported.body;
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
    for (const name of names) {
      if (name.contents.length === 0) continue;
      const docs: string[] = [];
      for (let k = 1; ; k++) {
        const part = store.docByOrigin(importOrigin(name.key, k));
        if (part === null) break;
        docs.push(part.id);
      }
      report.docs.push({ name: name.key, docs });
    }
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
        : this.revisionOf(doc, opts.rev, 'rev', actor);
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
    // Only a read that returns text counts or seals; recorded before the seal,
    // so no notice tells the run of the revision it read.
    if (actor.runId !== null)
      this.notices?.recordRead(actor.runId, doc.id, rev.id);
    this.sealIfOtherReads(actor, doc, rev);
    const store = this.store();
    const current = store.revisionMeta(rev.id) ?? rev;
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
      proposal: this.ownOpenProposal(actor, doc)?.rev ?? null,
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
  // The task's own team spec as one index line for review and verify prompts;
  // never a parent's or a personal spec. Null when there is none or docs fail.
  specLine(taskId: string): string | null {
    if (!this.available) return null;
    try {
      const own = this.taskDocs(this.overseerActor(), taskId).filter(
        (c) => c.depth === 0 && c.rel === 'spec' && c.row.scope === 'team'
      );
      const line = this.toIndexLines(own.slice(0, 1))[0];
      return line === undefined ? null : indexLineText(line);
    } catch {
      return null;
    }
  }

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
    const rev = this.revisionOf(doc, revRef, 'rev', actor);
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
    const a = this.revisionOf(doc, from, 'from', actor);
    const b = this.revisionOf(doc, to, 'to', actor);
    this.sealIfOtherReads(actor, doc, a);
    this.sealIfOtherReads(actor, doc, b);
    const { chunks, spent } = diffChunks(a.body, b.body);
    return { from: toInfo(a), to: toInfo(b), chunks, spent };
  }

  health(actor: DocsActor): DocsHealth {
    if (actor.kind !== 'human') throw forbidden('health is for humans');
    const warnings = this.deps.config().warnings.map((w) => w.message);
    const store = this.deps.store;
    // The orphan list names other projects' paths on this host, and the
    // restore report names files from the log: decide tier only.
    const restore = actor.decider ? this.lastRestore() : null;
    const decide = actor.decider
      ? {
          orphans: this.deps.orphans?.() ?? [],
          ...(restore === null ? {} : { restore }),
        }
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
    for (const key of store.metaKeys('sync-note:'))
      warnings.push(
        `team sync, ${key.slice('sync-note:'.length)}: ${store.meta(key) ?? ''}`
      );
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

  // ---- the receipt log ------------------------------------------------------

  // Whether this store holds `id` or deleted it, so its receipt file may go.
  knowsDoc(id: string): boolean {
    const store = this.store();
    return store.doc(id) !== null || store.tombstone(id) !== null;
  }

  // Every team doc with a sealed revision, for the receipt log; null while
  // docs are unavailable, so the log is left as it was.
  receiptsDocs(): ReceiptsDoc[] | null {
    const store = this.deps.store;
    if (store === null) return null;
    const { rows } = store.listDocs({
      ns: ['team'],
      statuses: DOC_STATUSES,
      limit: Number.MAX_SAFE_INTEGER,
      offset: 0,
    });
    const out: ReceiptsDoc[] = [];
    for (const row of rows.sort((a, b) => a.handle.localeCompare(b.handle))) {
      let head = store.revision(row.headId);
      while (head !== null && !head.sealed) {
        head = head.parents.length > 0 ? store.revision(head.parents[0]) : null;
      }
      if (head === null) continue;
      const links = store
        .links({ docId: row.id })
        .filter(
          (l) =>
            l.source === 'manual' &&
            (l.targetType !== 'doc' || store.doc(l.targetId)?.ns === 'team')
        )
        .map((l) => ({ target: `${l.targetType}:${l.targetId}`, rel: l.rel }));
      out.push({ row, head, authors: this.ancestryAuthors(head), links });
    }
    return out;
  }

  // Distinct authors of `head` and its ancestors, breadth first, at most 20.
  private ancestryAuthors(head: RevisionMeta): string[] {
    const store = this.store();
    const authors = new Set<string>();
    const seen = new Set<string>([head.id]);
    const queue: RevisionMeta[] = [head];
    for (let i = 0; i < queue.length; i++) {
      if (authors.size >= RECEIPT_AUTHORS) break;
      authors.add(queue[i].author);
      for (const parent of queue[i].parents) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        const meta = store.revisionMeta(parent);
        if (meta !== null) queue.push(meta);
      }
    }
    return [...authors].sort();
  }

  // A receipt file as a new team doc: one sealed, provisional `restore`
  // revision keeping its ids, never trusted as reviewed or accepted.
  restoreDoc(meta: DocFileMeta, body: string): 'restored' | 'skipped' {
    const store = this.store();
    if (this.knowsDoc(meta.id)) return 'skipped';
    if (store.revisionMeta(meta.rev) !== null) {
      throw new DocsError(
        'conflict',
        `revision ${meta.rev} is already held by another doc`,
        'rev'
      );
    }
    const at = this.nowIso();
    const handle = this.pickSlug('team', undefined, meta.slug);
    const title = meta.title.trim();
    const rev: RevisionRow = {
      id: meta.rev,
      docId: meta.id,
      n: Math.max(1, meta.n),
      parents: meta.parents,
      restoredParents: null,
      title,
      body,
      hash: sha256(body),
      bytes: utf8Bytes(body),
      author: meta.author,
      cause: 'restore',
      summary: 'restored from the receipt log',
      approval: null,
      conflicted: false,
      sealed: true,
      unreviewed: unreviewedAtCreation({
        author: meta.author,
        cause: 'restore',
        approval: null,
        unverifiedVia: false,
        parents: [],
      }),
      provisional: true,
      via: null,
      createdAt: meta.createdAt,
      updatedAt: meta.createdAt,
    };
    const doc: DocRow = {
      id: meta.id,
      ns: 'team',
      slug: handle,
      handle,
      title,
      scope: 'team',
      ownerIdentity: null,
      ownerHuman: null,
      status: meta.status === 'archived' ? 'archived' : 'draft',
      archivedFrom: meta.status === 'archived' ? 'draft' : null,
      restoredStatus: meta.status === 'accepted' ? 'accepted' : null,
      restoredAt: meta.status === 'accepted' ? at : null,
      headId: '',
      reviewedRev: null,
      unreviewed: false,
      conflicted: false,
      origin: null,
      publishedPath: null,
      publishedRev: null,
      publishedTask: null,
      publishedCommit: null,
      createdBy: meta.author,
      createdAt: at,
      updatedBy: meta.author,
      updatedAt: at,
      indexedHash: null,
    };
    this.write(() => {
      store.insertRevision(rev);
      this.setHead(doc, rev, meta.author, at);
      store.putDoc(doc);
      this.reindex(doc, rev);
      this.rebuildMentions(doc, rev);
      store.putDoc(doc);
      this.outbox.push({
        doc: doc.id,
        scope: 'team',
        kind: 'created',
        author: meta.author,
        rev: rev.id,
        summary: 'restored',
      });
    });
    return 'restored';
  }

  // Keeps the last boot restore's report for the health route.
  recordRestore(report: RestoreReport): void {
    this.deps.store?.setMeta('restore:last', JSON.stringify(report));
  }

  private lastRestore(): RestoreReport | null {
    const raw = this.deps.store?.meta('restore:last') ?? null;
    return raw === null ? null : (JSON.parse(raw) as RestoreReport);
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
    this.expireProposals(now);
    this.sweepAssets(now);
    const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
    for (const id of store.idleImportSessions(dayAgo))
      store.deleteImportSession(id);
    store.setMeta('sweep:last', now.toISOString());
    return { sealed, reindexed };
  }

  // ---- team sync (v2) -------------------------------------------------------
  // Primitives the federation `doc` handler (ELv2, team/federation/docs.ts)
  // writes through; it owns the rules, these own docs.db.

  /** Binds the team sync handler, or unbinds it with null. */
  bindSync(port: SyncRepairPort | null): void {
    this.syncPort = port;
  }

  /** Asks teammates' logs again for revisions retention dropped here. */
  syncRepair(actor: DocsActor, ref?: string): { reread: number } {
    if (!actor.decider)
      throw forbidden('only a decide-tier human repairs team sync');
    const docId = ref === undefined ? undefined : this.resolve(actor, ref).id;
    if (this.syncPort === null)
      throw new DocsError('conflict', 'team sync is not on');
    return this.syncPort.repair(docId);
  }

  /** The doc's team sync problems, oldest first. */
  syncProblems(docId: string): string[] {
    const raw = this.store().meta(syncProblemsKey(docId));
    return raw === null ? [] : (JSON.parse(raw) as string[]);
  }

  /** Runs `fn` as one docs.db write, then what it queued for after. */
  syncWrite<T>(fn: () => T): T {
    const out = this.write(fn);
    for (const after of this.syncAfter.splice(0)) {
      try {
        after();
      } catch (err) {
        console.error('docs: a team sync follow-up failed', err);
      }
    }
    return out;
  }

  syncDoc(id: string): DocRow | null {
    return this.store().doc(id);
  }

  /** A tombstone with its clock; one from before clocks reads as its wall time. */
  syncTombstone(id: string): { hlc: string; at: string } | null {
    const t = this.store().tombstoneFull(id);
    return t === null ? null : { at: t.at, hlc: t.hlc ?? localClock(t.at) };
  }

  syncRevision(id: string): RevisionRow | null {
    return this.store().revision(id);
  }

  syncRevisions(docId: string): RevisionMeta[] {
    return this.store().revisionsOfDoc(docId);
  }

  // Grounded: stored, confirmed, and every parent grounded (Team sync).
  syncGrounded(revId: string, memo = new Map<string, boolean>()): boolean {
    const store = this.store();
    const stack = [revId];
    while (stack.length > 0) {
      const id = stack[stack.length - 1];
      if (memo.has(id)) {
        stack.pop();
        continue;
      }
      const meta = store.revisionMeta(id);
      if (meta === null || meta.provisional) {
        memo.set(id, false);
        stack.pop();
        continue;
      }
      const open = meta.parents.filter((p) => !memo.has(p));
      if (open.length > 0) {
        stack.push(...open);
        continue;
      }
      memo.set(
        id,
        meta.parents.every((p) => memo.get(p) === true)
      );
      stack.pop();
    }
    return memo.get(revId) === true;
  }

  /** A team doc a teammate's root revision brings; its head is set after. */
  syncCreateDoc(input: {
    id: string;
    slug: string;
    title: string;
    by: string;
    at: string;
  }): DocRow {
    const store = this.store();
    store.deleteTombstone(input.id);
    const doc: DocRow = {
      id: input.id,
      ns: 'team',
      slug: input.slug,
      handle: `~sync-${input.id}`,
      title: input.title,
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
      origin: null,
      publishedPath: null,
      publishedRev: null,
      publishedTask: null,
      publishedCommit: null,
      createdBy: input.by,
      createdAt: input.at,
      updatedBy: input.by,
      updatedAt: input.at,
      indexedHash: null,
    };
    store.putDoc(doc);
    this.outbox.push({
      doc: doc.id,
      scope: 'team',
      kind: 'created',
      author: input.by,
      rev: null,
      summary: 'created by a teammate',
    });
    return doc;
  }

  /** Stores a teammate's revision, its flag computed as a local one is. */
  syncInsertRevision(input: SyncedRevision): RevisionRow {
    const store = this.store();
    const rev: RevisionRow = {
      id: input.id,
      docId: input.docId,
      n: input.numbered ? store.maxN(input.docId) + 1 : null,
      parents: input.parents,
      restoredParents: input.restoredParents,
      title: input.title,
      body: input.body,
      hash: input.hash,
      bytes: utf8Bytes(input.body),
      author: input.author,
      cause: input.cause,
      summary: cutUtf8(input.summary, DOCS_LIMITS.summaryBytes),
      approval: input.approval,
      conflicted: input.conflicted,
      sealed: true,
      unreviewed: this.syncUnreviewed(input),
      provisional: false,
      via: input.via,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    store.insertRevision(rev);
    store.deleteSyncMissing(rev.id);
    return rev;
  }

  private syncUnreviewed(input: SyncedRevision): boolean {
    const store = this.store();
    const state = (id: string) => {
      const meta = store.revisionMeta(id);
      return meta === null
        ? { unreviewed: false, reviewed: false }
        : { unreviewed: meta.unreviewed, reviewed: store.hasReview(id) };
    };
    return (
      input.taint ||
      unreviewedAtCreation({
        author: input.author,
        cause: input.cause,
        approval: input.approval,
        unverifiedVia: input.via !== null,
        parents: input.parents.map(state),
      })
    );
  }

  /** A provisional revision confirmed by the signed one: whether the bodies differed. */
  syncConfirmProvisional(input: SyncedRevision): boolean {
    const store = this.store();
    const held = store.revision(input.id);
    if (held === null) return false;
    store.replaceRevision({
      ...held,
      parents: input.parents,
      restoredParents: null,
      title: input.title,
      body: input.body,
      hash: input.hash,
      bytes: utf8Bytes(input.body),
      author: input.author,
      cause: input.cause,
      summary: cutUtf8(input.summary, DOCS_LIMITS.summaryBytes),
      approval: input.approval,
      unreviewed: this.syncUnreviewed(input),
      provisional: false,
      via: input.via,
      createdAt: input.createdAt,
    });
    store.deleteSyncMissing(input.id);
    const doc = store.doc(held.docId);
    if (doc !== null && doc.headId === held.id) {
      const fresh = this.headOf(doc);
      this.setHead(doc, fresh, input.author, this.nowIso());
      this.reindex(doc, fresh);
      this.rebuildMentions(doc, fresh);
      store.putDoc(doc);
    }
    return held.hash !== input.hash;
  }

  /** Gives a revision held out of history its place in it. */
  syncNumber(revId: string): void {
    const store = this.store();
    const meta = store.revisionMeta(revId);
    if (meta === null || meta.n !== null) return;
    store.setRevisionN(revId, store.maxN(meta.docId) + 1);
    store.sealRevision(revId);
  }

  /** Seals a doc's open head, so a fold may read it and it may travel. */
  syncSealOpenHead(docId: string): void {
    const doc = this.store().doc(docId);
    if (doc === null || doc.headId === '') return;
    const head = this.store().revisionMeta(doc.headId);
    if (head !== null && !head.sealed) this.sealInTx(doc, head);
  }

  /** Points a doc at a new head, rebuilding what a sealed head derives. */
  syncSetHead(docId: string, revId: string): void {
    const store = this.store();
    const doc = store.doc(docId);
    const rev = store.revision(revId);
    if (doc === null || rev === null || doc.headId === revId) return;
    const at = this.nowIso();
    this.setHead(doc, rev, rev.author, at);
    this.reindex(doc, rev);
    this.rebuildMentions(doc, rev);
    store.putDoc(doc);
    this.outbox.push({
      doc: doc.id,
      scope: doc.scope,
      kind: 'sealed',
      author: rev.author,
      rev: rev.id,
      summary: rev.summary,
    });
  }

  /** A doc's synced meta as this replica holds it. */
  syncMetaOf(docId: string): SyncMeta | null {
    const store = this.store();
    const doc = store.doc(docId);
    if (doc === null) return null;
    return {
      slug: doc.slug,
      aliases: store.aliasesOf(docId),
      status: doc.status,
      links: store
        .links({ docId })
        .filter((l) => l.source === 'manual')
        .map((l) => ({
          target: { type: l.targetType, id: l.targetId },
          rel: l.rel,
        })),
    };
  }

  syncMetaClocks(docId: string): Record<string, string> {
    return this.store().metaClocks(docId);
  }

  syncSetMetaClocks(docId: string, clocks: Record<string, string>): void {
    this.store().setMetaClocks(docId, clocks);
  }

  /** Applies meta fields a teammate's op won, as its `by`. */
  syncApplyMeta(docId: string, fields: Partial<SyncMeta>, by: string): void {
    const store = this.store();
    const doc = store.doc(docId);
    if (doc === null) return;
    const at = this.nowIso();
    if (fields.slug !== undefined && fields.slug !== doc.slug) {
      doc.slug = fields.slug;
      store.putDoc(doc);
    }
    for (const alias of fields.aliases ?? [])
      if (alias !== doc.slug) store.addAlias(doc.ns, alias, doc.id, at);
    if (fields.links !== undefined) {
      const keep = new Set(
        fields.links.map((l) => `${l.target.type}:${l.target.id}`)
      );
      for (const l of store.links({ docId }))
        if (l.source === 'manual' && !keep.has(`${l.targetType}:${l.targetId}`))
          store.removeLink(docId, l.targetType, l.targetId);
      for (const l of fields.links)
        store.addLink({
          docId,
          docNs: doc.ns,
          targetType: l.target.type,
          targetId: l.target.id,
          rel: l.rel,
          source: 'manual',
          createdBy: by,
          createdAt: at,
        });
    }
    if (fields.status !== undefined && fields.status !== doc.status) {
      const leaving = doc.status === 'accepted';
      this.sealInTx(doc, this.headOf(doc));
      if (fields.status === 'archived') {
        doc.archivedFrom = doc.status === 'accepted' ? 'accepted' : 'draft';
        doc.status = 'archived';
      } else {
        doc.status = fields.status;
        doc.archivedFrom = null;
      }
      if (fields.status === 'accepted') {
        doc.restoredStatus = null;
        doc.restoredAt = null;
      }
      if (leaving) {
        const reason =
          fields.status === 'archived' ? 'the doc was archived' : REOPENED;
        const withdrawn = store
          .proposalRows({ doc: docId, states: ['open'] })
          .filter((p) => !p.origin.startsWith('sync:'));
        for (const p of withdrawn)
          store.putProposal({
            ...p,
            state: 'withdrawn',
            reason,
            decidedAt: at,
          });
        this.syncAfter.push(() => this.afterWithdraw(withdrawn, doc, reason));
      }
    }
    doc.updatedBy = by;
    doc.updatedAt = at;
    store.putDoc(doc);
    this.outbox.push({
      doc: doc.id,
      scope: doc.scope,
      kind: 'meta',
      author: by,
      rev: null,
      summary: 'changed by a teammate',
    });
  }

  /** Every team doc's claimed slug, for handles. */
  syncClaims(): { id: string; slug: string; aliases: string[] }[] {
    return this.store().teamClaims();
  }

  /** Sets handles in two steps, so no swap trips the uniqueness rule. */
  syncSetHandles(handles: ReadonlyMap<string, string>): void {
    const store = this.store();
    const changed = [...handles].filter(
      ([id, handle]) => store.doc(id)?.handle !== handle
    );
    for (const [id] of changed) store.setHandle(id, `~sync-${id}`);
    for (const [id, handle] of changed) store.setHandle(id, handle);
  }

  /** A human's review of a revision, from a teammate's replica. */
  syncReview(docId: string, revId: string, by: string): void {
    const store = this.store();
    const doc = store.doc(docId);
    if (doc === null) return;
    store.addReview(docId, revId, by, this.nowIso());
    if (doc.headId === revId) {
      doc.unreviewed = false;
      doc.reviewedRev = revId;
      store.putDoc(doc);
    }
  }

  /** A teammate's removal: the doc's rows go and a tombstone keeps its clock. */
  syncRemove(docId: string, by: string, hlc: string): void {
    const store = this.store();
    const doc = store.doc(docId);
    const at = this.nowIso();
    if (doc === null) {
      if (store.tombstoneFull(docId) === null)
        store.putTombstone({
          docId,
          ns: 'team',
          slug: '',
          origin: null,
          deletedBy: by,
          at,
          hlc,
        });
      return;
    }
    const reason = 'the doc was deleted';
    const withdrawn = store.proposalRows({ doc: docId, states: ['open'] });
    for (const p of withdrawn)
      store.putProposal({ ...p, state: 'withdrawn', reason, decidedAt: at });
    this.syncAfter.push(() => this.afterWithdraw(withdrawn, doc, reason));
    store.putTombstone({
      docId,
      ns: doc.ns,
      slug: doc.handle,
      origin: doc.origin,
      deletedBy: by,
      at,
      hlc,
    });
    store.deleteDoc(docId);
    this.outbox.push({
      doc: docId,
      scope: doc.scope,
      kind: 'deleted',
      author: by,
      rev: null,
      summary: 'deleted by a teammate',
    });
  }

  /** Records a team sync problem on the doc; the newest 20 are kept. */
  syncProblem(docId: string, detail: string): void {
    const store = this.store();
    const list = [...this.syncProblems(docId), cutUtf8(detail, 500)].slice(
      -SYNC_PROBLEMS_KEPT
    );
    store.setMeta(syncProblemsKey(docId), JSON.stringify(list));
    const doc = store.doc(docId);
    if (doc !== null)
      this.outbox.push({
        doc: docId,
        scope: doc.scope,
        kind: 'meta',
        author: SYSTEM_ADDRESS,
        rev: null,
        summary: 'sync problem',
      });
  }

  /** The held-back revisions of a doc: every open sync proposal's chain. */
  syncHeld(docId: string): Set<string> {
    const store = this.store();
    const held = new Set<string>();
    for (const p of store.proposalRows({ doc: docId, states: ['open'] })) {
      if (!p.origin.startsWith('sync:')) continue;
      for (const id of this.heldChain(p.rev)) held.add(id);
    }
    return held;
  }

  // A held tip and the held revisions below it: unnumbered, parents first.
  private heldChain(tip: string): string[] {
    const store = this.store();
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const meta = store.revisionMeta(id);
      if (meta === null || meta.n !== null) return;
      for (const p of meta.parents) visit(p);
      out.push(id);
    };
    visit(tip);
    return out;
  }

  /** Holds a teammate's revision out of the head as (or onto) one open sync proposal. */
  syncHold(input: {
    docId: string;
    tip: string;
    replica: string;
    task: string | null;
  }): void {
    const store = this.store();
    const doc = store.doc(input.docId);
    const tip = store.revisionMeta(input.tip);
    if (doc === null || tip === null) return;
    const at = this.nowIso();
    const open = store
      .proposalRows({ doc: doc.id, states: ['open'] })
      .filter((p) => p.origin.startsWith('sync:'));
    const chain = this.heldChain(tip.id);
    // A later held revision on an open proposal's tip takes its place.
    const extended = open.find(
      (p) => chain.includes(p.rev) && p.rev !== tip.id
    );
    if (extended !== undefined) {
      store.putProposal({
        ...extended,
        state: 'withdrawn',
        reason: 'a later held change replaced it',
        decidedAt: at,
      });
      if (extended.gate !== null) {
        const gate = extended.gate;
        this.syncAfter.push(() =>
          this.closeGateQuietly(gate, 'a later held change replaced it')
        );
      }
    }
    let base = chain[0];
    for (
      let meta = store.revisionMeta(base);
      meta !== null && meta.n === null;
    ) {
      base = meta.parents[0] ?? base;
      const next = store.revisionMeta(base);
      if (next === null || next.n !== null) break;
      meta = next;
    }
    const p: DocProposal = {
      rev: tip.id,
      doc: doc.id,
      base,
      author: tip.author,
      operator: null,
      runId: null,
      taskId: input.task,
      origin: `sync:${input.replica}`,
      gate: null,
      state: 'open',
      decidedBy: null,
      decidedByPolicy: null,
      reason: null,
      result: null,
      createdAt: at,
      decidedAt: null,
    };
    store.putProposal(p);
    this.proposalChanged(doc, p, tip.author, 'opened');
    this.syncAfter.push(() => this.gateSyncProposal(p));
  }

  /** This replica's doc policy for a teammate's change: a task unknown here,
   *  or none, rules as elevated (FW-R38(2)). */
  syncPolicyAllows(taskId: string | null): boolean {
    return this.syncRuling(taskId).mode === 'auto';
  }

  private syncRuling(taskId: string | null): PolicyRuling {
    const task = taskId === null ? null : this.host.task(taskId);
    return this.host.rule(task?.risk ?? 'elevated');
  }

  // Gated here as a local proposal is: this replica's policy may approve it.
  private gateSyncProposal(p: DocProposal): void {
    const ruling = this.syncRuling(p.taskId);
    if (ruling.mode === 'auto') {
      const out = this.approveProposal(p.rev, SYSTEM_ADDRESS, {
        rung: ruling.rung,
        authorizedBy: ruling.authorizedBy,
      });
      if (out.ok) {
        this.recordPolicyApproval(p.rev, ruling);
        return;
      }
    }
    void this.ensureGate(p.rev);
  }

  /** Lets held revisions join the history: a decision elsewhere covered them,
   *  or the doc is no longer accepted here. */
  syncRelease(docId: string, reason: string): void {
    const store = this.store();
    const at = this.nowIso();
    for (const p of store.proposalRows({ doc: docId, states: ['open'] })) {
      if (!p.origin.startsWith('sync:')) continue;
      for (const id of this.heldChain(p.rev)) this.syncNumber(id);
      store.putProposal({ ...p, state: 'withdrawn', reason, decidedAt: at });
      if (p.gate !== null) {
        const gate = p.gate;
        this.syncAfter.push(() => this.closeGateQuietly(gate, reason));
      }
    }
  }

  /** A rolling note about one teammate's replica, shown with docs health. */
  syncNote(replica: string, note: string | null): void {
    const key = `sync-note:${replica}`;
    if (note === null) this.store().deleteMeta(key);
    else this.store().setMeta(key, cutUtf8(note, 500));
  }

  /** New docs `replica` brought this clock hour, counting one more when `add`. */
  syncNewDocs(replica: string, add: boolean): number {
    const store = this.store();
    const key = `sync:new:${replica}:${this.nowIso().slice(0, 13)}`;
    const n = Number(store.meta(key) ?? '0') + (add ? 1 : 0);
    if (add) store.setMeta(key, String(n));
    return n;
  }

  /** Open held proposals from `replica`. */
  syncHeldFrom(replica: string): number {
    return this.store()
      .proposalRows({ states: ['open'] })
      .filter((p) => p.origin === `sync:${replica}`).length;
  }

  /** Docs whose heads wait for the end-of-pass fold. */
  syncFoldDue(): string[] {
    return this.store()
      .metaKeys('sync:fold:')
      .map((k) => k.slice('sync:fold:'.length));
  }

  syncSetFoldDue(docId: string, due: boolean): void {
    if (due) this.store().setMeta(`sync:fold:${docId}`, '1');
    else this.store().deleteMeta(`sync:fold:${docId}`);
  }

  /** Marks revisions a teammate published as known there. */
  syncMarkKnown(key: SyncKnown): void {
    this.store().setMeta(syncKnownKey(key), '1');
  }

  syncKnown(key: SyncKnown): boolean {
    return this.store().meta(syncKnownKey(key)) !== null;
  }

  /** The meta last published for a doc (null before its first op). */
  syncSnapshot(docId: string): SyncMeta | null {
    const raw = this.store().meta(`sync:meta:${docId}`);
    return raw === null ? null : (JSON.parse(raw) as SyncMeta);
  }

  syncSetSnapshot(docId: string, fields: Partial<SyncMeta>): void {
    const base = this.syncSnapshot(docId) ?? {
      slug: '',
      aliases: [],
      status: 'draft',
      links: [],
    };
    this.store().setMeta(
      `sync:meta:${docId}`,
      JSON.stringify({ ...base, ...fields })
    );
  }

  recordSyncMissing(row: {
    revId: string;
    docId: string;
    replica: string;
    seq: number;
  }): void {
    this.store().addSyncMissing({ ...row, droppedAt: this.nowIso() });
  }

  syncMissingRows(filter: { docId?: string; revId?: string } = {}): {
    revId: string;
    docId: string;
    replica: string;
    seq: number;
    droppedAt: string;
  }[] {
    return this.store().syncMissing(filter);
  }

  /** What travels this pass: confirmed revisions parents first, then meta
   *  changes, reviews and removals of team docs (Team sync). */
  pendingSync(): DocBody[] {
    if (!this.available) return [];
    const store = this.store();
    const out: DocBody[] = [];
    const memo = new Map<string, boolean>();
    for (const docId of this.syncDirty()) {
      const bodies = this.pendingFor(docId, memo);
      // Clean: off the list until a write touches it again.
      if (bodies.length === 0) store.deleteMeta(syncDirtyKey(docId));
      out.push(...bodies);
    }
    return out;
  }

  // One doc's unpublished revisions (parents first), meta changes, reviews
  // and, once deleted, its removal.
  private pendingFor(docId: string, memo: Map<string, boolean>): DocBody[] {
    const store = this.store();
    const out: DocBody[] = [];
    const doc = store.doc(docId);
    if (doc === null) {
      const t = store.tombstoneFull(docId);
      if (
        t !== null &&
        t.ns === 'team' &&
        this.syncSnapshot(docId) !== null &&
        !this.syncKnown({ kind: 'remove', doc: docId })
      )
        out.push({
          doc: docId,
          kind: 'remove',
          by: t.deletedBy,
        });
      return out;
    }
    if (doc.ns !== 'team') return out;
    let first = this.syncSnapshot(doc.id) === null;
    for (const meta of store.unpublishedTeamRevisions(doc.id)) {
      if (!this.syncGrounded(meta.id, memo)) continue;
      const rev = store.revision(meta.id);
      if (rev === null) continue;
      const task =
        rev.cause === 'approve'
          ? (store
              .proposalRows({ doc: doc.id })
              .find((p) => p.result === rev.id)?.taskId ?? null)
          : null;
      out.push({
        doc: doc.id,
        kind: 'put',
        by: rev.author,
        revision: {
          id: rev.id,
          parents: rev.parents,
          title: rev.title,
          body: rev.body,
          hash: rev.hash,
          author: rev.author,
          cause: rev.cause,
          summary: rev.summary,
          createdAt: rev.createdAt,
          ...(rev.approval === null
            ? {}
            : {
                approval: rev.approval as NonNullable<
                  NonNullable<DocBody['revision']>['approval']
                >,
              }),
          ...(task === null ? {} : { task }),
        },
        ...(first
          ? {
              meta: {
                slug: doc.slug,
                title: doc.title,
                aliases: store.aliasesOf(doc.id),
                ...(doc.status === 'draft' ? { status: doc.status } : {}),
              },
            }
          : {}),
      });
      first = false;
    }
    const snap = this.syncSnapshot(doc.id);
    const now = this.syncMetaOf(doc.id);
    if (snap === null || now === null) return out;
    const meta: NonNullable<DocBody['meta']> = {};
    if (now.slug !== snap.slug) meta.slug = now.slug;
    if (now.aliases.some((a) => !snap.aliases.includes(a)))
      meta.aliases = now.aliases;
    if (now.status !== snap.status) meta.status = now.status;
    if (linksKey(now.links) !== linksKey(snap.links)) meta.links = now.links;
    const by = store.meta(`sync:by:${doc.id}`) ?? doc.updatedBy;
    if (Object.keys(meta).length > 0)
      out.push({ doc: doc.id, kind: 'put', by, meta });
    for (const r of store.reviewsOf(doc.id)) {
      if (!r.by.startsWith('human:')) continue;
      const key: SyncKnown = {
        kind: 'review',
        doc: doc.id,
        rev: r.rev,
        by: r.by,
      };
      if (this.syncKnown(key)) continue;
      if (store.revisionMeta(r.rev)?.n == null) continue;
      out.push({ doc: doc.id, kind: 'put', by: r.by, review: { rev: r.rev } });
    }
    return out;
  }

  /** After DocSync signed them: each body is known to the team, at its clock. */
  markSynced(bodies: readonly DocBody[], stamps: readonly string[] = []): void {
    this.syncWrite(() => {
      const store = this.store();
      bodies.forEach((body, i) => {
        const hlc =
          stamps[i] === undefined || stamps[i] === '' ? null : stamps[i];
        if (body.kind === 'remove') {
          this.syncMarkKnown({ kind: 'remove', doc: body.doc });
          // A local removal keeps the clock it was made at (localClock).
          if (hlc !== null && store.tombstoneFull(body.doc)?.hlc == null)
            store.setTombstoneHlc(body.doc, hlc);
          return;
        }
        const clocks =
          store.doc(body.doc) === null ? null : store.metaClocks(body.doc);
        if (body.revision !== undefined) {
          this.syncMarkKnown({ kind: 'rev', rev: body.revision.id });
          if (clocks !== null && hlc !== null && laterClock(hlc, clocks.rev))
            clocks.rev = hlc;
        }
        if (body.meta !== undefined) {
          const { title: _title, ...fields } = body.meta;
          this.syncSetSnapshot(body.doc, fields as Partial<SyncMeta>);
          if (clocks !== null && hlc !== null)
            for (const field of Object.keys(fields)) clocks[field] = hlc;
        }
        if (body.review !== undefined)
          this.syncMarkKnown({
            kind: 'review',
            doc: body.doc,
            rev: body.review.rev,
            by: body.by,
          });
        if (clocks !== null) store.setMetaClocks(body.doc, clocks);
      });
    });
  }

  /** After a complete pass: restored revisions no replica confirmed keep
   *  their place, dropping parents nobody supplied (Team sync). */
  adoptProvisional(): string[] {
    if (!this.available) return [];
    const store = this.store();
    const docs = new Set<string>();
    this.syncWrite(() => {
      for (const meta of store.provisionalRevisions()) {
        const rev = store.revision(meta.id);
        if (rev === null) continue;
        const present = rev.parents.filter(
          (p) => store.revisionMeta(p) !== null
        );
        const missing = rev.parents.filter((p) => !present.includes(p));
        store.replaceRevision({
          ...rev,
          parents: present,
          restoredParents: missing.length === 0 ? null : missing,
          provisional: false,
        });
        docs.add(rev.docId);
      }
    });
    return [...docs];
  }

  close(): void {
    this.deps.store?.close();
  }
}
