import type { ApiClient } from '@dispatch/client';
import { Button, cx } from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import type { DecideAvailability } from '../../lib/daemonAuth';
import type { EntryVersion, ProposalCardModel } from '../../lib/memory';
import { memoryQueryKey, proposalCardModel } from '../../lib/memory';
import { DecisionCard, type DecisionCardProps } from '../gates/DecisionCard';
import { DecideUnavailableNotice } from '../runs/DecideUnavailableNotice';
import { Markdown } from '../runs/Markdown';
import styles from './MemoryGateCard.module.css';

type Choice = 'approve' | 'reject';

interface MemoryGateCardProps {
  proposalId: string;
  /** Reads the proposal the gate names; the gate message carries none of its text. */
  client: Pick<ApiClient, 'getMemoryProposal'>;
  /** Keys the read under memory's queries, so memory.changed refetches it. */
  port: number | undefined;
  onDecide: (choice: Choice) => Promise<void>;
  /** Whether this window holds the app token deciding requires. */
  availability: DecideAvailability;
  onRestartDaemon: () => Promise<void>;
}

/** A memory gate on DecisionCard: the proposed entry (or the one a retire
 *  would remove), where it would reach and who asked, and Approve or Reject
 *  once it has loaded. */
export function MemoryGateCard({
  proposalId,
  client,
  port,
  onDecide,
  availability,
  onRestartDaemon,
}: MemoryGateCardProps) {
  const read = useQuery({
    queryKey: memoryQueryKey(port, `proposal:${proposalId}`),
    queryFn: () => client.getMemoryProposal(proposalId),
    retry: false,
  });
  const [pending, setPending] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>();

  const model: ProposalCardModel | null =
    read.data === undefined ? null : proposalCardModel(read.data);
  // Nothing is decided blind: the options wake only once the proposal is shown.
  const decidable =
    model !== null &&
    model.decided === null &&
    availability.enabled &&
    pending === null;

  async function decide(choice: Choice) {
    setPending(choice);
    setError(null);
    try {
      await onDecide(choice);
    } catch (err) {
      setSelectedId(undefined);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  function handleSelect(id: string) {
    if (!decidable) return;
    setSelectedId(id);
    void decide(id === 'approve' ? 'approve' : 'reject');
  }

  function retry() {
    void read.refetch();
  }

  const options: DecisionCardProps['options'] = [
    { id: 'reject', label: pending === 'reject' ? 'Rejecting…' : 'Reject' },
    { id: 'approve', label: pending === 'approve' ? 'Approving…' : 'Approve' },
  ];

  return (
    <DecisionCard
      data-slot="memory-gate-card"
      question={model?.ask ?? 'A memory proposal is waiting for a decision'}
      detail={
        model !== null ? (
          <ProposalDetail model={model} />
        ) : read.error !== null && !read.isFetching ? (
          <span className={styles.line}>
            <span role="alert" className="toneText" data-tone="danger">
              Could not read the proposal: {read.error.message}
            </span>
            <Button variant="quiet" size="sm" onClick={retry}>
              Try again
            </Button>
          </span>
        ) : (
          'Loading the proposal…'
        )
      }
      options={options}
      onSelect={handleSelect}
      selectedId={selectedId}
      disabled={!decidable}
    >
      <DecideUnavailableNotice
        availability={availability}
        onRestartDaemon={onRestartDaemon}
      />
      {error !== null ? (
        <div className={cx(styles.error, 'toneText')} data-tone="danger">
          {error}
        </div>
      ) : null}
    </DecisionCard>
  );
}

// The proposal itself. Titles and notes are author-written, so they render as
// plain text; bodies go through Markdown as other agent text does.
function ProposalDetail({ model }: { model: ProposalCardModel }) {
  return (
    <div className={styles.detail}>
      {model.diff === null ? (
        <>
          <div className={styles.title}>{model.title}</div>
          <Markdown content={model.body} />
        </>
      ) : (
        <>
          {model.diff.retired ? (
            <span className={styles.strong}>
              This entry was retired after this was proposed; approving saves
              this version as a new entry.
            </span>
          ) : (
            model.diff.base !== null && (
              <span className={styles.strong}>
                This entry changed after this was proposed; approving replaces
                the version it has now.
              </span>
            )
          )}
          {model.diff.base !== null && (
            <Version label="Proposed against" version={model.diff.base} />
          )}
          <Version
            label={model.diff.retired ? 'Now (retired)' : 'Now'}
            version={model.diff.current}
          />
          <Version label="Proposed" version={model.diff.proposed} />
        </>
      )}
      <span>Reaches {model.reach}</span>
      <span>
        Proposed by {model.author}
        {model.sourceTask === null ? '' : ` for task ${model.sourceTask}`}
      </span>
      {model.note !== null && (
        <span>
          {model.action === 'retire' ? 'Reason' : 'Note'}: {model.note}
        </span>
      )}
      {model.matchedPersonal && (
        <span>
          It matches a personal entry of the author’s operator, which stays
          private.
        </span>
      )}
      {model.decided !== null && (
        <span className={styles.strong}>Already {model.decided}.</span>
      )}
    </div>
  );
}

// One labelled version of a superseded entry: its title, then its body.
function Version({ label, version }: { label: string; version: EntryVersion }) {
  return (
    <div data-slot="memory-version" className={styles.version}>
      <div className={styles.caption}>{label}</div>
      <div className={styles.title}>{version.title}</div>
      <Markdown content={version.body} />
    </div>
  );
}
