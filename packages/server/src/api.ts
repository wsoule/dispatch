import {
  ASSIGNEES,
  ConfigError,
  KINDS,
  loadConfig,
  PRIORITIES,
  TaskParseError,
  TaskStore,
} from '@dispatch/core';
import type { CreateInput, DispatchConfig, UpdatePatch } from '@dispatch/core';

import type { TaskCache } from './cache.js';
import type { EventBus } from './events.js';

// Everything a request handler needs, bundled so `handleApi` stays a pure
// function of (request, context) instead of reaching for module-level state —
// this is what makes it easy to hit with plain fetch() in tests.
export interface ApiContext {
  rootDir: string;
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
  version: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, status);
}

// Mirrors the CLI's own enum check (packages/cli/src/commands/task.ts
// `validate`), including its exact message shape, without importing across
// the cli/server package boundary — cli is the one that depends on server
// for `dispatch serve`, not the other way around, and this check is small
// enough that duplicating it beats introducing a dependency edge for it.
// Used for status (against the project's configured list), kind, priority,
// and assignee (against core's fixed enums) — `undefined` means the field
// was omitted, which every caller here treats as "no change requested."
function validateEnumField(
  value: unknown,
  allowed: readonly string[],
  label: string
): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return `invalid ${label}: ${String(value)} (expected ${allowed.join('|')})`;
  }
  return null;
}

// Validates that an optional field, if present, is an array of strings —
// used for `labels` and `blockedBy`, both of which core's TaskParseError
// would otherwise only catch after the bad value had already been written to
// a task file (see taskfile.ts's matching `invalid ${key}: expected a list of
// strings`, which this mirrors).
function validateStringArrayField(
  value: unknown,
  label: string
): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    return `invalid ${label}: expected a list of strings`;
  }
  return null;
}

// Validates every field createTask/updateTask accept beyond title, entirely
// before either one touches the store — a request that fails here writes no
// file. `includeKind` is create-only: UpdatePatch has no `kind` field, since
// a task's kind is fixed at creation.
function validateTaskFields(
  value: Record<string, unknown>,
  config: DispatchConfig,
  { includeKind }: { includeKind: boolean }
): string | null {
  if (includeKind) {
    const kindError = validateEnumField(value.kind, KINDS, 'kind');
    if (kindError) return kindError;
  }
  const statusError = validateEnumField(
    value.status,
    config.statuses,
    'status'
  );
  if (statusError) return statusError;
  const priorityError = validateEnumField(
    value.priority,
    PRIORITIES,
    'priority'
  );
  if (priorityError) return priorityError;
  const assigneeError = validateEnumField(
    value.assignee,
    ASSIGNEES,
    'assignee'
  );
  if (assigneeError) return assigneeError;
  const labelsError = validateStringArrayField(value.labels, 'labels');
  if (labelsError) return labelsError;
  const blockedByError = validateStringArrayField(value.blockedBy, 'blockedBy');
  if (blockedByError) return blockedByError;
  return null;
}

async function readJsonBody(
  req: Request
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    const value = await req.json();
    if (typeof value !== 'object' || value === null) {
      return {
        ok: false,
        response: errorResponse(400, 'invalid body: expected a JSON object'),
      };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, response: errorResponse(400, 'invalid JSON body') };
  }
}

async function createTask(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const input = parsed.value as CreateInput;
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    return errorResponse(400, 'invalid title: title is required');
  }
  const config = loadConfig(ctx.rootDir);
  const fieldsError = validateTaskFields(
    parsed.value as Record<string, unknown>,
    config,
    { includeKind: true }
  );
  if (fieldsError) return errorResponse(400, fieldsError);

  const doc = ctx.store.create(input);
  ctx.cache.rebuild(ctx.store);
  ctx.events.broadcast({ type: 'task.changed' });
  return jsonResponse(doc, 201);
}

async function updateTask(
  req: Request,
  ctx: ApiContext,
  id: string
): Promise<Response> {
  if (ctx.store.get(id) === null) {
    return errorResponse(404, `task not found: ${id}`);
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const patch = parsed.value as UpdatePatch;
  const config = loadConfig(ctx.rootDir);
  const fieldsError = validateTaskFields(
    parsed.value as Record<string, unknown>,
    config,
    { includeKind: false }
  );
  if (fieldsError) return errorResponse(400, fieldsError);

  const doc = ctx.store.update(id, patch);
  ctx.cache.rebuild(ctx.store);
  ctx.events.broadcast({ type: 'task.changed' });
  return jsonResponse(doc);
}

// Routes every `/api/*` request. Called only for paths under `/api` — the
// caller (index.ts) handles `/ws` upgrades and static file serving itself.
export async function handleApi(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const url = new URL(req.url);
  const segments = url.pathname
    .replace(/^\/api\/?/, '')
    .split('/')
    .filter(Boolean);
  const method = req.method;

  try {
    if (segments[0] === 'health' && segments.length === 1 && method === 'GET') {
      // `rootDir` lets the web UI show a project name (its basename) in the
      // top bar without a separate endpoint — see the phase-2 plan's Slice
      // S3 TopBar requirement.
      return jsonResponse({
        ok: true,
        version: ctx.version,
        rootDir: ctx.rootDir,
        // Files the most recent cache rebuild couldn't parse (e.g. missing
        // frontmatter, invalid kind) — empty when the task set is clean. The
        // daemon keeps serving the last-good cache regardless; this is
        // visibility, not a fatal signal (`ok` stays true).
        problems: ctx.cache.problems(),
      });
    }

    if (segments[0] === 'config' && segments.length === 1 && method === 'GET') {
      return jsonResponse(loadConfig(ctx.rootDir));
    }

    if (segments[0] === 'tasks') {
      if (segments.length === 1 && method === 'GET') {
        return jsonResponse(
          ctx.cache.query({
            status: url.searchParams.get('status') ?? undefined,
            kind: url.searchParams.get('kind') ?? undefined,
            parent: url.searchParams.get('parent') ?? undefined,
          })
        );
      }
      if (segments.length === 1 && method === 'POST') {
        return await createTask(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'ready' &&
        method === 'GET'
      ) {
        return jsonResponse(ctx.cache.ready());
      }
      if (segments.length === 2 && method === 'GET') {
        const doc = ctx.cache.get(segments[1]);
        return doc !== null
          ? jsonResponse(doc)
          : errorResponse(404, `task not found: ${segments[1]}`);
      }
      if (segments.length === 2 && method === 'PATCH') {
        return await updateTask(req, ctx, segments[1]);
      }
    }

    return errorResponse(404, `not found: ${url.pathname}`);
  } catch (err) {
    // TaskParseError (a corrupt task file) and ConfigError (corrupt
    // config.yml) are the only errors expected to reach here from core; both
    // map to 422 with just their message — never a stack trace.
    if (err instanceof TaskParseError || err instanceof ConfigError) {
      return errorResponse(422, err.message);
    }
    throw err;
  }
}
