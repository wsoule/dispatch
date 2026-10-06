import {
  ACCEPTED_KINDS,
  ASSIGNEES,
  canonicalStatus,
  ConfigError,
  FileCommentStore,
  KINDS,
  loadConfig,
  PRIORITIES,
  readyTasks,
  resolveMilestoneRef,
  statusModelOf,
  TASK_RISKS,
  TaskParseError,
  TaskStore,
} from '@dispatch-foo/core';
import type { ListSafeError, TaskComment, TaskDoc } from '@dispatch-foo/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { basename } from 'node:path';
import { z } from 'zod';

import type { DaemonFileInfo } from './daemon.js';
import {
  daemonAuth,
  DaemonHttpError,
  daemonJsonBody,
  daemonOwnsStore,
  daemonRequest,
  DaemonUnreachableError,
  isDaemonHealthy,
  liveDaemon,
  readDaemonFile,
  requestDeadline,
  startDaemon,
} from './daemon.js';
import { registerDocTools, taskDocLines } from './docs.js';
import { registerMemoryTools } from './memory.js';
import { registerMessagingTools } from './messaging.js';
import type { MessageBlockingTiming, ToolOutcome } from './toolKit.js';
import { callingRunId, projectRoot, toolError, toolResult } from './toolKit.js';

// Thrown by validation/lookup helpers below. Every tool handler catches this
// (and core's ConfigError) via wrap() and turns it into an MCP tool-error
// result (isError: true, plain-text message) instead of letting it become a
// protocol-level error — the whole point being that the calling agent can
// see the message and self-correct, per the MCP spec's tool error-handling
// guidance.
class ToolError extends Error {}

// Same "not initialized" gate as the CLI's requireStore() (packages/cli/src/
// commands/task.ts) — same message, so a client rendering either surface
// shows the same instruction.
function requireStore(rootDir: string): TaskStore {
  const store = new TaskStore(rootDir);
  if (!store.isInitialized()) {
    throw new ToolError('not initialized — run: dispatch init');
  }
  return store;
}

// Mirrors the CLI's private validate() helper (packages/cli/src/commands/
// task.ts) message-for-message, so enum-validation errors read identically
// whether they came from `dispatch task ...` or an MCP tool call.
function validate<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  label: string
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ToolError(
      `invalid ${label}: ${value} (expected ${allowed.join('|')})`
    );
  }
  return value as T;
}

// TaskSummary: the fields task_list/task_next return, chosen to keep list
// payloads small (no body, and none of taskMetaShape's extras below).
const taskSummaryShape = {
  id: z.string(),
  title: z.string(),
  status: z.string(),
  kind: z.enum(KINDS as unknown as [string, ...string[]]),
  parent: z.string().nullable(),
  // Legacy and read-only: the free-form milestone name old task files carry.
  // A task's container is `parent`; task_save's `milestone` input sets that.
  milestone: z.string().nullable(),
  blockedBy: z.array(z.string()),
  labels: z.array(z.string()),
  priority: z.enum(PRIORITIES as unknown as [string, ...string[]]),
  // A named assignee (e.g. `human:wyat`, `agent:wyat/claude`) is valid on
  // disk but not one of the legacy ASSIGNEES enum values — same reasoning
  // as `status` above, which already widened for custom statuses.
  assignee: z.string(),
  // Drives review depth and model tier, so an agent picking work needs it.
  risk: z.enum(TASK_RISKS as unknown as [string, ...string[]]),
  // Set once a verify run has actually exercised this task's work.
  exercised: z.boolean(),
  created: z.string(),
  updated: z.string(),
};

// One record of a task's comment thread — mirrors core's TaskComment.
const commentShape = z.object({
  id: z.string(),
  taskId: z.string(),
  author: z.string(),
  body: z.string(),
  created: z.string(),
  updated: z.string(),
  parentId: z.string().nullable(),
  external: z.string().nullable(),
});

// The daemon's readiness reading — mirrors ReadinessReading in
// packages/server/src/judgments/readiness.ts.
const readinessShape = z.object({
  level: z.number(),
  label: z.string(),
  confidence: z.number(),
  splitProbability: z.number(),
});

const taskMetaShape = {
  ...taskSummaryShape,
  external: z.string().nullable(),
  writes: z.array(z.string()),
  selfReview: z.boolean(),
  model: z.string().nullable(),
  // Only present once a reconciler decided the task's merge landed.
  archivedAt: z.string().optional(),
  // Linear-parity fields. Optional so a daemon older than them still
  // validates.
  estimate: z.number().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  relatedTo: z.array(z.string()).optional(),
  duplicateOf: z.string().nullable().optional(),
  initiatives: z.array(z.string()).optional(),
  creator: z.string().nullable().optional(),
};

function toSummary(doc: TaskDoc) {
  const {
    id,
    title,
    status,
    kind,
    parent,
    milestone,
    blockedBy,
    labels,
    priority,
    assignee,
    risk,
    exercised,
    created,
    updated,
  } = doc.meta;
  return {
    id,
    title,
    status,
    kind,
    parent,
    milestone,
    blockedBy,
    labels,
    priority,
    assignee,
    risk,
    exercised,
    created,
    updated,
  };
}

// Turns listSafe()'s per-file parse failures into the same doctor-pointing
// text task_get uses for a single corrupt file, so an agent sees one
// consistent hint no matter which tool surfaced the problem.
const DOCTOR_HINT = " — run 'dispatch doctor'";

function formatProblems(errors: ListSafeError[]): string[] {
  return errors.map((e) => `${e.file}: ${e.message}${DOCTOR_HINT}`);
}

// The same hint for problems that came back from the daemon instead. Its
// `GET /api/health` already reports them as `<file>: <message>` (see
// TaskCache.problems), so only the hint has to be added — which keeps
// `problems` reading identically whether a tool answered from the daemon or
// from a local scan.
function formatDaemonProblems(problems: string[]): string[] {
  return problems.map((p) => `${p}${DOCTOR_HINT}`);
}

// ---------------------------------------------------------------------------
// Where a task tool reads and writes.
//
// dispatchd owns a project's task state (task t-c6dbd3): while it is running
// it is the only process that touches the store, and every tool here asks it
// over HTTP instead of opening the store itself. Two things make that a
// routing decision rather than a hard rule:
//
//  - The daemon may not be running. On the file backend the markdown under
//    `.dispatch/tasks` is still perfectly readable by a second process, and
//    refusing to read it would make these tools useless in exactly the
//    situation they are most often used from — a plain `dispatch mcp` in a
//    checkout with no daemon. So that case falls back to a direct read, which
//    is what every one of these tools did before this change.
//  - Unless the project is database-backed, in which case there is no safe
//    direct path at all and the tool says so. See `daemonOwnsStore`.
//
// Note which root each side resolves against. The daemon path is always the
// PROJECT (`projectRoot()`), so an agent mid-run sees the board every other
// agent sees rather than the frozen copy on its own branch — that is the
// point of routing reads through the daemon at all. The local fallback keeps
// using the raw `rootDir`, which inside a run is the worktree: unchanged
// behaviour for the no-daemon case, and the only state actually reachable
// there.
// ---------------------------------------------------------------------------

const DAEMON_REQUIRED =
  "dispatchd is not running — this project keeps its tasks in the daemon's " +
  'database, which only dispatchd may open. Start it with: dispatch serve';

type StoreRoute =
  | {
      via: 'daemon';
      daemon: DaemonFileInfo;
      // Carried from the health probe `liveDaemon` already made, so a read
      // that reports `problems` costs one round trip rather than two.
      problems: string[];
      configRoot: string;
    }
  | { via: 'local'; configRoot: string }
  | { via: 'refused'; message: string };

async function resolveStoreRoute(rootDir: string): Promise<StoreRoute> {
  const projRoot = projectRoot(rootDir);
  // Only a database-backed project needs one started: the file backend has
  // always had a direct path, and spawning a daemon for a read it can do
  // itself would be a change nobody asked for.
  const live =
    (await liveDaemon(projRoot)) ??
    (daemonOwnsStore(projRoot) ? await startDaemon(projRoot) : null);
  if (live !== null) {
    return {
      via: 'daemon',
      daemon: live.info,
      problems: formatDaemonProblems(live.problems),
      configRoot: projRoot,
    };
  }
  if (daemonOwnsStore(projRoot)) {
    return { via: 'refused', message: DAEMON_REQUIRED };
  }
  return { via: 'local', configRoot: rootDir };
}

// Runs a tool body, turning a ToolError/ConfigError into a clean MCP tool
// error with our own message text, and a DaemonHttpError into the daemon's
// own wording (its 404 for an unknown task already reads `task not found:
// <id>`, the same text the local path produces). Anything else thrown here
// is rethrown — but that does NOT become a protocol-level JSON-RPC error:
// the SDK's own tool-call handling catches exceptions thrown from a
// registered callback and turns them into a `{ isError: true }`
// CallToolResult itself (verified against the installed SDK — an uncaught
// throw in a tool handler surfaces to the client as a normal tool result,
// not a `client.callTool()` rejection). We still catch these three
// explicitly so the message text matches the CLI exactly, rather than
// relying on the SDK's default `String(err)` rendering of a rethrow.
async function wrapAsync(fn: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
  try {
    return await fn();
  } catch (err) {
    if (
      err instanceof ToolError ||
      err instanceof ConfigError ||
      err instanceof DaemonHttpError ||
      // A write cannot be retried locally — the request may have reached the
      // daemon before the connection dropped — so it reports the real cause
      // instead of a bare `TypeError: fetch failed`. Reads fall back to the
      // files before they ever get here (see taskList/taskGet/taskNext).
      err instanceof DaemonUnreachableError
    ) {
      return toolError(err.message);
    }
    throw err;
  }
}

// The clean "no daemon" shape `run_list` returns whenever there is nothing
// live to report — no daemon file for this rootDir, a stale file left by a
// crash (health check fails), or the health check itself throwing (daemon
// mid-restart, port unreachable, etc.). Every one of those is the same
// answer from a calling agent's point of view: no run awareness available
// right now, not an error.
function noDaemonResult(): ToolOutcome {
  return toolResult({ runs: [], note: 'dispatchd not running' });
}

// Proxies `GET /api/runs` from this project's dispatchd, if one is running
// and healthy. Unlike every other tool in this file, `run_list` never
// touches the filesystem directly — awareness of *other* agents' live runs
// only exists in dispatchd's in-memory registry, so a daemon proxy is the
// only way to answer this at all (see the Phase 4 plan's collaboration
// half). The response shape is passed through as-is (RunMeta objects,
// typed loosely here since @dispatch/mcp intentionally has no dependency on
// @dispatch/server, which is Bun-only).
async function runList(rootDir: string): Promise<ToolOutcome> {
  const daemon = readDaemonFile(projectRoot(rootDir));
  if (daemon === null || !(await isDaemonHealthy(daemon.port))) {
    return noDaemonResult();
  }
  try {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/runs`, {
      headers: daemonAuth(daemon),
      signal: requestDeadline(),
    });
    if (!res.ok) return noDaemonResult();
    const runs = await res.json();
    if (!Array.isArray(runs)) return noDaemonResult();
    return toolResult({ runs });
  } catch {
    return noDaemonResult();
  }
}

// The daemon's task-list response, plus the health call that carries the
// store problems `task_list`/`task_next` promise. Fetched together rather
// than in sequence: they are two independent localhost GETs, so paying for
// one round trip instead of two costs nothing but a Promise.all.

// Re-throws anything that is not a recoverable "daemon vanished", and
// re-throws even that when the project is database-backed — there, the files
// the caller is about to fall back to do not exist, so continuing would report
// an empty board as the truth.
function rethrowIfNoFiles(err: unknown, projRoot: string): void {
  if (!(err instanceof DaemonUnreachableError)) throw err;
  if (daemonOwnsStore(projRoot)) throw err;
}

// The task docs behind `path`. `problems` came from the health probe that
// decided this daemon was reachable in the first place (see `liveDaemon`),
// so a list costs exactly one request.
async function daemonDocs(
  daemon: DaemonFileInfo,
  path: string
): Promise<TaskDoc[]> {
  return daemonRequest<TaskDoc[]>(daemon, path);
}

async function taskList(
  rootDir: string,
  args: { status?: string; kind?: string; parent?: string }
): Promise<ToolOutcome> {
  const route = await resolveStoreRoute(rootDir);
  if (route.via === 'refused') return toolError(route.message);
  // Validated here on both paths, against the same config.yml the daemon
  // reads, so an invalid enum reads identically whether or not a daemon is
  // up — and so an obviously-bad filter never costs a round trip.
  const config = loadConfig(route.configRoot);
  const status = validate(
    args.status === undefined ? undefined : canonicalStatus(args.status),
    config.statuses,
    'status'
  );
  const kind = validate(args.kind, ACCEPTED_KINDS, 'kind');

  if (route.via === 'daemon') {
    const query = new URLSearchParams();
    if (status !== undefined) query.set('status', status);
    if (kind !== undefined) query.set('kind', kind);
    if (args.parent !== undefined) query.set('parent', args.parent);
    // `GET /api/tasks` hides archived tasks unless asked, but the local scan
    // below has no such filter — a plain `listSafe()` returns them. Asking
    // for them here keeps this tool's answer the same on both routes rather
    // than making "is a daemon running?" quietly change what it returns.
    query.set('archived', '1');
    const suffix = `?${query.toString()}`;
    try {
      const docs = await daemonDocs(route.daemon, `/api/tasks${suffix}`);
      return toolResult({
        tasks: docs.map(toSummary),
        problems: route.problems,
      });
    } catch (err) {
      // The daemon died between the health probe and this read. A read is
      // safely repeatable and the files are right there, so fall through to
      // them rather than failing the call — unless the database owns the
      // store, where there are no files to fall back to and `rethrowIfNoFiles`
      // surfaces the real cause.
      rethrowIfNoFiles(err, route.configRoot);
    }
  }

  const store = requireStore(rootDir);
  // listSafe() (not list()) so one unparsable task file surfaces as a
  // `problems` entry instead of failing the whole call — the daemon's
  // cache rebuild uses the same method for the same reason.
  const { docs, errors } = store.listSafe({
    status,
    kind,
    parent: args.parent,
  });
  return toolResult({
    tasks: docs.map(toSummary),
    problems: formatProblems(errors),
  });
}

// A task's first-class comment thread (what people and agents said about it,
// task_comment's notes included), oldest first.
async function taskComments(rootDir: string, id: string): Promise<ToolOutcome> {
  const route = await resolveStoreRoute(rootDir);
  if (route.via === 'refused') return toolError(route.message);
  if (route.via === 'daemon') {
    const comments = await daemonRequest<TaskComment[]>(
      route.daemon,
      `/api/tasks/${encodeURIComponent(id)}/comments`
    );
    return toolResult({ comments });
  }
  if (requireStore(rootDir).get(id) === null) {
    return toolError(`task not found: ${id}`);
  }
  return toolResult({ comments: new FileCommentStore(rootDir).list(id) });
}

async function taskGet(
  rootDir: string,
  server: McpServer,
  id: string
): Promise<ToolOutcome> {
  const route = await resolveStoreRoute(rootDir);
  if (route.via === 'refused') return toolError(route.message);

  if (route.via === 'daemon') {
    try {
      const doc = await daemonRequest<TaskDoc>(
        route.daemon,
        `/api/tasks/${encodeURIComponent(id)}`
      );
      const docs = await taskDocLines(rootDir, server, id);
      return toolResult({
        meta: doc.meta,
        body: doc.body,
        ...(docs === undefined ? {} : { docs }),
      });
    } catch (err) {
      // A 404 has two very different causes on the file backend, and the
      // daemon cannot tell them apart in this response: the task really does
      // not exist, or its file failed to parse and the cache skipped it. The
      // local branch below distinguishes them (TaskParseError -> "run
      // dispatch doctor"), and answering "task not found" for a task that is
      // sitting right there, merely malformed, sends an agent looking for
      // the wrong problem. The daemon reports those parse failures at
      // /api/health, so consult it before settling on not-found.
      if (err instanceof DaemonHttpError && err.status === 404) {
        if (route.problems.length > 0) {
          throw new ToolError(
            `task not found: ${id} — but this project has unreadable task ` +
              `files, and one of them may be it: ${route.problems.join('; ')}`
          );
        }
      }
      throw err;
    }
  }

  const store = requireStore(rootDir);
  let doc: TaskDoc | null;
  try {
    doc = store.get(id);
  } catch (err) {
    if (err instanceof TaskParseError) {
      // basename only — task_list's problems[] and the CLI never expose
      // absolute paths, and neither should a remote MCP client see them.
      const file = err.file === undefined ? id : basename(err.file);
      throw new ToolError(`${file}: ${err.message}${DOCTOR_HINT}`);
    }
    throw err;
  }
  if (doc === null) throw new ToolError(`task not found: ${id}`);
  return toolResult({ meta: doc.meta, body: doc.body });
}

interface TaskSaveInput {
  id?: string;
  title?: string;
  status?: string;
  kind?: string;
  parent?: string | null;
  milestone?: string;
  blockedBy?: string[];
  labels?: string[];
  priority?: string;
  assignee?: string;
  description?: string;
  writes?: string[];
}

// The parent a task_save's `milestone` names, for the local path; through
// the daemon the raw `milestone` goes along and dispatchd resolves it.
function localMilestoneParent(
  store: TaskStore,
  input: TaskSaveInput,
  childKind: string
): string | undefined {
  if (input.milestone === undefined) return undefined;
  const resolved = resolveMilestoneRef(store.list(), input.milestone, {
    childKind,
    parent: input.parent ?? null,
  });
  if (!resolved.ok) throw new ToolError(resolved.error);
  return resolved.id;
}

async function taskSave(
  rootDir: string,
  input: TaskSaveInput
): Promise<ToolOutcome> {
  const route = await resolveStoreRoute(rootDir);
  if (route.via === 'refused') return toolError(route.message);
  const config = loadConfig(route.configRoot);
  const status = validate(
    input.status === undefined ? undefined : canonicalStatus(input.status),
    config.statuses,
    'status'
  );
  const priority = validate(input.priority, PRIORITIES, 'priority');
  const assignee = validate(input.assignee, ASSIGNEES, 'assignee');

  if (input.id === undefined) {
    if (input.title === undefined || input.title.trim() === '') {
      throw new ToolError('title must not be empty');
    }
    const kind = validate(input.kind, ACCEPTED_KINDS, 'kind');
    const create = {
      title: input.title,
      kind,
      status,
      description: input.description,
      parent: input.parent ?? null,
      priority,
      labels: input.labels ?? [],
      blockedBy: input.blockedBy ?? [],
      assignee,
      writes: input.writes,
    };
    if (route.via === 'daemon') {
      const doc = await daemonRequest<TaskDoc>(
        route.daemon,
        '/api/tasks',
        daemonJsonBody(
          'POST',
          input.milestone === undefined
            ? create
            : { ...create, milestone: input.milestone }
        )
      );
      return toolResult({ meta: doc.meta, body: doc.body });
    }
    const store = requireStore(rootDir);
    const parent = localMilestoneParent(store, input, kind ?? 'task');
    const doc = store.create(
      parent === undefined ? create : { ...create, parent }
    );
    return toolResult({ meta: doc.meta, body: doc.body });
  }

  const patch = {
    title: input.title,
    status,
    parent: input.parent,
    milestone: input.milestone,
    blockedBy: input.blockedBy,
    labels: input.labels,
    priority,
    assignee,
    writes: input.writes,
  };
  // `kind` and `description` are the only fields a caller could have sent
  // that don't end up in `patch` (both are create-only — see the tool's own
  // description). If every other field is undefined too, there is nothing to
  // write: skip the update entirely rather than rewriting the task with an
  // identical body and a bumped `updated` timestamp for no real change.
  const hasChange = Object.values(patch).some((v) => v !== undefined);

  if (route.via === 'daemon') {
    const path = `/api/tasks/${encodeURIComponent(input.id)}`;
    // One round trip either way. The PATCH 404s an unknown id with the same
    // `task not found: <id>` text a GET would, so there is nothing to learn
    // from asking first; the GET is only for the no-op case, which has to
    // return the task's current state and has nothing to patch.
    const doc = hasChange
      ? await daemonRequest<TaskDoc>(
          route.daemon,
          path,
          daemonJsonBody('PATCH', patch)
        )
      : await daemonRequest<TaskDoc>(route.daemon, path);
    return toolResult({ meta: doc.meta, body: doc.body });
  }

  const store = requireStore(rootDir);
  const existing = store.get(input.id);
  if (existing === null) throw new ToolError(`task not found: ${input.id}`);
  if (!hasChange) {
    return toolResult({ meta: existing.meta, body: existing.body });
  }
  // The store never writes the legacy field: it becomes the parent.
  const { milestone, ...fields } = patch;
  const parent =
    milestone === undefined
      ? input.parent
      : localMilestoneParent(store, input, existing.meta.kind);
  const doc = store.update(input.id, { ...fields, parent });
  return toolResult({ meta: doc.meta, body: doc.body });
}

async function taskNext(rootDir: string): Promise<ToolOutcome> {
  const route = await resolveStoreRoute(rootDir);
  if (route.via === 'refused') return toolError(route.message);

  if (route.via === 'daemon') {
    // `/api/tasks/ready` applies core's own readyTasks() to the daemon's
    // cache, so this is the same graph rule the local branch below runs —
    // not a second implementation of it.
    try {
      // The daemon attaches a readiness reading per task when it has a
      // judgment client; passed through so an agent can tell a bare title
      // from a real spec before it picks one up.
      const docs = await daemonRequest<(TaskDoc & { readiness?: unknown })[]>(
        route.daemon,
        '/api/tasks/ready'
      );
      return toolResult({
        tasks: docs.map((doc) =>
          doc.readiness === undefined
            ? toSummary(doc)
            : { ...toSummary(doc), readiness: doc.readiness }
        ),
        problems: route.problems,
      });
    } catch (err) {
      // Same reasoning as task_list: a dead daemon must not cost a read that
      // the files can answer.
      rethrowIfNoFiles(err, route.configRoot);
    }
  }

  const store = requireStore(rootDir);
  const { docs, errors } = store.listSafe();
  return toolResult({
    // Archived tasks dropped to match `/api/tasks/ready`, which filters them
    // via the cache's default query. Unlike task_list — where including them
    // preserves what a raw file scan always returned — the daemon is simply
    // right here: an archived task is work that already landed, and "what
    // should I start now?" must never answer with it. Leaving the two paths
    // differing would also make the answer depend on whether a daemon
    // happened to be running.
    // The FULL set, archived included — readyTasks drops archived candidates
    // itself but needs them present to resolve blockers (see graph.ts).
    tasks: readyTasks(docs, statusModelOf(loadConfig(rootDir))).map(toSummary),
    problems: formatProblems(errors),
  });
}

// Adds a comment to a task's thread (the same records task_comments reads),
// crediting whoever actually said it. With a reachable daemon this proxies
// `POST /api/tasks/:id/comments` with the agent token and the calling run's
// id, so dispatchd credits that run's agent (or the bare `agent` with no
// run) and never the human operating it. With no daemon it writes through
// the file comment store directly, crediting 'none' rather than guessing at
// an actor it cannot resolve.
async function taskComment(
  rootDir: string,
  args: { id: string; text: string }
): Promise<ToolOutcome> {
  if (args.text.trim() === '') {
    return toolError('text must not be empty');
  }
  const projRoot = projectRoot(rootDir);
  const runId = callingRunId();
  // Gated on a LIVE DAEMON, not on having a run id. dispatchd is the single
  // writer whoever is asking, and the comments route takes a missing runId
  // perfectly well. Gating on the run id instead meant a plain `dispatch
  // mcp` session (no DISPATCH_RUN_ID) skipped the proxy entirely and then
  // refused with "dispatchd is not running" on a database-backed project
  // while the daemon was, in fact, running.
  const live =
    (await liveDaemon(projRoot)) ??
    (daemonOwnsStore(projRoot) ? await startDaemon(projRoot) : null);
  // Why the daemon proxy failed, kept so the fallback below can report it.
  // Without this, a daemon that answered 401 or 500 was reported to the agent
  // as "dispatchd is not running" — advice that is both false and unactionable
  // — and the comment was dropped. An agent logging progress has no way to
  // tell a lost write from a rejected one, so the real cause has to survive.
  let proxyFailure: string | null = null;
  if (live !== null) {
    const path = `/api/tasks/${encodeURIComponent(args.id)}/comments`;
    try {
      // `daemonAuth` is load-bearing, not decoration: every route but
      // /api/health requires a token, and the agent token is what makes the
      // daemon credit an agent rather than its operator.
      const comment = await daemonRequest<TaskComment>(
        live.info,
        path,
        daemonJsonBody(
          'POST',
          runId === undefined ? { body: args.text } : { body: args.text, runId }
        )
      );
      return toolResult({ comment });
    } catch (err) {
      // The daemon's own store agrees with what a direct write would find
      // — no point falling through to re-derive the same 404.
      if (err instanceof DaemonHttpError && err.status === 404) {
        return toolError(`task not found: ${args.id}`);
      }
      // Any other answer (or a network hiccup talking to a daemon that
      // just answered healthy) is not worth losing the comment over — fall
      // through to the direct write below, remembering why.
      proxyFailure =
        err instanceof DaemonHttpError
          ? `dispatchd answered ${err.status} for POST ${path}: ${err.message}`
          : (err as Error).message;
    }
  }

  // No daemon took the write. A database-backed project has no second way in,
  // so say so rather than letting requireStore report "not initialized" for a
  // project that is perfectly well initialized. When a daemon WAS reached and
  // rejected the write, its answer is the useful half of the message — the
  // generic "start dispatchd" advice is actively wrong in that case.
  if (daemonOwnsStore(projRoot)) {
    return toolError(
      proxyFailure === null
        ? DAEMON_REQUIRED
        : `could not record the comment: ${proxyFailure}`
    );
  }

  // projectRoot(), not the raw rootDir — see its doc comment above: a
  // comment written into a run's worktree would be discarded the moment
  // that run's branch is merged or discarded.
  if (requireStore(projRoot).get(args.id) === null) {
    return toolError(`task not found: ${args.id}`);
  }
  const comment = new FileCommentStore(projRoot).add({
    taskId: args.id,
    author: 'none',
    body: args.text,
  });
  return toolResult({ comment });
}

// Proxies `POST /api/notes` — the agent side of the notes/triage hub. Lets an
// agent capture triage it finds mid-run ("this file is huge, refactor it"), a
// follow-up to do after merge, or a plain note, without derailing to file a
// full task. Records the calling run id (if any) so the app can show "an agent
// flagged this". Works whenever dispatchd is running, inside a run or not, so a
// manually-started server can still jot a note.
async function dispatchNote(
  rootDir: string,
  args: { kind: string; title: string; body?: string }
): Promise<ToolOutcome> {
  if (args.title.trim() === '') {
    return toolError('title must not be empty');
  }
  const projRoot = projectRoot(rootDir);
  let daemon = readDaemonFile(projRoot);
  if (daemon === null || !(await isDaemonHealthy(daemon.port))) {
    // The inbox lives only in the daemon on every backend, so there is no
    // direct path to fall back to — start one if this process can.
    daemon = (await startDaemon(projRoot))?.info ?? null;
    if (daemon === null) {
      return toolError('dispatchd not running — cannot add a note');
    }
  }
  // Writes to the brain-dump inbox, which replaced the notes store. The tool's own vocabulary
  // is kept (`kind`, `title`, `body`) so every agent prompt that already knows how to call it
  // keeps working, and the four note kinds fold onto the inbox's the same way the migration
  // does — triage/followup/todo are all "something to do".
  const KIND: Record<string, string> = {
    note: 'note',
    triage: 'task',
    followup: 'task',
    todo: 'task',
  };
  const text =
    args.body !== undefined && args.body.trim() !== ''
      ? `${args.title.trim()} — ${args.body.trim()}`
      : args.title.trim();
  try {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/inbox`, {
      signal: requestDeadline(),
      method: 'POST',
      headers: { 'content-type': 'application/json', ...daemonAuth(daemon) },
      body: JSON.stringify({
        kind: KIND[args.kind] ?? 'note',
        text,
        createdByRunId: callingRunId(),
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return toolError(
        `dispatch_note failed: ${body.error ?? `HTTP ${res.status}`}`
      );
    }
    const created = (await res.json()) as { id: string }[];
    // The inbox can 201 and still store nothing (a title of pure bullet
    // punctuation), and no id breaks this tool's own `id: string` schema.
    const id = created[0]?.id;
    if (id === undefined) {
      return toolError(
        'dispatch_note failed: nothing was captured from that title — ' +
          'give it some words, not just punctuation'
      );
    }
    return toolResult({ ok: true, id });
  } catch (err) {
    return toolError(`dispatch_note failed: ${(err as Error).message}`);
  }
}

// Proxies `POST /api/runs/:id/evidence` — a command the calling run actually
// ran, recorded as data instead of narrated in the run's own report.
async function recordEvidence(
  rootDir: string,
  args: {
    command: string;
    exitCode: number;
    durationMs: number;
    summary: string;
  }
): Promise<ToolOutcome> {
  if (args.command.trim() === '') return toolError('command must not be empty');
  if (args.summary.trim() === '') return toolError('summary must not be empty');
  const runId = callingRunId();
  if (runId === undefined) {
    return toolError(
      'record_evidence requires a live dispatch run context (DISPATCH_RUN_ID not set)'
    );
  }
  const daemon = readDaemonFile(projectRoot(rootDir));
  if (daemon === null || !(await isDaemonHealthy(daemon.port))) {
    return toolError('dispatchd not running — cannot record evidence');
  }
  try {
    const res = await fetch(
      `http://127.0.0.1:${daemon.port}/api/runs/${runId}/evidence`,
      {
        signal: requestDeadline(),
        method: 'POST',
        headers: { 'content-type': 'application/json', ...daemonAuth(daemon) },
        body: JSON.stringify(args),
      }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return toolError(
        `record_evidence failed: ${body.error ?? `HTTP ${res.status}`}`
      );
    }
    return toolResult({ ok: true });
  } catch (err) {
    return toolError(`record_evidence failed: ${(err as Error).message}`);
  }
}

// Proxies `POST /api/runs/:id/mutations` — a guard reverted and the tests
// re-run. `testsFailed: 0` is what buildReviewPrompt flags to the reviewer.
async function recordMutation(
  rootDir: string,
  args: { guard: string; file: string; testsFailed: number }
): Promise<ToolOutcome> {
  if (args.guard.trim() === '') return toolError('guard must not be empty');
  if (args.file.trim() === '') return toolError('file must not be empty');
  const runId = callingRunId();
  if (runId === undefined) {
    return toolError(
      'record_mutation requires a live dispatch run context (DISPATCH_RUN_ID not set)'
    );
  }
  const daemon = readDaemonFile(projectRoot(rootDir));
  if (daemon === null || !(await isDaemonHealthy(daemon.port))) {
    return toolError('dispatchd not running — cannot record a mutation result');
  }
  try {
    const res = await fetch(
      `http://127.0.0.1:${daemon.port}/api/runs/${runId}/mutations`,
      {
        signal: requestDeadline(),
        method: 'POST',
        headers: { 'content-type': 'application/json', ...daemonAuth(daemon) },
        body: JSON.stringify(args),
      }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return toolError(
        `record_mutation failed: ${body.error ?? `HTTP ${res.status}`}`
      );
    }
    return toolResult({ ok: true });
  } catch (err) {
    return toolError(`record_mutation failed: ${(err as Error).message}`);
  }
}

// The status vocabulary as the model sees it on task_list/task_save. The
// fields stay plain strings (see task_save), so this is the only place an
// agent learns the valid values before a call fails.
const STATUS_PARAM_DOC =
  "A status name from this project's .dispatch/config.yml, which is what " +
  'this is checked against; a board imported from Linear keeps its own ' +
  'names (Backlog, Todo, In Progress, Done, …). Each status has a workflow ' +
  'type (triage | backlog | unstarted | started | completed | canceled), and ' +
  'Dispatch keys off the type and config `statusRoles`, never the name. ' +
  'With no statuses configured the built-ins apply: draft | ready | working ' +
  '| review | landing | landed | dropped.';

// Registers every dispatch tool against a fixed root. Each call re-resolves the
// store, config and daemon file, so a later init or daemon start is picked up.
export function registerDispatchTools(
  server: McpServer,
  rootDir: string,
  opts: { blockingTiming?: MessageBlockingTiming } = {}
): void {
  registerMessagingTools(server, rootDir, {
    blockingTiming: opts.blockingTiming,
  });
  registerMemoryTools(server, rootDir);
  registerDocTools(server, rootDir);
  server.registerTool(
    'task_list',
    {
      title: 'List tasks',
      description:
        'List tasks (metadata only — no body) optionally filtered by status, kind, or parent.',
      inputSchema: {
        status: z.string().optional().describe(STATUS_PARAM_DOC),
        kind: z.string().optional().describe('task | epic'),
        parent: z
          .string()
          .optional()
          .describe('An epic id (e-…): only that epic’s child tasks.'),
      },
      outputSchema: {
        tasks: z.array(z.object(taskSummaryShape)),
        problems: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
    ({ status, kind, parent }) =>
      wrapAsync(() => taskList(rootDir, { status, kind, parent }))
  );

  server.registerTool(
    'task_get',
    {
      title: 'Get a task',
      description:
        'Fetch a single task by id, including its full markdown body.',
      inputSchema: { id: z.string() },
      outputSchema: {
        meta: z.object(taskMetaShape),
        body: z.string(),
        docs: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => wrapAsync(() => taskGet(rootDir, server, id))
  );

  server.registerTool(
    'task_save',
    {
      title: 'Create or update a task',
      description:
        'Upsert a task. Omit id to create (title required) — creating is NOT ' +
        'idempotent; calling this twice without an id makes two tasks. With id, ' +
        'only the provided fields change — omitted fields are untouched, ' +
        'blockedBy/labels/writes are full replacements. kind and description apply on ' +
        'create only; there is no supported way to change kind or rewrite the ' +
        'description section after creation. milestone files the task under ' +
        'the project or milestone with that title (or id) by setting parent.',
      // Enum-shaped fields (kind, priority, assignee) are typed as plain
      // strings here — deliberately not z.enum — so an invalid value reaches
      // our own validate() below and produces the same CLI-style error
      // message, instead of a generic zod schema-validation error.
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe('The task to update (t-… or e-…). Omit to create.'),
        title: z.string().optional(),
        status: z
          .string()
          .optional()
          .describe(
            `${STATUS_PARAM_DOC} The statuses statusRoles names for ` +
              'dispatched, review, landing and landed (built-in: working, ' +
              'review, landing, landed) are normally set by dispatchd as runs ' +
              'and the merge queue advance; the landed role means merged.'
          ),
        kind: z
          .string()
          .optional()
          .describe(
            'task | milestone | project | initiative (default task; legacy ' +
              'epic reads as milestone). Create only.'
          ),
        parent: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Parent container id (a milestone, project, initiative or parent ' +
              'issue); null clears it.'
          ),
        milestone: z
          .string()
          .optional()
          .describe(
            'A project or milestone by title or id, resolved to `parent`.'
          ),
        blockedBy: z
          .array(z.string())
          .optional()
          .describe(
            'Task ids that must land before this one can start. Replaces the whole list.'
          ),
        labels: z
          .array(z.string())
          .optional()
          .describe('Free-form labels. Replaces the whole list.'),
        priority: z
          .string()
          .optional()
          .describe('urgent | high | medium | low | none'),
        assignee: z
          .string()
          .optional()
          .describe('agent | human | human:<handle> | none'),
        description: z
          .string()
          .optional()
          .describe(
            "Markdown for the task's Description section. Create only."
          ),
        // Files this task expects to touch, for the epic scheduler. Omitted
        // means "unknown", which serializes against everything.
        writes: z
          .array(z.string())
          .optional()
          .describe(
            'Files, or dir/** prefixes, this task will modify; tasks whose ' +
              'writes do not overlap may run in parallel. Omit when unknown — ' +
              'an unknown task is serialized against everything. Replaces the ' +
              'whole list.'
          ),
      },
      outputSchema: { meta: z.object(taskMetaShape), body: z.string() },
      // No idempotentHint: creating (no id) makes a new task every call, so
      // that hint would be false advertising for half of what this tool
      // does. Honest annotations over the plan's original text.
    },
    (input) => wrapAsync(() => taskSave(rootDir, input))
  );

  server.registerTool(
    'task_comment',
    {
      title: 'Comment on a task',
      description:
        "Add a comment to a task's thread, credited to you — for progress " +
        'notes, decisions and questions others should see. Humans read the ' +
        'thread in the app, and later runs of the same task receive it as ' +
        'part of their prompt. Read it back with task_comments.',
      inputSchema: {
        id: z.string().describe('The task id (t-… or e-…).'),
        text: z.string().describe('The comment; must not be empty.'),
      },
      outputSchema: { comment: commentShape },
    },
    ({ id, text }) => taskComment(rootDir, { id, text })
  );

  server.registerTool(
    'task_comments',
    {
      title: "Read a task's comments",
      description:
        "List a task's comment thread (what people said about it), oldest " +
        'first. Replies carry the parentId of the comment they answer.',
      inputSchema: { id: z.string() },
      outputSchema: { comments: z.array(commentShape) },
    },
    ({ id }) => wrapAsync(() => taskComments(rootDir, id))
  );

  server.registerTool(
    'task_next',
    {
      title: 'Ready work',
      description:
        'List tasks ready to start now, priority-ordered: kind task (not a ' +
        'container), not archived, in a status whose type is `unstarted` ' +
        '(built-in: ready; on a Linear-imported board e.g. Todo), and every ' +
        'blocker in a completed or canceled status.',
      outputSchema: {
        tasks: z.array(
          z.object({
            ...taskSummaryShape,
            // Present only through a daemon with a judgment client: how
            // completely the spec says what done looks like (0 = title
            // only .. 3 = criteria and surface both named).
            readiness: readinessShape.optional(),
          })
        ),
        problems: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
    () => wrapAsync(() => taskNext(rootDir))
  );

  server.registerTool(
    'run_list',
    {
      title: 'List orchestrator runs',
      description:
        "List this project's dispatchd orchestrator runs (live + recent) " +
        'so an agent can see whether other agents already have runs in ' +
        'flight — each live run includes `claims`, the files it has ' +
        'declared or actually touched — before assuming exclusive access ' +
        'to the repo. Returns an empty list with a note when dispatchd ' +
        "isn't running — that's a normal, not-an-error response, not " +
        'every project runs the daemon.',
      outputSchema: {
        runs: z.array(z.record(z.string(), z.unknown())),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    () => runList(rootDir)
  );

  server.registerTool(
    'dispatch_note',
    {
      title: 'Add a note or triage item',
      description:
        'Capture something in the project’s notes/triage hub without ' +
        'stopping to file a full task. Use `triage` for work you spot that ' +
        'should be scheduled later ("this file is huge, refactor it"), ' +
        '`followup` for something to do after this change merges, `todo` for ' +
        'a checklist item, or `note` for a plain observation. The human sees ' +
        'it in the Notes tab and can promote it into a real task in one click.',
      inputSchema: {
        kind: z.enum(['note', 'triage', 'followup', 'todo']),
        title: z.string(),
        body: z.string().optional(),
      },
      outputSchema: { ok: z.boolean(), id: z.string() },
      annotations: { readOnlyHint: false },
    },
    ({ kind, title, body }) => dispatchNote(rootDir, { kind, title, body })
  );

  server.registerTool(
    'record_evidence',
    {
      title: 'Record command evidence',
      description:
        'Record a command you actually ran as verification evidence, ' +
        'instead of describing the result in prose in your final report. ' +
        'Call it once per command load-bearing to your acceptance criteria ' +
        '— the build, the linter, the test run. The reviewer sees this as ' +
        'data, not a claim.',
      inputSchema: {
        command: z.string(),
        exitCode: z.number().int(),
        durationMs: z.number().nonnegative(),
        summary: z.string(),
      },
      outputSchema: { ok: z.boolean() },
      annotations: { readOnlyHint: false },
    },
    ({ command, exitCode, durationMs, summary }) =>
      recordEvidence(rootDir, { command, exitCode, durationMs, summary })
  );

  server.registerTool(
    'record_mutation',
    {
      title: 'Record a mutation test result',
      description:
        'Record the result of mutation-testing a guard you added: revert ' +
        'the guard, rerun the tests, and report how many failed. ' +
        '`testsFailed: 0` is flagged to the reviewer as a sign the guard is ' +
        'dead or its test is vacuous — call this for every guard you add, ' +
        'not just the ones you expect to pass.',
      inputSchema: {
        guard: z.string(),
        file: z.string(),
        testsFailed: z.number().int().nonnegative(),
      },
      outputSchema: { ok: z.boolean() },
      annotations: { readOnlyHint: false },
    },
    ({ guard, file, testsFailed }) =>
      recordMutation(rootDir, { guard, file, testsFailed })
  );
}
