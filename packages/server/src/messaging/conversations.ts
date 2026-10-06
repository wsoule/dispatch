import type {
  Address,
  ConversationMatch,
  DeliveryEngine,
  Message,
  Sender,
  SqliteMessageStore,
} from '@dispatch-foo/protocol';
import { localOnlyReason, parseAddress } from '@dispatch-foo/protocol';

import type { ApiContext } from '../api.js';
import { errorResponse, jsonResponse, parseCountParam } from '../api/http.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// Rows read per scan step, and the most one request reads before it stops,
// so an unreadable history cannot pin the daemon; mutable for tests.
export const conversationScan = { batch: 200, ceiling: 5000 };

type RunLookup = Pick<Orchestrator, 'isRunLive' | 'taskIdOfRun' | 'list'>;

// A task's address and every run of it, as `about=task:` and steering match.
function taskAndRuns(orchestrator: RunLookup, taskId: string): Address[] {
  return [
    `task:${taskId}`,
    ...orchestrator
      .list()
      .filter((run) => run.taskId === taskId)
      .map((run) => `run:${run.id}`),
  ];
}

/**
 * A `with` / `about` query as a store match, or a sentence saying why it is
 * malformed. A malformed address throws a MessagingError naming its field.
 */
export function conversationMatch(
  orchestrator: RunLookup,
  me: Address,
  peer: string | null,
  about: string | null
): ConversationMatch | string {
  if ((peer === null) === (about === null))
    return 'pass exactly one of with= or about=';
  if (peer !== null) {
    parseAddress(peer, 'with');
    if (peer === me) return 'with= names the caller; name someone else';
    return { kind: 'pair', a: me, b: peer };
  }
  const value = about ?? '';
  if (value.startsWith('doc:') && value.length > 'doc:'.length)
    return { kind: 'ref', type: 'doc', id: value.slice('doc:'.length) };
  const parsed = parseAddress(value, 'about');
  if (parsed.kind === 'task')
    return {
      kind: 'about',
      addresses: taskAndRuns(orchestrator, parsed.id),
    };
  if (parsed.kind === 'channel') return { kind: 'about', addresses: [value] };
  return `invalid about ${JSON.stringify(value)}: expected task:<id>, channel:<name> or doc:<id>`;
}

/**
 * One page of a conversation, newest page first, keeping only the threads
 * `reader` may read. `next` is the cursor for the older page, or null.
 */
export function scanConversation(
  store: Pick<SqliteMessageStore, 'conversation'>,
  engine: Pick<DeliveryEngine, 'canReadThread'>,
  match: ConversationMatch,
  reader: Sender,
  page: { before?: string; limit: number }
): { messages: Message[]; next: string | null } {
  const readable = new Map<string, boolean>();
  const canRead = (thread: string): boolean => {
    let ok = readable.get(thread);
    if (ok === undefined) {
      ok = engine.canReadThread(thread, reader);
      readable.set(thread, ok);
    }
    return ok;
  };
  const { limit } = page;
  const kept: Message[] = [];
  // The last row scanned; only ever handed back when it is a kept row.
  let cursor = page.before;
  let scanned = 0;
  let done = false;
  while (!done && kept.length < limit && scanned < conversationScan.ceiling) {
    const batch = store.conversation(match, {
      before: cursor,
      limit: conversationScan.batch,
    });
    let read = 0;
    for (const m of batch) {
      cursor = m.id;
      read++;
      if (canRead(m.thread)) kept.push(m);
      if (kept.length === limit || scanned + read >= conversationScan.ceiling)
        break;
    }
    scanned += read;
    // Read to the end of the match: a short batch, wholly consumed.
    done = batch.length < conversationScan.batch && read === batch.length;
  }
  // The cursor is the oldest kept row, never a scanned one the caller cannot
  // read; a scan that read to the end, or kept nothing, says nothing more.
  const oldest = kept.at(-1)?.id;
  const older =
    !done &&
    oldest !== undefined &&
    store.conversation(match, { before: oldest, limit: 1 }).length > 0;
  return { messages: kept.reverse(), next: older ? oldest : null };
}

// A row as the thread route shows it: with federation, who sent it from
// which machine and how its answer settled.
export function federatedRow(ctx: ApiContext, m: Message): Message {
  const fed = ctx.federation;
  if (fed === null) return m;
  const settledAs = ctx.messaging.store.settledAs(m.id);
  return {
    ...m,
    ...(m.origin === undefined ? {} : { remoteLabel: fed.label(m.origin) }),
    ...(settledAs === null ? {} : { settledAs }),
  };
}

/**
 * GET /api/conversations?with=<address>|about=<task:id|channel:name|doc:id>
 * &before=<id>&limit=N — flat messages, a page in ulid order, newest page
 * first. Only threads the caller may read (canReadThread, as the thread route
 * checks), so a request-tier caller gets their own talk rather than a 403.
 * `next` is the cursor for the older page, null when there is none.
 */
export function listBusConversation(ctx: ApiContext, url: URL): Response {
  const principal = ctx.principal;
  if (principal === undefined)
    throw new Error('conversation route reached with no resolved principal');
  const parsedLimit = parseCountParam(url, 'limit');
  if (!parsedLimit.ok) return parsedLimit.response;
  const limit = Math.max(
    1,
    Math.min(parsedLimit.value ?? DEFAULT_LIMIT, MAX_LIMIT)
  );
  const before = url.searchParams.get('before');
  if (before === '') return errorResponse(400, 'invalid before: empty');
  const match = conversationMatch(
    ctx.orchestrator,
    principal.address,
    url.searchParams.get('with'),
    url.searchParams.get('about')
  );
  if (typeof match === 'string') return errorResponse(400, match);
  const { messages, next } = scanConversation(
    ctx.messaging.store,
    ctx.messaging.engine,
    match,
    { address: principal.address, canDecide: principal.canDecide },
    { ...(before === null ? {} : { before }), limit }
  );
  return jsonResponse({
    messages: messages.map((m) => federatedRow(ctx, m)),
    next,
  });
}

/** Who a send continues: the newest open root it may join, or null. */
export type RootFinder = (sender: Sender, to: Address) => Message | null;

/**
 * The newest open root a plain message from `sender` to `to` continues, so a
 * run, a task or a person gets one conversation instead of a root per send:
 * - a live run or a task: a root about that task that `sender` is a party to;
 * - a human or agent: the pair's own root (one sender, one recipient).
 * Only plain-message roots continue: never a question or handoff, open or
 * answered, so a send can never become a reply to an ask. Local-only (gates,
 * the Overseer, A2A) and unreadable roots are skipped too. An ended run gets null, because replying would
 * re-address it to its task and change which run a wake continues.
 */
export function newestOpenRoot(
  deps: {
    engine: DeliveryEngine;
    store: SqliteMessageStore;
    orchestrator: RunLookup;
  },
  sender: Sender,
  to: Address
): Message | null {
  let parsed: ReturnType<typeof parseAddress>;
  try {
    parsed = parseAddress(to, 'to');
  } catch {
    return null;
  }
  const me = sender.address;
  let match: ConversationMatch;
  let fits: (root: Message) => boolean;
  if (parsed.kind === 'run' || parsed.kind === 'task') {
    let taskId: string | null = parsed.id;
    if (parsed.kind === 'run') {
      if (!deps.orchestrator.isRunLive(parsed.id)) return null;
      taskId = deps.orchestrator.taskIdOfRun(parsed.id);
    }
    match = {
      kind: 'about',
      addresses:
        taskId === null ? [to] : taskAndRuns(deps.orchestrator, taskId),
    };
    fits = (root) => root.from === me || root.to.includes(me);
  } else if (parsed.kind === 'human' || parsed.kind === 'agent') {
    if (to === me) return null;
    match = { kind: 'pair', a: me, b: to };
    fits = (root) =>
      root.to.length === 1 &&
      ((root.from === me && root.to[0] === to) ||
        (root.from === to && root.to[0] === me));
  } else {
    return null;
  }
  const roots = deps.store.conversation(match, {
    rootsOnly: true,
    limit: conversationScan.batch,
  });
  return (
    roots.find(
      (root) =>
        root.kind === 'message' &&
        fits(root) &&
        localOnlyReason(root, null, null) === null &&
        deps.engine.canRead(root.id, sender)
    ) ?? null
  );
}
