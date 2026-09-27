// Every messaging query the Threads surfaces read, the event handler that keeps
// them current, and the actions they take.
import type {
  AgentSummary,
  ApiClient,
  ChannelSummary,
  Delivery,
  DeliveryState,
  MailboxItem,
  Message,
  ThreadSummary as RecentThread,
  SendResult,
  ServerEvent,
  ThreadDetail,
} from '@dispatch/client';
import type { QueryClient } from '@tanstack/react-query';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { agentRosterKey } from '../lib/agentRoster';
import type { ComposeState } from '../lib/composer';
import { toSendInput } from '../lib/composer';
import type { MessageAccess } from '../lib/daemonAuth';
import { gateOf, openGatesKey, runIdOf } from '../lib/gates';
import type { RailGroup, ThreadSummary } from '../lib/threads';
import { appendToThread, groupRail, summarizeThreads } from '../lib/threads';
import type { ReplyPlan } from '../lib/threadSources';
import { mergeThreadSources } from '../lib/threadSources';

const RECENT_THREADS = 100;
const TASK_THREADS = 50;
const UNREAD: ReadonlySet<DeliveryState> = new Set([
  'held',
  'notified',
  'pushed',
]);
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
    queryClient.setQueryData<ThreadDetail>(
      threadKey(port, message.thread),
      (current) =>
        current === undefined
          ? current
          : { ...current, messages: appendToThread(current.messages, message) }
    );
    void queryClient.invalidateQueries({ queryKey: threadListsKey(port) });
  } else if (event.type === 'delivery.changed') {
    void queryClient.invalidateQueries({ queryKey: threadListsKey(port) });
  } else if (event.type === 'hello') {
    void queryClient.invalidateQueries({ queryKey: threadsPrefix(port) });
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
  const mailbox = useQuery({
    queryKey: [...threadListsKey(port), 'rail', me, 'mailbox'],
    queryFn: () => ready(client).getMailbox(me ?? undefined),
    enabled,
  });
  const recent = useQuery({
    queryKey: [...threadListsKey(port), 'rail', me, 'recent'],
    queryFn: () => ready(client).listRecentThreads(RECENT_THREADS),
    enabled: enabled && access.canDecide,
  });
  const gates = useOpenGates(client, port, access);
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
            { recent: recent.data?.threads ?? NO_RECENT }
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
    mailbox.data,
    mailbox.isLoading,
    mailbox.error,
    recent.data,
    recent.error,
    gates.data,
  ]);
}

/** One task's threads: those the task or any of its runs took part in (deciding humans only). */
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
  const gates = useOpenGates(client, port, access);
  return useMemo(() => {
    const recent = about.data?.threads ?? NO_RECENT;
    const inTask = new Set(recent.map((t) => t.thread));
    const open = (gates.data?.items ?? NO_MESSAGES).filter((g) =>
      inTask.has(g.thread)
    );
    const openIds = new Set(open.map((g) => g.id));
    const summaries =
      me === null ? [] : summarizeThreads(open, [], me, openIds, { recent });
    return {
      summaries,
      openIds: me === null ? NO_OPEN : openIds,
      loading: about.isLoading,
      error: about.error ?? null,
    };
  }, [me, about.data, about.isLoading, about.error, gates.data]);
}

export interface OpenThread {
  thread: string | null;
  messages: Message[];
  deliveries: Delivery[];
  loading: boolean;
  error: Error | null;
}

/** The thread holding `focus` (any message id in it; a root id is its own thread). */
export function useThread(
  client: ApiClient | null,
  port: number | undefined,
  focus: string | null
): OpenThread {
  const resolved = useQuery({
    queryKey: [...threadsPrefix(port), 'message', focus],
    queryFn: () => ready(client).getMessage(focus ?? ''),
    enabled: client !== null && focus !== null,
    staleTime: Infinity, // a message never changes
    select: (message) => message.thread,
  });
  const thread = focus === null ? null : (resolved.data ?? null);
  const detail = useQuery({
    queryKey: threadKey(port, thread ?? ''),
    queryFn: () => ready(client).getThread(thread ?? ''),
    enabled: client !== null && thread !== null,
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
  port: number | undefined
): AgentSummary[] {
  const roster = useQuery({
    queryKey: agentRosterKey(port),
    queryFn: () => ready(client).listAgentRoster(),
    enabled: client !== null,
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

export interface ThreadActions {
  send: (state: ComposeState) => Promise<SendResult>;
  reply: (plan: ReplyPlan, body: string) => Promise<SendResult>;
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

  const send = useCallback(
    async (state: ComposeState): Promise<SendResult> => {
      const result = await messenger().sendMessage(toSendInput(state), {
        idempotencyKey: crypto.randomUUID(),
      });
      refresh();
      return result;
    },
    [messenger, refresh]
  );

  const reply = useCallback(
    async (plan: ReplyPlan, body: string): Promise<SendResult> => {
      const api = messenger();
      const result =
        plan.kind === 'reply'
          ? await api.replyToMessage(plan.target.id, { body })
          : await api.sendMessage(
              { to: plan.to, kind: 'message', body, replyTo: plan.replyTo },
              { idempotencyKey: crypto.randomUUID() }
            );
      refresh();
      return result;
    },
    [messenger, refresh]
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
        await handlersRef.current.handleApprove(
          gate.runId,
          gate.requestId,
          answerInput.choice !== 'deny',
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

  const markRead = useCallback(
    (deliveries: readonly Delivery[]): void => {
      if (client === null || me === null || !access.canMessage) return;
      const unread = deliveries.filter(
        (d) => d.recipient === me && UNREAD.has(d.state)
      );
      if (unread.length === 0) return;
      void Promise.allSettled(
        unread.map((d) => client.markDeliveryRead(d.id))
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
