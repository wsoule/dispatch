import { untrustedInline } from '@dispatch/core';
import type { MemoryConfig, PolicyRuling } from '@dispatch/core';
import { SYSTEM_ADDRESS } from '@dispatch/protocol';
import type { Address, Ref } from '@dispatch/protocol';

import { normalizeTitle } from './contentHash.js';
import { MemoryError } from './errors.js';
import { memoryHandle, parseMemoryRef } from './handle.js';
import type { MemoryHost, MemoryStores } from './host.js';
import { cutUtf8 } from './limits.js';
import { queryTerms, relevanceTerms } from './query.js';
import { compareRank, rankEntries, reaches, specificity } from './rank.js';
import type { RankContext, Ranked } from './rank.js';
import {
  createMemoryIds,
  insertFresh,
  newMemoryEntry,
  newProposal,
} from './records.js';
import { renderIndex } from './render.js';
import type { IndexVariant, RenderedIndex } from './render.js';
import type { SearchMode } from './schema.js';
import type { ActivityRow, EntryFilter, MemoryStore } from './store.js';
import { displayState } from './types.js';
import type {
  DisplayState,
  MemoryEntry,
  MemoryKind,
  MemoryProposal,
  MemoryScope,
  MemoryTrust,
  PolicyDecision,
  Principal,
  ProposalAction,
  ProposalContent,
  ProposalState,
  Revision,
  RevisionCause,
  SharedScope,
} from './types.js';
import {
  checkTarget,
  validateMemoryInput,
  validateQuery,
  validateReason,
} from './validate.js';
import type { ValidMemoryInput } from './validate.js';
import {
  personalIdentityFor,
  proposalVisible,
  refuseA2A,
  sharedScopesFor,
} from './visibility.js';
import type { Viewer } from './visibility.js';

export interface EntryView extends MemoryEntry {
  state: DisplayState;
}

export interface ListQuery {
  scope?: MemoryScope;
  kind?: MemoryKind;
  state?: DisplayState | 'all';
  taskId?: string;
  limit?: number;
}

export interface SearchQuery {
  query: string;
  scope?: MemoryScope;
  kind?: MemoryKind;
  includeStale?: boolean;
  includeRetired?: boolean;
  limit?: number;
}

export interface SearchResult {
  id: string;
  handle: string;
  title: string;
  kind: MemoryKind;
  scope: MemoryScope;
  trust: MemoryTrust;
  state: DisplayState;
  updatedAt: string;
  snippet: string;
}

export interface ReadResult {
  entry: EntryView;
  revisions: Revision[];
  recallCount: number;
}

export interface IndexRequest {
  principal: Principal;
  taskId: string | null;
  runId: string | null;
  variant: IndexVariant;
  recordRecalls?: boolean;
}

export interface RankedIndex {
  ranked: Ranked[];
  ctx: RankContext;
  personalUnavailable: boolean;
}

// `origin` and `cause` are engine-internal: only in-process callers (the
// ledger importer, amendments, ingest, sync) set them; routes and tools refuse them.
export interface SaveInput {
  scope: MemoryScope;
  kind: MemoryKind;
  title: string;
  body: string;
  refs?: Ref[];
  epic?: string | null;
  appliesTo?: string[];
  supersedes?: string | null;
  projectOnly?: boolean;
  origin?: string | null;
  cause?: 'save' | 'ingest';
}

// `active` means the write took effect; `proposed` means it waits on a decision.
export type SaveResult =
  | { status: 'active'; id: string; handle: string }
  | { status: 'proposed'; proposal: string; gate: string | null };

export interface EditInput {
  title?: string;
  body?: string;
  kind?: MemoryKind;
  refs?: Ref[];
  baseRev?: number;
  cause?: 'edit' | 'ingest';
}

// What a shared write asks for; `origin` is set only by in-process callers.
interface ProposeInput {
  action: ProposalAction;
  scope: SharedScope;
  valid?: ValidMemoryInput;
  target?: MemoryEntry;
  baseRev?: number;
  reason?: string;
  origin?: string | null;
}

// A proposal from an in-process caller (amendments, ledger rows, ingest),
// whatever the principal's tier.
export interface SubmitProposalInput {
  action: ProposalAction;
  scope: SharedScope;
  content?: ValidMemoryInput;
  target?: string;
  baseRev?: number;
  reason?: string;
  origin?: string;
}

// A proposal with its target as proposed against (`base`) and as it is now.
export interface ProposalView {
  proposal: MemoryProposal;
  base: EntryView | null;
  current: EntryView | null;
}

// A memory gate's answer as the daemon's gate effect hands it over.
export interface GateAnswer {
  proposalId: string;
  gateId: string;
  choice: 'approve' | 'reject';
  by: Address;
  reason: string;
  expired: boolean;
}

interface Approval {
  decidedBy: Address | null;
  decidedByPolicy: PolicyDecision | null;
}

// What approving a proposal did: the proposal as approved and the entries it wrote.
interface Applied {
  proposal: MemoryProposal;
  created: MemoryEntry | null;
  retired: MemoryEntry | null;
}

type AnswerOutcome =
  | { kind: 'skipped'; proposal: MemoryProposal | null }
  | { kind: 'approved'; applied: Applied }
  | { kind: 'closed'; proposal: MemoryProposal };

interface Located {
  entry: MemoryEntry;
  store: MemoryStore;
}

interface Hit {
  located: Located;
  score: number;
  snippet: string;
}

interface ScopedStore {
  store: MemoryStore;
  filter: EntryFilter;
}

const view = (entry: MemoryEntry): EntryView => ({
  ...entry,
  state: displayState(entry),
});

const clamp = (value: number | undefined, fallback: number, max: number) =>
  Math.min(Math.max(1, value ?? fallback), max);

const HOUR_MS = 3_600_000;
// How long a rejection keeps an agent from proposing the same lesson again.
const REJECTION_HOLD_MS = 30 * 24 * HOUR_MS;
const ACTIVITY_LIMIT = 200;
// Revisions that spend a run's or agent's hourly personal-write budget.
const RATED_CAUSES: readonly RevisionCause[] = [
  'save',
  'edit',
  'retire',
  'ingest',
];

const isDecider = (principal: Principal): boolean =>
  principal.kind === 'human' && principal.canDecide;

// Trust is never raised by an agent: only a human principal writes `human`.
const trustOf = (principal: Principal): MemoryTrust =>
  principal.kind === 'human' ? 'human' : 'agent';

const runIdOf = (principal: Principal): string | null =>
  principal.kind === 'run' ? principal.address.slice('run:'.length) : null;

// Ledger-import and sync proposals are bounded by what arrives, not by what an agent asks.
const isExemptOrigin = (origin: string | null): boolean =>
  origin !== null &&
  (origin.startsWith('ledger:') || origin.startsWith('sync:'));

const toProposalContent = (valid: ValidMemoryInput): ProposalContent => ({
  kind: valid.kind,
  title: valid.title,
  body: valid.body,
  refs: valid.refs,
  epic: valid.epic,
  appliesTo: valid.appliesTo,
});

function sharedScope(scope: unknown): SharedScope {
  if (scope === 'project' || scope === 'team') return scope;
  throw new MemoryError('invalid', 'scope: expected project|team', 'scope');
}

// A supplied base revision must be one the entry has had.
function checkBaseRev(entry: MemoryEntry, baseRev?: number): number | null {
  if (baseRev === undefined) return null;
  if (!Number.isInteger(baseRev) || baseRev < 1 || baseRev > entry.rev)
    throw new MemoryError(
      'invalid',
      `baseRev: ${entry.handle} has revisions 1 to ${entry.rev}`,
      'baseRev'
    );
  return baseRev;
}

// An origin names one source row, so a second entry claiming it is a conflict.
function checkOrigin(store: MemoryStore, origin: string | null): void {
  if (origin === null) return;
  const existing = store.entryByOrigin(origin);
  if (existing !== null)
    throw new MemoryError(
      'conflict',
      `origin: ${existing.handle} already holds ${origin}`,
      'origin'
    );
}

// A shared write's origin must be free among entries and proposals alike, or
// approving the proposal that holds it would collide with the entry.
function checkSharedOrigin(store: MemoryStore, origin: string | null): void {
  checkOrigin(store, origin);
  if (origin === null) return;
  const existing = store.proposalByOrigin(origin);
  if (existing !== null)
    throw new MemoryError(
      'conflict',
      `origin: ${existing.id} already holds ${origin}`,
      'origin'
    );
}

// Reads and writes memory for a principal across the shared store and their
// operator's personal store, applying the one visibility rule to every path.
export class MemoryEngine {
  private readonly ids = createMemoryIds();

  constructor(
    private readonly deps: {
      stores: MemoryStores;
      host: MemoryHost;
      config: () => MemoryConfig;
    }
  ) {}

  viewer(principal: Principal): Viewer {
    refuseA2A(principal);
    const taskId = this.deps.host.taskOfPrincipal(principal);
    const a2aRun =
      principal.kind === 'run' &&
      taskId !== null &&
      this.deps.host.taskContext(taskId)?.a2a === true;
    return {
      principal,
      operator: a2aRun ? null : this.deps.host.operatorOf(principal),
      a2aRun,
    };
  }

  searchMode(): SearchMode {
    return this.deps.stores.shared().search;
  }

  list(principal: Principal, q: ListQuery = {}): EntryView[] {
    const viewer = this.viewer(principal);
    const states: DisplayState[] =
      q.state === 'all'
        ? ['active', 'stale', 'retired']
        : q.state === undefined
          ? ['active', 'stale']
          : [q.state];
    const ctx = this.rankContext(q.taskId ?? null);
    const projectKey = this.deps.host.projectKey();
    const items = this.visible(
      viewer,
      { states, kinds: q.kind === undefined ? undefined : [q.kind] },
      q.scope
    )
      .filter(
        ({ entry }) => q.taskId === undefined || reaches(entry, ctx, projectKey)
      )
      .map(({ entry }) => ({ entry, matched: false, score: 0 }));
    return rankEntries(items, ctx)
      .slice(0, clamp(q.limit, 50, 200))
      .map(({ entry }) => view(entry));
  }

  search(principal: Principal, q: SearchQuery): SearchResult[] {
    const viewer = this.viewer(principal);
    const query = validateQuery(q.query);
    const limit = clamp(q.limit, 10, 50);
    const states: DisplayState[] = ['active'];
    if (q.includeStale !== false) states.push('stale');
    if (q.includeRetired === true) states.push('retired');
    const filter: EntryFilter = {
      states,
      kinds: q.kind === undefined ? undefined : [q.kind],
    };
    const terms = queryTerms(query);
    const ctx: RankContext = { taskId: null, epic: null };
    let hits: Hit[];
    if (terms.length === 0) {
      const located = this.visible(viewer, filter, q.scope);
      const byId = new Map(located.map((l) => [l.entry.id, l]));
      hits = rankEntries(
        located.map((l) => ({ entry: l.entry, matched: false, score: 0 })),
        ctx
      )
        .slice(0, limit)
        .flatMap((r) => {
          const l = byId.get(r.entry.id);
          return l === undefined
            ? []
            : [{ located: l, score: 0, snippet: cutUtf8(l.entry.body, 160) }];
        });
    } else {
      hits = this.stores(viewer, q.scope).flatMap(({ store, filter: scoped }) =>
        store
          .searchEntries(terms, 'all', { ...filter, ...scoped }, limit)
          .map((h) => ({
            located: { entry: h.entry, store },
            score: h.score,
            snippet: h.snippet,
          }))
      );
      hits.sort((a, b) => this.compareHits(a, b, ctx));
      hits = hits.slice(0, limit);
    }
    for (const hit of hits) this.recall(hit.located, principal, 'search');
    return hits.map(({ located: { entry }, snippet }) => ({
      id: entry.id,
      handle: entry.handle,
      title: entry.title,
      kind: entry.kind,
      scope: entry.scope,
      trust: entry.trust,
      state: displayState(entry),
      updatedAt: entry.updatedAt,
      snippet,
    }));
  }

  read(principal: Principal, ref: string): ReadResult {
    const viewer = this.viewer(principal);
    const located = this.resolve(viewer, ref);
    this.recall(located, principal, 'read');
    const entry = located.store.getEntry(located.entry.id) ?? located.entry;
    return {
      entry: view(entry),
      revisions: located.store.revisions(entry.id),
      recallCount: entry.recallCount,
    };
  }

  // Every visible active entry that reaches the task, relevance-matched and
  // ranked, unbudgeted; the prompt index and the Claude export render from it.
  rank(principal: Principal, taskId: string | null): RankedIndex {
    const viewer = this.viewer(principal);
    const context = taskId === null ? null : this.deps.host.taskContext(taskId);
    const ctx = this.rankContext(taskId);
    const projectKey = this.deps.host.projectKey();
    const terms = context === null ? [] : relevanceTerms(context);
    let personalUnavailable = false;
    const items: Ranked[] = [];
    const scoped = this.stores(viewer, undefined, () => {
      personalUnavailable = true;
    });
    for (const { store, filter } of scoped) {
      const active: EntryFilter = { ...filter, states: ['active'] };
      const scores = new Map(
        store
          .searchEntries(terms, 'any', active, 1000)
          .map((h) => [h.entry.id, h.score])
      );
      for (const entry of store.listEntries(active)) {
        if (!reaches(entry, ctx, projectKey)) continue;
        const score = scores.get(entry.id);
        items.push({ entry, matched: score !== undefined, score: score ?? 0 });
      }
    }
    return { ranked: rankEntries(items, ctx), ctx, personalUnavailable };
  }

  // An `index` recall per included entry; it counts as use for decay only
  // when the entry matched the relevance query or is narrowed to the task or its epic.
  recordIndexRecalls(
    principal: Principal,
    runId: string,
    index: RankedIndex,
    included: readonly MemoryEntry[]
  ): void {
    const viewer = this.viewer(principal);
    const shown = new Set(included.map((e) => e.id));
    for (const item of index.ranked) {
      if (!shown.has(item.entry.id)) continue;
      const located = this.locate(viewer, item.entry.id);
      if (located === null) continue;
      const countsAsUse =
        item.matched || specificity(item.entry, index.ctx) >= 2;
      located.store.recordRecall(item.entry.id, {
        runId,
        via: 'index',
        at: this.now(),
        countsAsUse,
      });
    }
  }

  index(req: IndexRequest): RenderedIndex {
    const ranked = this.rank(req.principal, req.taskId);
    const out = renderIndex(
      ranked.ranked.map((r) => r.entry),
      {
        budgetTokens: this.deps.config().indexTokens,
        variant: req.variant,
        ctx: ranked.ctx,
        personalUnavailable: ranked.personalUnavailable,
      }
    );
    if (req.runId !== null && req.recordRecalls !== false)
      this.recordIndexRecalls(req.principal, req.runId, ranked, out.included);
    return out;
  }

  async save(principal: Principal, input: SaveInput): Promise<SaveResult> {
    const viewer = this.viewer(principal);
    if (input.projectOnly === true && input.scope !== 'personal')
      throw new MemoryError(
        'invalid',
        'projectOnly: only personal memory is narrowed to a project',
        'projectOnly'
      );
    const projectKey =
      input.scope === 'personal' && input.projectOnly === true
        ? this.deps.host.projectKey()
        : null;
    const valid = validateMemoryInput({ ...input, projectKey });
    if (valid.scope === 'personal')
      return this.savePersonal(viewer, valid, input);
    const scope = valid.scope;
    const supersedes = input.supersedes ?? null;
    const target =
      supersedes === null
        ? null
        : checkTarget(
            this.findVisible(viewer, supersedes),
            scope,
            'supersedes',
            supersedes
          );
    if (!isDecider(principal))
      return await this.propose(viewer, {
        action: target === null ? 'add' : 'supersede',
        scope,
        valid,
        target: target ?? undefined,
        baseRev: target?.rev,
        origin: input.origin ?? null,
      });
    return this.saveShared(viewer, scope, valid, target, input);
  }

  async edit(
    principal: Principal,
    ref: string,
    input: EditInput
  ): Promise<SaveResult> {
    const viewer = this.viewer(principal);
    const { entry, store } = this.resolve(viewer, ref);
    checkTarget(entry, entry.scope, 'id', ref);
    const baseRev = checkBaseRev(entry, input.baseRev);
    const valid = validateMemoryInput({
      scope: entry.scope,
      kind: input.kind ?? entry.kind,
      title: input.title ?? entry.title,
      body: input.body ?? entry.body,
      refs: input.refs ?? entry.refs,
      epic: entry.epic,
      appliesTo: entry.appliesTo,
      projectKey: entry.projectKey,
    });
    const content = {
      kind: valid.kind,
      title: valid.title,
      body: valid.body,
      refs: valid.refs,
    };
    const cause = input.cause ?? 'edit';
    if (entry.scope === 'personal') {
      this.checkPersonalRate(principal, store);
      store.transaction(() => {
        // A stale base still writes; the row names whose change it replaced.
        const replaced =
          baseRev !== null && baseRev < entry.rev
            ? (store.revisions(entry.id).at(-1)?.by ?? null)
            : null;
        const next = this.revise(
          store,
          entry,
          { ...content, trust: trustOf(principal) },
          principal.address,
          cause
        );
        const note =
          replaced === null ? '' : ` (replaced a change by ${replaced})`;
        this.logActivity(
          store,
          cause === 'ingest' ? 'ingested' : 'edited',
          entry.id,
          principal,
          `${principal.address} changed your memory: ${untrustedInline(next.title)}${note}`
        );
      });
      this.deps.host.changed({ scope: 'personal' });
      return { status: 'active', id: entry.id, handle: entry.handle };
    }
    const scope = entry.scope;
    if (!isDecider(principal))
      return await this.propose(viewer, {
        action: 'supersede',
        scope,
        valid,
        target: entry,
        baseRev: baseRev ?? entry.rev,
      });
    store.transaction(() =>
      this.revise(
        store,
        entry,
        { ...content, trust: 'human' },
        principal.address,
        cause
      )
    );
    this.deps.host.changed({ scope, id: entry.id });
    return { status: 'active', id: entry.id, handle: entry.handle };
  }

  async forget(
    principal: Principal,
    ref: string,
    reason: string
  ): Promise<SaveResult> {
    const viewer = this.viewer(principal);
    const why = validateReason(reason);
    const { entry, store } = this.resolve(viewer, ref);
    checkTarget(entry, entry.scope, 'id', ref);
    const retired = { status: 'retired', statusReason: 'forgotten' } as const;
    if (entry.scope === 'personal') {
      this.checkPersonalRate(principal, store);
      store.transaction(() => {
        this.revise(store, entry, retired, principal.address, 'retire');
        this.logActivity(
          store,
          'retired',
          entry.id,
          principal,
          `${principal.address} retired from your memory: ${untrustedInline(entry.title)} (${why})`
        );
      });
      this.deps.host.changed({ scope: 'personal' });
      return { status: 'active', id: entry.id, handle: entry.handle };
    }
    const scope = entry.scope;
    if (!isDecider(principal))
      return await this.propose(viewer, {
        action: 'retire',
        scope,
        target: entry,
        baseRev: entry.rev,
        reason: why,
      });
    store.transaction(() =>
      this.revise(store, entry, retired, principal.address, 'retire')
    );
    this.deps.host.changed({ scope, id: entry.id });
    return { status: 'active', id: entry.id, handle: entry.handle };
  }

  // Restores the previous revision as a new one. Undoing a creation retires
  // the entry as `undone` and brings back the entry it superseded.
  undo(principal: Principal, ref: string): EntryView {
    const viewer = this.viewer(principal);
    const { entry, store } = this.resolve(viewer, ref);
    this.mayManage(viewer, entry, 'undo');
    const by = principal.address;
    const revived: MemoryEntry[] = [];
    const next = store.transaction(() => {
      if (entry.rev === 1) {
        const undone = this.revise(
          store,
          entry,
          { status: 'retired', statusReason: 'undone' },
          by,
          'undo'
        );
        const replaced =
          entry.supersedes === null ? null : store.getEntry(entry.supersedes);
        if (replaced !== null && replaced.supersededBy === entry.id)
          revived.push(
            this.revise(
              store,
              replaced,
              { status: 'active', statusReason: null, supersededBy: null },
              by,
              'undo'
            )
          );
        return undone;
      }
      const previous = store
        .revisions(entry.id)
        .find((r) => r.rev === entry.rev - 1);
      if (previous === undefined)
        throw new MemoryError(
          'conflict',
          `${entry.handle} has no revision ${entry.rev - 1} to restore`,
          'id'
        );
      // Recall bookkeeping records use, not content, so it stays current.
      const { recallCount, lastRecalledAt, decay } = entry;
      return this.revise(
        store,
        entry,
        { ...previous.snapshot, recallCount, lastRecalledAt, decay },
        by,
        'undo'
      );
    });
    this.changedFor(entry);
    if (entry.status === 'retired' && next.status === 'active')
      revived.push(next);
    for (const back of revived) this.announceIfActivated(back, null);
    return view(next);
  }

  confirm(principal: Principal, ref: string): EntryView {
    const viewer = this.viewer(principal);
    const { entry, store } = this.resolve(viewer, ref);
    this.mayManage(viewer, entry, 'confirm');
    if (entry.trust !== 'agent') return view(entry);
    const next = store.transaction(() =>
      this.revise(
        store,
        entry,
        { trust: 'confirmed', decidedBy: principal.address },
        principal.address,
        'edit'
      )
    );
    this.changedFor(entry);
    return view(next);
  }

  setPinned(principal: Principal, ref: string, pinned: boolean): EntryView {
    const viewer = this.viewer(principal);
    const { entry, store } = this.resolve(viewer, ref);
    this.mayManage(viewer, entry, pinned ? 'pin' : 'unpin');
    if (entry.pinned === pinned) return view(entry);
    const next = store.transaction(() =>
      this.revise(store, entry, { pinned }, principal.address, 'edit')
    );
    this.changedFor(entry);
    return view(next);
  }

  // Copies a personal entry into shared memory; the personal entry stays.
  async promote(
    principal: Principal,
    ref: string,
    scope: SharedScope
  ): Promise<SaveResult> {
    const viewer = this.viewer(principal);
    const target = sharedScope(scope);
    const { entry } = this.resolve(viewer, ref);
    if (entry.scope !== 'personal')
      throw new MemoryError(
        'invalid',
        `id: ${entry.handle} is already ${entry.scope} memory`,
        'id'
      );
    checkTarget(entry, 'personal', 'id', ref);
    this.mayManage(viewer, entry, 'promote');
    const valid = validateMemoryInput({
      scope: target,
      kind: entry.kind,
      title: entry.title,
      body: entry.body,
      refs: entry.refs,
    });
    if (!isDecider(principal))
      return await this.propose(viewer, {
        action: 'add',
        scope: target,
        valid,
      });
    const store = this.deps.stores.shared();
    const now = this.now();
    const copy = insertFresh(
      store,
      this.ids,
      Date.parse(now),
      (id) =>
        newMemoryEntry(
          {
            ...valid,
            author: entry.author,
            trust: entry.trust === 'human' ? 'human' : 'confirmed',
            decidedBy: principal.address,
          },
          id,
          now
        ),
      principal.address,
      'save'
    );
    this.deps.host.changed({ scope: target, id: copy.id });
    this.announceIfActivated(copy, null);
    return { status: 'active', id: copy.id, handle: copy.handle };
  }

  // Removes the entry, its revisions, recalls and activity; an imported
  // entry's origin is tombstoned so a re-import never brings it back.
  hardDelete(principal: Principal, ref: string): void {
    const viewer = this.viewer(principal);
    const { entry, store } = this.resolve(viewer, ref);
    this.mayManage(viewer, entry, 'delete');
    store.deleteEntry(entry.id, principal.address, this.now());
    this.changedFor(entry);
  }

  // The caller's own personal activity, oldest first, the newest 200 rows.
  activity(principal: Principal, since: string): ActivityRow[] {
    const viewer = this.viewer(principal);
    if (principal.kind !== 'human')
      throw new MemoryError(
        'forbidden',
        'only a human reads their memory activity',
        'principal'
      );
    const sinceMs = Date.parse(since);
    if (Number.isNaN(sinceMs))
      throw new MemoryError('invalid', 'since: expected an ISO time', 'since');
    return this.personalStoreFor(viewer)
      .activitySince(new Date(sinceMs).toISOString(), ACTIVITY_LIMIT)
      .reverse();
  }

  // Deciders see every proposal; anyone else only their own (proposalVisible).
  proposals(principal: Principal, state?: ProposalState): MemoryProposal[] {
    const viewer = this.viewer(principal);
    return this.deps.stores
      .shared()
      .listProposals(state === undefined ? {} : { states: [state] })
      .filter((p) => proposalVisible(viewer, p));
  }

  proposal(principal: Principal, id: string): ProposalView {
    const viewer = this.viewer(principal);
    const store = this.deps.stores.shared();
    const proposal = store.getProposal(id);
    if (proposal === null || !proposalVisible(viewer, proposal))
      throw new MemoryError('not-found', `no proposal ${id} you can see`, 'id');
    if (proposal.target === null)
      return { proposal, base: null, current: null };
    const current = store.getEntry(proposal.target);
    const base = store
      .revisions(proposal.target)
      .find((r) => r.rev === proposal.baseRev);
    return {
      proposal,
      base: base === undefined ? null : view(base.snapshot),
      current: current === null ? null : view(current),
    };
  }

  // Always a proposal, even from a decider; the caller's content is validated here.
  async submitProposal(
    principal: Principal,
    input: SubmitProposalInput
  ): Promise<SaveResult> {
    const viewer = this.viewer(principal);
    const scope = sharedScope(input.scope);
    const { action } = input;
    if ((action === 'retire') !== (input.content === undefined))
      throw new MemoryError(
        'invalid',
        action === 'retire'
          ? 'content: a retire carries no content'
          : `content: required to ${action}`,
        'content'
      );
    if ((action === 'add') !== (input.target === undefined))
      throw new MemoryError(
        'invalid',
        action === 'add'
          ? 'target: an add names no target'
          : `target: required to ${action}`,
        'target'
      );
    if (input.content !== undefined && input.content.scope !== scope)
      throw new MemoryError(
        'invalid',
        `content.scope: expected ${scope}`,
        'content.scope'
      );
    const valid =
      input.content === undefined
        ? undefined
        : validateMemoryInput(input.content);
    const target =
      input.target === undefined
        ? undefined
        : checkTarget(
            this.findVisible(viewer, input.target),
            scope,
            'target',
            input.target
          );
    if (action === 'retire' && input.reason === undefined)
      throw new MemoryError('invalid', 'reason: required to retire', 'reason');
    return await this.propose(viewer, {
      action,
      scope,
      valid,
      target,
      baseRev:
        target === undefined
          ? undefined
          : (checkBaseRev(target, input.baseRev) ?? target.rev),
      reason:
        input.reason === undefined ? undefined : validateReason(input.reason),
      origin: input.origin ?? null,
    });
  }

  // The memory gate's effect. Only an open proposal whose recorded gate is
  // unset or this one changes, so a replayed or foreign answer is skipped.
  applyGateAnswer(answer: GateAnswer): {
    outcome: 'applied' | 'skipped';
    proposal: MemoryProposal | null;
  } {
    const store = this.deps.stores.shared();
    const done = store.transaction((): AnswerOutcome => {
      const p = store.getProposal(answer.proposalId);
      if (
        p === null ||
        p.state !== 'open' ||
        (p.gate !== null && p.gate !== answer.gateId)
      )
        return { kind: 'skipped', proposal: p };
      if (answer.choice === 'approve' && !answer.expired)
        return {
          kind: 'approved',
          applied: this.applyProposal(store, p, answer.gateId, {
            decidedBy: answer.by,
            decidedByPolicy: null,
          }),
        };
      const closed: MemoryProposal = {
        ...p,
        state: answer.expired ? 'expired' : 'rejected',
        gate: answer.gateId,
        decidedBy: answer.by,
        decisionReason: answer.reason === '' ? null : answer.reason,
        decidedAt: this.now(),
      };
      store.updateProposal(closed);
      return { kind: 'closed', proposal: closed };
    });
    if (done.kind === 'skipped')
      return { outcome: 'skipped', proposal: done.proposal };
    if (done.kind === 'approved') {
      this.afterApply(done.applied);
      return { outcome: 'applied', proposal: done.applied.proposal };
    }
    if (done.proposal.state === 'rejected')
      this.deps.host.proposalRejected(done.proposal);
    return { outcome: 'applied', proposal: done.proposal };
  }

  // Open proposals created before `cutoffIso`, oldest first, for expiry.
  openProposalsOlderThan(cutoffIso: string): MemoryProposal[] {
    return this.deps.stores
      .shared()
      .listProposals({ states: ['open'] })
      .filter((p) => p.createdAt < cutoffIso);
  }

  // Expires an open proposal that never got a gate, so no answer can close it.
  expireUngated(proposalId: string): void {
    const store = this.deps.stores.shared();
    store.transaction(() => {
      const p = store.getProposal(proposalId);
      if (p === null || p.state !== 'open' || p.gate !== null) return;
      store.updateProposal({
        ...p,
        state: 'expired',
        decidedBy: SYSTEM_ADDRESS,
        decidedAt: this.now(),
      });
    });
  }

  // Raises the gate of every open proposal left without one by a crash
  // between storing it and raising it; raiseGate finds a gate sent before.
  async recover(): Promise<{ raised: number }> {
    const store = this.deps.stores.shared();
    let raised = 0;
    for (const p of store.listProposals({ states: ['open'] })) {
      if (p.gate !== null) continue;
      this.recordGate(store, p.id, await this.deps.host.raiseGate(p));
      raised++;
    }
    return { raised };
  }

  private now(): string {
    return this.deps.host.now().toISOString();
  }

  private savePersonal(
    viewer: Viewer,
    valid: ValidMemoryInput,
    input: SaveInput
  ): SaveResult {
    const { principal } = viewer;
    const store = this.personalStoreFor(viewer);
    const supersedes = input.supersedes ?? null;
    const target =
      supersedes === null
        ? null
        : checkTarget(
            this.findVisible(viewer, supersedes),
            'personal',
            'supersedes',
            supersedes
          );
    const origin = input.origin ?? null;
    checkOrigin(store, origin);
    this.checkPersonalRate(principal, store);
    const now = this.now();
    const cause = input.cause ?? 'save';
    const entry = store.transaction(() => {
      const created = insertFresh(
        store,
        this.ids,
        Date.parse(now),
        (id) =>
          newMemoryEntry(
            {
              ...valid,
              author: principal.address,
              trust: trustOf(principal),
              origin,
              supersedes: target?.id ?? null,
            },
            id,
            now
          ),
        principal.address,
        cause
      );
      if (target !== null)
        this.revise(
          store,
          target,
          {
            status: 'retired',
            statusReason: 'superseded',
            supersededBy: created.id,
          },
          principal.address,
          'retire'
        );
      this.logActivity(
        store,
        cause === 'ingest' ? 'ingested' : 'saved',
        created.id,
        principal,
        `${principal.address} saved to your memory: ${untrustedInline(created.title)}`
      );
      return created;
    });
    this.deps.host.changed({ scope: 'personal' });
    return { status: 'active', id: entry.id, handle: entry.handle };
  }

  // A decide-tier human's direct write to project or team memory.
  private saveShared(
    viewer: Viewer,
    scope: SharedScope,
    valid: ValidMemoryInput,
    target: MemoryEntry | null,
    input: SaveInput
  ): SaveResult {
    const { principal } = viewer;
    const store = this.deps.stores.shared();
    const origin = input.origin ?? null;
    checkSharedOrigin(store, origin);
    const now = this.now();
    const entry = store.transaction(() => {
      const created = insertFresh(
        store,
        this.ids,
        Date.parse(now),
        (id) =>
          newMemoryEntry(
            {
              ...valid,
              author: principal.address,
              trust: 'human',
              origin,
              supersedes: target?.id ?? null,
            },
            id,
            now
          ),
        principal.address,
        input.cause ?? 'save'
      );
      if (target !== null)
        this.revise(
          store,
          target,
          {
            status: 'retired',
            statusReason: 'superseded',
            supersededBy: created.id,
          },
          principal.address,
          'retire'
        );
      return created;
    });
    this.deps.host.changed({ scope, id: entry.id });
    this.announceIfActivated(entry, null);
    return { status: 'active', id: entry.id, handle: entry.handle };
  }

  // An authorized shared write needing a decision: de-duplicate, rate-limit,
  // store, consult policy outside the transaction, then apply or raise the gate.
  private async propose(
    viewer: Viewer,
    input: ProposeInput
  ): Promise<SaveResult> {
    const store = this.deps.stores.shared();
    const { principal } = viewer;
    const now = this.now();
    const origin = input.origin ?? null;
    const draft = newProposal(
      {
        action: input.action,
        scope: input.scope,
        target: input.target?.id ?? null,
        baseRev: input.baseRev ?? input.target?.rev ?? null,
        content:
          input.valid === undefined ? null : toProposalContent(input.valid),
        reason: input.reason ?? null,
        author: principal.address,
        authorTrust: principal.kind === 'human' ? 'human' : 'agent',
        operator: viewer.operator?.human ?? null,
        runId: runIdOf(principal),
        taskId: this.deps.host.taskOfPrincipal(principal),
        origin,
      },
      this.ids.proposal(Date.parse(now)),
      now
    );
    checkSharedOrigin(store, origin);
    this.checkDuplicate(store, draft, now);
    if (!isExemptOrigin(origin))
      this.checkProposalLimits(store, principal, now);
    const stored: MemoryProposal = {
      ...draft,
      matchedPersonal: this.matchesOperatorPersonal(viewer, draft),
    };
    store.transaction(() => store.insertProposal(stored));
    const ruling = this.ruleOn(stored);
    if (ruling.mode === 'auto' && !stored.matchedPersonal) {
      const applied = store.transaction(() =>
        this.applyProposal(store, stored, null, {
          decidedBy: null,
          decidedByPolicy: {
            rung: ruling.rung,
            authorizedBy: ruling.authorizedBy,
          },
        })
      );
      // The entry already stands, so a lost receipt is logged rather than thrown.
      try {
        this.deps.host.recordPolicyApproval(applied.proposal, ruling);
      } catch (err) {
        console.error(
          'memory: the policy approval receipt was not written',
          err
        );
      }
      this.afterApply(applied);
      return this.settled(store, stored.id);
    }
    const gate = await this.raiseGateOrNull(stored);
    if (gate !== null) this.recordGate(store, stored.id, gate);
    return this.settled(store, stored.id);
  }

  // A gate that cannot be sent now stays unset, for recover() to raise later.
  private async raiseGateOrNull(
    proposal: MemoryProposal
  ): Promise<string | null> {
    try {
      return await this.deps.host.raiseGate(proposal);
    } catch (err) {
      console.error(
        'memory: the proposal gate was not raised; recover raises it',
        err
      );
      return null;
    }
  }

  // A ruling that throws leaves the proposal for a human.
  private ruleOn(proposal: MemoryProposal): PolicyRuling {
    try {
      return this.deps.host.rule(proposal);
    } catch (err) {
      console.error('memory: policy ruling failed; the proposal waits', err);
      return { mode: 'block' };
    }
  }

  // An answer may have landed first and recorded its own gate, so only an
  // open proposal still without one takes this gate id.
  private recordGate(store: MemoryStore, id: string, gate: string): void {
    store.transaction(() => {
      const current = store.getProposal(id);
      if (current !== null && current.state === 'open' && current.gate === null)
        store.updateProposal({ ...current, gate });
    });
  }

  // What a proposal came to, read back from the store rather than the host.
  private settled(store: MemoryStore, id: string): SaveResult {
    const p = store.getProposal(id);
    if (p === null)
      throw new MemoryError('not-found', `no proposal ${id}`, 'proposal');
    const entry =
      p.state === 'approved' && p.result !== null
        ? store.getEntry(p.result)
        : null;
    return entry === null
      ? { status: 'proposed', proposal: p.id, gate: p.gate }
      : { status: 'active', id: entry.id, handle: entry.handle };
  }

  // One lesson, one row: an equal active or stale entry, open proposal or
  // rejection in the last 30 days refuses the draft, as does a second open retire.
  private checkDuplicate(
    store: MemoryStore,
    draft: MemoryProposal,
    now: string
  ): void {
    if (draft.action === 'retire') {
      if (draft.target === null) return;
      const open = store.openRetireFor(draft.target);
      if (open !== null)
        throw new MemoryError(
          'conflict',
          `retiring ${memoryHandle(draft.target)} is already proposed as ${open.id}`,
          'id'
        );
      return;
    }
    if (draft.contentHash === null) return;
    const entry = store
      .entriesByContentHash(draft.contentHash, [draft.scope])
      .find((e) => displayState(e) !== 'retired');
    if (entry !== undefined)
      throw new MemoryError(
        'conflict',
        `the same lesson is already ${entry.handle}`,
        'title'
      );
    const same = store
      .proposalsByContentHash(draft.contentHash)
      .filter((p) => p.scope === draft.scope);
    const open = same.find((p) => p.state === 'open');
    if (open !== undefined)
      throw new MemoryError(
        'conflict',
        `the same lesson is already proposed as ${open.id}`,
        'title'
      );
    const cutoff = new Date(Date.parse(now) - REJECTION_HOLD_MS).toISOString();
    const rejected = same
      .filter(
        (p) =>
          p.state === 'rejected' && p.decidedAt !== null && p.decidedAt > cutoff
      )
      .at(-1);
    if (rejected === undefined) return;
    const why =
      rejected.decisionReason === null
        ? ''
        : `: ${untrustedInline(rejected.decisionReason)}`;
    throw new MemoryError(
      'conflict',
      `the same lesson was rejected by ${rejected.decidedBy ?? SYSTEM_ADDRESS} on ${(rejected.decidedAt ?? now).slice(0, 10)}${why}`,
      'title'
    );
  }

  // Per run or agent per hour, and per project while open.
  private checkProposalLimits(
    store: MemoryStore,
    principal: Principal,
    now: string
  ): void {
    const { proposalsPerHour, maxOpenProposals } = this.deps.config();
    const since = new Date(Date.parse(now) - HOUR_MS).toISOString();
    if (
      principal.kind !== 'human' &&
      store.countProposalsBy(principal.address, since) >= proposalsPerHour
    )
      throw new MemoryError(
        'limited',
        `at most ${proposalsPerHour} memory proposals per hour`,
        'scope'
      );
    if (store.countOpenProposals() >= maxOpenProposals)
      throw new MemoryError(
        'limited',
        `this project already has ${maxOpenProposals} open memory proposals; wait for decisions`,
        'scope'
      );
  }

  // Content equal to one of the operator's personal entries never auto-approves;
  // a personal store that will not open counts as a match.
  private matchesOperatorPersonal(
    viewer: Viewer,
    draft: MemoryProposal
  ): boolean {
    const identity = personalIdentityFor(viewer);
    if (identity === null || draft.content === null) return false;
    let personal: MemoryStore;
    try {
      personal = this.deps.stores.personal(identity);
    } catch (err) {
      if (err instanceof MemoryError) return true;
      throw err;
    }
    const live = (e: MemoryEntry) => displayState(e) !== 'retired';
    if (
      draft.contentHash !== null &&
      personal.entriesByContentHash(draft.contentHash, ['personal']).some(live)
    )
      return true;
    const title = normalizeTitle(draft.content.title);
    return personal
      .listEntries({ scopes: ['personal'], states: ['active', 'stale'] })
      .some((e) => normalizeTitle(e.title) === title);
  }

  // Approval's effect: add creates the entry, supersede also retires a target
  // still active, retire retires it; the proposal records what it produced.
  private applyProposal(
    store: MemoryStore,
    p: MemoryProposal,
    gate: string | null,
    decision: Approval
  ): Applied {
    const now = this.now();
    const by = decision.decidedBy ?? SYSTEM_ADDRESS;
    // A rung is not a review, so only a human decision raises trust.
    const trust: MemoryTrust =
      decision.decidedByPolicy !== null
        ? 'agent'
        : p.authorTrust === 'human'
          ? 'human'
          : 'confirmed';
    const content = p.action === 'retire' ? null : p.content;
    const created =
      content === null
        ? null
        : insertFresh(
            store,
            this.ids,
            Date.parse(now),
            (id) =>
              newMemoryEntry(
                {
                  ...content,
                  scope: p.scope,
                  author: p.author,
                  trust,
                  origin: p.origin,
                  proposal: p.id,
                  decidedBy: decision.decidedBy,
                  decidedByPolicy: decision.decidedByPolicy,
                  supersedes: p.action === 'supersede' ? p.target : null,
                },
                id,
                now
              ),
            by,
            'gate'
          );
    const target =
      p.action === 'add' || p.target === null ? null : store.getEntry(p.target);
    const retired =
      target === null || target.status !== 'active'
        ? null
        : this.revise(
            store,
            target,
            created === null
              ? { status: 'retired', statusReason: 'forgotten' }
              : {
                  status: 'retired',
                  statusReason: 'superseded',
                  supersededBy: created.id,
                },
            by,
            'gate'
          );
    const proposal: MemoryProposal = {
      ...p,
      state: 'approved',
      gate: gate ?? p.gate,
      result: created?.id ?? p.target,
      decidedBy: decision.decidedBy,
      decidedByPolicy: decision.decidedByPolicy,
      decidedAt: now,
    };
    store.updateProposal(proposal);
    return { proposal, created, retired };
  }

  // Tells listeners what an approval changed; a new shared hazard or
  // constraint also reaches live runs other than its author's.
  private afterApply({ proposal, created, retired }: Applied): void {
    for (const entry of [created, retired])
      if (entry !== null)
        this.deps.host.changed({ scope: proposal.scope, id: entry.id });
    if (created !== null) this.announceIfActivated(created, proposal.runId);
  }

  // Live runs hear of every shared hazard or constraint that becomes active.
  private announceIfActivated(
    entry: MemoryEntry,
    authorRun: string | null
  ): void {
    if (entry.scope === 'personal' || displayState(entry) !== 'active') return;
    if (entry.kind !== 'hazard' && entry.kind !== 'constraint') return;
    this.deps.host.entryActivated(entry, authorRun);
  }

  // Writes `changes` onto `entry` as its next revision and returns the result.
  private revise(
    store: MemoryStore,
    entry: MemoryEntry,
    changes: Partial<MemoryEntry>,
    by: Address,
    cause: RevisionCause
  ): MemoryEntry {
    const next: MemoryEntry = {
      ...entry,
      ...changes,
      id: entry.id,
      rev: entry.rev + 1,
      updatedAt: this.now(),
    };
    store.updateEntry(next, by, cause);
    return next;
  }

  // The principal's own personal store, or forbidden: no operator, no personal scope.
  private personalStoreFor(viewer: Viewer): MemoryStore {
    const identity = personalIdentityFor(viewer);
    if (identity === null)
      throw new MemoryError(
        'forbidden',
        'this principal acts for no human, so it has no personal memory',
        'scope'
      );
    return this.deps.stores.personal(identity);
  }

  // Runs and agents share one hourly budget for tool writes and ingested
  // files; the first refusal in an hour leaves the operator one activity row.
  private checkPersonalRate(principal: Principal, store: MemoryStore): void {
    if (principal.kind === 'human') return;
    const limit = this.deps.config().personalWritesPerHour;
    const since = new Date(
      this.deps.host.now().getTime() - HOUR_MS
    ).toISOString();
    if (store.countRevisionsBy(principal.address, since, RATED_CAUSES) < limit)
      return;
    if (!store.hasActivitySince('throttled', since))
      this.logActivity(
        store,
        'throttled',
        null,
        principal,
        `${principal.address} hit the personal memory write limit; further writes this hour are refused`
      );
    throw new MemoryError(
      'limited',
      `at most ${limit} personal memory writes per hour`,
      'scope'
    );
  }

  // Undo, confirm, pin, promote and hard delete: a personal entry's own
  // human, or a decide-tier human for shared memory.
  private mayManage(viewer: Viewer, entry: MemoryEntry, verb: string): void {
    const { principal, operator } = viewer;
    if (entry.scope === 'personal') {
      if (principal.kind === 'human' && operator?.human === principal.address)
        return;
      throw new MemoryError(
        'forbidden',
        `only ${operator?.human ?? 'its human'} may ${verb} ${entry.handle}`,
        'id'
      );
    }
    if (isDecider(principal)) return;
    throw new MemoryError(
      'forbidden',
      `only a decide-tier human may ${verb} ${entry.scope} memory`,
      'id'
    );
  }

  // Personal changes announce no id, so no title or handle leaves the store.
  private changedFor(entry: MemoryEntry): void {
    this.deps.host.changed(
      entry.scope === 'personal'
        ? { scope: 'personal' }
        : { scope: entry.scope, id: entry.id }
    );
  }

  // A supersede or retire target among every store the viewer can see, so a
  // personal write naming a team entry is told why (invalid), not "not found".
  private findVisible(viewer: Viewer, ref: string): MemoryEntry | null {
    try {
      return this.resolve(viewer, ref).entry;
    } catch (err) {
      if (err instanceof MemoryError && err.code === 'not-found') return null;
      throw err;
    }
  }

  // One row of the operator's personal activity (the Inbox undo list).
  private logActivity(
    store: MemoryStore,
    kind: ActivityRow['kind'],
    memoryId: string | null,
    principal: Principal,
    summary: string
  ): void {
    const at = this.now();
    store.appendActivity({
      id: this.ids.activity(Date.parse(at)),
      at,
      kind,
      memoryId,
      runId: runIdOf(principal),
      summary,
    });
  }

  // Hits merged from several stores: bm25, then the index rank. LIKE mode
  // has no score, so its hits rank by recency.
  private compareHits(a: Hit, b: Hit, ctx: RankContext): number {
    const x = a.located.entry;
    const y = b.located.entry;
    if (this.searchMode() === 'like') {
      const byRecency = y.updatedAt.localeCompare(x.updatedAt);
      return byRecency !== 0 ? byRecency : x.id.localeCompare(y.id);
    }
    const byScore = a.score - b.score;
    if (byScore !== 0) return byScore;
    return compareRank(
      { entry: x, matched: true, score: a.score },
      { entry: y, matched: true, score: b.score },
      ctx
    );
  }

  private rankContext(taskId: string | null): RankContext {
    if (taskId === null) return { taskId: null, epic: null };
    return { taskId, epic: this.deps.host.taskContext(taskId)?.epic ?? null };
  }

  // The stores a viewer reads, each with its scope filter; a personal store
  // that will not open is skipped and reported through `onPersonalDown`.
  private stores(
    viewer: Viewer,
    scope: MemoryScope | undefined,
    onPersonalDown?: () => void
  ): ScopedStore[] {
    const out: ScopedStore[] = [];
    const shared = sharedScopesFor(viewer).filter(
      (s) => scope === undefined || s === scope
    );
    if (shared.length > 0)
      out.push({
        store: this.deps.stores.shared(),
        filter: { scopes: shared },
      });
    const identity = personalIdentityFor(viewer);
    if (identity !== null && (scope === undefined || scope === 'personal')) {
      try {
        out.push({
          store: this.deps.stores.personal(identity),
          filter: {
            scopes: ['personal'],
            projectKey: this.deps.host.projectKey(),
          },
        });
      } catch (err) {
        if (!(err instanceof MemoryError)) throw err;
        onPersonalDown?.();
      }
    }
    return out;
  }

  private visible(
    viewer: Viewer,
    filter: EntryFilter,
    scope?: MemoryScope
  ): Located[] {
    return this.stores(viewer, scope).flatMap(({ store, filter: scoped }) =>
      store
        .listEntries({ ...filter, ...scoped })
        .map((entry) => ({ entry, store }))
    );
  }

  private locate(viewer: Viewer, id: string): Located | null {
    for (const { store, filter } of this.stores(viewer, undefined)) {
      const entry = store.getEntry(id);
      if (entry !== null && (filter.scopes ?? []).includes(entry.scope))
        return { entry, store };
    }
    return null;
  }

  // A handle or id among entries the viewer can see; a decider asking for
  // someone else's personal entry by id is told why (403), everyone else 404.
  private resolve(viewer: Viewer, ref: string): Located {
    const parsed = parseMemoryRef(ref);
    if (parsed.kind === 'id') {
      const found = this.locate(viewer, parsed.id);
      if (found !== null) return found;
      const owner = this.deps.stores.locatePersonal?.(parsed.id) ?? null;
      if (
        owner !== null &&
        viewer.principal.kind === 'human' &&
        viewer.principal.canDecide
      )
        throw new MemoryError(
          'forbidden',
          'that is another human’s personal memory',
          'id'
        );
      throw new MemoryError(
        'not-found',
        `no memory ${parsed.id} you can see`,
        'id'
      );
    }
    const matches = this.stores(viewer, undefined).flatMap(
      ({ store, filter }) =>
        store
          .entriesByHandle(parsed.handle)
          .filter((entry) => (filter.scopes ?? []).includes(entry.scope))
          .map((entry) => ({ entry, store }))
    );
    if (matches.length === 0)
      throw new MemoryError(
        'not-found',
        `no memory ${parsed.handle} you can see`,
        'id'
      );
    if (matches.length > 1)
      throw new MemoryError(
        'conflict',
        `${parsed.handle} matches ${matches.map((m) => m.entry.id).join(' and ')}; use the full id`,
        'id'
      );
    return matches[0];
  }

  // Runs leave a recalls row; humans and external agents only bump the entry.
  private recall(
    located: Located,
    principal: Principal,
    via: 'search' | 'read'
  ): void {
    located.store.recordRecall(located.entry.id, {
      runId: runIdOf(principal),
      via,
      at: this.now(),
      countsAsUse: true,
    });
  }
}
