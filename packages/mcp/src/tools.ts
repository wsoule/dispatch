import {
  ASSIGNEES,
  ConfigError,
  KINDS,
  loadConfig,
  PRIORITIES,
  readyTasks,
  TaskStore,
} from '@dispatch/core';
import type { TaskDoc } from '@dispatch/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

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

// Runs a tool body, turning a ToolError/ConfigError into a clean MCP tool
// error instead of letting it surface as a protocol-level failure. Anything
// else (a bug, a corrupt task file) is rethrown and becomes a protocol-level
// error, per the MCP spec: only *expected* operational failures belong in
// the result body.
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

// Registers the five task_* tools against a fixed root directory. Each tool
// re-resolves the TaskStore/config on every call (rather than caching it at
// registration time) so a `dispatch init` that happens after the server
// started is picked up without a restart.
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
      outputSchema: { tasks: z.array(z.object(taskSummaryShape)) },
      annotations: { readOnlyHint: true },
    },
    ({ status, kind, parent }) =>
      wrap(() => {
        const store = requireStore(rootDir);
        const config = loadConfig(rootDir);
        const tasks = store
          .list({
            status: validate(status, config.statuses, 'status'),
            kind: validate(kind, KINDS, 'kind'),
            parent,
          })
          .map(toSummary);
        return toolResult({ tasks });
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
        const doc = store.get(id);
        if (doc === null) throw new ToolError(`task not found: ${id}`);
        return toolResult({ meta: doc.meta, body: doc.body });
      })
  );

  server.registerTool(
    'task_save',
    {
      title: 'Create or update a task',
      description:
        'Upsert a task. Omit id to create (title required). With id, only the ' +
        'provided fields change — omitted fields are untouched, blockedBy/labels ' +
        'are full replacements. kind and description apply on create only; there ' +
        'is no supported way to change kind or rewrite the description section ' +
        'after creation.',
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
      annotations: { idempotentHint: true },
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

        if (store.get(input.id) === null) {
          throw new ToolError(`task not found: ${input.id}`);
        }
        const doc = store.update(input.id, {
          title: input.title,
          status,
          parent: input.parent,
          blockedBy: input.blockedBy,
          labels: input.labels,
          priority,
          assignee,
        });
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
      outputSchema: { tasks: z.array(z.object(taskSummaryShape)) },
      annotations: { readOnlyHint: true },
    },
    () =>
      wrap(() => {
        const store = requireStore(rootDir);
        const tasks = readyTasks(store.list()).map(toSummary);
        return toolResult({ tasks });
      })
  );
}
