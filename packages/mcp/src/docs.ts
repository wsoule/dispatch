import type {
  DocConflict,
  DocHit,
  DocRead,
  DocSaveResult,
  DocSummary,
} from '@dispatch/core';
import { untrustedInline, untrustedVerbatim } from '@dispatch/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { requestDeadline } from './daemon.js';
import { existingMessagingCredential } from './identity.js';
import {
  fetchFailed,
  messagingErrorText,
  messagingFetch,
} from './messaging.js';
import type { ToolOutcome } from './toolKit.js';
import { projectRoot, toolError } from './toolKit.js';

// The five doc tools. They authenticate like msg_* (a run's token or a
// registered agent's), return text only, and never pass another principal's
// text unmarked: pages and hunks are fenced verbatim, everything else folded.

const HUNKS_MAX_BYTES = 16 * 1024;

const text = (value: string): ToolOutcome => ({
  content: [{ type: 'text', text: value }],
});
const kb = (bytes: number): string =>
  `${Math.max(1, Math.round(bytes / 1024))} KB`;
const handleOf = (d: { scope: string; handle: string }): string =>
  `${d.scope === 'personal' ? '~' : ''}${d.handle}`;

interface SeenRev {
  id: string;
  n: number | null;
  hash: string;
}

// What this server last handed the agent per doc id and written handle, so a
// whole-body save against that revision carries its body hash (spec "Bases").
type Seen = Map<string, SeenRev>;

type CallOutcome =
  | { ok: true; res: Response }
  | { ok: false; result: ToolOutcome };

function remember(seen: Seen, keys: string[], rev: SeenRev): void {
  for (const key of keys) seen.set(key, rev);
}

// One doc_list line: handle, flags, size, last writer and title, all folded.
function docLine(d: DocSummary): string {
  const flags = [
    d.scope,
    d.status,
    ...(d.unreviewed ? ['unreviewed'] : []),
    ...(d.conflicted ? ['conflicted'] : []),
  ].join(' · ');
  const rel =
    d.rel === null ? '' : ` · ${d.fromParent ? 'parent ' : ''}${d.rel}`;
  return `- ${handleOf(d)} · ${flags} · rev ${d.head.n} · ${kb(d.head.bytes)} · updated by ${untrustedInline(d.updatedBy)} ${d.updatedAt.slice(0, 10)}${rel}: ${untrustedInline(d.title)}`;
}

// A doc_read answer: a folded header and outline, then the page fenced verbatim.
function renderDocRead(r: DocRead): string {
  const handle = handleOf(r.doc);
  const flags = [
    r.doc.scope,
    r.doc.status,
    ...(r.doc.unreviewed ? ['unreviewed'] : []),
  ].join(' · ');
  const links =
    r.links.length === 0
      ? 'none'
      : r.links
          .map((l) => `${l.target.type}:${l.target.id} (${l.rel})`)
          .join(', ');
  const nextPage =
    r.nextOffset === null
      ? '(end)'
      : `next page: doc_read("${handle}"${r.section === null ? '' : `, section: "#${r.section.anchor}"`}, offset: ${r.nextOffset})`;
  const lines = [
    `doc ${handle} · ${flags} · rev ${r.rev.n ?? '-'} (${r.rev.id}) · ${r.total} bytes${r.section === null ? '' : ` · section #${r.section.anchor}`}`,
    `title: ${untrustedInline(r.doc.title)}`,
    `last change: rev ${r.rev.n ?? '-'} by ${untrustedInline(r.rev.author)}: ${untrustedInline(r.rev.summary)}`,
    `links: ${links}`,
    ...(r.proposal === null
      ? []
      : [
          `your open proposal: ${r.proposal} (read it with doc_read(rev: "${r.proposal}"))`,
        ]),
    'outline:',
    ...r.outline.map(
      (o) =>
        `  ${'#'.repeat(o.level)} ${untrustedInline(o.heading)} (#${o.anchor}, ${kb(o.bytes)})`
    ),
    untrustedVerbatim(`doc ${handle} rev ${r.rev.n ?? r.rev.id}`, r.text),
    nextPage,
  ];
  return lines.join('\n');
}

// A doc_save answer: the outcome, what it rebased over, and where a merge left
// the writer's own text.
function saveLine(r: DocSaveResult): string {
  const out = [
    `${r.status} doc ${handleOf(r.doc)} rev ${r.rev.n ?? '-'} (${r.rev.id})`,
  ];
  for (const s of r.rebased?.since ?? [])
    out.push(
      `  since your base: rev ${s.n} by ${untrustedInline(s.author)}: ${untrustedInline(s.summary)}`
    );
  if (r.mine !== undefined)
    out.push(
      `  your text is rev ${r.mine.n ?? '-'} (${r.mine.id}); base another whole-body save on it, or doc_read the merged text first`
    );
  if (r.proposal !== undefined)
    out.push(
      `  proposed for review as ${r.proposal}${r.gate === undefined ? '' : ` (gate ${r.gate})`}`
    );
  return out.join('\n');
}

// A save the daemon refused as a conflict: what to do next, and the hunks fenced.
function conflictText(c: DocConflict): string {
  if (c.reason === 'base-changed') {
    return 'doc_save conflict: your base changed since you read it (another editor of yours saved first). Re-read with doc_read and save again.';
  }
  let hunks = c.hunks
    .map((h) =>
      [
        `@@ line ${h.line} @@`,
        '--- base',
        ...h.base,
        '--- head',
        ...h.head,
        '--- yours',
        ...h.mine,
      ]
        .map((l) => l.replace(/\n$/, ''))
        .join('\n')
    )
    .join('\n');
  if (Buffer.byteLength(hunks) > HUNKS_MAX_BYTES)
    hunks = `${Buffer.from(hunks).subarray(0, HUNKS_MAX_BYTES).toString('utf8')}\n(cut at 16 KiB)`;
  return [
    `doc_save conflict: rev ${c.head.n} by ${untrustedInline(c.head.author)} changed the same lines. Re-read with doc_read and edit with ops, or save against rev ${c.head.n}.`,
    untrustedVerbatim('conflict hunks', hunks),
  ].join('\n');
}

// A 409 carries a DocConflict only for a whole-body save; other conflicts
// (an archived doc, say) are a plain error body.
function isDocConflict(body: unknown): body is DocConflict {
  const reason = (body as { reason?: unknown } | null)?.reason;
  return reason === 'merge-conflict' || reason === 'base-changed';
}

const opSchema = z.object({
  op: z.enum(['replace_section', 'replace', 'insert', 'append', 'set_title']),
  section: z.string().optional(),
  text: z.string().optional(),
  find: z.string().optional(),
  before: z.string().optional(),
  title: z.string().optional(),
});

// A task's ## Docs lines on the caller's own messaging credential (docs routes
// refuse the shared agentToken). Omitted when no credential exists yet, so
// task_get never registers an agent, or when the daemon cannot answer.
export async function taskDocLines(
  rootDir: string,
  server: McpServer,
  taskId: string
): Promise<string[] | undefined> {
  const clientName = server.server.getClientVersion()?.name;
  if (existingMessagingCredential(projectRoot(rootDir), clientName) === null)
    return undefined;
  const out = await messagingFetch(
    rootDir,
    server,
    `/api/docs/index?taskId=${encodeURIComponent(taskId)}`,
    { signal: requestDeadline() }
  );
  if (!out.ok || !out.res.ok) return undefined;
  const body = (await out.res.json().catch(() => null)) as {
    lines?: unknown;
  } | null;
  const lines = body?.lines;
  return Array.isArray(lines) && lines.every((l) => typeof l === 'string')
    ? lines
    : undefined;
}

export function registerDocTools(server: McpServer, rootDir: string): void {
  const seen: Seen = new Map();

  // One request; a write carries an Idempotency-Key and retries a dropped
  // connection once with the same key.
  const call = async (
    path: string,
    init: RequestInit,
    name: string,
    write: boolean
  ): Promise<CallOutcome> => {
    const headers = new Headers(init.headers);
    if (write) headers.set('idempotency-key', randomUUID());
    const attempt = () =>
      messagingFetch(rootDir, server, path, {
        ...init,
        headers,
        signal: requestDeadline(),
      });
    let out = await attempt();
    if (!out.ok && out.transient && write) out = await attempt();
    if (!out.ok) return { ok: false, result: fetchFailed(out, name) };
    return { ok: true, res: out.res };
  };
  const json = (body: unknown): RequestInit => ({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const docPath = (ref: string): string =>
    `/api/docs/${encodeURIComponent(ref)}`;

  server.registerTool(
    'doc_list',
    {
      title: 'List docs',
      description:
        "List the project's docs you can see. With no arguments inside a run, your task's linked docs in the order your prompt's ## Docs section uses; pass task to see another task's, or query to filter by title.",
      inputSchema: {
        task: z.string().optional(),
        scope: z.enum(['team', 'personal']).optional(),
        status: z.enum(['draft', 'accepted', 'archived']).optional(),
        query: z.string().optional(),
        includeArchived: z.boolean().optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const q = new URLSearchParams();
      if (args.task !== undefined) q.set('taskId', args.task);
      if (args.scope !== undefined) q.set('scope', args.scope);
      if (args.status !== undefined) q.set('status', args.status);
      if (args.query !== undefined) q.set('q', args.query);
      if (args.includeArchived === true) q.set('includeArchived', '1');
      q.set('limit', String(args.limit ?? 20));
      const r = await call(`/api/docs?${q.toString()}`, {}, 'doc_list', false);
      if (!r.ok) return r.result;
      if (!r.res.ok) return toolError(await messagingErrorText(r.res));
      const { docs, total } = (await r.res.json()) as {
        docs: DocSummary[];
        total: number;
      };
      if (docs.length === 0) return text('no docs');
      const more =
        total > docs.length
          ? [`(${total - docs.length} more; raise limit)`]
          : [];
      return text([...docs.map(docLine), ...more].join('\n'));
    }
  );

  server.registerTool(
    'doc_read',
    {
      title: 'Read a doc',
      description:
        'Read a doc by handle or id (handle#anchor reads one section): a header, the outline with anchors and sizes, and one page of at most 32 KiB, fenced exactly as stored so text you copy from it matches for doc_save. Pass offset for the next page, or rev for an older revision.',
      inputSchema: {
        doc: z.string(),
        section: z.string().optional(),
        rev: z.union([z.string(), z.number().int()]).optional(),
        offset: z.number().int().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const hash = args.doc.indexOf('#');
      const ref = hash === -1 ? args.doc : args.doc.slice(0, hash);
      const section =
        args.section ?? (hash === -1 ? undefined : args.doc.slice(hash));
      const q = new URLSearchParams();
      if (section !== undefined) q.set('section', section);
      if (args.rev !== undefined) q.set('rev', String(args.rev));
      if (args.offset !== undefined) q.set('offset', String(args.offset));
      q.set('page', '1');
      const r = await call(
        `${docPath(ref)}?${q.toString()}`,
        {},
        'doc_read',
        false
      );
      if (!r.ok) return r.result;
      if (!r.res.ok) return toolError(await messagingErrorText(r.res));
      const read = (await r.res.json()) as DocRead;
      if (args.rev === undefined)
        remember(seen, [read.doc.id, handleOf(read.doc)], {
          id: read.rev.id,
          n: read.rev.n,
          hash: read.rev.hash,
        });
      return text(renderDocRead(read));
    }
  );

  server.registerTool(
    'doc_search',
    {
      title: 'Search docs',
      description:
        'Search every doc you can see; returns matching sections (handle#anchor, heading, snippet), at most 3 per doc.',
      inputSchema: {
        query: z.string(),
        scope: z.enum(['team', 'personal']).optional(),
        limit: z.number().int().positive().max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const q = new URLSearchParams({ q: args.query });
      if (args.scope !== undefined) q.set('scope', args.scope);
      if (args.limit !== undefined) q.set('limit', String(args.limit));
      const r = await call(
        `/api/docs/search?${q.toString()}`,
        {},
        'doc_search',
        false
      );
      if (!r.ok) return r.result;
      if (!r.res.ok) return toolError(await messagingErrorText(r.res));
      const { hits } = (await r.res.json()) as { hits: DocHit[] };
      if (hits.length === 0) return text('no matches');
      return text(
        hits
          .map(
            (h) =>
              `- ${handleOf(h)}#${h.anchor} ${untrustedInline(h.heading)}: ${untrustedInline(h.snippet)}`
          )
          .join('\n')
      );
    }
  );

  server.registerTool(
    'doc_save',
    {
      title: 'Create or change a doc',
      description:
        'Three modes. No doc: create one from title and body (scope team by default; inside a run it links to your task). doc and ops: anchored edits (replace_section swaps what is under a heading, and the heading line stays; replace with a unique find, insert before a heading, append, set_title) applied to the newest text, so they survive a human editing elsewhere in the doc — prefer these. doc, body and baseRev: a whole-body save, merged with any newer edits; a real conflict comes back with the hunks. Every revision is attributed and can be reverted; an edit to an accepted doc is proposed for review.',
      inputSchema: {
        doc: z.string().optional(),
        ops: z.array(opSchema).optional(),
        body: z.string().optional(),
        baseRev: z.union([z.string(), z.number().int()]).optional(),
        title: z.string().optional(),
        slug: z.string().optional(),
        scope: z.enum(['team', 'personal']).optional(),
        links: z
          .array(
            z.object({
              target: z.string(),
              rel: z.enum(['spec', 'plan', 'context']),
            })
          )
          .optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      if (args.ops !== undefined && args.body !== undefined)
        return toolError('doc_save: pass ops or body, not both');
      let r: CallOutcome;
      if (args.doc === undefined) {
        if (args.ops !== undefined)
          return toolError(
            'doc_save: ops edit an existing doc; to create, pass title and body'
          );
        if (args.title === undefined || args.body === undefined)
          return toolError('doc_save: creating a doc needs title and body');
        r = await call(
          '/api/docs',
          {
            method: 'POST',
            ...json({
              title: args.title,
              body: args.body,
              slug: args.slug,
              scope: args.scope,
              links: args.links,
            }),
          },
          'doc_save',
          true
        );
      } else if (args.ops !== undefined) {
        r = await call(
          `${docPath(args.doc)}/edit`,
          { method: 'POST', ...json({ ops: args.ops, baseRev: args.baseRev }) },
          'doc_save',
          true
        );
      } else if (args.body !== undefined) {
        if (args.baseRev === undefined)
          return toolError(
            'doc_save: a whole-body save needs baseRev, the revision you read (doc_read shows it)'
          );
        const known = seen.get(args.doc);
        const matches =
          known !== undefined &&
          (known.id === args.baseRev ||
            String(known.n) === String(args.baseRev));
        r = await call(
          `${docPath(args.doc)}/body`,
          {
            method: 'PUT',
            ...json({
              baseRev: args.baseRev,
              ...(matches ? { baseHash: known.hash } : {}),
              body: args.body,
              ...(args.title === undefined ? {} : { title: args.title }),
            }),
          },
          'doc_save',
          true
        );
      } else {
        return toolError('doc_save: pass ops or body to change a doc');
      }
      if (!r.ok) return r.result;
      if (r.res.status === 409) {
        const conflict: unknown = await r.res
          .clone()
          .json()
          .catch(() => null);
        if (isDocConflict(conflict)) return toolError(conflictText(conflict));
      }
      if (!r.res.ok) return toolError(await messagingErrorText(r.res));
      const result = (await r.res.json()) as DocSaveResult;
      remember(
        seen,
        [result.doc.id, handleOf(result.doc)],
        result.mine ?? result.rev
      );
      return text(saveLine(result));
    }
  );

  server.registerTool(
    'doc_link',
    {
      title: 'Link a doc',
      description:
        'Link a doc to task:t-…, run:r-…, thread:m-…, memory:mem-… or doc:<handle>, as spec (the doc a task implements), plan or context (default); remove: true unlinks. Inside a run you link only your own task, run and threads.',
      inputSchema: {
        doc: z.string(),
        target: z.string(),
        rel: z.enum(['spec', 'plan', 'context']).optional(),
        remove: z.boolean().optional(),
        replace: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const colon = args.target.indexOf(':');
      if (colon < 1)
        return toolError(
          'doc_link: target is type:id, like task:t-1 or doc:auth'
        );
      const type = encodeURIComponent(args.target.slice(0, colon));
      const id = encodeURIComponent(args.target.slice(colon + 1));
      const r =
        args.remove === true
          ? await call(
              `${docPath(args.doc)}/links/${type}/${id}`,
              { method: 'DELETE' },
              'doc_link',
              true
            )
          : await call(
              `${docPath(args.doc)}/links`,
              {
                method: 'POST',
                ...json({
                  target: args.target,
                  rel: args.rel ?? 'context',
                  replace: args.replace === true,
                }),
              },
              'doc_link',
              true
            );
      if (!r.ok) return r.result;
      if (!r.res.ok) return toolError(await messagingErrorText(r.res));
      const { links } = (await r.res.json()) as {
        links: {
          target: { type: string; id: string };
          rel: string;
          source: string;
        }[];
      };
      if (links.length === 0) return text('no links');
      return text(
        links
          .map(
            (l) =>
              `- ${l.target.type}:${l.target.id} (${l.rel}${l.source === 'mention' ? ', from a [[mention]]' : ''})`
          )
          .join('\n')
      );
    }
  );
}
