import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { ApiClient, Message } from '@dispatch/client';
import { useEffect, useState } from 'react';

import type { DecideAvailability } from '../../lib/daemonAuth';
import { approvalReply } from '../../lib/gates';
import type {
  ParkedCall,
  RefAction,
  RowControl,
  ThreadLookups,
} from '../../lib/threadSources';
import { offersAnswer } from '../../lib/threadSources';
import { DocGateCard } from '../docs/DocGateCard';
import { MemoryGateCard } from '../memory/MemoryGateCard';
import { ApprovalCard } from '../runs/ApprovalCard';
import { ScopeRequestCard } from '../runs/ScopeRequestCard';
import { TaskProposalCard } from '../threads/TaskProposalCard';
import { Button } from '@/ui/button';

/** An answer to a gate or ask: a body, and the choice a button stands for. */
export type GateReply = { body: string; choice?: string };

/** The client calls a gate card reads proposals and drafts through. */
export type GateClient = Pick<
  ApiClient,
  'declineA2ATask' | 'getMemoryProposal' | 'getDocProposal' | 'fetchTask'
>;

export interface GateCardProps {
  message: Message;
  /** What `rowControl` offers this viewer for `message`. */
  control: RowControl;
  lookups: ThreadLookups;
  onOpen: (action: RefAction) => void;
  availability: DecideAvailability;
  onRestartDaemon: () => Promise<void>;
  answer: (reply: GateReply) => Promise<void>;
  /** Reads a parked call's full input, for a tool-approval preview that was cut short. */
  loadApprovalInput: (call: ParkedCall) => Promise<unknown>;
  /** Without it, memory and doc gates cannot be read, so cannot be decided. */
  client: GateClient | null;
  /** The daemon's port, keying a proposal read under memory's or docs' queries. */
  port: number | undefined;
}

/** A message's answer affordance: a gate card, choice buttons, or why there are none. */
export function GateCard({
  message,
  control,
  lookups,
  onOpen,
  availability,
  onRestartDaemon,
  answer,
  loadApprovalInput,
  client,
  port,
}: GateCardProps) {
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
        client={client}
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
      return client === null ? (
        <p className="text-muted-foreground text-[12px]">
          This window cannot read the proposal, so it cannot decide it.
        </p>
      ) : (
        <MemoryGateCard
          proposalId={control.proposalId}
          client={client}
          port={port}
          availability={availability}
          onRestartDaemon={onRestartDaemon}
          onDecide={(choice) => answer({ body: '', choice })}
        />
      );
    case 'doc':
      return client === null ? (
        <p className="text-muted-foreground text-[12px]">
          This window cannot read the proposal, so it cannot decide it.
        </p>
      ) : (
        <DocGateCard
          doc={control.doc}
          proposal={control.proposal}
          client={client}
          port={port}
          availability={availability}
          onRestartDaemon={onRestartDaemon}
          onDecide={(choice, body) => answer({ body, choice })}
          onOpenDoc={(docId, merge) =>
            onOpen({ kind: 'doc', docId, anchor: null, merge })
          }
        />
      );
    case 'choices':
      return (
        <DecideButtons
          options={control.choices.map((choice) => ({ choice, label: choice }))}
          onDecide={(choice) =>
            answer(
              control.gate ? { body: '', choice } : { body: choice, choice }
            )
          }
        />
      );
  }
}

// Buttons that hold while one answer is in flight, so a double click answers
// once rather than failing the second time as already answered.
function DecideButtons({
  options,
  onDecide,
  disabled = false,
}: {
  options: readonly { choice: string; label: string }[];
  onDecide: (choice: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const choose = async (choice: string): Promise<void> => {
    if (pending !== null) return;
    setPending(choice);
    try {
      await onDecide(choice);
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
      {options.map(({ choice, label }) => (
        <Button
          key={choice}
          size="sm"
          variant="outline"
          disabled={disabled || pending !== null}
          onClick={() => void choose(choice)}
        >
          {pending === choice ? 'Sending…' : label}
        </Button>
      ))}
    </div>
  );
}

// `task:t-46` → `t-46`; any other address as written.
function wakeLabel(target: string): string {
  return target.startsWith('task:') ? target.slice('task:'.length) : target;
}

/** A wake gate: someone asked to wake `target` (a task or ended run) with a
 *  message; approving wakes it, Don't leaves the message waiting. */
export function WakeCard({
  target,
  onDecide,
  canDecide = true,
}: {
  target: string;
  onDecide: (choice: 'approve' | 'deny') => Promise<void>;
  canDecide?: boolean;
}) {
  return (
    <div data-testid="wake-card" className="flex flex-col gap-1.5">
      <DecideButtons
        options={[
          { choice: 'approve', label: `Wake ${wakeLabel(target)}` },
          { choice: 'deny', label: 'Don’t' },
        ]}
        onDecide={(choice) =>
          onDecide(choice === 'approve' ? 'approve' : 'deny')
        }
        disabled={!canDecide}
      />
    </div>
  );
}

/** An agent-registration gate: an MCP agent or A2A client asks to join;
 *  Approve lets its token act, Deny revokes it. */
export function RegistrationCard({
  agent,
  client,
  requestedBy,
  onDecide,
  canDecide = true,
}: {
  agent: string;
  client: string;
  requestedBy?: string;
  onDecide: (choice: 'approve' | 'deny') => Promise<void>;
  canDecide?: boolean;
}) {
  return (
    <div data-testid="registration-card" className="flex flex-col gap-1.5">
      <p className="text-muted-foreground text-[12px] break-words">
        {`${agent} · ${client}`}
        {requestedBy === undefined ? null : ` · asked by ${requestedBy}`}
      </p>
      <DecideButtons
        options={[
          { choice: 'approve', label: 'Approve' },
          { choice: 'deny', label: 'Deny' },
        ]}
        onDecide={(choice) =>
          onDecide(choice === 'approve' ? 'approve' : 'deny')
        }
        disabled={!canDecide}
      />
    </div>
  );
}

/** A task-proposal gate's card. The board list carries no bodies, so it
 *  fetches the draft's body, again whenever the draft is edited. */
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
