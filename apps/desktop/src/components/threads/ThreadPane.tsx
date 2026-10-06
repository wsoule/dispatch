import type {
  Delivery,
  Message,
  RemoteDeliveryRow,
  Settlement,
} from '@dispatch/client';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';

import { useStickToBottom } from '../../hooks/useStickToBottom';
import type { DecideAvailability, MessageAccess } from '../../lib/daemonAuth';
import type {
  RefAction,
  ReplyPlan,
  ReplyRoute,
  ThreadLookups,
} from '../../lib/threadSources';
import { replyPlan, threadOpenIds } from '../../lib/threadSources';
import type { MessageRowProps } from './MessageRow';
import { MessageRow } from './MessageRow';
import { type OverseerVoice, ReplyBox } from './ReplyBox';

// How long a message a link opened the thread at stays marked.
const LINKED_MARK_MS = 2000;

export interface ThreadPaneProps {
  messages: Message[];
  /** The message id the thread was opened at; a later one is scrolled to and briefly marked. */
  focus: string | null;
  /** The thread's deliveries: a teammate may reply only to what reached them. */
  deliveries: readonly Delivery[];
  /** Recipients on teammates' machines, each question's settlement and an
   *  admitted observer (federation); absent without board sync. */
  remote?: readonly RemoteDeliveryRow[];
  settlements?: Readonly<Record<string, Settlement>>;
  observer?: string | null;
  me: string;
  openIds: ReadonlySet<string>;
  access: MessageAccess;
  lookups: ThreadLookups;
  availability: DecideAvailability;
  onRestartDaemon: () => Promise<void>;
  onAnswer: MessageRowProps['onAnswer'];
  onOpen: (action: RefAction) => void;
  loadApprovalInput: MessageRowProps['loadApprovalInput'];
  /** Declines an open question from an A2A client; without it there is no Decline. */
  client?: MessageRowProps['client'];
  /** The daemon's port, keying a memory gate's proposal read. */
  port?: number;
  route: ReplyRoute;
  /** Sends under the reply draft's idempotency key, kept until a send or an edit. */
  onReply: (
    plan: ReplyPlan,
    body: string,
    idempotencyKey: string
  ) => Promise<unknown>;
  onOverseerReply: (body: string) => Promise<void>;
  /** The Assistant is mid-turn or taking a message, so it would refuse another. */
  overseerBusy: boolean;
  onOpenOverseer: () => void;
  /** How the reply box names the Overseer: "the Assistant", or "your agent" in Two views. */
  overseerVoice?: OverseerVoice;
}

/** An open thread, following its newest message: its messages, then a reply
 *  box addressed by `replyPlan`. */
export function ThreadPane(props: ThreadPaneProps) {
  const { messages, me, focus } = props;
  const openIds = useMemo(
    () => threadOpenIds(messages, me, props.openIds),
    [messages, me, props.openIds]
  );
  const thread = messages[0]?.thread ?? '';
  const { scrollRef, contentRef, unpin } = useStickToBottom(thread);
  const linked =
    focus !== null && focus !== thread && messages.some((m) => m.id === focus)
      ? focus
      : null;
  const [faded, setFaded] = useState<string | null>(null);
  // Runs after the hook's jump to the bottom, so the linked message wins.
  useLayoutEffect(() => {
    if (linked === null) return;
    const rows = scrollRef.current?.querySelectorAll('[data-message-id]');
    const row = Array.from(rows ?? []).find(
      (el) => el.getAttribute('data-message-id') === linked
    );
    if (row === undefined) return;
    unpin();
    row.scrollIntoView({ block: 'center' });
  }, [linked, scrollRef, unpin]);
  useEffect(() => {
    if (linked === null) return;
    const timer = setTimeout(() => setFaded(linked), LINKED_MARK_MS);
    // A later link back to the same message marks it again.
    return () => {
      clearTimeout(timer);
      setFaded(null);
    };
  }, [linked]);
  const marked = linked !== faded ? linked : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        role="log"
        aria-label="Messages"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div ref={contentRef} className="flex flex-col gap-3 p-3">
          {messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              me={me}
              linked={message.id === marked}
              open={openIds.has(message.id)}
              access={props.access}
              lookups={props.lookups}
              availability={props.availability}
              onRestartDaemon={props.onRestartDaemon}
              onAnswer={props.onAnswer}
              onOpen={props.onOpen}
              loadApprovalInput={props.loadApprovalInput}
              {...federated(message, messages, props)}
              client={props.client}
              port={props.port}
            />
          ))}
        </div>
      </div>
      <div className="border-border border-t-[0.5px] p-2">
        <ReplyBox
          {...props}
          openIds={openIds}
          plan={replyPlan(messages, me, openIds, {
            canDecide: props.access.canDecide,
            deliveries: props.deliveries,
          })}
        />
      </div>
    </div>
  );
}

// A row's federation props: its remote recipients, the standing of a reply
// at its question's settler, and an admitted observer.
function federated(
  message: Message,
  messages: readonly Message[],
  props: ThreadPaneProps
): Partial<MessageRowProps> {
  const remote = (props.remote ?? []).filter((r) => r.messageId === message.id);
  const question =
    message.replyTo === null
      ? undefined
      : messages.find((m) => m.id === message.replyTo);
  const settlement: Settlement | undefined =
    message.settledAs === 'pending' || message.settledAs === 'superseded'
      ? message.settledAs
      : undefined;
  return {
    ...(remote.length > 0 ? { remoteDeliveries: remote } : {}),
    ...(settlement === undefined ? {} : { settlement }),
    ...(question?.remoteLabel === undefined
      ? {}
      : { settlerLabel: question.remoteLabel }),
    observer: props.observer ?? null,
  };
}
