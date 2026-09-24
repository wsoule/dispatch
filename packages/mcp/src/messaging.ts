import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { z } from 'zod';

import {
  daemonAuth,
  isDaemonHealthy,
  readDaemonFile,
  requestDeadline,
} from './daemon.js';
import {
  agentName,
  agentTokenFilePath,
  forgetAgentToken,
  messagingCredential,
} from './identity.js';
import type { MessagingCredential } from './identity.js';
import type { MessageBlockingTiming } from './toolKit.js';
import {
  DEFAULT_MESSAGE_BLOCKING_TIMING,
  pollSignal,
  projectRoot,
  toolError,
  toolResult,
} from './toolKit.js';
import type { ToolOutcome } from './toolKit.js';

// Messaging tools (spec §5–§8), each proxying a route under
// packages/server/src/messaging/routes.ts, authenticated via identity.ts.

const refShape = {
  type: z.string(),
  id: z.string(),
  at: z.string().optional(),
};

// Every messaging response is relayed close to verbatim — no value in
// re-declaring @dispatch/protocol's shapes field by field here.
const record = z.record(z.string(), z.unknown());

// Renders a messaging route's {error, field?} body as one line, so an agent
// sees which input was rejected without parsing JSON out of an error string.
async function messagingErrorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    field?: string;
  };
  const message = body.error ?? `HTTP ${res.status}`;
  return body.field !== undefined
    ? `${message} (field: ${body.field})`
    : message;
}

// A messaging request's result, or why it failed: `transient` (a network
// hiccup) is safe to retry/ride out; non-transient (no daemon, revoked) is not.
type MessagingFetchOutcome =
  | { ok: true; res: Response; kind: MessagingCredential['kind'] }
  | { ok: false; transient: true; message: string }
  | { ok: false; transient: false; result: ToolOutcome };

// The auth `code` a messaging route's 401 body carries, when it parses
// (see packages/server/src/messaging/principal.ts's resolvePrincipal).
async function authErrorCode(res: Response): Promise<string | undefined> {
  const body = (await res
    .clone()
    .json()
    .catch(() => ({}))) as {
    code?: string;
  };
  return body.code;
}

// Adds the bearer however the caller passed its headers (object, tuple list
// or Headers instance); an object spread would drop the latter two's entries.
export function withBearer(init: RequestInit, token: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  return { ...init, headers };
}

// A request built for the credential it goes out with, so a body can carry
// fields (like `session`) that only one kind of caller sends.
type RequestFor = (credential: MessagingCredential) => RequestInit;

// One request to a messaging route. A 401 for an unknown (not revoked)
// agent token self-heals: drops the stale cache, re-registers, retries once.
async function messagingFetch(
  rootDir: string,
  server: McpServer,
  path: string,
  init: RequestInit | RequestFor = {}
): Promise<MessagingFetchOutcome> {
  const projRoot = projectRoot(rootDir);
  const daemon = readDaemonFile(projRoot);
  if (daemon === null || !(await isDaemonHealthy(daemon.port))) {
    return {
      ok: false,
      transient: false,
      result: toolError('dispatchd not running — no one to message'),
    };
  }
  const clientName = server.server.getClientVersion()?.name;
  const credential = await messagingCredential(projRoot, clientName);
  if ('error' in credential) {
    return { ok: false, transient: false, result: toolError(credential.error) };
  }

  const url = `http://127.0.0.1:${daemon.port}${path}`;
  const requestFor: RequestFor = typeof init === 'function' ? init : () => init;
  const attempt = (cred: MessagingCredential): Promise<Response> =>
    fetch(url, withBearer(requestFor(cred), cred.token));

  let res: Response;
  let kind = credential.kind;
  try {
    res = await attempt(credential);
  } catch (err) {
    return { ok: false, transient: true, message: (err as Error).message };
  }

  if (res.status === 401 && credential.kind === 'agent') {
    const code = await authErrorCode(res);
    const name = agentName(process.env, clientName, hostname());
    if (code === 'auth_agent_revoked') {
      const filePath = agentTokenFilePath(projRoot, name);
      return {
        ok: false,
        transient: false,
        result: toolError(
          `This agent's access to ${projRoot} was revoked. To ask for ` +
            `approval again, delete ${filePath} and retry.`
        ),
      };
    }
    if (code === 'auth_invalid_token') {
      forgetAgentToken(projRoot, name, credential.token);
      const fresh = await messagingCredential(projRoot, clientName);
      if ('error' in fresh) {
        return { ok: false, transient: false, result: toolError(fresh.error) };
      }
      kind = fresh.kind;
      try {
        res = await attempt(fresh);
      } catch (err) {
        return { ok: false, transient: true, message: (err as Error).message };
      }
    }
  }
  return { ok: true, res, kind };
}

// Turns a failed MessagingFetchOutcome into the tool's error result.
function fetchFailed(
  outcome: Extract<MessagingFetchOutcome, { ok: false }>,
  toolName: string
): ToolOutcome {
  return outcome.transient
    ? toolError(`${toolName} failed: ${outcome.message}`)
    : outcome.result;
}

// This project's `messaging.agentBlockingTimeoutSec` (GET /api/config, not a
// messaging route — stays on the shared request-tier token), or `fallbackMs`.
async function agentBlockingTimeoutMs(
  rootDir: string,
  fallbackMs: number
): Promise<number> {
  const daemon = readDaemonFile(projectRoot(rootDir));
  if (daemon === null) return fallbackMs;
  try {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/config`, {
      headers: daemonAuth(daemon),
      signal: requestDeadline(),
    });
    if (!res.ok) return fallbackMs;
    const config = (await res.json()) as {
      messaging?: { agentBlockingTimeoutSec?: number };
    };
    const sec = config.messaging?.agentBlockingTimeoutSec;
    return typeof sec === 'number' && sec > 0 ? sec * 1000 : fallbackMs;
  } catch {
    return fallbackMs;
  }
}

// Resolves after `ms`, or immediately (returning true) if `signal` aborts
// first — keeps a poll loop's backoff cancellable.
function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// A 4xx that retrying cannot fix — anything except 408 (request timeout) and
// 429 (rate limited), which are transient by nature.
function isPermanentClientError(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

type PollOutcome =
  | { kind: 'answer'; value: Record<string, unknown> }
  | { kind: 'timeout' }
  | { kind: 'error'; result: ToolOutcome };

// Long-polls GET /api/messages/:id/answer?wait=1 until an answer, timeout, or
// non-retryable error; each poll is capped to what's left of the budget.
async function pollForAnswer(
  rootDir: string,
  server: McpServer,
  messageId: string,
  totalWaitMs: number,
  timing: MessageBlockingTiming,
  signal?: AbortSignal
): Promise<PollOutcome> {
  const deadline = Date.now() + totalWaitMs;
  while (Date.now() < deadline && signal?.aborted !== true) {
    const remainingMs = Math.max(deadline - Date.now(), 0);
    const outcome = await messagingFetch(
      rootDir,
      server,
      `/api/messages/${encodeURIComponent(messageId)}/answer?wait=1`,
      {
        signal: pollSignal(
          Math.min(timing.requestTimeoutMs, remainingMs),
          signal
        ),
      }
    );
    if (!outcome.ok) {
      if (!outcome.transient) return { kind: 'error', result: outcome.result };
      if (await abortableSleep(timing.errorDelayMs, signal)) break;
      continue;
    }
    if (outcome.res.ok) {
      const body = (await outcome.res.json().catch(() => ({}))) as {
        answer?: Record<string, unknown> | null;
      };
      if (body.answer != null) return { kind: 'answer', value: body.answer };
      if (await abortableSleep(timing.retryDelayMs, signal)) break;
      continue;
    }
    if (isPermanentClientError(outcome.res.status)) {
      return {
        kind: 'error',
        result: toolError(await messagingErrorText(outcome.res)),
      };
    }
    if (await abortableSleep(timing.errorDelayMs, signal)) break;
  }
  return { kind: 'timeout' };
}

interface MsgSendArgs {
  to: string[];
  kind: string;
  body: string;
  refs?: { type: string; id: string; at?: string }[];
  data?: unknown;
  urgent?: boolean;
  blocking?: boolean;
  choices?: string[];
  wake?: 'none' | 'request';
}

// An external agent's sessions share one mailbox, so its sends and replies
// name this MCP process's session; a run is a single session and names none.
function withSession<T extends object>(
  body: T,
  credential: MessagingCredential,
  session: string
): T | (T & { session: string }) {
  return credential.kind === 'agent' ? { ...body, session } : body;
}

// Where else a blocking answer lands: a run's session gets it pushed, while an
// external agent's copy waits in its mailbox.
function answerCopyNote(kind: MessagingCredential['kind']): string {
  return kind === 'run'
    ? 'this answer was also delivered to your session as a pushed message ' +
        '— no need to act on it twice'
    : 'this answer is also in your mailbox (inbox_read) — no need to act on ' +
        'it twice';
}

// POST /api/messages, then (when `blocking`) long-polls for its answer.
async function msgSend(
  rootDir: string,
  server: McpServer,
  args: MsgSendArgs,
  session: string,
  timing: MessageBlockingTiming,
  signal?: AbortSignal
): Promise<ToolOutcome> {
  // Same key on both attempts: a dropped connection doesn't say whether the
  // send landed, so the retry replays the server's cached first result.
  const idempotencyKey = randomUUID();
  const sendInit = (credential: MessagingCredential): RequestInit => ({
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(withSession(args, credential, session)),
    signal: requestDeadline(),
  });
  let sent = await messagingFetch(rootDir, server, '/api/messages', sendInit);
  if (!sent.ok && sent.transient) {
    sent = await messagingFetch(rootDir, server, '/api/messages', sendInit);
  }
  if (!sent.ok) return fetchFailed(sent, 'msg_send');
  if (!sent.res.ok) return toolError(await messagingErrorText(sent.res));
  const result = (await sent.res.json()) as {
    message: Record<string, unknown>;
    deliveries: unknown[];
    downgraded: boolean;
  };

  if (args.blocking !== true) return toolResult(result);

  const isHuman = args.to.some((addr) => addr.startsWith('human:'));
  const totalWaitMs = isHuman
    ? timing.humanTotalWaitMs
    : await agentBlockingTimeoutMs(rootDir, timing.defaultAgentTotalWaitMs);
  const outcome = await pollForAnswer(
    rootDir,
    server,
    result.message.id as string,
    totalWaitMs,
    timing,
    signal
  );
  if (outcome.kind === 'error') return outcome.result;
  if (outcome.kind === 'timeout') {
    return toolResult({
      message: result.message,
      answer: null,
      note: 'no answer yet — it will arrive in your inbox',
    });
  }
  return toolResult({
    message: result.message,
    answer: outcome.value,
    note: answerCopyNote(sent.kind),
  });
}

interface MsgReplyArgs {
  messageId: string;
  body: string;
  choice?: string;
}

// POST /api/messages/:id/reply — an answer if the target is a question or
// handoff, a plain message otherwise; the server decides which.
async function msgReply(
  rootDir: string,
  server: McpServer,
  args: MsgReplyArgs,
  session: string
): Promise<ToolOutcome> {
  const fetched = await messagingFetch(
    rootDir,
    server,
    `/api/messages/${encodeURIComponent(args.messageId)}/reply`,
    (credential) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        withSession(
          { body: args.body, choice: args.choice },
          credential,
          session
        )
      ),
      signal: requestDeadline(),
    })
  );
  if (!fetched.ok) return fetchFailed(fetched, 'msg_reply');
  if (!fetched.res.ok) return toolError(await messagingErrorText(fetched.res));
  return toolResult((await fetched.res.json()) as Record<string, unknown>);
}

interface InboxReadArgs {
  state?: string[];
  limit?: number;
  markRead?: boolean;
}

const DEFAULT_INBOX_LIMIT = 50;

// GET /api/mailbox, trimmed here to the newest `limit` items (the route has no
// limit); marks the returned held/notified items read unless `markRead: false`.
async function inboxRead(
  rootDir: string,
  server: McpServer,
  args: InboxReadArgs
): Promise<ToolOutcome> {
  const query = new URLSearchParams();
  if (args.state !== undefined && args.state.length > 0) {
    query.set('state', args.state.join(','));
  }
  const qs = query.size > 0 ? `?${query.toString()}` : '';
  const fetched = await messagingFetch(rootDir, server, `/api/mailbox${qs}`);
  if (!fetched.ok) return fetchFailed(fetched, 'inbox_read');
  if (!fetched.res.ok) return toolError(await messagingErrorText(fetched.res));
  const body = (await fetched.res.json()) as {
    items: { delivery: { id: string; state: string } }[];
  };
  // Delivery ids are ULID-based, so a descending id sort is newest first.
  const items = body.items
    .toSorted((a, b) =>
      a.delivery.id < b.delivery.id ? 1 : a.delivery.id > b.delivery.id ? -1 : 0
    )
    .slice(0, args.limit ?? DEFAULT_INBOX_LIMIT);

  const marked: string[] = [];
  const markReadErrors: { id: string; error: string }[] = [];
  if (args.markRead !== false) {
    const toMark = items.filter(
      (item) =>
        item.delivery.state === 'held' || item.delivery.state === 'notified'
    );
    await Promise.all(
      toMark.map(async (item) => {
        const outcome = await messagingFetch(
          rootDir,
          server,
          `/api/deliveries/${encodeURIComponent(item.delivery.id)}/read`,
          { method: 'POST' }
        );
        if (!outcome.ok) {
          markReadErrors.push({
            id: item.delivery.id,
            error: outcome.transient ? outcome.message : 'mark-read failed',
          });
        } else if (!outcome.res.ok) {
          markReadErrors.push({
            id: item.delivery.id,
            error: await messagingErrorText(outcome.res),
          });
        } else {
          marked.push(item.delivery.id);
        }
      })
    );
  }
  const result: Record<string, unknown> = { ...body, items, marked };
  if (markReadErrors.length > 0) result.markReadErrors = markReadErrors;
  return toolResult(result);
}

// GET /api/threads/:id
async function threadRead(
  rootDir: string,
  server: McpServer,
  args: { threadId: string }
): Promise<ToolOutcome> {
  const fetched = await messagingFetch(
    rootDir,
    server,
    `/api/threads/${encodeURIComponent(args.threadId)}`
  );
  if (!fetched.ok) return fetchFailed(fetched, 'thread_read');
  if (!fetched.res.ok) return toolError(await messagingErrorText(fetched.res));
  return toolResult((await fetched.res.json()) as Record<string, unknown>);
}

// POST /api/channels/:name/members — `member` omitted lets the server apply
// its own default (the caller itself, or a run's task).
async function channelJoin(
  rootDir: string,
  server: McpServer,
  args: { name: string; member?: string }
): Promise<ToolOutcome> {
  const fetched = await messagingFetch(
    rootDir,
    server,
    `/api/channels/${encodeURIComponent(args.name)}/members`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        args.member !== undefined ? { member: args.member } : {}
      ),
      signal: requestDeadline(),
    }
  );
  if (!fetched.ok) return fetchFailed(fetched, 'channel_join');
  if (!fetched.res.ok) return toolError(await messagingErrorText(fetched.res));
  return toolResult({ ok: true });
}

// DELETE /api/channels/:name/members[/:addr] — `member` omitted removes the
// caller's own self-acting address, the same default join uses.
async function channelLeave(
  rootDir: string,
  server: McpServer,
  args: { name: string; member?: string }
): Promise<ToolOutcome> {
  const path =
    args.member !== undefined
      ? `/api/channels/${encodeURIComponent(args.name)}/members/${encodeURIComponent(args.member)}`
      : `/api/channels/${encodeURIComponent(args.name)}/members`;
  const fetched = await messagingFetch(rootDir, server, path, {
    method: 'DELETE',
    signal: requestDeadline(),
  });
  if (!fetched.ok) return fetchFailed(fetched, 'channel_leave');
  if (!fetched.res.ok) return toolError(await messagingErrorText(fetched.res));
  return toolResult({ ok: true });
}

// GET /api/channels
async function channelList(
  rootDir: string,
  server: McpServer
): Promise<ToolOutcome> {
  const fetched = await messagingFetch(rootDir, server, '/api/channels');
  if (!fetched.ok) return fetchFailed(fetched, 'channel_list');
  if (!fetched.res.ok) return toolError(await messagingErrorText(fetched.res));
  return toolResult((await fetched.res.json()) as Record<string, unknown>);
}

const ADDRESS_GRAMMAR =
  '`to` addresses: `human:<handle>` (a person), `task:<id>` (its current or ' +
  'next run — a message to a task WAITS if none is live right now), ' +
  '`run:<id>` (one specific live run), `channel:<name>` (everyone in it), or ' +
  '`agent:<owner>/<name>` (a specific registered agent client).';

const MESSAGE_KIND_SCHEMA = z.union([
  z.enum(['message', 'question', 'answer', 'handoff', 'notice']),
  z.string().regex(/^x-[a-z0-9][a-z0-9-]*$/),
]);

// Registers the seven messaging tools against a fixed root and server; kept
// separate from registerDispatchTools so the two families stay independent.
export function registerMessagingTools(
  server: McpServer,
  rootDir: string,
  opts: { blockingTiming?: MessageBlockingTiming } = {}
): void {
  const timing = opts.blockingTiming ?? DEFAULT_MESSAGE_BLOCKING_TIMING;
  // Generated once as the server starts: every send and reply this process
  // makes as an external agent carries it.
  const session = randomUUID();

  server.registerTool(
    'msg_send',
    {
      title: 'Send a message',
      description:
        'Send a message on the agent-communication bus. ' +
        ADDRESS_GRAMMAR +
        ' `kind` is message|question|answer|handoff|notice or a custom ' +
        '`x-<slug>`. Set `blocking: true` on a `question` (with `choices`) ' +
        'to wait for an answer: a human recipient gets up to 30 minutes, an ' +
        "agent recipient gets this project's configured " +
        'agentBlockingTimeoutSec (10 minutes by default). If nobody answers ' +
        'in time this returns `answer: null` — the question stays open in ' +
        'your inbox. Inside a dispatch run, any answer this call DOES ' +
        'receive is also pushed to your session; outside one it also waits ' +
        'in your inbox. Do not act on it twice.',
      inputSchema: {
        to: z.array(z.string()).min(1),
        kind: MESSAGE_KIND_SCHEMA,
        body: z.string(),
        refs: z.array(z.object(refShape)).optional(),
        data: z.unknown().optional(),
        urgent: z.boolean().optional(),
        blocking: z.boolean().optional(),
        choices: z.array(z.string()).optional(),
        wake: z.enum(['none', 'request']).optional(),
      },
      outputSchema: {
        message: record,
        deliveries: z.array(record).optional(),
        downgraded: z.boolean().optional(),
        answer: record.nullable().optional(),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    (args, extra) =>
      msgSend(rootDir, server, args, session, timing, extra.signal)
  );

  server.registerTool(
    'msg_reply',
    {
      title: 'Reply to a message',
      description:
        'Reply to a message by id — an answer if it was a question or ' +
        'handoff (choose one of its `choices` with `choice`), a plain ' +
        'message otherwise.',
      inputSchema: {
        messageId: z.string(),
        body: z.string(),
        choice: z.string().optional(),
      },
      outputSchema: {
        message: record,
        deliveries: z.array(record).optional(),
        downgraded: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    ({ messageId, body, choice }) =>
      msgReply(rootDir, server, { messageId, body, choice }, session)
  );

  server.registerTool(
    'inbox_read',
    {
      title: 'Read your mailbox',
      description:
        'List your own mailbox, newest first: at most `limit` items (50 by ' +
        'default), optionally filtered by delivery `state`. Marks every ' +
        'returned held/notified item read unless `markRead: false` is passed.',
      inputSchema: {
        state: z
          .array(
            z.enum([
              'held',
              'sending',
              'pushed',
              'notified',
              'read',
              'answered',
            ])
          )
          .optional(),
        limit: z.number().int().min(1).optional(),
        markRead: z.boolean().optional(),
      },
      outputSchema: {
        items: z.array(record),
        marked: z.array(z.string()),
        markReadErrors: z
          .array(z.object({ id: z.string(), error: z.string() }))
          .optional(),
      },
      annotations: { readOnlyHint: false },
    },
    ({ state, limit, markRead }) =>
      inboxRead(rootDir, server, { state, limit, markRead })
  );

  server.registerTool(
    'thread_read',
    {
      title: 'Read a message thread',
      description: 'Fetch every message and delivery in one thread by id.',
      inputSchema: { threadId: z.string() },
      outputSchema: { messages: z.array(record), deliveries: z.array(record) },
      annotations: { readOnlyHint: true },
    },
    ({ threadId }) => threadRead(rootDir, server, { threadId })
  );

  server.registerTool(
    'channel_join',
    {
      title: 'Join a channel',
      description:
        'Join a channel by its bare name (no `channel:` prefix). Omit ' +
        '`member` to join as yourself (a run joins as its task); pass it to ' +
        'add someone else you may act for.',
      inputSchema: { name: z.string(), member: z.string().optional() },
      outputSchema: { ok: z.boolean() },
      annotations: { readOnlyHint: false },
    },
    ({ name, member }) => channelJoin(rootDir, server, { name, member })
  );

  server.registerTool(
    'channel_leave',
    {
      title: 'Leave a channel',
      description:
        'Leave a channel by its bare name. Omit `member` to leave as ' +
        'yourself (a run leaves as its task, same default `channel_join` ' +
        'uses); pass a full address (e.g. `agent:<owner>/<name>` or ' +
        '`run:<id>`) to remove someone else you may act for.',
      inputSchema: { name: z.string(), member: z.string().optional() },
      outputSchema: { ok: z.boolean() },
      annotations: { readOnlyHint: false },
    },
    ({ name, member }) => channelLeave(rootDir, server, { name, member })
  );

  server.registerTool(
    'channel_list',
    {
      title: 'List channels',
      description:
        "List every channel, including each epic's implicit `epic/<id>` " +
        'channel, with its membership.',
      outputSchema: {
        channels: z.array(
          z.object({
            name: z.string(),
            auto: z.boolean(),
            members: z.array(z.string()),
          })
        ),
      },
      annotations: { readOnlyHint: true },
    },
    () => channelList(rootDir, server)
  );
}
