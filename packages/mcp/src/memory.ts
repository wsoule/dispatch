import { untrustedFenced } from '@dispatch/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { DaemonFileInfo } from './daemon.js';
import { daemonAuth, readDaemonFile, requestDeadline } from './daemon.js';
import {
  fetchFailed,
  messagingErrorText,
  messagingFetch,
} from './messaging.js';
import { callingRunId, projectRoot, toolError, toolResult } from './toolKit.js';
import type { ToolOutcome } from './toolKit.js';

// Memory tools proxy /api/memory* (packages/server/src/memory/routes.ts) on the
// same credential as the msg_* tools: a run's token or an approved agent's.
const record = z.record(z.string(), z.unknown());

type JsonOutcome<T> =
  | { ok: true; body: T }
  | { ok: false; result: ToolOutcome };

// One GET to a memory route: its JSON body, or the tool error to return.
async function getJson<T = Record<string, unknown>>(
  rootDir: string,
  server: McpServer,
  path: string,
  tool: string
): Promise<JsonOutcome<T>> {
  const fetched = await messagingFetch(rootDir, server, path, {
    signal: requestDeadline(),
  });
  if (!fetched.ok) return { ok: false, result: fetchFailed(fetched, tool) };
  if (!fetched.res.ok)
    return {
      ok: false,
      result: toolError(await messagingErrorText(fetched.res)),
    };
  return { ok: true, body: (await fetched.res.json()) as T };
}

// Handles are stored upper-case; an agent may type one in any case.
function memoryRef(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith('#') ? trimmed.toUpperCase() : trimmed;
}

// Looks up the calling run's task and that task's parent epic — best-effort,
// since an unresolved one just makes a shared save project-wide instead.
async function callingTaskAndEpic(
  daemon: DaemonFileInfo,
  runId: string
): Promise<{ taskId: string | null; epicId: string | null }> {
  const port = daemon.port;
  const headers = daemonAuth(daemon);
  try {
    const runRes = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}`, {
      signal: requestDeadline(),
      headers,
    });
    if (!runRes.ok) return { taskId: null, epicId: null };
    const run = (await runRes.json()) as { taskId?: string };
    if (typeof run.taskId !== 'string') return { taskId: null, epicId: null };
    const taskRes = await fetch(
      `http://127.0.0.1:${port}/api/tasks/${run.taskId}`,
      { headers, signal: requestDeadline() }
    );
    if (!taskRes.ok) return { taskId: run.taskId, epicId: null };
    const task = (await taskRes.json()) as {
      meta?: { parent?: string | null };
    };
    return { taskId: run.taskId, epicId: task.meta?.parent ?? null };
  } catch {
    return { taskId: null, epicId: null };
  }
}

const MEMORY_SCOPES = ['personal', 'project', 'team'] as const;
const MEMORY_KINDS = [
  'preference',
  'convention',
  'constraint',
  'hazard',
  'decision',
  'fact',
  'reference',
] as const;

interface MemorySaveArgs {
  scope: (typeof MEMORY_SCOPES)[number];
  kind: (typeof MEMORY_KINDS)[number];
  title: string;
  body: string;
  refs?: { type: string; id: string; at?: string }[];
  epic?: string | null;
  appliesTo?: string[];
  supersedes?: string;
  projectOnly?: boolean;
}

// The POST /api/memory body. Personal memory has no epic; a shared save that
// names none inside a run reaches the run's epic.
async function saveBody(
  rootDir: string,
  args: MemorySaveArgs
): Promise<Record<string, unknown>> {
  const { epic, ...rest } = args;
  if (args.scope === 'personal') return rest;
  if (epic !== undefined) return { ...rest, epic };
  const runId = callingRunId();
  const daemon = readDaemonFile(projectRoot(rootDir));
  if (runId === undefined || daemon === null) return rest;
  const { epicId } = await callingTaskAndEpic(daemon, runId);
  return { ...rest, epic: epicId };
}

// POST /api/memory. One Idempotency-Key for both attempts: a dropped
// connection doesn't say whether the save landed, so the retry replays it.
async function memorySave(
  rootDir: string,
  server: McpServer,
  args: MemorySaveArgs
): Promise<ToolOutcome> {
  const idempotencyKey = randomUUID();
  const body = JSON.stringify(await saveBody(rootDir, args));
  const init = (): RequestInit => ({
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body,
    signal: requestDeadline(),
  });
  let sent = await messagingFetch(rootDir, server, '/api/memory', init);
  if (!sent.ok && sent.transient)
    sent = await messagingFetch(rootDir, server, '/api/memory', init);
  if (!sent.ok) return fetchFailed(sent, 'memory_save');
  if (!sent.res.ok) return toolError(await messagingErrorText(sent.res));
  return toolResult((await sent.res.json()) as Record<string, unknown>);
}

// POST /api/memory/:id/retire. Not retried: the route keeps no replay key,
// and a second retire could raise a second proposal.
async function memoryForget(
  rootDir: string,
  server: McpServer,
  args: { id: string; reason: string }
): Promise<ToolOutcome> {
  const sent = await messagingFetch(
    rootDir,
    server,
    `/api/memory/${encodeURIComponent(memoryRef(args.id))}/retire`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: args.reason }),
      signal: requestDeadline(),
    }
  );
  if (!sent.ok) return fetchFailed(sent, 'memory_forget');
  if (!sent.res.ok) return toolError(await messagingErrorText(sent.res));
  return toolResult((await sent.res.json()) as Record<string, unknown>);
}

const saveOutput = {
  status: z.string(),
  id: z.string().optional(),
  handle: z.string().optional(),
  proposal: z.string().optional(),
  gate: z.string().nullable().optional(),
};

// The GET /api/memory/:id fields memory_read reshapes; the rest pass through.
interface ReadBody {
  entry: Record<string, unknown> & {
    body: string;
    handle: string;
    author: unknown;
    trust: unknown;
    decidedBy: unknown;
    decidedByPolicy: unknown;
  };
  revisions: { rev: number; by: string; cause: string; at: string }[];
}

export function registerMemoryTools(server: McpServer, rootDir: string): void {
  server.registerTool(
    'memory_search',
    {
      title: 'Search memory',
      description:
        'Search the lessons, conventions and preferences Dispatch remembers. Your prompt\'s "## Memory" ' +
        'index lists only the top lines; this finds the rest. An empty query returns your top entries. ' +
        'Stale entries are included and marked unless includeStale is false.',
      inputSchema: {
        query: z.string(),
        scope: z.enum(['personal', 'project', 'team']).optional(),
        kind: z
          .string()
          .optional()
          .describe(
            'preference | convention | constraint | hazard | decision | fact | reference'
          ),
        includeStale: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      outputSchema: { hits: z.array(record), search: z.string() },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const params = new URLSearchParams({ q: args.query });
      if (args.scope !== undefined) params.set('scope', args.scope);
      if (args.kind !== undefined) params.set('kind', args.kind);
      if (args.includeStale !== undefined)
        params.set('includeStale', args.includeStale ? '1' : '0');
      if (args.limit !== undefined) params.set('limit', String(args.limit));
      const out = await getJson(
        rootDir,
        server,
        `/api/memory/search?${params.toString()}`,
        'memory_search'
      );
      return out.ok ? toolResult(out.body) : out.result;
    }
  );

  server.registerTool(
    'memory_read',
    {
      title: 'Read one memory',
      description:
        'Open one memory by its #handle (from the index or a search) or full id: its body, who wrote it, ' +
        'how far it is trusted, and its revisions.',
      inputSchema: { id: z.string() },
      outputSchema: {
        entry: record,
        body: z.string(),
        provenance: record,
        revisions: z.array(record),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const out = await getJson<ReadBody>(
        rootDir,
        server,
        `/api/memory/${encodeURIComponent(memoryRef(id))}`,
        'memory_read'
      );
      if (!out.ok) return out.result;
      const { entry, revisions } = out.body;
      const { body, ...rest } = entry;
      return toolResult({
        entry: rest,
        body: untrustedFenced(`memory ${entry.handle}`, body),
        provenance: {
          author: entry.author,
          trust: entry.trust,
          decidedBy: entry.decidedBy,
          decidedByPolicy: entry.decidedByPolicy,
        },
        revisions: revisions.map(({ rev, by, cause, at }) => ({
          rev,
          by,
          cause,
          at,
        })),
      });
    }
  );

  server.registerTool(
    'memory_save',
    {
      title: 'Save a memory',
      description:
        'Remember a lesson, convention, constraint, hazard, decision, fact or reference for later work. ' +
        'The title is the whole lesson in one line: later runs see only titles in their index. ' +
        'scope "personal" is your operator\'s own memory: saved at once, and they can undo it. ' +
        'scope "project" (this machine only) or "team" is reviewed: it becomes a proposal a human approves ' +
        "unless the project's autonomy policy accepts it. A preference is personal; a convention is shared.",
      inputSchema: {
        scope: z.enum(MEMORY_SCOPES),
        kind: z.enum(MEMORY_KINDS),
        title: z.string(),
        body: z.string(),
        refs: z
          .array(
            z.object({
              type: z.string(),
              id: z.string(),
              at: z.string().optional(),
            })
          )
          .optional(),
        epic: z.string().nullable().optional(),
        appliesTo: z.array(z.string()).optional(),
        supersedes: z.string().optional(),
        projectOnly: z.boolean().optional(),
      },
      outputSchema: saveOutput,
      annotations: { readOnlyHint: false },
    },
    (args) => memorySave(rootDir, server, args)
  );

  server.registerTool(
    'memory_forget',
    {
      title: 'Forget a memory',
      description:
        'Retire a memory that is wrong or no longer true, by its #handle or id, with a one-line reason. ' +
        "Your operator's personal entries retire at once and they can undo it; a project or team entry " +
        "becomes a proposal a human approves unless the project's autonomy policy accepts it.",
      inputSchema: { id: z.string(), reason: z.string() },
      outputSchema: saveOutput,
      annotations: { readOnlyHint: false },
    },
    (args) => memoryForget(rootDir, server, args)
  );
}
