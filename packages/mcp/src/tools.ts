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

// Bug fix (fix/executor-mcp-wiring): when this server is launched by a
// dispatch run's own ClaudeExecutor (see packages/server/src/orchestrator/
// executors/claude.ts), `rootDir` is the run's git WORKTREE — a different
// directory than the dispatch PROJECT it was cut from — so task_list/
// task_get/task_save/task_next keep reading and writing the exact task files
// the run's own repo checkout sees. Two things must NOT resolve against that
// worktree, though:
//  - daemon discovery (run_list, agent_message): dispatchd's daemon file is
//    keyed by a hash of the PROJECT root (see daemon.ts), not the worktree —
//    a worktree path hashes to a different, nonexistent file, so these tools
//    would always report "dispatchd not running" for a project whose daemon
//    is, in fact, running.
//  - task_comment's write: a comment appended to the worktree's copy of a
//    task file lives on the run's own branch and is discarded the moment
//    that branch is squash-merged or the worktree is torn down — comments
//    need to land in the PROJECT's .dispatch/tasks, the one copy that
//    outlives any single run.
// The executor sets DISPATCH_PROJECT_ROOT to the project root whenever it
// differs from the worktree `--root` it passes; every other tool in this
// file keeps resolving against the raw `rootDir` argument.
function projectRoot(rootDir: string): string {
  const override = process.env.DISPATCH_PROJECT_ROOT;
  return override !== undefined && override !== '' ? override : rootDir;
}

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
  const daemon = readDaemonFile(projectRoot(rootDir));
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
  const daemon = readDaemonFile(projectRoot(rootDir));
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

// The calling agent's own run id, as set by ClaudeExecutor's
// buildDispatchMcpServerConfig (see packages/server/src/orchestrator/
// executors/claude.ts) into this MCP server's own process env — this is how
// `agent_message`/`message_user` know *whose* message they're forwarding
// without the calling model having to know or supply its own run id.
// `undefined` when this server wasn't launched by a real dispatch run (a
// manually-started server, or a test) — every caller below treats that as
// "sender identity unknown" rather than a hard error, so agent_message still
// works (falling back to the generic label dispatchd's own inject() already
// has) and only message_user, which has no meaning without an owning run,
// treats it as fatal.
function callingRunId(): string | undefined {
  const id = process.env.DISPATCH_RUN_ID;
  return id !== undefined && id !== '' ? id : undefined;
}

// Proxies `POST /api/runs/:id/inject` — the messaging half of agent
// collaboration (spec §5). Exactly one of `runId`/`taskId` must be given;
// `taskId` is resolved to that task's one live run via the same `GET
// /api/runs` fetch run_list already uses (no live run for that task is the
// same "clean error" as an unrecognized runId, not a protocol-level
// failure). The calling agent's identity comes from `DISPATCH_RUN_ID` (see
// `callingRunId` above) and rides along as `fromRunId` so dispatchd's own
// `inject()` can resolve a real sender label (task title + id) instead of
// the generic "another agent" fallback — this tool itself never builds the
// prefixed text, that's still entirely dispatchd's job.
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
    const fromRunId = callingRunId();
    const res = await fetch(
      `http://127.0.0.1:${live.port}/api/runs/${match.id}/inject`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          fromRunId !== undefined
            ? { text: args.text, fromRunId }
            : { text: args.text }
        ),
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

// Proxies `POST /api/runs/:id/message-user` — the agent->human channel
// (spec §8, `message_user`). Unlike `agent_message` there is no target to
// pick: the message always lands on the CALLING agent's own run (from
// `DISPATCH_RUN_ID`), which is also why a server not launched by a real
// dispatch run (no DISPATCH_RUN_ID at all) can't use this tool — there is
// no run for the message to belong to.
async function messageUser(
  rootDir: string,
  args: { text: string }
): Promise<ToolOutcome> {
  if (args.text.trim() === '') {
    return toolError('text must not be empty');
  }
  const runId = callingRunId();
  if (runId === undefined) {
    return toolError(
      'message_user requires a live dispatch run context (DISPATCH_RUN_ID not set)'
    );
  }

  const daemon = readDaemonFile(projectRoot(rootDir));
  if (daemon === null || !(await isDaemonHealthy(daemon.port))) {
    return toolError('dispatchd not running — no live run to message from');
  }

  try {
    const res = await fetch(
      `http://127.0.0.1:${daemon.port}/api/runs/${runId}/message-user`,
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
      return toolError(
        `message_user failed: ${body.error ?? `HTTP ${res.status}`}`
      );
    }
    return toolResult({ ok: true, runId });
  } catch (err) {
    return toolError(`message_user failed: ${(err as Error).message}`);
  }
}

// Proxies `POST /api/notes` — the agent side of the notes/triage hub. Lets an
// agent capture triage it finds mid-run ("this file is huge, refactor it"), a
// follow-up to do after merge, or a plain note, without derailing to file a
// full task. Records the calling run id (if any) so the app can show "an agent
// flagged this". Works whenever dispatchd is running — unlike message_user it
// doesn't require a live run context, so a manually-started server can still
// jot a note.
async function dispatchNote(
  rootDir: string,
  args: { kind: string; title: string; body?: string }
): Promise<ToolOutcome> {
  if (args.title.trim() === '') {
    return toolError('title must not be empty');
  }
  const daemon = readDaemonFile(projectRoot(rootDir));
  if (daemon === null || !(await isDaemonHealthy(daemon.port))) {
    return toolError('dispatchd not running — cannot add a note');
  }
  try {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: args.kind,
        title: args.title,
        body: args.body,
        createdByRunId: callingRunId(),
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return toolError(
        `dispatch_note failed: ${body.error ?? `HTTP ${res.status}`}`
      );
    }
    const note = (await res.json()) as { id: string };
    return toolResult({ ok: true, id: note.id });
  } catch (err) {
    return toolError(`dispatch_note failed: ${(err as Error).message}`);
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
        // projectRoot(), not the raw rootDir — see its doc comment above:
        // a comment written to a run's worktree copy of a task file would
        // be discarded the moment that run's branch is merged or discarded.
        const store = requireStore(projectRoot(rootDir));
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
        'Send a message into another live dispatch run — the agent->agent ' +
        'half of agent collaboration. Target it with exactly one of runId ' +
        "(a specific run) or taskId (that task's current live run); the " +
        'message is delivered prefixed "[message from <sender>]" (your own ' +
        'task title + run id when known, otherwise a generic "another ' +
        'agent" label) so the receiving agent can tell who is talking and ' +
        "tell it apart from its own task prompt. Both sides' Session tabs " +
        'show it. Fails with a clear error (and a list of what IS live ' +
        'right now) when the target has no live run, or when dispatchd ' +
        'itself is not running.',
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

  server.registerTool(
    'message_user',
    {
      title: 'Message the human',
      description:
        'Raise a message to the human running this task — the agent->user ' +
        'channel of agent collaboration. Use it to flag a question, a ' +
        'blocker, or a notable update that should surface beyond your own ' +
        'assistant output, e.g. before pausing on something ambiguous. ' +
        "Lands on this run's own Session tab, badged as coming from you. " +
        'Requires a live dispatch run context; fails with a clear error ' +
        'outside one (a manually-started MCP server, or dispatchd not ' +
        'running).',
      inputSchema: { text: z.string() },
      outputSchema: {
        ok: z.boolean(),
        runId: z.string(),
      },
      annotations: { readOnlyHint: false },
    },
    ({ text }) => messageUser(rootDir, { text })
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
}
