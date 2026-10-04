import type {
  DocSaveResult,
  DocScope,
  DocStatus,
  LinkRel,
  LinkTarget,
  LinkTargetType,
  ProposalState,
} from '@dispatch/core';
import {
  DOC_STATUSES,
  DOCS_LIMITS,
  LINK_RELS,
  LINK_TARGET_TYPES,
} from '@dispatch/core';

import type { ApiContext } from '../api.js';
import { humanOperator, requestActor } from '../api/caller.js';
import { errorResponse, jsonResponse } from '../api/http.js';
import { retryWhileBusy } from '../api/storageErrors.js';
import { MAX_ASSET_BYTES } from './assets.js';
import { DocConflictError, DOCS_ERROR_STATUS, DocsError } from './errors.js';
import { readBoundedBytes, readBoundedJson } from './http.js';
import { parseOps } from './ops.js';
import { indexLineText } from './prompt.js';
import type { DocsActor, DocsService } from './service.js';
import type { ImportFile } from './transfer.js';

// /api/docs* over DocsService. api.ts resolves the principal before this runs;
// every DocsError maps to its status here.

// A body that could not be read (413, 415, 400), carried out of a handler.
class BodyRefused extends Error {
  constructor(readonly response: Response) {
    super('request body refused');
  }
}

const invalid = (field: string, why: string): DocsError =>
  new DocsError('invalid', `${field}: ${why}`, field);

function str(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalid(field, 'expected a string');
  return value;
}

function optStr(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : str(value, field);
}

// A path segment, percent-decoded; a malformed escape is the caller's error.
function decode(segment: string, field: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw invalid(field, 'malformed percent-encoding');
  }
}

// A revision number or a rev- id; digits alone read as a number.
function revRef(value: unknown, field: string): string | number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && value !== '') {
    return /^\d+$/.test(value) ? Number(value) : value;
  }
  throw invalid(field, 'expected a revision number or rev- id');
}

// "task:t-…", "run:r-…", "thread:m-…", "memory:mem-…" or "doc:<handle or id>".
function parseTarget(value: unknown, field: string): LinkTarget {
  const text = str(value, field);
  const colon = text.indexOf(':');
  const type = text.slice(0, colon) as LinkTargetType;
  const id = text.slice(colon + 1);
  if (
    colon < 1 ||
    !LINK_TARGET_TYPES.includes(type) ||
    id === '' ||
    id.length > 512
  ) {
    throw invalid(
      field,
      'expected task:, run:, thread:, memory: or doc: and an id'
    );
  }
  return { type, id };
}

function rel(value: unknown, field: string): LinkRel {
  const text = str(value, field);
  if (!LINK_RELS.includes(text as LinkRel)) {
    throw invalid(field, 'expected spec, plan or context');
  }
  return text as LinkRel;
}

function scope(value: string | null): DocScope | undefined {
  if (value === null || value === '') return undefined;
  if (value !== 'team' && value !== 'personal') {
    throw invalid('scope', 'expected team or personal');
  }
  return value;
}

function status(value: unknown, field: string): DocStatus {
  const text = str(value, field);
  if (!DOC_STATUSES.includes(text as DocStatus)) {
    throw invalid(field, 'expected draft, accepted or archived');
  }
  return text as DocStatus;
}

const PROPOSAL_STATES: readonly ProposalState[] = [
  'open',
  'approved',
  'rejected',
  'expired',
  'withdrawn',
  'failed',
];

// `?state=open,approved`: the proposal states to list, or all of them.
function proposalStates(value: string | null): ProposalState[] | undefined {
  if (value === null || value === '') return undefined;
  return value.split(',').map((raw) => {
    if (!PROPOSAL_STATES.includes(raw as ProposalState)) {
      throw invalid('state', `expected one of ${PROPOSAL_STATES.join(', ')}`);
    }
    return raw as ProposalState;
  });
}

// A proposed write answers with its gate, raised here if the proposal has none.
async function withGate(
  docs: DocsService,
  result: DocSaveResult
): Promise<DocSaveResult> {
  if (
    result.status !== 'proposed' ||
    result.proposal === undefined ||
    result.gate !== undefined
  )
    return result;
  const gate = await docs.ensureGate(result.proposal);
  return gate === null ? result : { ...result, gate };
}

function int(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return undefined;
  if (!/^\d+$/.test(raw))
    throw invalid(name, 'expected a non-negative integer');
  return Number(raw);
}

const flag = (url: URL, name: string): boolean =>
  url.searchParams.get(name) === '1';

// The create body's links: [{ target: "task:t-…", rel }].
function links(
  value: unknown
): { target: LinkTarget; rel: LinkRel }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalid('links', 'expected a list');
  return value.map((raw: unknown, i) => {
    const field = `links[${i}]`;
    if (typeof raw !== 'object' || raw === null) {
      throw invalid(field, 'expected an object');
    }
    const link = raw as Record<string, unknown>;
    return {
      target: parseTarget(link.target, `${field}.target`),
      rel: rel(link.rel, `${field}.rel`),
    };
  });
}

// An ISO-8601 timestamp, returned in its canonical toISOString form.
function isoTime(value: unknown, field: string): string {
  const ms = Date.parse(str(value, field));
  if (Number.isNaN(ms)) throw invalid(field, 'expected an ISO timestamp');
  return new Date(ms).toISOString();
}

// An import manifest: [{ path, name, mtime, bytes, hash }].
function importManifest(value: unknown): ImportFile[] {
  if (!Array.isArray(value)) throw invalid('files', 'expected a list');
  return value.map((raw: unknown, i) => {
    const field = `files[${i}]`;
    if (typeof raw !== 'object' || raw === null) {
      throw invalid(field, 'expected an object');
    }
    const f = raw as Record<string, unknown>;
    if (
      typeof f.bytes !== 'number' ||
      !Number.isInteger(f.bytes) ||
      f.bytes < 0
    ) {
      throw invalid(`${field}.bytes`, 'expected a byte count');
    }
    return {
      path: str(f.path, `${field}.path`),
      name: str(f.name, `${field}.name`),
      mtime: isoTime(f.mtime, `${field}.mtime`),
      bytes: f.bytes,
      hash: str(f.hash, `${field}.hash`),
    };
  });
}

// /api/docs/imports*: open a session, upload raw contents, commit or drop it.
async function importRoute(
  req: Request,
  docs: DocsService,
  actor: DocsActor,
  rest: readonly string[],
  url: URL,
  body: () => Promise<Record<string, unknown>>
): Promise<Response | null> {
  const method = req.method;
  if (rest.length === 1 && method === 'POST') {
    const b = await body();
    const link = b.link === undefined ? null : parseTarget(b.link, 'link');
    const opened = docs.openImport(actor, {
      files: importManifest(b.files),
      link,
    });
    return jsonResponse(opened, 201);
  }
  if (rest.length < 2) return null;
  const id = decode(rest[1], 'import');
  if (rest.length === 4 && rest[2] === 'contents' && method === 'PUT') {
    // A cross-origin page cannot send this content type without a preflight.
    if (req.headers.get('content-type') !== 'application/octet-stream') {
      return errorResponse(
        415,
        'expected content-type: application/octet-stream'
      );
    }
    const hash = decode(rest[3], 'hash');
    docs.admitImportContent(actor, id, hash);
    const bytes = await readBoundedBytes(req, DOCS_LIMITS.importContentBytes);
    if (bytes instanceof Response) return bytes;
    docs.putImportContent(actor, id, hash, bytes);
    return new Response(null, { status: 204 });
  }
  if (rest.length === 3 && rest[2] === 'commit' && method === 'POST') {
    await body();
    return jsonResponse(docs.commitImport(actor, id, flag(url, 'dryRun')));
  }
  if (rest.length === 2 && method === 'DELETE') {
    docs.deleteImport(actor, id);
    return new Response(null, { status: 204 });
  }
  return null;
}

function errorFor(err: DocsError): Response {
  const body: Record<string, unknown> = { error: err.message, code: err.code };
  if (err.field !== undefined) body.field = err.field;
  if (err instanceof DocConflictError) Object.assign(body, err.conflict);
  return jsonResponse(body, DOCS_ERROR_STATUS[err.code]);
}

const MAX_IDEMPOTENCY_KEYS = 500;
const idempotency = new WeakMap<
  DocsService,
  Map<string, Promise<{ status: number; body: unknown }>>
>();

// Replays the first answer to a repeated Idempotency-Key from the same
// principal on the same route; a failed attempt is forgotten.
async function once(
  req: Request,
  docs: DocsService,
  actor: DocsActor,
  route: string,
  run: () => Promise<Response>
): Promise<Response> {
  const key = req.headers.get('idempotency-key');
  if (key === null || key === '') return run();
  let cache = idempotency.get(docs);
  if (cache === undefined) {
    cache = new Map();
    idempotency.set(docs, cache);
  }
  const k = `${actor.address}\n${route}\n${key}`;
  let pending = cache.get(k);
  if (pending === undefined) {
    pending = run().then(async (res) => ({
      status: res.status,
      body: res.status === 204 ? null : await res.json(),
    }));
    cache.set(k, pending);
    if (cache.size > MAX_IDEMPOTENCY_KEYS) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  try {
    const answer = await pending;
    if (answer.status >= 400) cache.delete(k);
    return answer.status === 204
      ? new Response(null, { status: 204 })
      : jsonResponse(answer.body, answer.status);
  } catch (err) {
    cache.delete(k);
    throw err;
  }
}

// Starts the publish task's run as the human who asked (MEM-R5..R8: the
// operator is theirs, the owner only with the owner credential). The task
// stands either way, so a failed dispatch is reported rather than thrown.
async function dispatchPublish(
  ctx: Pick<ApiContext, 'orchestrator'>,
  task: string,
  as: { actor: string; operator: string | null }
): Promise<{ run: string | null; dispatchError: string | null }> {
  try {
    const run = await ctx.orchestrator.dispatch(
      task,
      ctx.orchestrator.defaultExecutorName(),
      as
    );
    return { run: run.id, dispatchError: null };
  } catch (err) {
    return {
      run: null,
      dispatchError: err instanceof Error ? err.message : String(err),
    };
  }
}

// Boot, after reconcileOnBoot: an open publish that asked for a run and has
// none (a crash between its row and its dispatch) starts as who asked.
export async function redispatchPublishes(
  docs: DocsService,
  orchestrator: ApiContext['orchestrator']
): Promise<void> {
  const ran = new Set(orchestrator.list().map((r) => r.taskId));
  for (const p of docs.publishesToDispatch()) {
    if (ran.has(p.task)) continue;
    const out = await dispatchPublish({ orchestrator }, p.task, {
      actor: p.actor,
      operator: p.operator,
    });
    if (out.dispatchError !== null)
      console.error(
        `dispatchd: publish ${p.task} did not start again: ${out.dispatchError}`
      );
  }
}

// Routes /api/docs/<rest>; null when nothing here matches, so api.ts 404s.
export async function handleDocsRoute(
  req: Request,
  ctx: ApiContext,
  rest: readonly string[],
  url: URL
): Promise<Response | null> {
  const principal = ctx.principal;
  if (principal === undefined) {
    throw new Error('docs route reached with no resolved principal');
  }
  const docs = ctx.docs;
  const method = req.method;
  try {
    const actor = docs.actorFor(principal);
    // Read once and kept, so a write retried on a busy docs.db sees it again.
    let parsedBody: Promise<Record<string, unknown>> | null = null;
    const body = (): Promise<Record<string, unknown>> => {
      parsedBody ??= readBoundedJson(req).then((parsed) => {
        if (!parsed.ok) throw new BodyRefused(parsed.response);
        return parsed.value;
      });
      return parsedBody;
    };
    const write = (fn: () => Promise<Response>): Promise<Response> =>
      once(req, docs, actor, `${method} ${url.pathname}`, () =>
        retryWhileBusy(fn)
      );

    if (rest.length === 0) {
      if (method === 'GET') {
        const wanted = url.searchParams.get('status');
        return jsonResponse(
          docs.list(actor, {
            taskId: url.searchParams.get('taskId') ?? undefined,
            scope: scope(url.searchParams.get('scope')),
            status: wanted === null ? undefined : status(wanted, 'status'),
            unreviewed: flag(url, 'unreviewed'),
            conflicted: flag(url, 'conflicted'),
            query: url.searchParams.get('q') ?? undefined,
            includeArchived: flag(url, 'includeArchived'),
            limit: int(url, 'limit'),
            offset: int(url, 'offset'),
          })
        );
      }
      if (method === 'POST') {
        return await write(async () => {
          const b = await body();
          const result = docs.create(actor, {
            title: str(b.title, 'title'),
            body: str(b.body, 'body'),
            slug: optStr(b.slug, 'slug'),
            scope: scope(optStr(b.scope, 'scope') ?? null),
            links: links(b.links),
          });
          return jsonResponse(result, 201);
        });
      }
      return null;
    }

    const head = rest[0];
    if (head === 'imports')
      return await importRoute(req, docs, actor, rest, url, body);
    if (rest.length === 1 && method === 'GET') {
      if (head === 'search') {
        const hits = docs.search(actor, {
          query: url.searchParams.get('q') ?? '',
          scope: scope(url.searchParams.get('scope')),
          includeArchived: flag(url, 'includeArchived'),
          limit: int(url, 'limit'),
        });
        return jsonResponse({ hits });
      }
      if (head === 'links') {
        const target = parseTarget(url.searchParams.get('target'), 'target');
        return jsonResponse({ docs: docs.linking(actor, target) });
      }
      if (head === 'health') return jsonResponse(docs.health(actor));
      if (head === 'proposals') {
        const proposals = docs.proposals(actor, {
          doc: url.searchParams.get('doc') ?? undefined,
          state: proposalStates(url.searchParams.get('state')),
        });
        return jsonResponse({ proposals });
      }
      if (head === 'index') {
        const taskId = url.searchParams.get('taskId');
        if (taskId === null || taskId === '')
          throw invalid('taskId', 'required');
        return jsonResponse({
          lines: docs.indexLines(actor, taskId).map(indexLineText),
        });
      }
    }

    if (head === 'proposals' && rest.length === 2 && method === 'GET') {
      return jsonResponse(docs.proposal(actor, decode(rest[1], 'rev')));
    }
    const ref = decode(head, 'doc');
    if (rest.length === 1) {
      if (method === 'GET') {
        const rev = url.searchParams.get('rev');
        return jsonResponse(
          docs.read(actor, ref, {
            rev: rev === null ? undefined : revRef(rev, 'rev'),
            section: url.searchParams.get('section') ?? undefined,
            offset: int(url, 'offset'),
            page: flag(url, 'page'),
          })
        );
      }
      if (method === 'PATCH') {
        const slug = str((await body()).slug, 'slug');
        return jsonResponse(docs.rename(actor, ref, slug));
      }
      if (method === 'DELETE') {
        docs.remove(actor, ref);
        return new Response(null, { status: 204 });
      }
      return null;
    }

    const action = rest[1];
    if (rest.length === 2 && method === 'PUT' && action === 'body') {
      return await write(async () => {
        const b = await body();
        return jsonResponse(
          await withGate(
            docs,
            docs.saveBody(actor, ref, {
              baseRev: revRef(b.baseRev, 'baseRev'),
              baseHash: optStr(b.baseHash, 'baseHash'),
              body: str(b.body, 'body'),
              title: optStr(b.title, 'title'),
            })
          )
        );
      });
    }
    if (rest.length === 2 && method === 'POST') {
      switch (action) {
        case 'edit':
          return await write(async () => {
            const b = await body();
            return jsonResponse(
              await withGate(
                docs,
                docs.edit(actor, ref, {
                  ops: parseOps(b.ops),
                  baseRev:
                    b.baseRev === undefined
                      ? undefined
                      : revRef(b.baseRev, 'baseRev'),
                })
              )
            );
          });
        case 'status':
          return await write(async () => {
            const wanted = status((await body()).status, 'status');
            return jsonResponse(docs.setStatus(actor, ref, wanted));
          });
        case 'publish':
          return await write(async () => {
            const b = await body();
            if (b.dispatch !== undefined && typeof b.dispatch !== 'boolean')
              throw invalid('dispatch', 'expected a boolean');
            const out = docs.publish(actor, ref, {
              path: str(b.path, 'path'),
              idempotencyKey: req.headers.get('idempotency-key') ?? undefined,
              ...(b.dispatch === false
                ? {}
                : {
                    dispatchAs: {
                      actor: requestActor(ctx),
                      operator: humanOperator(ctx),
                    },
                  }),
            });
            const ran = ctx.orchestrator
              .list()
              .filter((r) => r.taskId === out.task)
              .at(-1);
            const { existing, ...rest } = out;
            return jsonResponse(
              {
                ...rest,
                ...(ran !== undefined
                  ? { run: ran.id, dispatchError: null }
                  : b.dispatch === false
                    ? { run: null, dispatchError: null }
                    : await dispatchPublish(ctx, out.task, {
                        actor: requestActor(ctx),
                        operator: humanOperator(ctx),
                      })),
              },
              existing ? 200 : 201
            );
          });
        case 'reviewed':
          await body();
          return jsonResponse(docs.markReviewed(actor, ref));
        case 'seal':
          await body();
          return jsonResponse(docs.seal(actor, ref));
        case 'revert':
          return await write(async () => {
            const rev = revRef((await body()).rev, 'rev');
            return jsonResponse(
              await withGate(docs, docs.revert(actor, ref, rev))
            );
          });
        case 'links':
          return await write(async () => {
            const b = await body();
            const linked = docs.link(actor, ref, {
              target: parseTarget(b.target, 'target'),
              rel: rel(b.rel, 'rel'),
              replace: b.replace === true,
            });
            return jsonResponse({ links: linked });
          });
        case 'assets': {
          // A cross-origin page cannot send this content type without a preflight.
          if (req.headers.get('content-type') !== 'application/octet-stream')
            return errorResponse(
              415,
              'expected content-type: application/octet-stream'
            );
          // Who may write, and the doc's room, are answered before any body is read.
          docs.assetUploadAllowed(actor, ref);
          const bytes = await readBoundedBytes(req, MAX_ASSET_BYTES);
          if (bytes instanceof Response) return bytes;
          return jsonResponse(docs.putAsset(actor, ref, bytes), 201);
        }
        case 'share-linear':
          return await write(async () => {
            await body();
            const documentId = await ctx.linearSync.shareDocument(actor, ref);
            return jsonResponse({ documentId }, 201);
          });
        case 'promote':
          return await write(async () => {
            await body();
            return jsonResponse(docs.promote(actor, ref), 201);
          });
        default:
          return null;
      }
    }
    if (rest.length === 2 && method === 'GET') {
      if (action === 'revisions') {
        const revisions = docs.revisions(actor, ref, {
          before: int(url, 'before'),
          limit: int(url, 'limit'),
        });
        return jsonResponse({ revisions });
      }
      if (action === 'diff') {
        const from = revRef(url.searchParams.get('from'), 'from');
        const to = revRef(url.searchParams.get('to'), 'to');
        return jsonResponse(docs.diff(actor, ref, from, to));
      }
    }
    if (rest.length === 3 && method === 'GET' && action === 'assets') {
      const name = decode(rest[2], 'name');
      const { bytes, mime } = docs.assetBytes(actor, ref, name);
      // Served as an inert image: typed by its bytes, never sniffed, sandboxed.
      return new Response(bytes, {
        headers: {
          'content-type': mime,
          'x-content-type-options': 'nosniff',
          'content-disposition': `inline; filename="${name}"`,
          'content-security-policy': "default-src 'none'; sandbox",
          'cache-control': 'private, max-age=3600',
        },
      });
    }
    if (rest.length === 3 && method === 'GET' && action === 'revisions') {
      const rev = revRef(decode(rest[2], 'rev'), 'rev');
      return jsonResponse(docs.revision(actor, ref, rev));
    }
    if (rest.length === 4 && method === 'DELETE' && action === 'links') {
      const target = parseTarget(
        `${decode(rest[2], 'target')}:${decode(rest[3], 'target')}`,
        'target'
      );
      return jsonResponse({ links: docs.unlink(actor, ref, target) });
    }
    return null;
  } catch (err) {
    if (err instanceof DocsError) return errorFor(err);
    if (err instanceof BodyRefused) return err.response;
    throw err;
  }
}
