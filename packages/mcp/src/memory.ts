import { untrustedFenced } from '@dispatch/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
      // Handles are stored upper-case; an agent may type one in any case.
      const trimmed = id.trim();
      const ref = trimmed.startsWith('#') ? trimmed.toUpperCase() : trimmed;
      const out = await getJson<ReadBody>(
        rootDir,
        server,
        `/api/memory/${encodeURIComponent(ref)}`,
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
}
