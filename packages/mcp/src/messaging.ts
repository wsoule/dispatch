import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { DaemonFileInfo } from './daemon.js';
import {
  daemonAuth,
  isDaemonHealthy,
  readDaemonFile,
  requestDeadline,
} from './daemon.js';
import { messagingCredential } from './identity.js';
import type { ToolOutcome } from './tools.js';
import { projectRoot, toolError, toolResult } from './tools.js';

// ---------------------------------------------------------------------------
// Messaging tools — the agent-communication bus's tool-calling surface (spec
// §5–§8): msg_send, msg_reply, inbox_read, thread_read, channel_join,
// channel_leave, channel_list. Every one of these proxies a route under
// packages/server/src/messaging/routes.ts, which is the source of truth for
// every request/response shape reproduced (loosely, as plain records) below
// — this package cannot depend on @dispatch/server (FSL) or @dispatch/
// protocol (a runtime dependency the rest of this MIT package deliberately
// avoids; see packages/client/src/api.ts's own structural mirrors for the
// same reasoning).
//
// Unlike every other tool in tools.ts, these authenticate with the calling
// run's own DISPATCH_RUN_TOKEN or a self-registered agent token (see
// identity.ts) rather than the daemon's shared agentToken — the messaging
// routes reject that shared token outright, because a message needs a real,
// individually attributable sender.
// ---------------------------------------------------------------------------

/** How long `msg_send` waits for a blocking answer, and how hard it polls. */
export interface MessageBlockingTiming {
  /** Total budget when any recipient is a human. */
  humanTotalWaitMs: number;
  /** Total budget when no recipient is a human and `GET /api/config` could
   *  not be read — the project's own `messaging.agentBlockingTimeoutSec`
   *  wins whenever it is available. */
  defaultAgentTotalWaitMs: number;
  /** Per-request timeout; longer than the daemon's own 30s long-poll window. */
  requestTimeoutMs: number;
  /** Pause after a clean unanswered poll, and after a failed one. */
  retryDelayMs: number;
  errorDelayMs: number;
}

// Same numbers as tools.ts's DEFAULT_QUESTION_TIMING for the human case (not
// imported, to avoid a needless import cycle with tools.ts — see the module
// comment above) and core's DEFAULT_MESSAGING.agentBlockingTimeoutSec for the
// agent fallback.
export const DEFAULT_MESSAGE_BLOCKING_TIMING: MessageBlockingTiming = {
  humanTotalWaitMs: 30 * 60_000,
  defaultAgentTotalWaitMs: 600_000,
  requestTimeoutMs: 45_000,
  retryDelayMs: 250,
  errorDelayMs: 2000,
};

const refShape = {
  type: z.string(),
  id: z.string(),
  at: z.string().optional(),
};

// A loosely-typed passthrough record — every messaging response is relayed
// to the caller close to verbatim, so there is no value in re-declaring
// @dispatch/protocol's Message/Delivery shapes field-for-field here.
const record = z.record(z.string(), z.unknown());

// One poll's abort signal: its own timeout, plus the client's cancellation
// when there is one — same construction as tools.ts's own pollSignal, kept
// local to avoid a second import-cycle edge back into tools.ts.
function pollSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
}

// Renders a messaging route's error body ({error, field?}) as one line —
// `field` rides along in brackets so an agent can see exactly which input
// was rejected without parsing JSON out of a tool-error string. A gate like
// "awaiting approval in Dispatch" carries no field and passes through as-is.
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

// Resolves the daemon and the caller's messaging credential together, since
// every messaging tool needs both before it can make its one real request.
async function messagingContext(
  rootDir: string,
  server: McpServer
): Promise<
  | { ok: true; daemon: DaemonFileInfo; auth: Record<string, string> }
  | { ok: false; result: ToolOutcome }
> {
  const projRoot = projectRoot(rootDir);
  const daemon = readDaemonFile(projRoot);
  if (daemon === null || !(await isDaemonHealthy(daemon.port))) {
    return {
      ok: false,
      result: toolError('dispatchd not running — no one to message'),
    };
  }
  // The MCP client's own name (e.g. "Claude Code") is only known once
  // `initialize` has completed, which has already happened by the time any
  // tool handler runs — so this is read here, at call time, not cached at
  // registration.
  const clientName = server.server.getClientVersion()?.name;
  const credential = await messagingCredential(projRoot, clientName);
  if ('error' in credential)
    return { ok: false, result: toolError(credential.error) };
  return {
    ok: true,
    daemon,
    auth: { authorization: `Bearer ${credential.token}` },
  };
}

// This project's configured agent-to-agent blocking timeout
// (`messaging.agentBlockingTimeoutSec`, in GET /api/config), or `fallbackMs`
// when the daemon can't be reached, answers with something unreadable, or
// simply doesn't carry the field (an older config). Read with the daemon's
// shared request-tier token — GET /api/config is not a messaging route and
// stays on the same auth every other proxy tool in tools.ts already uses.
async function agentBlockingTimeoutMs(
  daemon: DaemonFileInfo,
  fallbackMs: number
): Promise<number> {
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

// Long-polls `GET /api/messages/:id/answer?wait=1` until an answer lands or
// `totalWaitMs` elapses — the daemon's own long-poll window (30s) is shorter
// than `requestTimeoutMs`, so a clean "no answer yet" response is the normal
// case this loop just repeats, not a failure.
async function pollForAnswer(
  daemon: DaemonFileInfo,
  auth: Record<string, string>,
  messageId: string,
  totalWaitMs: number,
  timing: MessageBlockingTiming,
  signal?: AbortSignal
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + totalWaitMs;
  while (Date.now() < deadline && signal?.aborted !== true) {
    let polled: { answer: Record<string, unknown> | null } | null = null;
    try {
      const res = await fetch(
        `http://127.0.0.1:${daemon.port}/api/messages/${encodeURIComponent(messageId)}/answer?wait=1`,
        { headers: auth, signal: pollSignal(timing.requestTimeoutMs, signal) }
      );
      if (res.ok) {
        polled = (await res.json()) as {
          answer: Record<string, unknown> | null;
        };
      }
    } catch {
      // A dropped or timed-out poll says nothing about the answer; ask again.
    }
    if (polled?.answer != null) return polled.answer;
    if (signal !== undefined && signal.aborted) break;
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        polled !== null ? timing.retryDelayMs : timing.errorDelayMs
      )
    );
  }
  return null;
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

// POST /api/messages, then (when `blocking`) long-polls for its answer.
// dispatchd also pushes that same answer straight into the asking run's own
// session as soon as it lands (ruling R2-2), so a non-null result here
// carries a note saying so — the calling agent must not act on it twice.
async function msgSend(
  rootDir: string,
  server: McpServer,
  args: MsgSendArgs,
  timing: MessageBlockingTiming,
  signal?: AbortSignal
): Promise<ToolOutcome> {
  const ctx = await messagingContext(rootDir, server);
  if (!ctx.ok) return ctx.result;

  let sendRes: Response;
  try {
    sendRes = await fetch(`http://127.0.0.1:${ctx.daemon.port}/api/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // A random key per call, not a hash of the body: this is here so a
        // dropped-connection RETRY of the exact same tool call can be told
        // apart from two genuinely separate sends, not to deduplicate
        // identical-looking messages the agent means to send twice.
        'idempotency-key': randomUUID(),
        ...ctx.auth,
      },
      body: JSON.stringify(args),
      signal: requestDeadline(),
    });
  } catch (err) {
    return toolError(`msg_send failed: ${(err as Error).message}`);
  }
  if (!sendRes.ok) return toolError(await messagingErrorText(sendRes));
  const result = (await sendRes.json()) as {
    message: Record<string, unknown>;
    deliveries: unknown[];
    downgraded: boolean;
  };

  if (args.blocking !== true) return toolResult(result);

  const isHuman = args.to.some((addr) => addr.startsWith('human:'));
  const totalWaitMs = isHuman
    ? timing.humanTotalWaitMs
    : await agentBlockingTimeoutMs(ctx.daemon, timing.defaultAgentTotalWaitMs);
  const answer = await pollForAnswer(
    ctx.daemon,
    ctx.auth,
    result.message.id as string,
    totalWaitMs,
    timing,
    signal
  );
  return toolResult(
    answer === null
      ? {
          message: result.message,
          answer: null,
          note: 'no answer yet — it will arrive in your inbox',
        }
      : {
          message: result.message,
          answer,
          note:
            'this answer was also delivered to your session as a pushed ' +
            'message — no need to act on it twice',
        }
  );
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
  args: MsgReplyArgs
): Promise<ToolOutcome> {
  const ctx = await messagingContext(rootDir, server);
  if (!ctx.ok) return ctx.result;
  let res: Response;
  try {
    res = await fetch(
      `http://127.0.0.1:${ctx.daemon.port}/api/messages/${encodeURIComponent(args.messageId)}/reply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ctx.auth },
        body: JSON.stringify({ body: args.body, choice: args.choice }),
        signal: requestDeadline(),
      }
    );
  } catch (err) {
    return toolError(`msg_reply failed: ${(err as Error).message}`);
  }
  if (!res.ok) return toolError(await messagingErrorText(res));
  return toolResult((await res.json()) as Record<string, unknown>);
}

interface InboxReadArgs {
  state?: string[];
  markRead?: boolean;
}

// GET /api/mailbox, then marks every returned held/notified item read
// (POST /api/deliveries/:id/read) unless the caller passed `markRead: false`
// — `pushed`, `read` and `answered` items are left alone, since marking them
// again would be a no-op at best and a stale-state race at worst.
async function inboxRead(
  rootDir: string,
  server: McpServer,
  args: InboxReadArgs
): Promise<ToolOutcome> {
  const ctx = await messagingContext(rootDir, server);
  if (!ctx.ok) return ctx.result;
  const query = new URLSearchParams();
  if (args.state !== undefined && args.state.length > 0) {
    query.set('state', args.state.join(','));
  }
  const qs = query.size > 0 ? `?${query.toString()}` : '';
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${ctx.daemon.port}/api/mailbox${qs}`, {
      headers: ctx.auth,
      signal: requestDeadline(),
    });
  } catch (err) {
    return toolError(`inbox_read failed: ${(err as Error).message}`);
  }
  if (!res.ok) return toolError(await messagingErrorText(res));
  const body = (await res.json()) as {
    items: { delivery: { id: string; state: string } }[];
  };

  if (args.markRead !== false) {
    const toMark = body.items.filter(
      (item) =>
        item.delivery.state === 'held' || item.delivery.state === 'notified'
    );
    await Promise.all(
      toMark.map((item) =>
        fetch(
          `http://127.0.0.1:${ctx.daemon.port}/api/deliveries/${encodeURIComponent(item.delivery.id)}/read`,
          { method: 'POST', headers: ctx.auth, signal: requestDeadline() }
        ).catch(() => null)
      )
    );
  }
  return toolResult(body);
}

// GET /api/threads/:id
async function threadRead(
  rootDir: string,
  server: McpServer,
  args: { threadId: string }
): Promise<ToolOutcome> {
  const ctx = await messagingContext(rootDir, server);
  if (!ctx.ok) return ctx.result;
  let res: Response;
  try {
    res = await fetch(
      `http://127.0.0.1:${ctx.daemon.port}/api/threads/${encodeURIComponent(args.threadId)}`,
      { headers: ctx.auth, signal: requestDeadline() }
    );
  } catch (err) {
    return toolError(`thread_read failed: ${(err as Error).message}`);
  }
  if (!res.ok) return toolError(await messagingErrorText(res));
  return toolResult((await res.json()) as Record<string, unknown>);
}

// POST /api/channels/:name/members — `member` omitted lets the server apply
// its own default (the caller itself, or a run's task).
async function channelJoin(
  rootDir: string,
  server: McpServer,
  args: { name: string; member?: string }
): Promise<ToolOutcome> {
  const ctx = await messagingContext(rootDir, server);
  if (!ctx.ok) return ctx.result;
  let res: Response;
  try {
    res = await fetch(
      `http://127.0.0.1:${ctx.daemon.port}/api/channels/${encodeURIComponent(args.name)}/members`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ctx.auth },
        body: JSON.stringify(
          args.member !== undefined ? { member: args.member } : {}
        ),
        signal: requestDeadline(),
      }
    );
  } catch (err) {
    return toolError(`channel_join failed: ${(err as Error).message}`);
  }
  if (!res.ok) return toolError(await messagingErrorText(res));
  return toolResult({ ok: true });
}

// DELETE /api/channels/:name/members/:addr — unlike joining, the server has
// no "myself" default for leaving (see routes.ts's leaveChannel), so `member`
// is required here rather than silently guessed at.
async function channelLeave(
  rootDir: string,
  server: McpServer,
  args: { name: string; member: string }
): Promise<ToolOutcome> {
  const ctx = await messagingContext(rootDir, server);
  if (!ctx.ok) return ctx.result;
  let res: Response;
  try {
    res = await fetch(
      `http://127.0.0.1:${ctx.daemon.port}/api/channels/${encodeURIComponent(args.name)}/members/${encodeURIComponent(args.member)}`,
      { method: 'DELETE', headers: ctx.auth, signal: requestDeadline() }
    );
  } catch (err) {
    return toolError(`channel_leave failed: ${(err as Error).message}`);
  }
  if (!res.ok) return toolError(await messagingErrorText(res));
  return toolResult({ ok: true });
}

// GET /api/channels
async function channelList(
  rootDir: string,
  server: McpServer
): Promise<ToolOutcome> {
  const ctx = await messagingContext(rootDir, server);
  if (!ctx.ok) return ctx.result;
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${ctx.daemon.port}/api/channels`, {
      headers: ctx.auth,
      signal: requestDeadline(),
    });
  } catch (err) {
    return toolError(`channel_list failed: ${(err as Error).message}`);
  }
  if (!res.ok) return toolError(await messagingErrorText(res));
  return toolResult((await res.json()) as Record<string, unknown>);
}

const ADDRESS_GRAMMAR =
  '`to` addresses: `human:<handle>` (a person), `task:<id>` (its current or ' +
  'next run — a message to a task WAITS if none is live right now), ' +
  '`run:<id>` (one specific live run), `channel:<name>` (everyone in it), or ' +
  '`agent:<owner>/<name>` (a specific registered agent client).';

// Registers the seven messaging tools (spec §5–§8) against a fixed root
// directory and MCP server. Kept separate from registerDispatchTools so the
// task_*/run_list/ask_user family and the messaging family can be read (and
// tested) independently, even though both register onto the same server.
export function registerMessagingTools(
  server: McpServer,
  rootDir: string,
  opts: { blockingTiming?: MessageBlockingTiming } = {}
): void {
  const timing = opts.blockingTiming ?? DEFAULT_MESSAGE_BLOCKING_TIMING;

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
        'your inbox. Any answer this call DOES receive is also pushed to ' +
        'your own session as it arrives; do not act on it twice.',
      inputSchema: {
        to: z.array(z.string()).min(1),
        kind: z.string(),
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
    (args, extra) => msgSend(rootDir, server, args, timing, extra.signal)
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
      msgReply(rootDir, server, { messageId, body, choice })
  );

  server.registerTool(
    'inbox_read',
    {
      title: 'Read your mailbox',
      description:
        'List your own mailbox (or filter by delivery `state`). Marks every ' +
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
        markRead: z.boolean().optional(),
      },
      outputSchema: { items: z.array(record) },
      annotations: { readOnlyHint: false },
    },
    ({ state, markRead }) => inboxRead(rootDir, server, { state, markRead })
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
        'Remove `member` (a full address, e.g. your own `agent:<owner>/' +
        '<name>` or `run:<id>`) from a channel by its bare name.',
      inputSchema: { name: z.string(), member: z.string() },
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
