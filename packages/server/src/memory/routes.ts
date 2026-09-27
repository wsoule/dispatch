import {
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MemoryError,
  rankEntries,
  refuseA2A,
  renderIndex,
} from '@dispatch/memory';
import type {
  MemoryEntry,
  Principal,
  RankContext,
  RenderedIndex,
  SqliteMemoryStore,
} from '@dispatch/memory';

import type { ApiContext } from '../api.js';
import { jsonResponse } from '../api/http.js';
import { renderImportReport } from './ledgerImport.js';

// Every line of a rebuilt index was already inside the budget when the run got it.
const RECALLED_INDEX_TOKENS = 4000;
const LIST_STATES = ['active', 'stale', 'retired', 'all'] as const;

// Narrows ctx.principal (handleApi resolves it for every memory route) and
// refuses A2A clients, which have no access to memory.
function requireMemoryPrincipal(ctx: ApiContext): Principal {
  if (ctx.principal === undefined)
    throw new Error('memory route reached with no resolved principal');
  refuseA2A(ctx.principal);
  return ctx.principal;
}

// The shared store, or MemoryError('unavailable') naming why it did not open.
function requireShared(ctx: ApiContext): SqliteMemoryStore {
  ctx.memory.requireEngine();
  const shared = ctx.memory.shared;
  if (shared === null)
    throw new MemoryError('unavailable', 'memory unavailable', 'store');
  return shared;
}

function oneOf<T extends string>(
  url: URL,
  name: string,
  allowed: readonly T[]
): T | undefined {
  const value = url.searchParams.get(name);
  if (value === null || value === '') return undefined;
  if (!(allowed as readonly string[]).includes(value))
    throw new MemoryError(
      'invalid',
      `${name}: expected ${allowed.join('|')}`,
      name
    );
  return value as T;
}

function count(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new MemoryError(
      'invalid',
      `${name}: expected a positive integer`,
      name
    );
  return n;
}

function flag(url: URL, name: string): boolean | undefined {
  if (!url.searchParams.has(name)) return undefined;
  const value = url.searchParams.get(name);
  return value === '1' || value === 'true';
}

// A run's recalls and rebuilt index answer the run itself and decide-tier humans.
function requireRunReader(principal: Principal, runId: string): void {
  if (principal.address === `run:${runId}`) return;
  if (principal.kind === 'human' && principal.canDecide) return;
  throw new MemoryError(
    'forbidden',
    "only the run itself or a decide-tier human reads a run's memory",
    'runId'
  );
}

function indexJson(out: RenderedIndex) {
  return {
    text: out.text,
    included: out.included.map((e) => e.handle),
    omitted: out.omitted,
    pinnedOverflow: out.pinnedOverflow,
  };
}

// The index a run got, rebuilt from its `index` recalls and ranked in its task's context.
function recalledIndex(ctx: ApiContext, runId: string): RenderedIndex {
  const shared = requireShared(ctx);
  const taskId = ctx.orchestrator.getRun(runId)?.meta.taskId ?? null;
  const epic =
    taskId === null
      ? null
      : (ctx.memory.host.taskContext(taskId)?.epic ?? null);
  const rankCtx: RankContext = { taskId, epic };
  const seen = new Set<string>();
  const entries: MemoryEntry[] = [];
  for (const recall of shared.recallsForRun(runId)) {
    if (recall.via !== 'index' || seen.has(recall.memoryId)) continue;
    seen.add(recall.memoryId);
    const entry = shared.getEntry(recall.memoryId);
    if (entry !== null) entries.push(entry);
  }
  const ranked = rankEntries(
    entries.map((entry) => ({ entry, matched: false, score: 0 })),
    rankCtx
  );
  return renderIndex(
    ranked.map((r) => r.entry),
    { budgetTokens: RECALLED_INDEX_TOKENS, variant: 'tools', ctx: rankCtx }
  );
}

// GET /api/memory
export function listMemory(ctx: ApiContext, url: URL): Response {
  const principal = requireMemoryPrincipal(ctx);
  const entries = ctx.memory.requireEngine().list(principal, {
    scope: oneOf(url, 'scope', MEMORY_SCOPES),
    kind: oneOf(url, 'kind', MEMORY_KINDS),
    state: oneOf(url, 'state', LIST_STATES),
    taskId: url.searchParams.get('taskId') ?? undefined,
    limit: count(url, 'limit'),
  });
  return jsonResponse({ entries });
}

// GET /api/memory/search
export function searchMemory(ctx: ApiContext, url: URL): Response {
  const principal = requireMemoryPrincipal(ctx);
  const engine = ctx.memory.requireEngine();
  const hits = engine.search(principal, {
    query: url.searchParams.get('q') ?? '',
    scope: oneOf(url, 'scope', MEMORY_SCOPES),
    kind: oneOf(url, 'kind', MEMORY_KINDS),
    includeStale: flag(url, 'includeStale'),
    includeRetired: flag(url, 'includeRetired'),
    limit: count(url, 'limit'),
  });
  return jsonResponse({ hits, search: engine.searchMode() });
}

// GET /api/memory/:id — an id or a #handle (sent percent-encoded as %23).
export function getMemory(ctx: ApiContext, segment: string): Response {
  const principal = requireMemoryPrincipal(ctx);
  let ref: string;
  try {
    ref = decodeURIComponent(segment);
  } catch {
    throw new MemoryError('invalid', 'id: malformed percent-encoding', 'id');
  }
  return jsonResponse(ctx.memory.requireEngine().read(principal, ref));
}

// GET /api/memory/index?taskId= renders the caller's own index for a task;
// ?runId= rebuilds, from its index recalls, the index a run got.
export function memoryIndexRoute(ctx: ApiContext, url: URL): Response {
  const principal = requireMemoryPrincipal(ctx);
  const engine = ctx.memory.requireEngine();
  const taskId = url.searchParams.get('taskId');
  const runId = url.searchParams.get('runId');
  if (taskId !== null) {
    const out = engine.index({
      principal,
      taskId,
      runId: null,
      variant: 'tools',
      recordRecalls: false,
    });
    return jsonResponse(indexJson(out));
  }
  if (runId === null)
    throw new MemoryError(
      'invalid',
      'taskId or runId: one is required',
      'taskId'
    );
  requireRunReader(principal, runId);
  return jsonResponse(indexJson(recalledIndex(ctx, runId)));
}

// GET /api/memory/recalls?runId=
export function memoryRecallsRoute(ctx: ApiContext, url: URL): Response {
  const principal = requireMemoryPrincipal(ctx);
  const runId = url.searchParams.get('runId');
  if (runId === null)
    throw new MemoryError('invalid', 'runId: required', 'runId');
  requireRunReader(principal, runId);
  const shared = requireShared(ctx);
  return jsonResponse({
    recalls: shared.recallsForRun(runId).map((r) => ({
      memoryId: r.memoryId,
      handle: shared.getEntry(r.memoryId)?.handle ?? null,
      via: r.via,
      at: r.at,
    })),
  });
}

// GET /api/memory/health
export function memoryHealthRoute(ctx: ApiContext): Response {
  requireMemoryPrincipal(ctx);
  return jsonResponse(ctx.memory.health());
}

// POST /api/memory/import/ledger[?dryRun=1] — decide tier.
export function importLedgerRoute(ctx: ApiContext, url: URL): Response {
  const principal = requireMemoryPrincipal(ctx);
  if (!(principal.kind === 'human' && principal.canDecide))
    throw new MemoryError(
      'forbidden',
      'the ledger import needs the decide tier',
      'principal'
    );
  const report = ctx.memory.importLedger({
    dryRun: flag(url, 'dryRun') === true,
  });
  if (report === null)
    throw new MemoryError('unavailable', 'memory unavailable', 'store');
  return jsonResponse({ report, text: renderImportReport(report) });
}
