import {
  kindFromClaudeType,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MemoryError,
  parseMemoryFile,
  personalIdentityFor,
  projectOnlyForClaudeType,
  rankEntries,
  refuseA2A,
  renderIndex,
} from '@dispatch/memory';
import type {
  MemoryEntry,
  MemoryStore,
  MemoryTrust,
  Principal,
  ProposalState,
  RankContext,
  RecallRow,
  RenderedIndex,
  SaveInput,
  SaveResult,
  SqliteMemoryStore,
} from '@dispatch/memory';
import type { Ref } from '@dispatch/protocol';
import { basename } from 'node:path';

import type { ApiContext } from '../api.js';
import {
  jsonResponse,
  readJsonBody,
  readJsonBodyOptional,
} from '../api/http.js';
import { rosterEmailOf } from './host.js';
import type { MemoryIdentities } from './identities.js';
import { renderImportReport } from './ledgerImport.js';
import type { MemoryService } from './service.js';

// Every line of a rebuilt index was already inside the budget when the run got it.
const RECALLED_INDEX_TOKENS = 4000;
const LIST_STATES = ['active', 'stale', 'retired', 'all'] as const;
const ORIGIN_SOURCES = ['ledger', 'claude', 'amendment'] as const;
const TRUST_LEVELS: readonly MemoryTrust[] = ['human', 'confirmed', 'agent'];
const INGEST_PROBLEMS_SHOWN = 200;
// The roster email `dispatch init` writes, which tells no two people apart.
const PLACEHOLDER_EMAIL = 'local@localhost';
const PROPOSAL_STATES: readonly ProposalState[] = [
  'open',
  'approved',
  'rejected',
  'expired',
];
const DAY_MS = 24 * 3_600_000;
// Idempotency-Keys remembered per daemon, oldest forgotten first.
const SAVE_REPLAY_KEYS = 500;
// Set by Dispatch's own importers and ingest, never by a client.
const INTERNAL_FIELDS = ['origin', 'cause'] as const;
const ENTRY_ACTIONS = [
  'retire',
  'undo',
  'confirm',
  'pin',
  'unpin',
  'promote',
] as const;

type Body = Record<string, unknown>;

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

function requireIdentities(ctx: ApiContext): MemoryIdentities {
  const identities = ctx.memory.identities;
  if (identities === null)
    throw new MemoryError(
      'unavailable',
      'personal memory identities unavailable',
      'store'
    );
  return identities;
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

// An id or a #handle from a path segment (a handle is sent as %23…).
function refOf(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new MemoryError('invalid', 'id: malformed percent-encoding', 'id');
  }
}

function invalidField(name: string, expected: string): MemoryError {
  return new MemoryError('invalid', `${name}: expected ${expected}`, name);
}

function stringField(body: Body, name: string): string {
  const value = body[name];
  if (typeof value !== 'string') throw invalidField(name, 'a string');
  return value;
}

function optionalString(body: Body, name: string): string | undefined {
  return body[name] === undefined ? undefined : stringField(body, name);
}

function optionalNullableString(
  body: Body,
  name: string
): string | null | undefined {
  return body[name] === null ? null : optionalString(body, name);
}

function optionalStrings(body: Body, name: string): string[] | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
    throw invalidField(name, 'a list of strings');
  return value;
}

function optionalBoolean(body: Body, name: string): boolean | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalidField(name, 'true or false');
  return value;
}

// Refs are checked item by item by the engine's validation.
function optionalRefs(body: Body): Ref[] | undefined {
  const value = body.refs;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalidField('refs', 'a list');
  return value as Ref[];
}

// The body a client may send: `origin` and `cause` would let it pose as an
// import, skipping the proposal limits and claiming a ledger row's origin.
function saveInputOf(body: Body): SaveInput {
  for (const field of INTERNAL_FIELDS)
    if (body[field] !== undefined)
      throw new MemoryError(
        'invalid',
        `${field}: set by Dispatch, not by a client`,
        field
      );
  const scope = stringField(body, 'scope');
  const kind = stringField(body, 'kind');
  return {
    scope: scope as SaveInput['scope'],
    kind: kind as SaveInput['kind'],
    title: stringField(body, 'title'),
    body: stringField(body, 'body'),
    refs: optionalRefs(body),
    epic: optionalNullableString(body, 'epic'),
    appliesTo: optionalStrings(body, 'appliesTo'),
    supersedes: optionalNullableString(body, 'supersedes'),
    projectOnly: optionalBoolean(body, 'projectOnly'),
  };
}

// A POST body, or the 400/415 response for one that is not JSON.
async function bodyOf(
  req: Request,
  optional: boolean
): Promise<{ ok: true; value: Body } | { ok: false; response: Response }> {
  if (optional) return readJsonBodyOptional(req);
  const parsed = await readJsonBody(req);
  return parsed.ok ? { ok: true, value: parsed.value as Body } : parsed;
}

const saveCaches = new WeakMap<
  MemoryService,
  Map<string, Promise<SaveResult>>
>();

// The first save or retire under (action, principal, Idempotency-Key) answers
// every repeat; a failed one is forgotten so a retry runs again.
function idempotentSave(
  service: MemoryService,
  key: string,
  save: () => Promise<SaveResult>
): { result: Promise<SaveResult>; replayed: boolean } {
  let cache = saveCaches.get(service);
  if (cache === undefined) {
    cache = new Map();
    saveCaches.set(service, cache);
  }
  const hit = cache.get(key);
  if (hit !== undefined) return { result: hit, replayed: true };
  const result = save();
  cache.set(key, result);
  const held = cache;
  result.catch(() => {
    if (held.get(key) === result) held.delete(key);
  });
  if (cache.size > SAVE_REPLAY_KEYS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return { result, replayed: false };
}

// The human a run acts for and the personal store it wrote to, as the
// engine sees them; an A2A run, or a run acting for no one, has neither.
function runPersonal(
  ctx: ApiContext,
  runId: string
): { human: string | null; store: MemoryStore | null } {
  const viewer = ctx.memory
    .requireEngine()
    .viewer({ address: `run:${runId}`, canDecide: false, kind: 'run' });
  const human = viewer.operator?.human ?? null;
  const identity = personalIdentityFor(viewer);
  if (identity === null) return { human, store: null };
  try {
    return { human, store: ctx.memory.personal.personal(identity) };
  } catch (err) {
    if (err instanceof MemoryError) return { human, store: null };
    throw err;
  }
}

// A run's recalls and rebuilt index answer the run itself, its operator and
// decide-tier humans.
function requireRunReader(
  principal: Principal,
  runId: string,
  operator: string | null
): void {
  if (principal.address === `run:${runId}`) return;
  if (principal.kind === 'human' && principal.address === operator) return;
  if (principal.kind === 'human' && principal.canDecide) return;
  throw new MemoryError(
    'forbidden',
    "only the run itself, its operator or a decide-tier human reads a run's memory",
    'runId'
  );
}

// Only the run and its operator see the run's personal recalls.
function seesPersonal(
  principal: Principal,
  runId: string,
  operator: string | null
): boolean {
  return (
    principal.address === `run:${runId}` ||
    (principal.kind === 'human' && principal.address === operator)
  );
}

function indexJson(out: RenderedIndex, personalHidden: number) {
  return {
    text: out.text,
    included: out.included.map((e) => e.handle),
    omitted: out.omitted,
    pinnedOverflow: out.pinnedOverflow,
    personalHidden,
  };
}

// The distinct entries of `store` a run's index showed it.
function indexedEntries(store: MemoryStore, runId: string): MemoryEntry[] {
  const seen = new Set<string>();
  const entries: MemoryEntry[] = [];
  for (const recall of store.recallsForRun(runId)) {
    if (recall.via !== 'index' || seen.has(recall.memoryId)) continue;
    seen.add(recall.memoryId);
    const entry = store.getEntry(recall.memoryId);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

// The index a run got, rebuilt from its `index` recalls and ranked in its
// task's context; personal lines the caller may not see are only counted.
function recalledIndex(
  ctx: ApiContext,
  runId: string,
  personal: MemoryStore | null,
  showPersonal: boolean
): { out: RenderedIndex; personalHidden: number } {
  const shared = requireShared(ctx);
  const taskId = ctx.orchestrator.getRun(runId)?.meta.taskId ?? null;
  const epic =
    taskId === null
      ? null
      : (ctx.memory.host.taskContext(taskId)?.epic ?? null);
  const rankCtx: RankContext = { taskId, epic };
  const entries = indexedEntries(shared, runId);
  const own = personal === null ? [] : indexedEntries(personal, runId);
  if (showPersonal) entries.push(...own);
  const personalHidden = showPersonal ? 0 : own.length;
  const ranked = rankEntries(
    entries.map((entry) => ({ entry, matched: false, score: 0 })),
    rankCtx
  );
  const out = renderIndex(
    ranked.map((r) => r.entry),
    { budgetTokens: RECALLED_INDEX_TOKENS, variant: 'tools', ctx: rankCtx }
  );
  if (personalHidden === 0) return { out, personalHidden };
  const note = `(${personalHidden} personal lines hidden)`;
  return {
    out: { ...out, text: out.text === null ? note : `${out.text}\n${note}` },
    personalHidden,
  };
}

// GET /api/memory
export function listMemory(ctx: ApiContext, url: URL): Response {
  const principal = requireMemoryPrincipal(ctx);
  const entries = ctx.memory.requireEngine().list(principal, {
    scope: oneOf(url, 'scope', MEMORY_SCOPES),
    kind: oneOf(url, 'kind', MEMORY_KINDS),
    state: oneOf(url, 'state', LIST_STATES),
    taskId: url.searchParams.get('taskId') ?? undefined,
    origin: oneOf(url, 'origin', ORIGIN_SOURCES),
    trust: oneOf(url, 'trust', TRUST_LEVELS),
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
  return jsonResponse(
    ctx.memory.requireEngine().read(principal, refOf(segment))
  );
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
    return jsonResponse(indexJson(out, 0));
  }
  if (runId === null)
    throw new MemoryError(
      'invalid',
      'taskId or runId: one is required',
      'taskId'
    );
  const { human, store } = runPersonal(ctx, runId);
  requireRunReader(principal, runId, human);
  const rebuilt = recalledIndex(
    ctx,
    runId,
    store,
    seesPersonal(principal, runId, human)
  );
  return jsonResponse(indexJson(rebuilt.out, rebuilt.personalHidden));
}

// GET /api/memory/recalls?runId=
export function memoryRecallsRoute(ctx: ApiContext, url: URL): Response {
  const principal = requireMemoryPrincipal(ctx);
  const runId = url.searchParams.get('runId');
  if (runId === null)
    throw new MemoryError('invalid', 'runId: required', 'runId');
  const { human, store } = runPersonal(ctx, runId);
  requireRunReader(principal, runId, human);
  const shared = requireShared(ctx);
  const rows = (from: MemoryStore, recalls: RecallRow[]) =>
    recalls.map((r) => ({
      memoryId: r.memoryId,
      handle: from.getEntry(r.memoryId)?.handle ?? null,
      via: r.via,
      at: r.at,
    }));
  const recalls = rows(shared, shared.recallsForRun(runId));
  const own = store === null ? [] : store.recallsForRun(runId);
  const showPersonal = seesPersonal(principal, runId, human);
  if (showPersonal && store !== null) {
    recalls.push(...rows(store, own));
    recalls.sort((a, b) => a.at.localeCompare(b.at));
  }
  return jsonResponse({
    recalls,
    personalHidden: showPersonal ? 0 : own.length,
  });
}

// GET /api/memory/health
export function memoryHealthRoute(ctx: ApiContext): Response {
  return jsonResponse(ctx.memory.health(requireMemoryPrincipal(ctx)));
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

// POST /api/memory/import/claude[?dryRun=1][&from=<abs dir> | &none=1] — the
// daemon's own human only, since it reads that human's Claude notes.
export async function importClaudeRoute(
  ctx: ApiContext,
  url: URL
): Promise<Response> {
  const principal = requireMemoryPrincipal(ctx);
  if (
    !(
      principal.kind === 'human' &&
      principal.address === ctx.actorContext.humanRef &&
      principal.ownerCredential === true
    )
  )
    throw new MemoryError(
      'forbidden',
      "only the daemon's own human imports its Claude notes",
      'principal'
    );
  const from = url.searchParams.get('from');
  const none = flag(url, 'none') === true;
  if (from !== null && none)
    throw new MemoryError(
      'invalid',
      'from: give from or none, not both',
      'from'
    );
  const report = await ctx.memory.importClaude({
    ...(from === null ? {} : { from }),
    none,
    dryRun: flag(url, 'dryRun') === true,
  });
  return jsonResponse({ report });
}

// POST /api/memory — 201 with the result; a repeated Idempotency-Key gets
// the first result back with 200.
export async function saveMemoryRoute(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const principal = requireMemoryPrincipal(ctx);
  const parsed = await bodyOf(req, false);
  if (!parsed.ok) return parsed.response;
  const input = saveInputOf(parsed.value);
  const engine = ctx.memory.requireEngine();
  const save = () => engine.save(principal, input);
  const key = req.headers.get('idempotency-key');
  if (key === null) return jsonResponse(await save(), 201);
  const { result, replayed } = idempotentSave(
    ctx.memory,
    `save:${principal.address}:${key}`,
    save
  );
  return jsonResponse(await result, replayed ? 200 : 201);
}

// POST /api/memory/:id/{retire,undo,confirm,pin,unpin,promote}; a retire
// replays a repeated Idempotency-Key, as a save does.
export async function memoryActionRoute(
  req: Request,
  ctx: ApiContext,
  segment: string,
  action: string
): Promise<Response | null> {
  if (!(ENTRY_ACTIONS as readonly string[]).includes(action)) return null;
  const principal = requireMemoryPrincipal(ctx);
  const needsBody = action === 'retire' || action === 'promote';
  const parsed = await bodyOf(req, !needsBody);
  if (!parsed.ok) return parsed.response;
  const engine = ctx.memory.requireEngine();
  const ref = refOf(segment);
  switch (action) {
    case 'retire': {
      const forget = () =>
        engine.forget(principal, ref, stringField(parsed.value, 'reason'));
      const key = req.headers.get('idempotency-key');
      if (key === null) return jsonResponse(await forget());
      const { result } = idempotentSave(
        ctx.memory,
        `retire:${principal.address}:${key}`,
        forget
      );
      return jsonResponse(await result);
    }
    case 'undo':
      return jsonResponse(engine.undo(principal, ref));
    case 'confirm':
      return jsonResponse(engine.confirm(principal, ref));
    case 'pin':
    case 'unpin':
      return jsonResponse(engine.setPinned(principal, ref, action === 'pin'));
    case 'promote': {
      const scope = stringField(parsed.value, 'scope');
      if (scope !== 'project' && scope !== 'team')
        throw invalidField('scope', 'project|team');
      return jsonResponse(await engine.promote(principal, ref, scope));
    }
    default:
      return null;
  }
}

// DELETE /api/memory/:id — the entry and its history, for good.
export function deleteMemoryRoute(ctx: ApiContext, segment: string): Response {
  const principal = requireMemoryPrincipal(ctx);
  ctx.memory.requireEngine().hardDelete(principal, refOf(segment));
  return new Response(null, { status: 204 });
}

// GET /api/memory/proposals?state=
export function listProposalsRoute(ctx: ApiContext, url: URL): Response {
  const principal = requireMemoryPrincipal(ctx);
  const proposals = ctx.memory
    .requireEngine()
    .proposals(principal, oneOf(url, 'state', PROPOSAL_STATES));
  return jsonResponse({ proposals });
}

// GET /api/memory/proposals/:id — the proposal with its target then and now.
export function getProposalRoute(ctx: ApiContext, id: string): Response {
  const principal = requireMemoryPrincipal(ctx);
  return jsonResponse(ctx.memory.requireEngine().proposal(principal, id));
}

// GET /api/memory/activity?since= — the caller's own, the last day by default.
export function memoryActivityRoute(ctx: ApiContext, url: URL): Response {
  const principal = requireMemoryPrincipal(ctx);
  const since =
    url.searchParams.get('since') ??
    new Date(Date.now() - DAY_MS).toISOString();
  return jsonResponse({
    activity: ctx.memory.requireEngine().activity(principal, since),
  });
}

// The calling human and their handle in this project; `does` names what only a human does.
function callingHuman(
  ctx: ApiContext,
  does: string
): { principal: Principal; handle: string } {
  const principal = requireMemoryPrincipal(ctx);
  if (principal.kind !== 'human')
    throw new MemoryError('forbidden', `only a human ${does}`, 'principal');
  return { principal, handle: principal.address.slice('human:'.length) };
}

// The calling human's identity and personal store, refused as every personal
// read is: 409 for a reused handle, 503 while identities.db is down.
function ownPersonal(
  ctx: ApiContext,
  principal: Principal
): { identity: string; store: MemoryStore } {
  const identity = ctx.memory.host.operatorOf(principal)?.identity;
  if (identity === undefined)
    throw new MemoryError(
      'forbidden',
      'this principal has no personal memory',
      'principal'
    );
  return { identity, store: ctx.memory.stores.personal(identity) };
}

// GET /api/memory/identity — the caller's personal identity, the handles bound
// to it, and whether their roster email is the placeholder that cannot tell people apart.
export function memoryIdentityRoute(ctx: ApiContext): Response {
  const { principal, handle } = callingHuman(ctx, 'has a memory identity');
  const identities = requireIdentities(ctx);
  const { identity } = ownPersonal(ctx, principal);
  const email = rosterEmailOf(ctx.rootDir, handle);
  return jsonResponse({
    identity,
    aliases: identities.aliasesOf(identity),
    placeholderEmail: email?.trim().toLowerCase() === PLACEHOLDER_EMAIL,
  });
}

// GET /api/memory/ingest-problems — the caller's skipped Claude files, newest first.
export function ingestProblemsRoute(ctx: ApiContext): Response {
  const { principal } = callingHuman(ctx, 'reviews skipped memory files');
  const { store } = ownPersonal(ctx, principal);
  return jsonResponse({
    problems: store.ingestProblems(INGEST_PROBLEMS_SHOWN),
  });
}

// POST /api/memory/ingest-problems/:id/accept — saves a skipped file's kept
// content to the caller's memory with agent trust: an agent wrote it, not the human.
export async function acceptIngestProblemRoute(
  ctx: ApiContext,
  segment: string
): Promise<Response> {
  const { principal, handle } = callingHuman(
    ctx,
    'accepts skipped memory files'
  );
  const engine = ctx.memory.requireEngine();
  const { store } = ownPersonal(ctx, principal);
  const id = refOf(segment);
  // A throw inside the transaction leaves the problem where it was.
  const problem = store.transaction(() => {
    const taken = store.takeIngestProblem(id);
    if (taken === null)
      throw new MemoryError('not-found', `id: no skipped file ${id}`, 'id');
    if (taken.content === null)
      throw new MemoryError(
        'invalid',
        `id: nothing of ${taken.file} was kept to accept`,
        'id'
      );
    return { row: taken, content: taken.content };
  });
  const parsed = parseMemoryFile(problem.content, basename(problem.row.file));
  try {
    const result = await engine.save(
      {
        address: `agent:${handle}/claude-code`,
        canDecide: false,
        kind: 'agent',
      },
      {
        scope: 'personal',
        kind: kindFromClaudeType(parsed.type),
        projectOnly: projectOnlyForClaudeType(parsed.type),
        title: parsed.title,
        body: parsed.body,
        cause: 'ingest',
      }
    );
    return jsonResponse(result, 201);
  } catch (err) {
    // Refused (the hourly write limit, say): the file stays listed to accept later.
    store.addIngestProblem(problem.row);
    throw err;
  }
}

// POST /api/memory/link — a one-time code for linking another project's
// handle to this identity, or with { fresh: true } a new, empty identity.
export async function startLinkRoute(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const { principal, handle } = callingHuman(ctx, 'links personal memory');
  const parsed = await bodyOf(req, true);
  if (!parsed.ok) return parsed.response;
  const identities = requireIdentities(ctx);
  const alias = {
    projectKey: ctx.memory.host.projectKey(),
    handle,
    rosterEmail: rosterEmailOf(ctx.rootDir, handle),
  };
  if (optionalBoolean(parsed.value, 'fresh') !== true)
    return jsonResponse(identities.startLink(alias));
  if (principal.address === ctx.actorContext.humanRef)
    throw new MemoryError(
      'invalid',
      "fresh: the owner's personal memory always stays its own",
      'fresh'
    );
  const identity = identities.startFresh(alias);
  ctx.memory.host.changed({ scope: 'personal' });
  return jsonResponse({ identity });
}

// POST /api/memory/link/:code — binds this handle to the code's identity and
// moves over what the handle held, unless another project still uses it.
export async function completeLinkRoute(
  req: Request,
  ctx: ApiContext,
  code: string
): Promise<Response> {
  const { handle } = callingHuman(ctx, 'links personal memory');
  const parsed = await bodyOf(req, true);
  if (!parsed.ok) return parsed.response;
  const identities = requireIdentities(ctx);
  const { identity, previous } = identities.completeLink({
    code: refOf(code),
    projectKey: ctx.memory.host.projectKey(),
    handle,
    rosterEmail: rosterEmailOf(ctx.rootDir, handle),
  });
  if (previous !== null && identities.aliasesOf(previous).length === 0)
    ctx.memory.personal.move(previous, identity);
  ctx.memory.host.changed({ scope: 'personal' });
  return jsonResponse({ identity });
}
