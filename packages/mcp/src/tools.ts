import {
  ASSIGNEES,
  ConfigError,
  KINDS,
  loadConfig,
  PRIORITIES,
  readyTasks,
  TaskParseError,
  TaskStore,
} from '@dispatch/core';
import type { ListSafeError, TaskDoc } from '@dispatch/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { basename } from 'node:path';
import { z } from 'zod';

import { isDaemonHealthy, readDaemonFile } from './daemon.js';

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

// TaskSummary: TaskMeta minus `external`, used by task_list/task_next to keep
// list payloads small (bodies are never included in a list response).
const taskSummaryShape = {
  id: z.string(),
  title: z.string(),
  status: z.string(),
  kind: z.enum(KINDS as unknown as [string, ...string[]]),
  parent: z.string().nullable(),
  blockedBy: z.array(z.string()),
  labels: z.array(z.string()),
  priority: z.enum(PRIORITIES as unknown as [string, ...string[]]),
  assignee: z.enum(ASSIGNEES as unknown as [string, ...string[]]),
  created: z.string(),
  updated: z.string(),
};

const taskMetaShape = {
  ...taskSummaryShape,
  external: z.string().nullable(),
};

function toSummary(doc: TaskDoc) {
  const {
    id,
    title,
    status,
    kind,
    parent,
    blockedBy,
    labels,
    priority,
    assignee,
    created,
    updated,
  } = doc.meta;
  return {
    id,
    title,
    status,
    kind,
    parent,
    blockedBy,
    labels,
    priority,
    assignee,
    created,
    updated,
  };
}

// Index signature matches the SDK's CallToolResult shape (an open record
// with a few known fields) so this satisfies ToolCallback's return type
// without pulling in the SDK's own (deeply generic) result type here.
interface ToolOutcome {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function toolResult(structuredContent: Record<string, unknown>): ToolOutcome {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function toolError(message: string): ToolOutcome {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Turns listSafe()'s per-file parse failures into the same doctor-pointing
// text task_get uses for a single corrupt file, so an agent sees one
// consistent hint no matter which tool surfaced the problem.
function formatProblems(errors: ListSafeError[]): string[] {
  return errors.map((e) => `${e.file}: ${e.message} — run 'dispatch doctor'`);
}

// Runs a tool body, turning a ToolError/ConfigError into a clean MCP tool
// error with our own message text. Anything else thrown here (a bug, a
// TaskParseError we didn't handle explicitly) is rethrown — but that does
// NOT become a protocol-level JSON-RPC error: the SDK's own tool-call
// handling catches exceptions thrown from a registered callback and turns
// them into a `{ isError: true }` CallToolResult itself (verified against
// the installed SDK — an uncaught throw in a tool handler surfaces to the
// client as a normal tool result, not a `client.callTool()` rejection). We
// still catch ToolError/ConfigError explicitly so the message text matches
// the CLI exactly, rather than relying on the SDK's default `String(err)`
// rendering of whatever a rethrow produces.
function wrap(fn: () => ToolOutcome): ToolOutcome {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ToolError || err instanceof ConfigError) {
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
  const daemon = readDaemonFile(rootDir);
  if (daemon === null || !(await isDaemonHealthy(daemon.port))) {
    return noDaemonResult();
  }
  try {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/runs`);
    if (!res.ok) return noDaemonResult();
    const runs = await res.json();
    if (!Array.isArray(runs)) return noDaemonResult();
    return toolResult({ runs });
  } catch {
    return noDaemonResult();
  }
}

// Mirrors @dispatch/server's orchestrator/types.ts TERMINAL_RUN_STATES —
// kept as a plain local copy (like run_list's loosely-typed RunMeta) since
// @dispatch/mcp intentionally has no dependency on the Bun-only
// @dispatch/server package.
const TERMINAL_RUN_STATES = new Set(['finished', 'failed', 'cancelled']);

interface LiveRunLike {
  id: string;
  taskId: string;
  taskTitle: string;
  state: string;
}

// Fetches `GET /api/runs` from the live daemon and narrows it to runs that
// are not yet terminal — the only ones agent_message can actually reach.
// Returns null when there is nothing to report at all (no daemon, unhealthy,
// bad response shape) so the caller can fall back to a single "not running"
// message instead of duplicating run_list's daemon-plumbing tolerance here.
async function fetchLiveRuns(
  rootDir: string
): Promise<{ port: number; runs: LiveRunLike[] } | null> {
  const daemon = readDaemonFile(rootDir);
  if (daemon === null || !(await isDaemonHealthy(daemon.port))) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/runs`);
    if (!res.ok) return null;
    const runs = await res.json();
    if (!Array.isArray(runs)) return null;
    return {
      port: daemon.port,
      runs: (runs as LiveRunLike[]).filter(
        (r) => !TERMINAL_RUN_STATES.has(r.state)
      ),
    };
  } catch {
    return null;
  }
}

// Builds the "nothing to message" error text agent_message returns when its
// target (a runId or taskId) doesn't match any currently-live run — always
// lists every other live run (id + task title) so the calling agent can
// self-correct by picking one of those instead, or learn there simply are
// none right now.
function noLiveTargetMessage(target: string, live: LiveRunLike[]): string {
  if (live.length === 0) {
    return `no live run for ${target} — there are no live runs at all right now`;
  }
  const listing = live.map((r) => `${r.id} (${r.taskTitle})`).join(', ');
  return `no live run for ${target} — live runs: ${listing}`;
}

// Proxies `POST /api/runs/:id/inject` — the messaging half of agent
// collaboration (spec §5). Exactly one of `runId`/`taskId` must be given;
// `taskId` is resolved to that task's one live run via the same `GET
// /api/runs` fetch run_list already uses (no live run for that task is the
// same "clean error" as an unrecognized runId, not a protocol-level
// failure). The calling agent's own identity is unknown to MCP, so every
// injected message is unconditionally prefixed — dispatchd's `inject()`
// endpoint owns the actual prefixing (see orchestrator.ts's `inject`), this
// tool only has to route to the right run.
async function agentMessage(
  rootDir: string,
  args: { runId?: string; taskId?: string; text: string }
): Promise<ToolOutcome> {
  if (args.text.trim() === '') {
    return toolError('text must not be empty');
  }
  if ((args.runId === undefined) === (args.taskId === undefined)) {
    return toolError('exactly one of runId or taskId is required');
  }

  const live = await fetchLiveRuns(rootDir);
  if (live === null) {
    return toolError('dispatchd not running — no live runs to message');
  }

  const target = args.runId ?? args.taskId!;
  const match =
    args.runId !== undefined
      ? live.runs.find((r) => r.id === args.runId)
      : live.runs.find((r) => r.taskId === args.taskId);
  if (match === undefined) {
    return toolError(noLiveTargetMessage(target, live.runs));
  }

  try {
    const res = await fetch(
      `http://127.0.0.1:${live.port}/api/runs/${match.id}/inject`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: args.text }),
      }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      return toolError(`inject failed: ${body.error ?? `HTTP ${res.status}`}`);
    }
    return toolResult({ ok: true, runId: match.id });
  } catch (err) {
    return toolError(`inject failed: ${(err as Error).message}`);
  }
}

// Registers the five task_* tools plus run_list against a fixed root
// directory. Each task_* tool re-resolves the TaskStore/config on every call
// (rather than caching it at registration time) so a `dispatch init` that
// happens after the server started is picked up without a restart; run_list
// re-resolves the daemon file for the same reason (a `dispatch serve`/`ui`
// that starts or stops after this MCP server started is picked up too).
export function registerDispatchTools(
  server: McpServer,
  rootDir: string
): void {
  server.registerTool(
    'task_list',
    {
      title: 'List tasks',
      description:
        'List tasks (metadata only — no body) optionally filtered by status, kind, or parent.',
      inputSchema: {
        status: z.string().optional(),
        kind: z.string().optional(),
        parent: z.string().optional(),
      },
      outputSchema: {
        tasks: z.array(z.object(taskSummaryShape)),
        problems: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
    ({ status, kind, parent }) =>
      wrap(() => {
        const store = requireStore(rootDir);
        const config = loadConfig(rootDir);
        // listSafe() (not list()) so one unparsable task file surfaces as a
        // `problems` entry instead of failing the whole call — the daemon's
        // cache rebuild uses the same method for the same reason.
        const { docs, errors } = store.listSafe({
          status: validate(status, config.statuses, 'status'),
          kind: validate(kind, KINDS, 'kind'),
          parent,
        });
        return toolResult({
          tasks: docs.map(toSummary),
          problems: formatProblems(errors),
        });
      })
  );

  server.registerTool(
    'task_get',
    {
      title: 'Get a task',
      description:
        'Fetch a single task by id, including its full markdown body.',
      inputSchema: { id: z.string() },
      outputSchema: { meta: z.object(taskMetaShape), body: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      wrap(() => {
        const store = requireStore(rootDir);
        let doc: TaskDoc | null;
        try {
          doc = store.get(id);
        } catch (err) {
          if (err instanceof TaskParseError) {
            // basename only — task_list's problems[] and the CLI never expose
            // absolute paths, and neither should a remote MCP client see them.
            const file = err.file === undefined ? id : basename(err.file);
            throw new ToolError(
              `${file}: ${err.message} — run 'dispatch doctor'`
            );
          }
          throw err;
        }
        if (doc === null) throw new ToolError(`task not found: ${id}`);
        return toolResult({ meta: doc.meta, body: doc.body });
      })
  );

  server.registerTool(
    'task_save',
    {
      title: 'Create or update a task',
      description:
        'Upsert a task. Omit id to create (title required) — creating is NOT ' +
        'idempotent; calling this twice without an id makes two tasks. With id, ' +
        'only the provided fields change — omitted fields are untouched, ' +
        'blockedBy/labels are full replacements. kind and description apply on ' +
        'create only; there is no supported way to change kind or rewrite the ' +
        'description section after creation.',
      // Enum-shaped fields (kind, priority, assignee) are typed as plain
      // strings here — deliberately not z.enum — so an invalid value reaches
      // our own validate() below and produces the same CLI-style error
      // message, instead of a generic zod schema-validation error.
      inputSchema: {
        id: z.string().optional(),
        title: z.string().optional(),
        status: z.string().optional(),
        kind: z.string().optional(),
        parent: z.string().nullable().optional(),
        blockedBy: z.array(z.string()).optional(),
        labels: z.array(z.string()).optional(),
        priority: z.string().optional(),
        assignee: z.string().optional(),
        description: z.string().optional(),
      },
      outputSchema: { meta: z.object(taskMetaShape), body: z.string() },
      // No idempotentHint: creating (no id) makes a new task every call, so
      // that hint would be false advertising for half of what this tool
      // does. Honest annotations over the plan's original text.
    },
    (input) =>
      wrap(() => {
        const store = requireStore(rootDir);
        const config = loadConfig(rootDir);
        const status = validate(input.status, config.statuses, 'status');
        const priority = validate(input.priority, PRIORITIES, 'priority');
        const assignee = validate(input.assignee, ASSIGNEES, 'assignee');

        if (input.id === undefined) {
          if (input.title === undefined || input.title.trim() === '') {
            throw new ToolError('title must not be empty');
          }
          const kind = validate(input.kind, KINDS, 'kind');
          const doc = store.create({
            title: input.title,
            kind,
            status,
            description: input.description,
            parent: input.parent ?? null,
            priority,
            labels: input.labels ?? [],
            blockedBy: input.blockedBy ?? [],
            assignee,
          });
          return toolResult({ meta: doc.meta, body: doc.body });
        }

        const existing = store.get(input.id);
        if (existing === null) {
          throw new ToolError(`task not found: ${input.id}`);
        }
        const patch = {
          title: input.title,
          status,
          parent: input.parent,
          blockedBy: input.blockedBy,
          labels: input.labels,
          priority,
          assignee,
        };
        // `kind` and `description` are the only fields a caller could have
        // sent that don't end up in `patch` (both are create-only — see
        // above). If every other field is undefined too, there is nothing
        // to write: skip store.update() entirely rather than rewriting the
        // file with an identical body and a bumped `updated` timestamp for
        // no real change.
        const hasChange = Object.values(patch).some((v) => v !== undefined);
        if (!hasChange) {
          return toolResult({ meta: existing.meta, body: existing.body });
        }
        const doc = store.update(input.id, patch);
        return toolResult({ meta: doc.meta, body: doc.body });
      })
  );

  server.registerTool(
    'task_comment',
    {
      title: 'Comment on a task',
      description: "Append a timestamped line to a task's Activity log.",
      inputSchema: { id: z.string(), text: z.string() },
      outputSchema: { meta: z.object(taskMetaShape) },
    },
    ({ id, text }) =>
      wrap(() => {
        const store = requireStore(rootDir);
        if (store.get(id) === null)
          throw new ToolError(`task not found: ${id}`);
        const doc = store.update(id, {
          appendActivity: `${new Date().toISOString()} ${text}`,
        });
        return toolResult({ meta: doc.meta });
      })
  );

  server.registerTool(
    'task_next',
    {
      title: 'Ready work',
      description:
        'List tasks ready to start now: kind task, status todo, all blockers done. Priority-ordered.',
      outputSchema: {
        tasks: z.array(z.object(taskSummaryShape)),
        problems: z.array(z.string()),
      },
      annotations: { readOnlyHint: true },
    },
    () =>
      wrap(() => {
        const store = requireStore(rootDir);
        const { docs, errors } = store.listSafe();
        const tasks = readyTasks(docs).map(toSummary);
        return toolResult({ tasks, problems: formatProblems(errors) });
      })
  );

  server.registerTool(
    'run_list',
    {
      title: 'List orchestrator runs',
      description:
        "List this project's dispatchd orchestrator runs (live + recent) " +
        'so an agent can see whether other agents already have runs in ' +
        'flight before assuming exclusive access to the repo. Returns an ' +
        "empty list with a note when dispatchd isn't running — that's a " +
        'normal, not-an-error response, not every project runs the daemon.',
      outputSchema: {
        runs: z.array(z.record(z.string(), z.unknown())),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    () => runList(rootDir)
  );

  server.registerTool(
    'agent_message',
    {
      title: 'Message a live run',
      description:
        'Send a message into another live dispatch run — the messaging ' +
        'half of agent collaboration. Target it with exactly one of runId ' +
        "(a specific run) or taskId (that task's current live run); the " +
        'message is delivered prefixed "[message from another agent]" so ' +
        'the receiving agent can tell it apart from its own task prompt. ' +
        'Fails with a clear error (and a list of what IS live right now) ' +
        'when the target has no live run, or when dispatchd itself is not ' +
        'running.',
      inputSchema: {
        runId: z.string().optional(),
        taskId: z.string().optional(),
        text: z.string(),
      },
      outputSchema: {
        ok: z.boolean(),
        runId: z.string(),
      },
    },
    ({ runId, taskId, text }) => agentMessage(rootDir, { runId, taskId, text })
  );
}
