import type { ApiClient, DocProposalView } from '@dispatch/client';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { docsKey } from '../../hooks/useDocs';
import type { DecideAvailability } from '../../lib/daemonAuth';
import { DecideUnavailableNotice } from '../runs/DecideUnavailableNotice';
import type { ApprovalCardOption } from '@/ui/ai/approval-card';
import { ApprovalCard } from '@/ui/ai/approval-card';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';

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

/** A doc gate: the proposed edit's title, proposer, diff and whether it merges
 *  onto the head, then Approve (only when it merges cleanly) or Reject. */
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
  const reasonId = useId();

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

  const options: ApprovalCardOption[] = [
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
    <div
      data-slot="doc-gate-card"
      className="animate-in fade-in-0 flex flex-col gap-2 duration-100 motion-reduce:animate-none"
    >
      <ApprovalCard
        className="max-w-none"
        question="Apply this edit to an accepted doc?"
        detail={
          view !== null ? (
            <ProposalDetail
              view={view}
              onOpenDoc={() => onOpenDoc(doc, proposal)}
            />
          ) : read.error !== null && !read.isFetching ? (
            <span className="flex flex-wrap items-center gap-x-1.5">
              <span role="alert" className="text-red">
                Could not read the proposal: {read.error.message}
              </span>
              <Button
                variant="link"
                size="xs"
                className="h-auto px-0 text-[12px]"
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
      />
      {view !== null && view.proposal.state === 'open' && (
        <div className="flex items-center gap-2 text-[12px]">
          <label htmlFor={reasonId} className="text-muted-foreground shrink-0">
            Reason (optional)
          </label>
          <Input
            id={reasonId}
            value={reason}
            disabled={!decidable}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      )}
      <DecideUnavailableNotice
        availability={availability}
        onRestartDaemon={onRestartDaemon}
      />
      {error !== null && <div className="text-red text-[12px]">{error}</div>}
    </div>
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
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-foreground font-medium">{view.title}</span>
        <span>Proposed by {proposal.author}</span>
        <span>
          {mergeable.clean
            ? 'merges cleanly'
            : `conflicts with rev ${mergeable.headN}`}
        </span>
      </div>
      <pre className="rounded-control border-border-chip max-h-64 overflow-auto border-[0.5px] px-2.5 py-2 font-mono text-[11px]">
        {view.chunks
          .filter((c) => !c.equal)
          .flatMap((c, i) => [
            ...c.a.map((line, j) => (
              <div key={`a${i}-${j}`}>{`-${line.replace(/\n$/, '')}`}</div>
            )),
            ...c.b.map((line, j) => (
              <div key={`b${i}-${j}`}>{`+${line.replace(/\n$/, '')}`}</div>
            )),
          ])}
      </pre>
      {!mergeable.clean && proposal.state === 'open' && (
        <span className="flex flex-wrap items-center gap-x-1.5">
          <span>
            Resolve it in the doc’s merge view and save, then reject this
            proposal as resolved.
          </span>
          <Button
            variant="link"
            size="xs"
            className="h-auto px-0 text-[12px]"
            onClick={onOpenDoc}
          >
            Open merge view
          </Button>
        </span>
      )}
      {proposal.state !== 'open' && (
        <span className="text-foreground">Already {proposal.state}.</span>
      )}
    </div>
  );
}
