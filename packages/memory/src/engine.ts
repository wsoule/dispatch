import { untrustedInline } from '@dispatch/core';
import type { MemoryConfig } from '@dispatch/core';
import type { Address, Ref } from '@dispatch/protocol';

import { MemoryError } from './errors.js';
import { parseMemoryRef } from './handle.js';
import type { MemoryHost, MemoryStores } from './host.js';
import { cutUtf8 } from './limits.js';
import { queryTerms, relevanceTerms } from './query.js';
import { compareRank, rankEntries, reaches, specificity } from './rank.js';
import type { RankContext, Ranked } from './rank.js';
import { createMemoryIds, insertFresh, newMemoryEntry } from './records.js';
import { renderIndex } from './render.js';
import type { IndexVariant, RenderedIndex } from './render.js';
import type { SearchMode } from './schema.js';
import type { ActivityRow, EntryFilter, MemoryStore } from './store.js';
import { displayState } from './types.js';
import type {
  DisplayState,
  MemoryEntry,
  MemoryKind,
  MemoryScope,
  MemoryTrust,
  Principal,
  ProposalAction,
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
          this.revise(
            store,
            replaced,
            { status: 'active', statusReason: null, supersededBy: null },
            by,
            'undo'
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
    checkOrigin(store, origin);
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
    return { status: 'active', id: entry.id, handle: entry.handle };
  }

  // Shared writes that need a decision; refused until proposals exist.
  private propose(_viewer: Viewer, _input: ProposeInput): Promise<SaveResult> {
    return Promise.reject(
      new MemoryError(
        'forbidden',
        'shared memory from you is a proposal, and this build takes no proposals yet',
        'scope'
      )
    );
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
      runId:
        principal.kind === 'run'
          ? principal.address.slice('run:'.length)
          : null,
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
    const runId =
      principal.kind === 'run' ? principal.address.slice('run:'.length) : null;
    located.store.recordRecall(located.entry.id, {
      runId,
      via,
      at: this.now(),
      countsAsUse: true,
    });
  }
}
