import type { TaskDoc } from '@dispatch-foo/core/browser';
import type { Message } from '@dispatch/client';
import { Button, Chip, cx } from '@dispatch/ui';
import { useState } from 'react';

import { DECIDE_TIER_EXPLANATION } from '../../lib/daemonAuth';
import { taskProposalOf } from '../../lib/gates';
import { DecisionCard } from '../gates/DecisionCard';
import styles from './TaskProposalCard.module.css';

type Choice = 'approve' | 'decline';

export interface TaskProposalCardProps {
  /** The open `task-proposal` gate; its answer approves or declines the draft. */
  gate: Message;
  /** The draft from the board; null while it is not there, which holds Approve. */
  task: TaskDoc | null;
  /** The draft's body is still loading, which also holds Approve. */
  loading?: boolean;
  onAnswer: (choice: Choice) => Promise<void>;
  onOpenTask: (id: string) => void;
  canDecide: boolean;
}

/** An A2A client's handoff awaiting the owner, on DecisionCard: the draft,
 *  its proposer, and Approve or Decline as buttons. Nothing runs until it is
 *  approved. The client wrote the title and the draft, so both stay plain
 *  text. */
export function TaskProposalCard({
  gate,
  task,
  loading = false,
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
    <DecisionCard
      data-slot="task-proposal-card"
      question={task?.meta.title ?? 'A task proposed over A2A'}
      detail={
        <span className={styles.proposer}>
          <span>Proposed by</span>
          <span className={styles.id}>{proposal.proposedBy}</span>
          <Chip>A2A</Chip>
        </span>
      }
      actions={
        <>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => onOpenTask(proposal.task)}
          >
            Open draft
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!idle}
            onClick={() => void answer('decline')}
          >
            {pending === 'decline' ? 'Declining…' : 'Decline'}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!idle || task === null}
            onClick={() => void answer('approve')}
          >
            {pending === 'approve' ? 'Approving…' : 'Approve'}
          </Button>
        </>
      }
    >
      {task === null ? (
        <p className={styles.note}>
          {loading
            ? 'Loading the draft…'
            : `The draft ${proposal.task} is not on the board.`}
        </p>
      ) : (
        <>
          {/* The client wrote it, so it shows as typed, never as markdown. */}
          <pre
            tabIndex={0}
            role="region"
            aria-label="Draft description"
            className={styles.draft}
          >
            {task.body}
          </pre>
          <Writes writes={task.meta.writes} />
        </>
      )}
      {!canDecide && <p className={styles.note}>{DECIDE_TIER_EXPLANATION}</p>}
      {error !== null && (
        <p
          role="alert"
          className={cx(styles.error, 'toneText')}
          data-tone="danger"
        >
          {error}
        </p>
      )}
    </DecisionCard>
  );
}

// The paths the draft declares it will change, wrapped so each reads in full.
function Writes({ writes }: { writes: readonly string[] }) {
  if (writes.length === 0) {
    return <p className={styles.note}>It declares no writes.</p>;
  }
  return (
    <div className={styles.writes}>
      <span className={styles.label}>Writes</span>
      <ul className={styles.paths}>
        {writes.map((path, i) => (
          <li key={`${path}:${i}`} className={styles.id}>
            {path}
          </li>
        ))}
      </ul>
    </div>
  );
}
