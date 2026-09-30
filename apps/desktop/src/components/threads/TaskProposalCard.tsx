import type { Message } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import { useState } from 'react';

import { DECIDE_TIER_EXPLANATION } from '../../lib/daemonAuth';
import { taskProposalOf } from '../../lib/gates';
import { Pill } from '@/ui/ai/pill';
import { Button } from '@/ui/button';

type Choice = 'approve' | 'decline';

export interface TaskProposalCardProps {
  /** The open `task-proposal` gate; its answer approves or declines the draft. */
  gate: Message;
  /** The draft from the board; null while it is not there, which holds Approve. */
  task: TaskDoc | null;
  onAnswer: (choice: Choice) => Promise<void>;
  onOpenTask: (id: string) => void;
  canDecide: boolean;
}

/** An A2A client's handoff awaiting the owner: the draft, its proposer, and
 *  Approve or Decline. Nothing runs until it is approved. */
export function TaskProposalCard({
  gate,
  task,
  onAnswer,
  onOpenTask,
  canDecide,
}: TaskProposalCardProps) {
  const [pending, setPending] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const proposal = taskProposalOf(gate);
  if (proposal === null) return null;

  // One answer at a time; a successful one stays held so no second click conflicts.
  async function answer(choice: Choice) {
    if (pending !== null) return;
    setPending(choice);
    setError(null);
    try {
      await onAnswer(choice);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(null);
    }
  }

  const idle = canDecide && pending === null;
  return (
    <div
      data-slot="task-proposal-card"
      className="rounded-card bg-surface-quaternary shadow-card flex flex-col gap-2 p-3 text-[12px]"
    >
      <div className="text-foreground text-[13px] font-medium text-pretty">
        {task?.meta.title ?? 'A task proposed over A2A'}
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-1.5">
        <span>Proposed by</span>
        <span className="text-foreground font-mono text-[11px] break-all">
          {proposal.proposedBy}
        </span>
        <Pill>A2A</Pill>
      </div>
      {task === null ? (
        <p className="text-muted-foreground">
          The draft {proposal.task} is not on the board.
        </p>
      ) : (
        <>
          {/* The client wrote it, so it shows as typed, never as markdown. */}
          <pre
            tabIndex={0}
            aria-label="Draft description"
            className="rounded-control border-border-chip text-foreground max-h-60 overflow-y-auto border-[0.5px] px-2.5 py-2 font-mono text-[11px] break-words whitespace-pre-wrap"
          >
            {task.body}
          </pre>
          <Writes writes={task.meta.writes} />
        </>
      )}
      {!canDecide && (
        <p className="text-muted-foreground">{DECIDE_TIER_EXPLANATION}</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          disabled={!idle || task === null}
          onClick={() => void answer('approve')}
        >
          {pending === 'approve' ? 'Approving…' : 'Approve'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!idle}
          onClick={() => void answer('decline')}
        >
          {pending === 'decline' ? 'Declining…' : 'Decline'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onOpenTask(proposal.task)}
        >
          Open draft
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

// The paths the draft declares it will change, wrapped so each reads in full.
function Writes({ writes }: { writes: readonly string[] }) {
  if (writes.length === 0) {
    return <p className="text-muted-foreground">It declares no writes.</p>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground">Writes</span>
      <ul className="flex min-w-0 flex-col gap-0.5">
        {writes.map((path, i) => (
          <li
            key={`${path}:${i}`}
            className="text-foreground max-w-full min-w-0 font-mono text-[11px] break-all"
          >
            {path}
          </li>
        ))}
      </ul>
    </div>
  );
}
