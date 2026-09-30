import type { ApiClient, Message } from '@dispatch/client';
import type { TaskListItem } from '@dispatch/core/browser';
import { memo, useEffect, useState } from 'react';

import { isFromA2A } from '../../lib/a2a';
import type { DecideAvailability, MessageAccess } from '../../lib/daemonAuth';
import { approvalReply, isSystemMarker, taskProposalOf } from '../../lib/gates';
import { formatShortDate } from '../../lib/taskDates';
import type {
  ParkedCall,
  RefAction,
  RowControl,
  ThreadLookups,
} from '../../lib/threadSources';
import {
  addressAction,
  kindLabel,
  offersAnswer,
  participantLabel,
  refAction,
  rowControl,
} from '../../lib/threadSources';
import { MemoryGateCard } from '../memory/MemoryGateCard';
import { ApprovalCard } from '../runs/ApprovalCard';
import { Markdown } from '../runs/Markdown';
import { ScopeRequestCard } from '../runs/ScopeRequestCard';
import { A2ADeclineAction } from './A2ADeclineAction';
import { TaskProposalCard } from './TaskProposalCard';
import { cn } from '@/lib/utils';
import { ChatMessage } from '@/ui/ai/chat';
import { InitialsAvatar } from '@/ui/ai/initials-avatar';
import { Pill, PillButton } from '@/ui/ai/pill';
import { Button } from '@/ui/button';

type Reply = { body: string; choice?: string };

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
  /** Declines an open question from an A2A client, reads a memory gate's
   *  proposal and a task proposal's draft body; without it there is no
   *  Decline and no proposal to show. */
  client?: Pick<
    ApiClient,
    'declineA2ATask' | 'getMemoryProposal' | 'fetchTask'
  > | null;
}

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
  client = null,
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
            {badge !== undefined && <Pill>{badge}</Pill>}
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
          <Control
            message={message}
            control={rowControl(message, { me, open, access })}
            lookups={lookups}
            onOpen={onOpen}
            availability={availability}
            onRestartDaemon={onRestartDaemon}
            answer={answer}
            loadApprovalInput={loadApprovalInput}
            client={client}
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

// The row's answer affordance: a gate card, choice buttons, or why there are none.
function Control({
  message,
  control,
  lookups,
  onOpen,
  availability,
  onRestartDaemon,
  answer,
  loadApprovalInput,
  client,
}: {
  message: Message;
  control: RowControl;
  lookups: ThreadLookups;
  onOpen: (action: RefAction) => void;
  availability: DecideAvailability;
  onRestartDaemon: () => Promise<void>;
  answer: (reply: Reply) => Promise<void>;
  loadApprovalInput: MessageRowProps['loadApprovalInput'];
  client: MessageRowProps['client'];
}) {
  if (control.kind === 'read-only') {
    return (
      <p className="text-muted-foreground text-[12px]">{control.reason}</p>
    );
  }
  // Drawn for every viewer; its answers wait on the decide tier.
  if (control.kind === 'task-proposal') {
    return (
      <TaskProposalGate
        gate={message}
        item={lookups.task(control.task)}
        client={client ?? null}
        onAnswer={(choice) => answer({ body: '', choice })}
        onOpenTask={(taskId) => onOpen({ kind: 'task', taskId })}
        canDecide={control.canDecide}
      />
    );
  }
  if (!offersAnswer(control)) return null;
  switch (control.kind) {
    case 'tool-approval': {
      const { call } = control;
      return (
        <ApprovalCard
          toolName={control.tool}
          toolInput={control.input}
          truncated={control.truncated}
          loadFullInput={
            call === null ? undefined : () => loadApprovalInput(call)
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
    case 'memory':
      return client === null || client === undefined ? (
        <p className="text-muted-foreground text-[12px]">
          This window cannot read the proposal, so it cannot decide it.
        </p>
      ) : (
        <MemoryGateCard
          proposalId={control.proposalId}
          client={client}
          availability={availability}
          onRestartDaemon={onRestartDaemon}
          onDecide={(choice) => answer({ body: '', choice })}
        />
      );
    case 'choices':
      return (
        <Choices
          choices={control.choices}
          gate={control.gate}
          answer={answer}
        />
      );
  }
}

// Choice buttons that hold while one answer is in flight, so a double click
// answers once rather than failing the second time as already answered.
function Choices({
  choices,
  gate,
  answer,
}: {
  choices: string[];
  gate: boolean;
  answer: (reply: Reply) => Promise<void>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const choose = async (choice: string): Promise<void> => {
    if (pending !== null) return;
    setPending(choice);
    try {
      await answer(gate ? { body: '', choice } : { body: choice, choice });
    } finally {
      setPending(null);
    }
  };
  return (
    <div
      role="group"
      aria-label="Answer"
      aria-busy={pending === null ? undefined : true}
      className="flex flex-wrap gap-1.5"
    >
      {choices.map((choice) => (
        <Button
          key={choice}
          size="sm"
          variant="outline"
          disabled={pending !== null}
          onClick={() => void choose(choice)}
        >
          {pending === choice ? 'Sending…' : choice}
        </Button>
      ))}
    </div>
  );
}

// The board list carries no bodies, so the proposal card fetches its draft's
// body, again whenever the draft is edited.
function TaskProposalGate({
  item,
  client,
  ...card
}: {
  gate: Message;
  item: TaskListItem | null;
  client: Pick<ApiClient, 'fetchTask'> | null;
  onAnswer: (choice: 'approve' | 'decline') => Promise<void>;
  onOpenTask: (id: string) => void;
  canDecide: boolean;
}) {
  const [body, setBody] = useState<{
    key: string;
    text: string | null;
  } | null>(null);
  const id = item?.meta.id ?? null;
  const key = item === null ? '' : `${item.meta.id}@${item.meta.updated}`;
  useEffect(() => {
    if (id === null || client === null) return;
    let live = true;
    client.fetchTask(id).then(
      (doc) => {
        if (live) setBody({ key, text: doc.body });
      },
      () => {
        // A draft that cannot be read shows as not on the board.
        if (live) setBody({ key, text: null });
      }
    );
    return () => {
      live = false;
    };
  }, [client, id, key]);
  const settled = body !== null && body.key === key;
  const text = settled ? body.text : null;
  return (
    <TaskProposalCard
      {...card}
      task={
        item === null || text === null ? null : { meta: item.meta, body: text }
      }
      loading={item !== null && !settled}
    />
  );
}
