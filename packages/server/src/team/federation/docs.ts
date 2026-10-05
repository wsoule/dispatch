import type { RevisionCause } from '@dispatch-foo/core';
import { docBodyProblem, DOCS_LIMITS, docSlug } from '@dispatch-foo/core';
import { SYSTEM_ADDRESS } from '@dispatch-foo/protocol';
import type { Address, JsonValue } from '@dispatch-foo/protocol';
import {
  hlcWallMs,
  MAX_CLOCK_LEAD_MS,
} from '@dispatch-foo/protocol/federation';
import type { DocBody } from '@dispatch-foo/protocol/federation';
import { createHash } from 'node:crypto';

import { merge3, MERGE_ALGO } from '../../docs/merge.js';
import { laterClock } from '../../docs/service.js';
import type {
  DocsService,
  SyncedRevision,
  SyncMeta,
} from '../../docs/service.js';
import type { DocsPort, DocSync } from './ops.js';
import { docBody } from './validate.js';

// Team docs across replicas: revisions are immutable, so replicas take the
// union; concurrent heads fold pairwise, lowest ids first, into merges whose
// ids name the algorithm, base and parents, so every replica builds the same
// bytes (docs design "Team sync").
//
// Licensed under the Elastic License 2.0 (../LICENSE).

const DOC_FOLD_ALGO = MERGE_ALGO;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface FoldRevision {
  id: string;
  parents: string[];
  cause: RevisionCause;
  title: string;
  body: string;
  createdAt: string;
}

export interface Fold {
  id: string;
  parents: [string, string];
  title: string;
  body: string;
  createdAt: string;
  conflicted: boolean;
}

function crockford(bytes: Uint8Array, chars: number): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += CROCKFORD[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

/** A sync merge's id: its algorithm, base and sorted parents, hashed. */
export function mergeRevisionId(
  baseId: string,
  parents: readonly string[]
): string {
  const digest = createHash('sha256')
    .update(`${DOC_FOLD_ALGO}\n${baseId}\n${[...parents].sort().join('\n')}`)
    .digest();
  return `rev-${crockford(digest, 26)}`;
}

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const decision = (r: FoldRevision): boolean =>
  r.cause === 'approve' || r.cause === 'reject';

function ancestors(
  id: string,
  get: (id: string) => FoldRevision | null
): Map<string, FoldRevision> {
  const out = new Map<string, FoldRevision>();
  const queue = [id];
  while (queue.length > 0) {
    const r = get(queue.pop() ?? '');
    if (r === null || out.has(r.id)) continue;
    out.set(r.id, r);
    queue.push(...r.parents);
  }
  return out;
}

// Two decisions on one held tip fold against that tip, so a reject removes the
// change everywhere; otherwise the latest common ancestor, ties by id.
function foldBase(
  a: FoldRevision,
  b: FoldRevision,
  get: (id: string) => FoldRevision | null
): FoldRevision | null {
  if (
    decision(a) &&
    decision(b) &&
    a.parents[1] !== undefined &&
    a.parents[1] === b.parents[1]
  )
    return get(a.parents[1]);
  const mine = ancestors(a.id, get);
  const common = [...ancestors(b.id, get).values()].filter((r) =>
    mine.has(r.id)
  );
  if (common.length === 0) return null;
  return common.sort((x, y) =>
    x.createdAt !== y.createdAt
      ? x.createdAt < y.createdAt
        ? 1
        : -1
      : byId(x, y)
  )[0];
}

// The oversize form: the lower-id parent's body under one bounded marker block.
function oversize(kept: FoldRevision, other: FoldRevision): string {
  return `<<<<<<< ${kept.id}\n=======\n>>>>>>> ${other.id} (too large to merge; read it with doc_read(rev: "${other.id}"))\n${kept.body}`;
}

/** Folds two heads into one sync merge, the same whichever order they come in. */
export function foldPair(
  a0: FoldRevision,
  b0: FoldRevision,
  get: (id: string) => FoldRevision | null
): Fold {
  const [a, b] = [a0, b0].sort(byId);
  const base = foldBase(a, b, get);
  const baseId = base === null ? '-' : base.id;
  const baseBody = base === null ? '' : base.body;
  const baseTitle = base === null ? '' : base.title;
  const merged = merge3(baseBody, a.body, b.body, {
    head: a.id,
    base: baseId,
    mine: b.id,
  });
  let body = merged.clean ? merged.body : merged.marked;
  let conflicted = !merged.clean;
  if (docBodyProblem(body) !== null) {
    body = oversize(a, b);
    conflicted = true;
  }
  const later =
    a.createdAt !== b.createdAt ? (a.createdAt > b.createdAt ? a : b) : b;
  const title =
    a.title === baseTitle
      ? b.title
      : b.title === baseTitle
        ? a.title
        : later.title;
  return {
    id: mergeRevisionId(baseId, [a.id, b.id]),
    parents: [a.id, b.id],
    title,
    body,
    createdAt: later.createdAt,
    conflicted,
  };
}

/** Folds the heads pairwise, lowest ids first, until one head remains. */
export function foldHeads(
  heads: readonly FoldRevision[],
  get: (id: string) => FoldRevision | null
): Fold[] {
  const out: Fold[] = [];
  const pool = [...heads].sort(byId);
  const extra = new Map<string, FoldRevision>();
  const lookup = (id: string) => extra.get(id) ?? get(id);
  while (pool.length > 1) {
    const a = pool.shift() as FoldRevision;
    const b = pool.shift() as FoldRevision;
    const f = foldPair(a, b, lookup);
    out.push(f);
    const asRev: FoldRevision = {
      id: f.id,
      parents: [...f.parents],
      cause: 'sync',
      title: f.title,
      body: f.body,
      createdAt: f.createdAt,
    };
    extra.set(f.id, asRev);
    pool.push(asRev);
    pool.sort(byId);
  }
  return out;
}

// Handles from claimed slugs: the lower id keeps a contested slug, the other
// takes an id suffix (6, then 12 characters, then the whole id). Derived
// locally and never published.
export function claimHandles(
  docs: readonly { id: string; slug: string; aliases: readonly string[] }[]
): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  const sorted = [...docs].sort(byId);
  for (const d of sorted) {
    if (!sorted.some((o) => o.id < d.id && o.slug === d.slug)) {
      out.set(d.id, d.slug);
      taken.add(d.slug);
    }
  }
  for (const d of sorted) {
    if (out.has(d.id)) continue;
    const tail = d.id.toLowerCase();
    for (const n of [6, 12, tail.length]) {
      const suffix = n === tail.length ? tail : tail.slice(-n);
      const candidate = `${d.slug.slice(0, DOCS_LIMITS.slugChars - suffix.length - 1)}-${suffix}`;
      if (!taken.has(candidate)) {
        out.set(d.id, candidate);
        taken.add(candidate);
        break;
      }
    }
  }
  return out;
}

/** Whether an arriving revision to an accepted doc may join the head
 *  (docs design "Accepted docs keep their gate across replicas"). */
export function covered(
  rev: {
    author: string;
    cause: RevisionCause;
    approval: { by: string; policy?: { rung: number } } | null;
    task: string | null;
  },
  ctx: {
    publisher: string;
    speaksFor(replica: string, address: string): boolean;
    policyAllows(taskId: string | null): boolean;
  }
): boolean {
  if (rev.cause === 'approve' && rev.approval !== null) {
    if (rev.approval.policy !== undefined) return ctx.policyAllows(rev.task);
    return (
      rev.approval.by.startsWith('human:') &&
      ctx.speaksFor(ctx.publisher, rev.approval.by)
    );
  }
  return (
    rev.author.startsWith('human:') && ctx.speaksFor(ctx.publisher, rev.author)
  );
}

// ---- the doc op handler ------------------------------------------------------

/** Per teammate replica: new docs an hour, held proposals open here, and
 *  held revisions on one open proposal's chain. */
interface SyncLimits {
  newDocsPerHour: number;
  heldPerPublisher: number;
  heldChain?: number;
}

const SYNC_LIMITS = {
  newDocsPerHour: 500,
  heldPerPublisher: 50,
  heldChain: 50,
};

// A revision stamped later than its op's clock allows reads as that clock's time.
function clampTime(
  rev: NonNullable<DocBody['revision']>,
  hlc: string
): NonNullable<DocBody['revision']> {
  const wall = hlcWallMs(hlc);
  if (wall === null || Date.parse(rev.createdAt) <= wall + MAX_CLOCK_LEAD_MS)
    return rev;
  return { ...rev, createdAt: new Date(wall).toISOString() };
}

// A fold made by a replica: cause `sync`, by agent:dispatch, two parents.
// A verified one is stored with no `via`; any other is content (T1).
const isSyncMerge = (r: {
  cause: string;
  author: string;
  parents: readonly string[];
  via: string | null;
}): boolean =>
  r.cause === 'sync' &&
  r.author === SYSTEM_ADDRESS &&
  r.parents.length === 2 &&
  r.via === null;

/** How long one missing parent's dropped ops are not asked for again. */
const REREAD_EVERY_MS = 10 * 60 * 1000;

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

interface ApplyMeta {
  replica: string;
  seq: number;
  hlc: string;
  speaksFor: (address: Address) => boolean;
}

type Outcome = 'applied' | 'parked' | 'dropped';

// Folds teammates' doc ops into docs.db through the service's sync
// primitives: union of revisions, held-back changes on accepted docs, last
// writer wins meta, handles from slug claims, and one head by folding.
export class DocOpHandler implements DocsPort {
  private fed: Pick<DocSync, 'speaksFor' | 'rereadOps'> | null = null;
  // When each missing parent's dropped ops were last asked for.
  private readonly asked = new Map<string, number>();
  private handlesStale = false;

  constructor(
    private readonly deps: {
      service: DocsService;
      policyAllows(taskId: string | null): boolean;
      limits?: SyncLimits;
    }
  ) {}

  private get limits(): SyncLimits {
    return this.deps.limits ?? SYNC_LIMITS;
  }

  // Whether a policy approval sits on a change held here: [head, held tip]
  // with the tip's text, or the clean merge an approval here would write.
  private onHeldTip(
    rev: NonNullable<DocBody['revision']>,
    parents: readonly string[],
    held: ReadonlySet<string>
  ): boolean {
    const { service } = this.deps;
    if (parents.length !== 2 || !held.has(parents[1])) return false;
    const head = service.syncRevision(parents[0]);
    const tip = service.syncRevision(parents[1]);
    if (head === null || tip === null) return false;
    if (rev.body === tip.body) return true;
    let baseId = tip.id;
    for (let r = tip; held.has(r.id); ) {
      const next = service.syncRevision(r.parents[0] ?? '');
      if (next === null) return false;
      baseId = next.id;
      r = next;
    }
    const base = service.syncRevision(baseId);
    if (base === null) return false;
    const merged = merge3(base.body, head.body, tip.body, {
      head: head.id,
      base: base.id,
      mine: tip.id,
    });
    return merged.clean && merged.body === rev.body;
  }

  /** Late: DocSync takes this handler as its port. */
  bindFederation(fed: Pick<DocSync, 'speaksFor' | 'rereadOps'>): void {
    this.fed = fed;
  }

  applyDocOp(
    op: { replica: string; seq: number; hlc: string; body: DocBody },
    ctx: { speaksFor(replica: string, address: Address): boolean }
  ): Outcome {
    return this.apply(op.body as unknown as JsonValue, {
      replica: op.replica,
      seq: op.seq,
      hlc: op.hlc,
      speaksFor: (a) => ctx.speaksFor(op.replica, a),
    });
  }

  apply(raw: JsonValue, meta: ApplyMeta): Outcome {
    const { service } = this.deps;
    if (!service.available) return 'parked';
    const body = docBody(raw);
    if (body === null) {
      const doc = (raw as { doc?: unknown } | null)?.doc;
      if (typeof doc === 'string' && service.syncDoc(doc) !== null)
        service.syncWrite(() =>
          service.syncProblem(
            doc,
            `a doc change from ${meta.replica} at seq ${meta.seq} did not read and was dropped`
          )
        );
      return 'dropped';
    }
    this.handlesStale = false;
    return service.syncWrite(() => {
      const out = this.applyIn(body, meta);
      if (this.handlesStale) {
        service.syncSetHandles(claimHandles(service.syncClaims()));
        this.handlesStale = false;
      }
      return out;
    });
  }

  private applyIn(body: DocBody, meta: ApplyMeta): Outcome {
    const { service } = this.deps;
    if (body.kind === 'remove') return this.remove(body, meta);
    if (body.revision !== undefined) {
      const out = this.revision(body, body.revision, meta);
      if (out !== 'applied') return out;
    } else if (service.syncDoc(body.doc) === null)
      return service.syncTombstone(body.doc) === null ? 'parked' : 'applied';
    const doc = service.syncDoc(body.doc);
    if (doc === null) return 'applied';
    if (doc.scope !== 'team') return 'dropped';
    if (body.meta !== undefined) {
      const out = this.meta(body, body.meta, meta);
      if (out !== 'applied') return out;
    }
    if (body.review !== undefined) {
      const out = this.review(body, body.review.rev, meta);
      if (out !== 'applied') return out;
    }
    this.settle(body.doc);
    return 'applied';
  }

  private problem(docId: string, detail: string): 'dropped' {
    this.deps.service.syncProblem(docId, detail);
    return 'dropped';
  }

  private revision(
    body: DocBody,
    given: NonNullable<DocBody['revision']>,
    meta: ApplyMeta
  ): Outcome {
    const { service } = this.deps;
    const isFold = given.cause === 'sync' && given.author === SYSTEM_ADDRESS;
    // A fold's time is checked against its parents instead.
    const rev = isFold ? given : clampTime(given, meta.hlc);
    if (sha256(rev.body) !== rev.hash)
      return this.problem(
        body.doc,
        `${rev.id} from ${meta.replica} does not match its own hash; it was dropped`
      );
    const existing = service.syncRevision(rev.id);
    if (existing !== null) {
      if (existing.docId !== body.doc)
        return this.problem(
          body.doc,
          `${rev.id} from ${meta.replica} names another doc than the one holding it; it was dropped`
        );
      if (existing.provisional) {
        const missing = rev.parents.filter(
          (p) => service.syncRevision(p) === null
        );
        if (missing.length > 0) {
          this.askAgain(missing);
          return 'parked';
        }
        // T1: a "sync merge" must be the fold of its parents, as for a new id;
        // anything else confirms only what the receipt named, or what a human
        // the publisher speaks for wrote.
        let fold: Fold | null = null;
        if (isFold) {
          const checked = this.verifyFold(rev, rev.parents);
          if (checked === 'parked') return 'parked';
          if (checked === null)
            return this.problem(
              body.doc,
              `${rev.id} from ${meta.replica} is a sync merge that does not follow from its parents; the restored revision stays`
            );
          fold = checked;
        } else {
          // Named: the receipt's own revision, byte for byte.
          const named =
            existing.hash === rev.hash &&
            existing.author === rev.author &&
            existing.parents.length === rev.parents.length &&
            existing.parents.every((p, i) => p === rev.parents[i]);
          const vouched =
            rev.author.startsWith('human:') && meta.speaksFor(rev.author);
          if (!named && !vouched)
            return this.problem(
              body.doc,
              `${rev.id} from ${meta.replica} does not match the restored revision's author, parents and text; the restored revision stays`
            );
        }
        const differs = service.syncConfirmProvisional(
          this.stored(body.doc, rev, meta, rev.parents, null, true, fold)
        );
        this.known(body.doc, rev.id, meta.hlc);
        if (differs)
          service.syncProblem(
            body.doc,
            `${rev.id} differs from the restored copy; the signed revision replaced it`
          );
        return 'applied';
      }
      if (existing.hash !== rev.hash)
        return this.problem(
          body.doc,
          `${rev.id} arrived with a different hash from ${meta.replica}; the stored revision stays`
        );
      this.known(body.doc, rev.id, meta.hlc);
      return 'applied';
    }
    let doc = service.syncDoc(body.doc);
    if (doc !== null && doc.scope !== 'team') return 'dropped';
    let reviving = false;
    if (doc === null) {
      const tomb = service.syncTombstone(body.doc);
      if (tomb !== null) {
        // D1: while this replica's removal is unpublished it decides nothing;
        // the revision waits, unspent, for the removal's op clock.
        if ('pending' in tomb) return 'parked';
        // A revision later than the removal revives the doc; others are spent.
        if (!laterClock(meta.hlc, tomb.hlc)) return 'applied';
        // FW-R38(3): only a human's edit brings a removed doc back.
        if (!(rev.author.startsWith('human:') && meta.speaksFor(rev.author))) {
          service.syncProblem(
            body.doc,
            `${rev.id} by ${rev.author} did not revive the removed doc: only a human ${meta.replica} speaks for can`
          );
          return 'applied';
        }
        reviving = true;
      }
    }
    const missing = rev.parents.filter((p) => service.syncRevision(p) === null);
    if (missing.length > 0 && !reviving) {
      this.askAgain(missing);
      return 'parked';
    }
    const parents = rev.parents.filter((p) => !missing.includes(p));
    if (parents.some((p) => service.syncRevision(p)?.docId !== body.doc))
      return this.problem(
        body.doc,
        `${rev.id} from ${meta.replica} names a parent of another doc; it was dropped`
      );
    let fold: Fold | null = null;
    if (isFold) {
      const checked = this.verifyFold(rev, parents);
      if (checked === 'parked') return 'parked';
      if (checked === null)
        return this.problem(
          body.doc,
          `${rev.id} from ${meta.replica} is a sync merge that does not follow from its parents; it was dropped`
        );
      fold = checked;
    }
    if (doc === null) {
      // FW-R38(4): one replica brings at most so many new docs an hour.
      if (
        service.syncNewDocs(meta.replica, false) >= this.limits.newDocsPerHour
      ) {
        service.syncNote(
          meta.replica,
          `more than ${this.limits.newDocsPerHour} new docs this hour; the rest wait`
        );
        return 'parked';
      }
      service.syncNewDocs(meta.replica, true);
      const slug = body.meta?.slug ?? docSlug(rev.title);
      doc = service.syncCreateDoc({
        id: body.doc,
        slug,
        title: body.meta?.title ?? rev.title,
        by: rev.author,
        at: rev.createdAt,
      });
      service.syncSetSnapshot(doc.id, {
        slug,
        aliases: [],
        status: 'draft',
        links: [],
      });
      this.handlesStale = true;
    }
    let held = false;
    if (doc.status === 'accepted') {
      const heldNow = service.syncHeld(doc.id);
      const parentHeld = parents.some((p) => heldNow.has(p));
      // FW-R38(2): a policy approval counts only on a change held here.
      const policy =
        rev.cause === 'approve' && rev.approval?.policy !== undefined;
      const isCovered =
        isFold ||
        (policy
          ? this.onHeldTip(rev, parents, heldNow) &&
            this.deps.policyAllows(rev.task ?? null)
          : covered(
              {
                author: rev.author,
                cause: rev.cause,
                approval: rev.approval ?? null,
                task: rev.task ?? null,
              },
              {
                publisher: meta.replica,
                speaksFor: (_replica, address) => meta.speaksFor(address),
                policyAllows: (task) => this.deps.policyAllows(task),
              }
            ));
      const decision = rev.cause === 'approve' || rev.cause === 'reject';
      if (isCovered && decision && parentHeld)
        service.syncRelease(doc.id, `decided on ${meta.replica}`);
      else held = parentHeld || !isCovered;
      // FW-R38(4): one replica holds at most so many proposals open here.
      if (
        held &&
        !parentHeld &&
        service.syncHeldFrom(meta.replica) >= this.limits.heldPerPublisher
      ) {
        service.syncNote(
          meta.replica,
          `more than ${this.limits.heldPerPublisher} held changes wait for a decision; the rest wait`
        );
        return 'parked';
      }
      const chainCap = this.limits.heldChain ?? SYNC_LIMITS.heldChain;
      const longest = Math.max(
        0,
        ...parents
          .filter((p) => heldNow.has(p))
          .map((p) => service.syncHeldChainLength(p))
      );
      if (held && parentHeld && longest >= chainCap) {
        service.syncNote(
          meta.replica,
          `a held change's chain is over ${chainCap} revisions; the rest wait for a decision`
        );
        return 'parked';
      }
    }
    service.syncInsertRevision(
      this.stored(
        doc.id,
        rev,
        meta,
        parents,
        reviving && missing.length > 0 ? missing : null,
        !held,
        fold
      )
    );
    this.known(doc.id, rev.id, meta.hlc);
    if (held)
      service.syncHold({
        docId: doc.id,
        tip: rev.id,
        replica: meta.replica,
        task: rev.task ?? null,
      });
    return 'applied';
  }

  // The service's input for a teammate's revision: marked via its publisher
  // when that one cannot speak for the author; a fold is checked instead.
  private stored(
    docId: string,
    rev: NonNullable<DocBody['revision']>,
    meta: ApplyMeta,
    parents: string[],
    restoredParents: string[] | null,
    numbered: boolean,
    fold: Fold | null
  ): SyncedRevision {
    const via =
      fold !== null || meta.speaksFor(rev.author) ? null : meta.replica;
    return {
      id: rev.id,
      docId,
      parents,
      restoredParents,
      // A verified fold is stored as computed here, never as sent.
      title: fold?.title ?? rev.title,
      body: fold?.body ?? rev.body,
      hash: fold === null ? rev.hash : sha256(fold.body),
      author: rev.author,
      cause: rev.cause,
      summary: rev.summary,
      createdAt: fold?.createdAt ?? rev.createdAt,
      approval: rev.approval ?? null,
      via,
      numbered,
      // Only a verified fold is a mechanical sync; any other `sync` is outside text.
      taint: rev.cause === 'sync' && fold === null,
      conflicted: fold?.conflicted ?? false,
    };
  }

  // A teammate's sync merge must be the fold of its parents, byte for byte.
  private verifyFold(
    rev: NonNullable<DocBody['revision']>,
    parents: string[]
  ): Fold | 'parked' | null {
    const { service } = this.deps;
    if (parents.length !== 2 || rev.parents.length !== 2) return null;
    const memo = new Map<string, boolean>();
    if (!parents.every((p) => service.syncGrounded(p, memo))) return 'parked';
    const get = this.reader();
    const [a, b] = parents.map((p) => get(p));
    if (a === null || b === null) return 'parked';
    const fold = foldPair(a, b, get);
    // FW-R38(1): every field must be the fold's.
    const same =
      fold.id === rev.id &&
      sha256(fold.body) === rev.hash &&
      fold.title === rev.title &&
      fold.createdAt === rev.createdAt &&
      fold.parents[0] === rev.parents[0] &&
      fold.parents[1] === rev.parents[1];
    return same ? fold : null;
  }

  // Revisions as the fold reads them, cached for one op.
  private reader(): (id: string) => FoldRevision | null {
    const cache = new Map<string, FoldRevision | null>();
    return (id) => {
      if (cache.has(id)) return cache.get(id) ?? null;
      const r = this.deps.service.syncRevision(id);
      const out =
        r === null
          ? null
          : {
              id: r.id,
              parents: r.parents,
              cause: r.cause,
              title: r.title,
              body: r.body,
              createdAt: r.createdAt,
            };
      cache.set(id, out);
      return out;
    };
  }

  private known(docId: string, revId: string, hlc: string): void {
    const { service } = this.deps;
    service.syncMarkKnown({ kind: 'rev', rev: revId });
    if (service.syncDoc(docId) === null) return;
    const clocks = service.syncMetaClocks(docId);
    if (laterClock(hlc, clocks['rev'])) {
      clocks['rev'] = hlc;
      service.syncSetMetaClocks(docId, clocks);
    }
  }

  private meta(
    body: DocBody,
    given: NonNullable<DocBody['meta']>,
    meta: ApplyMeta
  ): Outcome {
    let m = given;
    const { service } = this.deps;
    const current = service.syncMetaOf(body.doc);
    if (current === null) return 'parked';
    // Status and spec or plan links count only from a human the publisher
    // speaks for; an op carrying a revision keeps the revision without them.
    const human = meta.speaksFor(body.by);
    const refused: string[] = [];
    if (m.status !== undefined && m.status !== current.status && !human)
      refused.push(`a change of status to ${m.status}`);
    if (m.slug !== undefined && m.slug !== current.slug && !human)
      refused.push(`a change of slug to ${m.slug}`);
    if (
      m.links !== undefined &&
      !human &&
      decideTierLinks(current.links, m.links)
    )
      refused.push('a spec or plan link change');
    if (refused.length > 0) {
      const detail = `${refused.join(' and ')} by ${body.by} was dropped: ${meta.replica} cannot speak for that human`;
      if (body.revision === undefined) return this.problem(body.doc, detail);
      this.deps.service.syncProblem(body.doc, detail);
      m = { ...m, status: undefined, links: undefined, slug: undefined };
    }
    const clocks = service.syncMetaClocks(body.doc);
    const won: Partial<SyncMeta> = {};
    for (const field of ['slug', 'status', 'links'] as const) {
      const value = m[field];
      if (value === undefined || !laterClock(meta.hlc, clocks[field])) continue;
      clocks[field] = meta.hlc;
      (won as Record<string, unknown>)[field] = value;
    }
    const aliases = (m.aliases ?? []).filter(
      (a) => !current.aliases.includes(a)
    );
    if (aliases.length > 0) won.aliases = aliases;
    if (won.slug !== undefined && won.slug !== current.slug)
      this.handlesStale = true;
    service.syncApplyMeta(body.doc, won, body.by);
    service.syncSetMetaClocks(body.doc, clocks);
    const after = service.syncMetaOf(body.doc);
    if (after !== null) {
      const echo: Partial<SyncMeta> = { aliases: after.aliases };
      if (won.slug !== undefined) echo.slug = after.slug;
      if (won.status !== undefined) echo.status = after.status;
      if (won.links !== undefined) echo.links = after.links;
      service.syncSetSnapshot(body.doc, echo);
      if (current.status === 'accepted' && after.status !== 'accepted')
        service.syncRelease(body.doc, 'the doc is no longer accepted here');
    }
    return 'applied';
  }

  private review(body: DocBody, revId: string, meta: ApplyMeta): Outcome {
    const { service } = this.deps;
    if (!meta.speaksFor(body.by))
      return this.problem(
        body.doc,
        `a review by ${body.by} was dropped: ${meta.replica} cannot speak for that human`
      );
    if (service.syncRevision(revId)?.docId !== body.doc) return 'parked';
    service.syncReview(body.doc, revId, body.by);
    service.syncMarkKnown({
      kind: 'review',
      doc: body.doc,
      rev: revId,
      by: body.by,
    });
    return 'applied';
  }

  // A removal stands unless this replica holds a revision later than it, or
  // one no teammate has seen yet; a later revision revives the doc.
  private remove(body: DocBody, meta: ApplyMeta): Outcome {
    const { service } = this.deps;
    const doc = service.syncDoc(body.doc);
    if (!meta.speaksFor(body.by)) {
      if (doc !== null)
        return this.problem(
          body.doc,
          `a removal by ${body.by} was dropped: ${meta.replica} cannot speak for that human`
        );
      return 'dropped';
    }
    if (doc !== null && doc.scope !== 'team') return 'dropped';
    if (doc !== null) {
      const clocks = service.syncMetaClocks(doc.id);
      if (clocks['rev'] !== undefined && !laterClock(meta.hlc, clocks['rev']))
        return 'applied';
      const unsent = service
        .syncRevisions(doc.id)
        .some(
          (r) => r.n !== null && !service.syncKnown({ kind: 'rev', rev: r.id })
        );
      if (unsent) return 'applied';
    }
    service.syncRemove(body.doc, body.by, meta.hlc);
    service.syncMarkKnown({ kind: 'remove', doc: body.doc });
    return 'applied';
  }

  // One head: the grounded heads, folded pairwise once a pass has applied
  // everything it read (`fold`), so replicas fold whole states, not each op;
  // a single head is taken at once. An ungrounded local head stays.
  private settle(docId: string, fold = false): void {
    const { service } = this.deps;
    service.syncSealOpenHead(docId);
    const doc = service.syncDoc(docId);
    if (doc === null) return;
    const memo = new Map<string, boolean>();
    if (doc.headId !== '' && !service.syncGrounded(doc.headId, memo)) return;
    const all = service.syncRevisions(docId);
    const numbered = all.filter((r) => r.n !== null);
    // Sync merges are transparent: the heads folded are the content revisions
    // no other content revision descends from, so the fold depends only on
    // which changes a replica holds, never on the merges it made on the way.
    const content = numbered.filter((r) => !isSyncMerge(r));
    const byId = new Map(all.map((r) => [r.id, r]));
    const below = new Set<string>();
    const stack = content.flatMap((r) => r.parents);
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (below.has(id)) continue;
      below.add(id);
      stack.push(...(byId.get(id)?.parents ?? []));
    }
    const heads = content.filter(
      (r) => r.sealed && !below.has(r.id) && service.syncGrounded(r.id, memo)
    );
    if (heads.length === 0) return;
    let target = heads[0].id;
    if (heads.length > 1 && !fold) {
      service.syncSetFoldDue(docId, true);
      return;
    }
    service.syncSetFoldDue(docId, false);
    if (heads.length > 1) {
      const get = this.reader();
      const folds = foldHeads(
        heads.map((h) => get(h.id)).filter((r) => r !== null),
        get
      );
      for (const f of folds) {
        if (service.syncRevision(f.id) !== null) continue;
        service.syncInsertRevision({
          id: f.id,
          docId,
          parents: [...f.parents],
          restoredParents: null,
          title: f.title,
          body: f.body,
          hash: sha256(f.body),
          author: SYSTEM_ADDRESS,
          cause: 'sync',
          summary: "merged teammates' changes",
          createdAt: f.createdAt,
          approval: null,
          via: null,
          numbered: true,
          taint: false,
          conflicted: f.conflicted,
        });
      }
      target = folds.at(-1)?.id ?? target;
    }
    service.syncSetHead(docId, target);
  }

  // Asks federation again for dropped ops that carried a missing parent,
  // at most once every ten minutes per parent.
  private askAgain(revIds: readonly string[]): void {
    if (this.fed === null) return;
    const now = Date.now();
    const byReplica = new Map<string, Set<number>>();
    for (const id of revIds) {
      const last = this.asked.get(id);
      if (last !== undefined && now - last < REREAD_EVERY_MS) continue;
      const rows = this.deps.service.syncMissingRows({ revId: id });
      if (rows.length === 0) continue;
      this.asked.set(id, now);
      for (const r of rows) {
        const seqs = byReplica.get(r.replica) ?? new Set<number>();
        seqs.add(r.seq);
        byReplica.set(r.replica, seqs);
      }
    }
    for (const [replica, seqs] of [...byReplica].sort(([a], [b]) =>
      a < b ? -1 : 1
    ))
      this.fed.rereadOps(
        replica,
        [...seqs].sort((a, b) => a - b)
      );
  }

  pendingDocOps(): DocBody[] {
    return this.deps.service.pendingSync();
  }

  published(bodies: readonly DocBody[], clocks?: readonly string[]): void {
    this.deps.service.markSynced(bodies, clocks);
  }

  parkedDropped(
    meta: { replica: string; seq: number; reason: 'overflow' | 'revoked' },
    body: JsonValue
  ): void {
    // A drop for revocation is final; an overflow drop can be read again.
    if (meta.reason !== 'overflow') return;
    const doc = docBody(body);
    if (doc?.revision === undefined || !this.deps.service.available) return;
    this.deps.service.syncWrite(() =>
      this.deps.service.recordSyncMissing({
        revId: doc.revision?.id ?? '',
        docId: doc.doc,
        replica: meta.replica,
        seq: meta.seq,
      })
    );
  }

  passComplete(): void {
    const { service } = this.deps;
    if (!service.available) return;
    const due = new Set([
      ...service.adoptProvisional(),
      ...service.syncFoldDue(),
    ]);
    for (const docId of [...due].sort())
      service.syncWrite(() => this.settle(docId, true));
  }

  /** Re-reads every recorded drop, or one doc's: replicas in order, seqs ascending. */
  repair(docId?: string): { reread: number } {
    const rows = this.deps.service.syncMissingRows(
      docId === undefined ? {} : { docId }
    );
    const byReplica = new Map<string, Set<number>>();
    for (const r of rows) {
      const seqs = byReplica.get(r.replica) ?? new Set<number>();
      seqs.add(r.seq);
      byReplica.set(r.replica, seqs);
    }
    for (const [replica, seqs] of [...byReplica].sort(([a], [b]) =>
      a < b ? -1 : 1
    ))
      this.fed?.rereadOps(
        replica,
        [...seqs].sort((a, b) => a - b)
      );
    return { reread: rows.length };
  }
}

// Whether a links change touches a spec or plan link, which only a
// decide-tier human makes (docs design "Team sync").
function decideTierLinks(
  before: SyncMeta['links'],
  after: SyncMeta['links']
): boolean {
  const key = (l: SyncMeta['links'][number]) =>
    `${l.target.type}:${l.target.id}:${l.rel}`;
  const was = new Set(before.filter((l) => l.rel !== 'context').map(key));
  const now = new Set(after.filter((l) => l.rel !== 'context').map(key));
  return was.size !== now.size || [...was].some((k) => !now.has(k));
}
