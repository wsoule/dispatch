// Every messaging query the Threads surfaces read, the event handler that keeps
// them current, and the actions they take.
import type {
  AgentSummary,
  ApiClient,
  ChannelSummary,
  Delivery,
  MailboxItem,
  Message,
  ThreadSummary as RecentThread,
  SendInput,
  SendResult,
  ServerEvent,
  ThreadDetail,
} from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import type { QueryClient } from '@tanstack/react-query';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { agentRosterKey, mutedAddresses } from '../lib/agentRoster';
import type { ComposeState } from '../lib/composer';
import { toSendInput } from '../lib/composer';
import type { MessageAccess } from '../lib/daemonAuth';
import { gateOf, openGatesKey, runIdOf } from '../lib/gates';
import type { RailGroup, ThreadSummary } from '../lib/threads';
import {
  appendToThread,
  groupRail,
  isUnread,
  summarizeThreads,
} from '../lib/threads';
import type { ReplyPlan } from '../lib/threadSources';
import { mergeThreadSources } from '../lib/threadSources';

const RECENT_THREADS = 100;
const TASK_THREADS = 50;
const APPROVES: ReadonlySet<string> = new Set(['approve', 'approve-session']);
const NO_ITEMS: readonly MailboxItem[] = [];
const NO_MESSAGES: Message[] = [];
const NO_DELIVERIES: Delivery[] = [];
const NO_RECENT: readonly RecentThread[] = [];
const NO_AGENTS: AgentSummary[] = [];
const NO_CHANNELS: ChannelSummary[] = [];
const NO_OPEN: ReadonlySet<string> = new Set();

function threadsPrefix(port: number | undefined) {
  return ['dispatch-threads', port] as const;
}

/** The rail and task lists: what a new message or delivery change can reorder. */
export function threadListsKey(port: number | undefined) {
  return ['dispatch-threads', port, 'lists'] as const;
}

export function threadKey(port: number | undefined, thread: string) {
  return ['dispatch-threads', port, 'thread', thread] as const;
}

// Tries a read again when it may pass next time, never when the daemon said
// this window may not read it (403) or it does not exist (404).
function retryTransient(failures: number, error: Error): boolean {
  const final =
    error instanceof ApiError && (error.status === 403 || error.status === 404);
  return !final && failures < 3;
}

function ready(client: ApiClient | null): ApiClient {
  if (client === null) throw new Error('dispatchd client not ready');
  return client;
}

/** Keeps messaging queries current from the event stream, appending to an open thread in place. */
export function applyThreadEvent(
  queryClient: QueryClient,
  port: number | undefined,
  event: ServerEvent
): void {
  if (event.type === 'message.new') {
    const { message } = event;
    const key = threadKey(port, message.thread);
    queryClient.setQueryData<ThreadDetail>(key, (current) =>
      current === undefined
        ? current
        : { ...current, messages: appendToThread(current.messages, message) }
    );
    // A response in flight was read before this message: drop it and fetch
    // again. Invalidating alone would reuse a first fetch that has no data.
    if (queryClient.getQueryState(key)?.fetchStatus === 'fetching') {
      void queryClient
        .cancelQueries({ queryKey: key, exact: true })
        .then(() =>
          queryClient.invalidateQueries({ queryKey: key, exact: true })
        );
    }
    void queryClient.invalidateQueries({ queryKey: threadListsKey(port) });
  } else if (event.type === 'delivery.changed') {
    // Refetch a cached thread holding the message, so its deliveries (which
    // mark-read reads) stay current; unchanged rows keep their identity.
    const cached = queryClient.getQueriesData<ThreadDetail>({
      queryKey: [...threadsPrefix(port), 'thread'],
    });
    for (const [key, detail] of cached) {
      if (detail?.messages.some((m) => m.id === event.messageId)) {
        void queryClient.invalidateQueries({ queryKey: key, exact: true });
      }
    }
    void queryClient.invalidateQueries({ queryKey: threadListsKey(port) });
  } else if (event.type === 'hello') {
    // A restart may have closed gates or settled agents with no event we saw.
    void queryClient.invalidateQueries({ queryKey: threadsPrefix(port) });
    void queryClient.invalidateQueries({ queryKey: openGatesKey(port) });
    void queryClient.invalidateQueries({ queryKey: agentRosterKey(port) });
  }
}

// The open-gates query the run cards read, with the same options, so both share one cache entry.
function useOpenGates(
  client: ApiClient | null,
  port: number | undefined,
  access: MessageAccess
) {
  return useQuery({
    queryKey: openGatesKey(port),
    queryFn: () => ready(client).openDecisions(),
    enabled: client !== null && access.canDecide,
    refetchInterval: 60_000,
    retry: false,
  });
}

// My mailbox, on one key the rail and a task's Thread tab share.
function useMailbox(
  client: ApiClient | null,
  port: number | undefined,
  me: string | null,
  enabled: boolean
) {
  return useQuery({
    queryKey: [...threadListsKey(port), 'mailbox', me],
    queryFn: () => ready(client).getMailbox(me ?? undefined),
    enabled: client !== null && me !== null && enabled,
  });
}

export interface ThreadRail {
  summaries: ThreadSummary[];
  groups: Record<RailGroup, ThreadSummary[]>;
  openIds: ReadonlySet<string>;
  loading: boolean;
  error: Error | null;
}

/** The Threads rail: my mailbox, plus recent threads and open gates for a deciding human. */
export function useThreadRail(
  client: ApiClient | null,
  port: number | undefined,
  me: string | null,
  access: MessageAccess
): ThreadRail {
  const enabled = client !== null && me !== null && access.canMessage;
  const mailbox = useMailbox(client, port, me, access.canMessage);
  const recent = useQuery({
    queryKey: [...threadListsKey(port), 'rail', me, 'recent'],
    queryFn: () => ready(client).listRecentThreads(RECENT_THREADS),
    enabled: enabled && access.canDecide,
  });
  const gates = useOpenGates(client, port, access);
  const agents = useAgentRoster(client, port, access.canMessage);
  const { canDecide } = access;
  return useMemo(() => {
    const merged = mergeThreadSources(
      {
        mailbox: mailbox.data?.items ?? NO_ITEMS,
        openGates: gates.data?.items ?? NO_MESSAGES,
      },
      me ?? ''
    );
    const summaries =
      me === null
        ? []
        : summarizeThreads(
            merged.messages,
            merged.deliveries,
            me,
            merged.openIds,
            {
              recent: recent.data?.threads ?? NO_RECENT,
              canDecide,
              muted: mutedAddresses(agents),
            }
          );
    return {
      summaries,
      groups: groupRail(summaries),
      openIds: merged.openIds,
      loading: mailbox.isLoading,
      error: mailbox.error ?? recent.error ?? null,
    };
  }, [
    me,
    canDecide,
    agents,
    mailbox.data,
    mailbox.isLoading,
    mailbox.error,
    recent.data,
    recent.error,
    gates.data,
  ]);
}

/** One task's threads: those the task or any of its runs took part in
 *  (deciding humans only), open where the rail would say so. */
export function useTaskThreads(
  client: ApiClient | null,
  port: number | undefined,
  me: string | null,
  access: MessageAccess,
  taskId: string
): {
  summaries: ThreadSummary[];
  openIds: ReadonlySet<string>;
  loading: boolean;
  error: Error | null;
} {
  const about = useQuery({
    queryKey: [...threadListsKey(port), 'about', taskId],
    queryFn: () =>
      ready(client).listRecentThreads(TASK_THREADS, {
        about: `task:${taskId}`,
      }),
    enabled: client !== null && me !== null && access.canDecide,
  });
  const mailbox = useMailbox(client, port, me, access.canDecide);
  const gates = useOpenGates(client, port, access);
  const agents = useAgentRoster(client, port, access.canDecide);
  return useMemo(() => {
    const recent = about.data?.threads ?? NO_RECENT;
    const inTask = new Set(recent.map((t) => t.thread));
    // The same sources as the rail, so a handoff put to me is open in both.
    const merged = mergeThreadSources(
      {
        mailbox: mailbox.data?.items ?? NO_ITEMS,
        openGates: gates.data?.items ?? NO_MESSAGES,
      },
      me ?? ''
    );
    const messages = merged.messages.filter((m) => inTask.has(m.thread));
    const ids = new Set(messages.map((m) => m.id));
    const openIds = new Set([...merged.openIds].filter((id) => ids.has(id)));
    const deliveries = merged.deliveries.filter((d) => ids.has(d.messageId));
    const summaries =
      me === null
        ? []
        : summarizeThreads(messages, deliveries, me, openIds, {
            recent,
            muted: mutedAddresses(agents),
          });
    return {
      summaries,
      openIds: me === null ? NO_OPEN : openIds,
      loading: about.isLoading,
      error: about.error ?? null,
    };
  }, [
    me,
    agents,
    about.data,
    about.isLoading,
    about.error,
    mailbox.data,
    gates.data,
  ]);
}

export interface OpenThread {
  thread: string | null;
  messages: Message[];
  deliveries: Delivery[];
  loading: boolean;
  error: Error | null;
}

// The thread holding message `id`. A rail row names its thread by the root,
// which a teammate pulled in by a later reply may not hold; the thread itself
// may still be theirs to read, so a refused id is tried as a thread id.
async function threadOf(api: ApiClient, id: string): Promise<string> {
  try {
    return (await api.getMessage(id)).thread;
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 403)) throw err;
    const detail = await api.getThread(id).catch(() => null);
    if (detail === null || detail.messages.length === 0) throw err;
    return id;
  }
}

/** The thread holding `focus` (any message id in it; a root id is its own
 *  thread). A window that cannot message reads none. */
export function useThread(
  client: ApiClient | null,
  port: number | undefined,
  focus: string | null,
  access: MessageAccess
): OpenThread {
  const enabled = client !== null && focus !== null && access.canMessage;
  const resolved = useQuery({
    queryKey: [...threadsPrefix(port), 'message', focus],
    queryFn: () => threadOf(ready(client), focus ?? ''),
    enabled,
    staleTime: Infinity, // a message never moves thread
    // A link to a thread this window cannot read, or one gone, says so at once.
    retry: retryTransient,
  });
  const thread = enabled ? (resolved.data ?? null) : null;
  const detail = useQuery({
    queryKey: threadKey(port, thread ?? ''),
    queryFn: () => ready(client).getThread(thread ?? ''),
    enabled: client !== null && thread !== null,
    retry: retryTransient,
  });
  return {
    thread,
    messages: detail.data?.messages ?? NO_MESSAGES,
    deliveries: detail.data?.deliveries ?? NO_DELIVERIES,
    loading: resolved.isLoading || detail.isLoading,
    error: resolved.error ?? detail.error ?? null,
  };
}

/** The agent roster, on the key Settings → Connected agents uses, so both share it. */
export function useAgentRoster(
  client: ApiClient | null,
  port: number | undefined,
  enabled = true
): AgentSummary[] {
  const roster = useQuery({
    queryKey: agentRosterKey(port),
    queryFn: () => ready(client).listAgentRoster(),
    enabled: client !== null && enabled,
  });
  return roster.data?.agents ?? NO_AGENTS;
}

export function useChannels(
  client: ApiClient | null,
  port: number | undefined,
  enabled: boolean
): ChannelSummary[] {
  const channels = useQuery({
    queryKey: [...threadsPrefix(port), 'channels'],
    queryFn: () => ready(client).listChannels(),
    enabled: client !== null && enabled,
    staleTime: 60_000,
  });
  return channels.data?.channels ?? NO_CHANNELS;
}

/** The run-gate handlers; they assert decide and refresh the run views themselves. */
export interface RunGateHandlers {
  handleApprove: (
    runId: string,
    requestId: string,
    allow: boolean,
    opts?: { scope?: 'once' | 'session'; reason?: string }
  ) => Promise<void>;
  handleDecideScopeRequest: (
    runId: string,
    requestId: string,
    granted: boolean,
    reason?: string
  ) => Promise<void>;
}

/** One Idempotency-Key per draft, which its text box renews after a send or an
 *  edit: resending an unchanged draft after a lost response replays that send. */
export function useDraftKey(): [key: string, renew: () => void] {
  const [key, setKey] = useState(() => crypto.randomUUID());
  const renew = useCallback(() => setKey(crypto.randomUUID()), []);
  return [key, renew];
}

export interface ThreadActions {
  /** Sends a draft under the key its text box holds (`useDraftKey`). */
  send: (state: ComposeState, idempotencyKey: string) => Promise<SendResult>;
  reply: (
    plan: ReplyPlan,
    body: string,
    idempotencyKey: string
  ) => Promise<SendResult>;
  answer: (
    message: Message,
    reply: { body: string; choice?: string }
  ) => Promise<void>;
  markRead: (deliveries: readonly Delivery[]) => void;
}

export function useThreadActions(
  client: ApiClient | null,
  port: number | undefined,
  me: string | null,
  access: MessageAccess,
  handlers: RunGateHandlers
): ThreadActions {
  const queryClient = useQueryClient();
  // App re-renders on every event and rebuilds its handlers; reading them through
  // a ref keeps `answer` stable, so memoised message rows do not re-render.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: threadListsKey(port) });
    void queryClient.invalidateQueries({ queryKey: openGatesKey(port) });
  }, [queryClient, port]);
  const messenger = useCallback((): ApiClient => {
    if (!access.canMessage) {
      throw new Error(
        access.explanation ?? 'This window cannot send messages.'
      );
    }
    return ready(client);
  }, [access, client]);

  const sendDraft = useCallback(
    async (input: SendInput, idempotencyKey: string): Promise<SendResult> => {
      const result = await messenger().sendMessage(input, { idempotencyKey });
      refresh();
      return result;
    },
    [messenger, refresh]
  );

  const send = useCallback(
    (state: ComposeState, idempotencyKey: string): Promise<SendResult> =>
      sendDraft(toSendInput(state), idempotencyKey),
    [sendDraft]
  );

  // An answer goes as a keyed send, as the reply route would build it, so a
  // resend after a lost response replays rather than 409s.
  const reply = useCallback(
    (plan: ReplyPlan, body: string, idempotencyKey: string) =>
      sendDraft(
        plan.kind === 'send'
          ? { to: plan.to, kind: 'message', body, replyTo: plan.replyTo }
          : {
              to: [plan.target.from],
              kind: 'answer',
              body,
              replyTo: plan.target.id,
            },
        idempotencyKey
      ),
    [sendDraft]
  );

  const answer = useCallback(
    async (
      message: Message,
      answerInput: { body: string; choice?: string }
    ): Promise<void> => {
      const gate = gateOf(message);
      if (gate !== null && !access.canDecide) {
        throw new Error(
          access.explanation ?? 'Only a deciding human can answer this.'
        );
      }
      const runId = runIdOf(message);
      if (gate?.type === 'tool-approval' && gate.runId !== undefined) {
        // Fails closed: only an approve choice lets the call run.
        const allow = APPROVES.has(answerInput.choice ?? '');
        if (!allow && answerInput.choice !== 'deny') {
          throw new Error('Choose approve, approve-session or deny.');
        }
        await handlersRef.current.handleApprove(
          gate.runId,
          gate.requestId,
          allow,
          {
            scope:
              answerInput.choice === 'approve-session' ? 'session' : 'once',
            ...(answerInput.body === '' ? {} : { reason: answerInput.body }),
          }
        );
      } else if (gate?.type === 'scope' && runId !== null) {
        await handlersRef.current.handleDecideScopeRequest(
          runId,
          message.id,
          answerInput.choice === 'grant',
          answerInput.body === '' ? undefined : answerInput.body
        );
      } else {
        await (gate === null ? messenger() : ready(client)).replyToMessage(
          message.id,
          answerInput
        );
      }
      refresh();
    },
    [access, client, messenger, refresh]
  );

  // Deliveries marked read or being marked. A thread refetched mid-mark still
  // lists them unread; only a failed mark is sent again.
  const marked = useRef(new Set<string>());
  const markRead = useCallback(
    (deliveries: readonly Delivery[]): void => {
      if (client === null || me === null || !access.canMessage) return;
      const unread = deliveries.filter(
        (d) => isUnread(d, me) && !marked.current.has(d.id)
      );
      if (unread.length === 0) return;
      for (const d of unread) marked.current.add(d.id);
      void Promise.all(
        unread.map((d) =>
          client.markDeliveryRead(d.id).then(
            () => {},
            () => {
              marked.current.delete(d.id);
            }
          )
        )
      ).then(() => {
        void queryClient.invalidateQueries({ queryKey: threadListsKey(port) });
      });
    },
    [client, me, access, queryClient, port]
  );

  return useMemo(
    () => ({ send, reply, answer, markRead }),
    [send, reply, answer, markRead]
  );
}
