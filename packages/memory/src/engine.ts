import type { MemoryConfig } from '@dispatch/core';

import { MemoryError } from './errors.js';
import { parseMemoryRef } from './handle.js';
import type { MemoryHost, MemoryStores } from './host.js';
import { cutUtf8 } from './limits.js';
import { queryTerms, relevanceTerms } from './query.js';
import { compareRank, rankEntries, reaches, specificity } from './rank.js';
import type { RankContext, Ranked } from './rank.js';
import { renderIndex } from './render.js';
import type { IndexVariant, RenderedIndex } from './render.js';
import type { SearchMode } from './schema.js';
import type { EntryFilter, MemoryStore } from './store.js';
import { displayState } from './types.js';
import type {
  DisplayState,
  MemoryEntry,
  MemoryKind,
  MemoryScope,
  MemoryTrust,
  Principal,
  Revision,
} from './types.js';
import { validateQuery } from './validate.js';
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

// Reads memory for a principal across the shared store and their operator's
// personal store, applying the one visibility rule to every path.
export class MemoryEngine {
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

  private now(): string {
    return this.deps.host.now().toISOString();
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
