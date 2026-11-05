import type { Message } from '@dispatch/client';
import {
  Chip,
  cx,
  Disclosure,
  EmptyState,
  SegmentedControl,
} from '@dispatch/ui';
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
import styles from './ConversationTimeline.module.css';
import { HomeComposer } from './HomeComposer';

const NONE: ReadonlySet<string> = new Set();
const SHOW = [
  { id: 'people', label: 'People' },
  { id: 'all', label: 'All' },
];

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
      <div className={styles.unavailable}>
        <EmptyState label="Conversations are not available in this window.">
          {access.explanation}
        </EmptyState>
      </div>
    );
  }

  const row = (entry: TimelineEntry): ReactNode => {
    if (entry.kind === 'comment') {
      const { comment } = entry;
      return (
        <li
          key={entry.key}
          data-testid="timeline-comment"
          className={styles.comment}
        >
          <div className={styles.commentHead}>
            <Chip>comment</Chip>
            <span className={styles.author}>
              {participantLabel(comment.author, pane.lookups)}
            </span>
            <span>{formatRelativeTimeFromIso(comment.created)}</span>
          </div>
          {/* A teammate's comment: plain text only. */}
          <p className={styles.commentBody}>{comment.body}</p>
        </li>
      );
    }
    if (entry.kind === 'fold') {
      const expanded = all || open.has(entry.key);
      return (
        <li key={entry.key} data-testid="timeline-fold" className={styles.fold}>
          <Disclosure
            variant="bar"
            open={expanded}
            onOpenChange={() =>
              setOpen((prev) => {
                const next = new Set(prev);
                if (next.has(entry.key)) next.delete(entry.key);
                else next.add(entry.key);
                return next;
              })
            }
            summary={`Agent chatter · ${entry.messages.length} · ${entry.between
              .slice(0, 2)
              .map((a) => participantLabel(a, pane.lookups))
              .join(' ↔ ')} · ${clock(entry.first)}–${clock(entry.last)}`}
          >
            <ul className={styles.folded}>
              {entry.messages.map((message) => messageRow(message))}
            </ul>
          </Disclosure>
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
          <p className={styles.quote}>
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
            inlineAnswer
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
    <div data-testid="conversation" className={styles.root}>
      <div className={styles.bar}>
        <div className={styles.header}>{header}</div>
        <SegmentedControl
          label="Show"
          size="sm"
          options={SHOW}
          value={all ? 'all' : 'people'}
          onChange={(choice) => setAll(choice === 'all')}
        />
      </div>
      <ul className={styles.timeline}>
        {conversation.error !== null && (
          <li
            role="alert"
            className={cx('toneText', styles.error)}
            data-tone="danger"
          >
            {conversation.error.message}
          </li>
        )}
        {entries.length === 0 && conversation.isSuccess && (
          <li className={styles.empty}>{emptyText}</li>
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
