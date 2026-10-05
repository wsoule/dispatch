import type { Message, RemoteDeliveryRow, Settlement } from '@dispatch/client';
import { memo, useState } from 'react';

import { isFromA2A } from '../../lib/a2a';
import type { DecideAvailability, MessageAccess } from '../../lib/daemonAuth';
import { isSystemMarker, taskProposalOf } from '../../lib/gates';
import { formatShortDate } from '../../lib/taskDates';
import type {
  ParkedCall,
  RefAction,
  ThreadLookups,
} from '../../lib/threadSources';
import {
  addressAction,
  kindLabel,
  participantLabel,
  refAction,
  rowControl,
} from '../../lib/threadSources';
import type { GateClient, GateReply } from '../gates/GateCard';
import { GateCard } from '../gates/GateCard';
import { Markdown } from '../runs/Markdown';
import { A2ADeclineAction } from './A2ADeclineAction';
import { cn } from '@/lib/utils';
import { ChatMessage } from '@/ui/ai/chat';
import { InitialsAvatar } from '@/ui/ai/initials-avatar';
import { Pill, PillButton } from '@/ui/ai/pill';

type Reply = GateReply;

// A ref chip's suffix: a doc's whole section anchor, or a commit's short sha.
function refAt(ref: Message['refs'][number]): string {
  if (ref.at === undefined) return '';
  return ref.type === 'doc' ? `#${ref.at}` : `@${ref.at.slice(0, 7)}`;
}

export interface MessageRowProps {
  message: Message;
  me: string;
  /** The message is an open gate or ask, so its control is live. */
  open: boolean;
  /** A link opened the thread at this message, so it is briefly marked. */
  linked?: boolean;
  access: MessageAccess;
  lookups: ThreadLookups;
  availability: DecideAvailability;
  onRestartDaemon: () => Promise<void>;
  onAnswer: (message: Message, reply: Reply) => Promise<void>;
  onOpen: (action: RefAction) => void;
  /** Reads a parked call's full input, for a tool-approval preview that was cut short. */
  loadApprovalInput: (call: ParkedCall) => Promise<unknown>;
  /** Recipients of this message homed on teammates' machines, as reported. */
  remoteDeliveries?: readonly RemoteDeliveryRow[];
  /** This reply's standing at its question's settler (federation). */
  settlement?: Settlement;
  /** The settler's handle, for a pending answer. */
  settlerLabel?: string;
  /** "<handle>'s <device>" of an admitted observer reading the thread. */
  observer?: string | null;
  /** Declines an open question from an A2A client, reads a memory or doc
   *  gate's proposal and a task proposal's draft body; without it there is
   *  no Decline and no proposal to show. */
  client?: GateClient | null;
  /** The daemon's port, keying a proposal read under memory's or docs' queries. */
  port?: number;
}

// How a teammate's machine reports a recipient's state, in words.
const REMOTE_STATE: Record<RemoteDeliveryRow['state'], string> = {
  forwarded: 'sent to their machine',
  held: 'held on their machine',
  pushed: 'delivered',
  notified: 'delivered',
  read: 'read',
  answered: 'answered',
  refused: 'refused by their machine',
};

/** One message in a thread: who, what kind, the body, its refs, and what this viewer may answer. */
export const MessageRow = memo(function MessageRow({
  message,
  me,
  open,
  linked = false,
  access,
  lookups,
  availability,
  onRestartDaemon,
  onAnswer,
  onOpen,
  loadApprovalInput,
  remoteDeliveries = [],
  settlement,
  settlerLabel,
  observer = null,
  client = null,
  port,
}: MessageRowProps) {
  const [error, setError] = useState<string | null>(null);
  const mine = message.from === me;
  const sender = participantLabel(message.from, lookups);
  const senderAction = addressAction(message.from, lookups);
  const status = lookups.agentStatus(message.from);
  // Only the daemon's own close or breaker marker earns its badge.
  const badge = isSystemMarker(message, 'x-closed')
    ? 'Closed'
    : isSystemMarker(message, 'x-breaker')
      ? 'Breaker'
      : kindLabel(message.kind);
  const answer = async (reply: Reply): Promise<void> => {
    setError(null);
    try {
      await onAnswer(message, reply);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <article
      data-message-id={message.id}
      data-linked={linked ? 'true' : undefined}
      className={cn(
        'rounded-card transition-colors duration-700',
        linked && 'bg-surface-hover'
      )}
    >
      <ChatMessage
        role={mine ? 'user' : 'agent'}
        avatar={mine ? undefined : <InitialsAvatar name={sender} />}
      >
        <div className="flex flex-col gap-1.5">
          <header className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-[12px]">
            {senderAction === null ? (
              <span className="text-foreground font-medium">{sender}</span>
            ) : (
              <button
                type="button"
                className="text-foreground font-medium hover:underline"
                onClick={() => onOpen(senderAction)}
              >
                {sender}
              </button>
            )}
            {isFromA2A(message) && (
              <Pill title="Sent from outside this machine over A2A">A2A</Pill>
            )}
            {badge !== undefined && <Pill>{badge}</Pill>}
            {message.remoteLabel !== undefined && (
              <Pill>{`remote: ${message.remoteLabel}`}</Pill>
            )}
            {message.urgent && <Pill>Urgent</Pill>}
            {status !== null && (
              <Pill>{status === 'revoked' ? 'Revoked' : 'Muted'}</Pill>
            )}
            <time dateTime={message.createdAt}>
              {formatShortDate(message.createdAt)}
            </time>
          </header>
          {/* Text an A2A sender wrote, or a proposal quoting it, never renders as markdown. */}
          {taskProposalOf(message) === null && !isFromA2A(message) ? (
            <Markdown
              content={message.body}
              className="font-book text-[13px]"
            />
          ) : (
            <p className="font-book text-[13px] break-words whitespace-pre-wrap">
              {message.body}
            </p>
          )}
          {message.choice !== undefined && (
            <p className="text-muted-foreground text-[12px]">
              Chose {message.choice}
            </p>
          )}
          {message.refs.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {message.refs.map((ref, i) => {
                const action = refAction(ref, lookups);
                const text = `${ref.type}:${ref.id}${refAt(ref)}`;
                const key = `${text}:${i}`;
                return action === null ? (
                  <Pill key={key}>{text}</Pill>
                ) : (
                  <PillButton key={key} onClick={() => onOpen(action)}>
                    {text}
                  </PillButton>
                );
              })}
            </div>
          )}
          {remoteDeliveries.length > 0 && (
            <ul className="text-muted-foreground flex flex-wrap gap-x-3 text-[12px]">
              {remoteDeliveries.map((d) => (
                <li
                  key={d.recipient}
                >{`${d.recipient}: ${REMOTE_STATE[d.state]}`}</li>
              ))}
            </ul>
          )}
          {settlement === 'pending' && message.kind === 'answer' && (
            <p className="text-muted-foreground text-[12px]">
              {`answered here, waiting for ${settlerLabel ?? 'the asker'}'s machine`}
            </p>
          )}
          {settlement === 'superseded' && (
            <p className="text-muted-foreground text-[12px]">superseded</p>
          )}
          {observer !== null && message.origin !== undefined && (
            <p className="text-muted-foreground text-[12px]">
              {`an observer (${observer}) reads this thread`}
            </p>
          )}
          <GateCard
            message={message}
            control={rowControl(message, { me, open, access })}
            lookups={lookups}
            onOpen={onOpen}
            availability={availability}
            onRestartDaemon={onRestartDaemon}
            answer={answer}
            loadApprovalInput={loadApprovalInput}
            client={client ?? null}
            port={port}
          />
          {open && (
            <A2ADeclineAction
              message={message}
              client={client}
              canDecide={access.canDecide}
            />
          )}
          {error !== null && (
            <p role="alert" className="text-destructive text-[12px]">
              {error}
            </p>
          )}
        </div>
      </ChatMessage>
    </article>
  );
});
