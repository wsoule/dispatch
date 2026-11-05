import type { Message, RemoteDeliveryRow, Settlement } from '@dispatch/client';
import { Chip, ChipButton, cx, InitialsAvatar } from '@dispatch/ui';
import { memo, useState } from 'react';

import { isFromA2A } from '../../lib/a2a';
import type { DecideAvailability, MessageAccess } from '../../lib/daemonAuth';
import { taskProposalOf } from '../../lib/gates';
import { formatShortDate } from '../../lib/taskDates';
import type {
  ParkedCall,
  RefAction,
  ThreadLookups,
} from '../../lib/threadSources';
import {
  addressAction,
  answersWithText,
  messageBadge,
  messageBadgeTone,
  participantLabel,
  refAction,
  rowControl,
} from '../../lib/threadSources';
import type { GateClient, GateReply } from '../gates/GateCard';
import { GateCard } from '../gates/GateCard';
import { QuestionAnswerForm } from '../gates/QuestionAnswerForm';
import { Markdown } from '../runs/Markdown';
import { A2ADeclineAction } from './A2ADeclineAction';
import styles from './MessageRow.module.css';

type Reply = GateReply;

// A ref chip's suffix: a doc's whole section anchor, or a commit's short sha.
function refAt(ref: Message['refs'][number]): string {
  if (ref.at === undefined) return '';
  return ref.type === 'doc' ? `#${ref.at}` : `@${ref.at.slice(0, 7)}`;
}

// The agent that wrote a message a human sent (sendAsHuman's data.draftedBy);
// only this machine's daemon sets it, so another machine's claim is ignored.
function draftedByOf(message: Message): string | null {
  if (message.origin !== undefined) return null;
  const data = message.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return null;
  const by = (data as { draftedBy?: unknown }).draftedBy;
  return typeof by === 'string' && by !== '' ? by : null;
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
  /** Offer an answer box on an open free-text question, for a surface with no
   *  reply box of its own aimed at it (the middle conversation). */
  inlineAnswer?: boolean;
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
  inlineAnswer = false,
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
  const draftedBy = draftedByOf(message);
  const senderAction = addressAction(message.from, lookups);
  const status = lookups.agentStatus(message.from);
  // Only the daemon's own close or breaker marker earns its badge.
  const badge = messageBadge(message);
  const silenced =
    status === null ? null : status === 'revoked' ? 'Revoked' : 'Muted';
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
      data-mine={mine ? 'true' : undefined}
      className={styles.row}
    >
      <InitialsAvatar name={sender} />
      <div className={styles.main}>
        <header className={styles.head}>
          {senderAction === null ? (
            <span className={styles.sender}>{sender}</span>
          ) : (
            <button
              type="button"
              className={styles.senderButton}
              onClick={() => onOpen(senderAction)}
            >
              {sender}
            </button>
          )}
          {isFromA2A(message) && (
            <Chip title="Sent from outside this machine over A2A">A2A</Chip>
          )}
          {badge !== undefined && (
            <Chip tone={messageBadgeTone(badge)}>{badge}</Chip>
          )}
          {draftedBy !== null && (
            <Chip title="An agent wrote this; the sender approved and sent it">
              {`drafted by ${participantLabel(draftedBy, lookups)}`}
            </Chip>
          )}
          {message.remoteLabel !== undefined && (
            <Chip>
              {'remote: '}
              <span className={styles.mono}>{message.remoteLabel}</span>
            </Chip>
          )}
          {message.urgent && (
            <Chip tone={messageBadgeTone('Urgent')}>Urgent</Chip>
          )}
          {silenced !== null && (
            <Chip tone={messageBadgeTone(silenced)}>{silenced}</Chip>
          )}
          <time className={styles.time} dateTime={message.createdAt}>
            {formatShortDate(message.createdAt)}
          </time>
        </header>
        <div className={styles.bubble}>
          {/* Text an A2A sender wrote, or a proposal quoting it, never renders as markdown. */}
          {taskProposalOf(message) === null && !isFromA2A(message) ? (
            <Markdown content={message.body} className={styles.markdown} />
          ) : (
            <p className={styles.plain}>{message.body}</p>
          )}
        </div>
        {message.choice !== undefined && (
          <p className={styles.note}>Chose {message.choice}</p>
        )}
        {message.refs.length > 0 && (
          <div className={styles.refs}>
            {message.refs.map((ref, i) => {
              const action = refAction(ref, lookups);
              const text = `${ref.type}:${ref.id}${refAt(ref)}`;
              const key = `${text}:${i}`;
              return action === null ? (
                <Chip key={key}>
                  <span className={styles.mono}>{text}</span>
                </Chip>
              ) : (
                <ChipButton key={key} onClick={() => onOpen(action)}>
                  <span className={styles.mono}>{text}</span>
                </ChipButton>
              );
            })}
          </div>
        )}
        {remoteDeliveries.length > 0 && (
          <ul className={styles.deliveries}>
            {remoteDeliveries.map((d) => (
              <li
                key={d.recipient}
              >{`${d.recipient}: ${REMOTE_STATE[d.state]}`}</li>
            ))}
          </ul>
        )}
        {settlement === 'pending' && message.kind === 'answer' && (
          <p className={styles.note}>
            {`answered here, waiting for ${settlerLabel ?? 'the asker'}'s machine`}
          </p>
        )}
        {settlement === 'superseded' && (
          <p className={styles.note}>superseded</p>
        )}
        {observer !== null && message.origin !== undefined && (
          <p className={styles.note}>
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
        {open &&
          inlineAnswer &&
          access.canMessage &&
          answersWithText(message, me) && (
            <QuestionAnswerForm
              asker={sender}
              onAnswer={(body) => onAnswer(message, { body })}
            />
          )}
        {open && (
          <A2ADeclineAction
            message={message}
            client={client}
            canDecide={access.canDecide}
          />
        )}
        {error !== null && (
          <p
            role="alert"
            className={cx('toneText', styles.note)}
            data-tone="danger"
          >
            {error}
          </p>
        )}
      </div>
    </article>
  );
});
