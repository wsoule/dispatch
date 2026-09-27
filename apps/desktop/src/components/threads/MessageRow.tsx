import type { Message } from '@dispatch/client';
import { memo, useState } from 'react';

import type { DecideAvailability, MessageAccess } from '../../lib/daemonAuth';
import { approvalReply } from '../../lib/gates';
import { formatShortDate } from '../../lib/taskDates';
import type {
  RefAction,
  RowControl,
  ThreadLookups,
} from '../../lib/threadSources';
import {
  addressAction,
  participantLabel,
  refAction,
  rowControl,
} from '../../lib/threadSources';
import { ApprovalCard } from '../runs/ApprovalCard';
import { Markdown } from '../runs/Markdown';
import { ScopeRequestCard } from '../runs/ScopeRequestCard';
import { ChatMessage } from '@/ui/ai/chat';
import { InitialsAvatar } from '@/ui/ai/initials-avatar';
import { Pill, PillButton } from '@/ui/ai/pill';
import { Button } from '@/ui/button';

const KIND_BADGE: Partial<Record<Message['kind'], string>> = {
  question: 'Question',
  handoff: 'Handoff',
  notice: 'Notice',
  answer: 'Answer',
};

type Reply = { body: string; choice?: string };

export interface MessageRowProps {
  message: Message;
  me: string;
  /** The message is an open gate or ask, so its control is live. */
  open: boolean;
  access: MessageAccess;
  lookups: ThreadLookups;
  availability: DecideAvailability;
  onRestartDaemon: () => Promise<void>;
  onAnswer: (message: Message, reply: Reply) => Promise<void>;
  onOpen: (action: RefAction) => void;
  /** Reads a parked run call's full input, for a tool-approval preview that was cut short. */
  loadApprovalInput: (runId: string, requestId: string) => Promise<unknown>;
}

/** One message in a thread: who, what kind, the body, its refs, and what this viewer may answer. */
export const MessageRow = memo(function MessageRow({
  message,
  me,
  open,
  access,
  lookups,
  availability,
  onRestartDaemon,
  onAnswer,
  onOpen,
  loadApprovalInput,
}: MessageRowProps) {
  const [error, setError] = useState<string | null>(null);
  const mine = message.from === me;
  const sender = participantLabel(message.from, lookups);
  const senderAction = addressAction(message.from, lookups);
  const status = lookups.agentStatus(message.from);
  const badge = KIND_BADGE[message.kind];
  const answer = async (reply: Reply): Promise<void> => {
    setError(null);
    try {
      await onAnswer(message, reply);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <article data-message-id={message.id}>
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
            {badge !== undefined && <Pill>{badge}</Pill>}
            {message.urgent && <Pill>Urgent</Pill>}
            {status !== null && (
              <Pill>{status === 'revoked' ? 'Revoked' : 'Muted'}</Pill>
            )}
            <time dateTime={message.createdAt}>
              {formatShortDate(message.createdAt)}
            </time>
          </header>
          <Markdown content={message.body} className="font-book text-[13px]" />
          {message.choice !== undefined && (
            <p className="text-muted-foreground text-[12px]">
              Chose {message.choice}
            </p>
          )}
          {message.refs.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {message.refs.map((ref, i) => {
                const action = refAction(ref, lookups);
                const text = `${ref.type}:${ref.id}${ref.at === undefined ? '' : `@${ref.at.slice(0, 7)}`}`;
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
          <Control
            control={rowControl(message, { me, open, access })}
            availability={availability}
            onRestartDaemon={onRestartDaemon}
            answer={answer}
            loadApprovalInput={loadApprovalInput}
          />
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

// The row's answer affordance: a gate card, choice buttons, or why there are none.
function Control({
  control,
  availability,
  onRestartDaemon,
  answer,
  loadApprovalInput,
}: {
  control: RowControl;
  availability: DecideAvailability;
  onRestartDaemon: () => Promise<void>;
  answer: (reply: Reply) => Promise<void>;
  loadApprovalInput: MessageRowProps['loadApprovalInput'];
}) {
  switch (control.kind) {
    case 'none':
      return null;
    case 'read-only':
      return (
        <p className="text-muted-foreground text-[12px]">{control.reason}</p>
      );
    case 'tool-approval': {
      const { runId, requestId } = control;
      return (
        <ApprovalCard
          toolName={control.tool}
          toolInput={control.input}
          truncated={control.truncated}
          loadFullInput={
            runId === null
              ? undefined
              : () => loadApprovalInput(runId, requestId)
          }
          availability={availability}
          onRestartDaemon={onRestartDaemon}
          onDecide={(allow, opts) => answer(approvalReply(allow, opts))}
        />
      );
    }
    case 'scope':
      return (
        <ScopeRequestCard
          paths={control.paths}
          reason={control.reason}
          availability={availability}
          onRestartDaemon={onRestartDaemon}
          onDecide={(granted) =>
            answer({ body: '', choice: granted ? 'grant' : 'deny' })
          }
        />
      );
    case 'choices':
      if (control.choices.length === 0) return null;
      return (
        <div
          role="group"
          aria-label="Answer"
          className="flex flex-wrap gap-1.5"
        >
          {control.choices.map((choice) => (
            <Button
              key={choice}
              size="sm"
              variant="outline"
              onClick={() =>
                void answer(
                  control.gate ? { body: '', choice } : { body: choice, choice }
                )
              }
            >
              {choice}
            </Button>
          ))}
        </div>
      );
  }
}
