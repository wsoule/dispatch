import type { Message } from '@dispatch/client';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import type { TaskCommentsApi } from '../../hooks/useTaskComments';
import { useThreadPaneProps } from '../../hooks/useThreadPaneProps';
import {
  threadListsKey,
  useMailbox,
  useOpenGates,
  useThreadActions,
} from '../../hooks/useThreads';
import { scopeOf } from '../../lib/conversationScope';
import { formatRelativeTimeFromIso } from '../../lib/format';
import { participantLabel, type RefAction } from '../../lib/threadSources';
import { buildTimeline, quoteOf, type TimelineEntry } from '../../lib/timeline';
import { MessageRow } from '../threads/MessageRow';
import { HomeComposer } from './HomeComposer';
import { InlineSegmented } from '@/ui/ai/inline-segmented';
import { Badge } from '@/ui/badge';
import { EmptyState } from '@/ui/chrome';
import { CollapseBar } from '@/ui/chrome/collapse-bar';

const NONE: ReadonlySet<string> = new Set();
const SHOW = [
  { id: 'people', label: 'People' },
  { id: 'all', label: 'All' },
] as const;

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      });
}

export interface ConversationTimelineProps {
  data: DispatchProjectData;
  /** The home: everything about a task or room, or everything between you and someone. */
  query: { about: string } | { with: string };
  /** A task home's comments, merged into the same timeline. */
  comments?: TaskCommentsApi;
  /** Where its composer sends; `null` for a read-only home. */
  composerTo: string | null;
  composerLabel: string;
  onOpenRef: (action: RefAction) => void;
  header?: ReactNode;
  emptyText: string;
}

/** A home's one flat timeline: oldest to newest, chatter folded, nothing nested. */
export function ConversationTimeline({
  data,
  query,
  comments,
  composerTo,
  composerLabel,
  onOpenRef,
  header,
  emptyText,
}: ConversationTimelineProps) {
  const { client, port, me, messageAccess: access } = data;
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(NONE);
  const conversation = useQuery({
    queryKey: [...threadListsKey(port), 'conversation', query],
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.getConversation({ ...query, limit: 200 });
    },
    enabled: client !== null && access.canMessage,
    retry: false,
  });
  const gates = useOpenGates(client, port, access);
  const pane = useThreadPaneProps(data, onOpenRef);
  const actions = useThreadActions(client, port, me, access, data);
  const mailbox = useMailbox(client, port, me, access.canMessage);
  const messages = useMemo(
    () => conversation.data?.messages ?? [],
    [conversation.data]
  );
  const byId = useMemo(
    () => new Map<string, Message>(messages.map((m) => [m.id, m])),
    [messages]
  );
  const openIds = useMemo(
    () => new Set((gates.data?.items ?? []).map((m) => m.id)),
    [gates.data]
  );
  const entries = useMemo(
    () =>
      me === null
        ? []
        : buildTimeline(messages, comments?.comments ?? [], (m) =>
            scopeOf(m, {
              me,
              myTaskIds: NONE,
              followed: NONE,
              muted: NONE,
              authorOf: (id) => byId.get(id)?.from ?? null,
            })
          ),
    [messages, comments?.comments, me, byId]
  );

  // Reading a home reads its messages.
  const { markRead } = actions;
  useEffect(() => {
    const ids = new Set(messages.map((m) => m.id));
    const deliveries = (mailbox.data?.items ?? [])
      .filter((item) => ids.has(item.message.id))
      .map((item) => item.delivery);
    if (deliveries.length > 0) markRead(deliveries);
  }, [messages, mailbox.data, markRead]);

  if (!access.canMessage) {
    return (
      <EmptyState
        className="h-full"
        heading="Conversations are not available in this window."
        description={access.explanation}
      />
    );
  }

  const row = (entry: TimelineEntry): ReactNode => {
    if (entry.kind === 'comment') {
      const { comment } = entry;
      return (
        <li
          key={entry.key}
          data-testid="timeline-comment"
          className="px-3 py-2"
        >
          <div className="text-muted-foreground flex items-center gap-2 text-[12px]">
            <Badge variant="outline" className="h-5 px-1.5 text-[11px]">
              comment
            </Badge>
            <span className="text-foreground font-medium">
              {participantLabel(comment.author, pane.lookups)}
            </span>
            <span>{formatRelativeTimeFromIso(comment.created)}</span>
          </div>
          <p className="mt-1 text-[13px] whitespace-pre-wrap">{comment.body}</p>
        </li>
      );
    }
    if (entry.kind === 'fold') {
      const expanded = all || open.has(entry.key);
      return (
        <li key={entry.key} data-testid="timeline-fold" className="px-3 py-1">
          <CollapseBar
            collapsed={!expanded}
            onToggle={() =>
              setOpen((prev) => {
                const next = new Set(prev);
                if (next.has(entry.key)) next.delete(entry.key);
                else next.add(entry.key);
                return next;
              })
            }
            label={`Agent chatter · ${entry.messages.length} · ${entry.between
              .slice(0, 2)
              .map((a) => participantLabel(a, pane.lookups))
              .join(' ↔ ')} · ${clock(entry.first)}–${clock(entry.last)}`}
          />
          {expanded && (
            <ul className="border-border mt-1 border-l-[0.5px]">
              {entry.messages.map((message) => messageRow(message))}
            </ul>
          )}
        </li>
      );
    }
    return messageRow(entry.message);
  };

  const messageRow = (message: Message): ReactNode => {
    const quote = quoteOf(message, byId);
    return (
      <li key={message.id} data-testid="timeline-message">
        {quote !== null && (
          <p className="text-muted-foreground truncate px-3 pt-1 text-[12px]">
            ↳ re: {participantLabel(quote.from, pane.lookups)} {clock(quote.at)}{' '}
            “{quote.text}”
          </p>
        )}
        {me !== null && (
          <MessageRow
            message={message}
            me={me}
            open={openIds.has(message.id)}
            access={access}
            lookups={pane.lookups}
            availability={pane.availability}
            onRestartDaemon={pane.onRestartDaemon}
            onAnswer={actions.answer}
            onOpen={pane.onOpen}
            loadApprovalInput={pane.loadApprovalInput}
            client={client}
            port={port}
          />
        )}
      </li>
    );
  };

  return (
    <div data-testid="conversation" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">{header}</div>
        <InlineSegmented
          label="Show"
          options={SHOW}
          value={all ? 'all' : 'people'}
          onChange={(choice) => setAll(choice === 'all')}
        />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {conversation.error !== null && (
          <li role="alert" className="text-state-failed px-3 py-2 text-[12px]">
            {conversation.error.message}
          </li>
        )}
        {entries.length === 0 && conversation.isSuccess && (
          <li className="text-muted-foreground px-3 py-6 text-center text-[13px]">
            {emptyText}
          </li>
        )}
        {entries.map(row)}
      </ul>
      {composerTo !== null && (
        <HomeComposer
          client={client}
          port={port}
          to={composerTo}
          label={composerLabel}
          onComment={
            comments === undefined ? undefined : (body) => comments.add(body)
          }
        />
      )}
    </div>
  );
}
