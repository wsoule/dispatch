import type { ApiClient, DocProposalView } from '@dispatch/client';
import { Button, cx, Field, TextField } from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { docsKey } from '../../hooks/useDocs';
import type { DecideAvailability } from '../../lib/daemonAuth';
import { DecisionCard, type DecisionCardProps } from '../gates/DecisionCard';
import { DecideUnavailableNotice } from '../runs/DecideUnavailableNotice';
import styles from './DocGateCard.module.css';

type Choice = 'approve' | 'reject';

// The reject body when a conflict was resolved in the doc and no reason was typed.
const RESOLVED_IN_DOC = 'resolved in the doc';

interface DocGateCardProps {
  doc: string;
  proposal: string;
  /** Reads the proposal the gate names; the gate message carries none of its text. */
  client: Pick<ApiClient, 'getDocProposal'>;
  /** Keys the read under the docs queries, so doc.changed refetches it. */
  port: number | undefined;
  /** Answers the gate; `body` is the reject reason (empty for approve). */
  onDecide: (choice: Choice, body: string) => Promise<void>;
  /** Opens the doc on this proposal's marked merge, to resolve it there. */
  onOpenDoc: (doc: string, proposal: string) => void;
  /** Whether this window holds the app token deciding requires. */
  availability: DecideAvailability;
  onRestartDaemon: () => Promise<void>;
}

/** A doc gate on DecisionCard: the proposed edit's title, proposer, diff and
 *  whether it merges onto the head, then Approve (only when it merges
 *  cleanly) or Reject, an optional reason, and why deciding is unavailable
 *  in this window when it is. */
export function DocGateCard({
  doc,
  proposal,
  client,
  port,
  onDecide,
  onOpenDoc,
  availability,
  onRestartDaemon,
}: DocGateCardProps) {
  const read = useQuery({
    queryKey: [...docsKey(port), 'proposal', proposal],
    queryFn: () => client.getDocProposal(proposal),
    retry: false,
  });
  const [pending, setPending] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [reason, setReason] = useState('');

  const view = read.data ?? null;
  const clean = view?.mergeable.clean ?? true;
  // Nothing is decided blind: the options wake only once the proposal is shown.
  const decidable =
    view !== null &&
    view.proposal.state === 'open' &&
    availability.enabled &&
    pending === null;

  async function decide(choice: Choice) {
    setPending(choice);
    setError(null);
    const typed = reason.trim();
    const body =
      choice === 'approve'
        ? ''
        : typed !== '' || clean
          ? typed
          : RESOLVED_IN_DOC;
    try {
      await onDecide(choice, body);
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

  const options: DecisionCardProps['options'] = [
    { id: 'reject', label: pending === 'reject' ? 'Rejecting…' : 'Reject' },
    ...(clean
      ? [
          {
            id: 'approve',
            label: pending === 'approve' ? 'Approving…' : 'Approve',
          },
        ]
      : []),
  ];

  return (
    <DecisionCard
      data-slot="doc-gate-card"
      question="Apply this edit to an accepted doc?"
      detail={
        view !== null ? (
          <ProposalDetail
            view={view}
            onOpenDoc={() => onOpenDoc(doc, proposal)}
          />
        ) : read.error !== null && !read.isFetching ? (
          <span className={styles.line}>
            <span role="alert" className="toneText" data-tone="danger">
              Could not read the proposal: {read.error.message}
            </span>
            <Button
              variant="quiet"
              size="sm"
              onClick={() => void read.refetch()}
            >
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
      {view !== null && view.proposal.state === 'open' ? (
        <Field label="Reason (optional)">
          <TextField
            size="sm"
            value={reason}
            disabled={!decidable}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      ) : null}
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

// The proposal: title and proposer as plain text, its changed lines, and
// whether it merges; a conflict points at the doc's merge view instead.
function ProposalDetail({
  view,
  onOpenDoc,
}: {
  view: DocProposalView;
  onOpenDoc: () => void;
}) {
  const { mergeable, proposal } = view;
  return (
    <div className={styles.detail}>
      <div className={styles.meta}>
        <span className={styles.title}>{view.title}</span>
        <span>Proposed by {proposal.author}</span>
        <span>
          {mergeable.clean
            ? 'merges cleanly'
            : `conflicts with rev ${mergeable.headN}`}
        </span>
      </div>
      {/* The changed lines, scrollable by keyboard when they run long; a
          named region, so the Tab stop announces what it holds. */}
      <pre
        className={styles.diff}
        tabIndex={0}
        role="region"
        aria-label="Proposed changes"
      >
        {view.chunks
          .filter((c) => !c.equal)
          .flatMap((c, i) => [
            ...c.a.map((line, j) => (
              <span key={`a${i}-${j}`} className={styles.diffLine}>
                {`-${line.replace(/\n$/, '')}`}
              </span>
            )),
            ...c.b.map((line, j) => (
              <span key={`b${i}-${j}`} className={styles.diffLine}>
                {`+${line.replace(/\n$/, '')}`}
              </span>
            )),
          ])}
      </pre>
      {!mergeable.clean && proposal.state === 'open' && (
        <span className={styles.line}>
          <span>
            Resolve it in the doc’s merge view and save, then reject this
            proposal as resolved.
          </span>
          <Button variant="quiet" size="sm" onClick={onOpenDoc}>
            Open merge view
          </Button>
        </span>
      )}
      {proposal.state !== 'open' && (
        <span className={styles.strong}>Already {proposal.state}.</span>
      )}
    </div>
  );
}
