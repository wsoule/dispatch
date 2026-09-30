import { memoryReadView } from '@dispatch/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { requestDeadline } from './daemon.js';
import {
  fetchFailed,
  messagingErrorText,
  messagingFetch,
} from './messaging.js';
import { toolError, toolResult } from './toolKit.js';
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

// The POST /api/memory body. Personal memory has no epic; the daemon gives a
// run's shared save that names none its task's parent epic.
function saveBody(args: MemorySaveArgs): Record<string, unknown> {
  const { epic, ...rest } = args;
  if (args.scope === 'personal' || epic === undefined) return rest;
  return { ...rest, epic };
}

// POSTs a memory write under one Idempotency-Key for both attempts: a dropped
// connection doesn't say whether the write landed, so the retry replays it.
async function postWrite(
  rootDir: string,
  server: McpServer,
  path: string,
  payload: Record<string, unknown>,
  tool: string
): Promise<ToolOutcome> {
  const idempotencyKey = randomUUID();
  const body = JSON.stringify(payload);
  const init = (): RequestInit => ({
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body,
    signal: requestDeadline(),
  });
  let sent = await messagingFetch(rootDir, server, path, init);
  if (!sent.ok && sent.transient)
    sent = await messagingFetch(rootDir, server, path, init);
  if (!sent.ok) return fetchFailed(sent, tool);
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
      const out = await getJson<Parameters<typeof memoryReadView>[0]>(
        rootDir,
        server,
        `/api/memory/${encodeURIComponent(memoryRef(id))}`,
        'memory_read'
      );
      if (!out.ok) return out.result;
      return toolResult(memoryReadView(out.body));
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
    async (args) =>
      postWrite(rootDir, server, '/api/memory', saveBody(args), 'memory_save')
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
    (args) =>
      postWrite(
        rootDir,
        server,
        `/api/memory/${encodeURIComponent(memoryRef(args.id))}/retire`,
        { reason: args.reason },
        'memory_forget'
      )
  );
}
