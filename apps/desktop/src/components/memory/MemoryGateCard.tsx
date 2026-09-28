import type { ApiClient } from '@dispatch/client';
import { useEffect, useState } from 'react';

import type { DecideAvailability } from '../../lib/daemonAuth';
import type { EntryVersion, ProposalCardModel } from '../../lib/memory';
import { proposalCardModel } from '../../lib/memory';
import { DecideUnavailableNotice } from '../runs/DecideUnavailableNotice';
import { Markdown } from '../runs/Markdown';
import type { ApprovalCardOption } from '@/ui/ai/approval-card';
import { ApprovalCard } from '@/ui/ai/approval-card';
import { Button } from '@/ui/button';

type Choice = 'approve' | 'reject';

type Loaded =
  | { state: 'loading' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; model: ProposalCardModel };

interface MemoryGateCardProps {
  proposalId: string;
  /** Reads the proposal the gate names; the gate message carries none of its text. */
  client: Pick<ApiClient, 'getMemoryProposal'>;
  onDecide: (choice: Choice) => Promise<void>;
  /** Whether this window holds the app token deciding requires. */
  availability: DecideAvailability;
  onRestartDaemon: () => Promise<void>;
}

/** A memory gate: the proposed entry (or the one a retire would remove), where
 *  it would reach and who asked, and Approve or Reject once it has loaded. */
export function MemoryGateCard({
  proposalId,
  client,
  onDecide,
  availability,
  onRestartDaemon,
}: MemoryGateCardProps) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>();

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const read = await client.getMemoryProposal(proposalId);
        if (live) setLoaded({ state: 'ready', model: proposalCardModel(read) });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (live) setLoaded({ state: 'failed', error });
      }
    })();
    return () => {
      live = false;
    };
  }, [client, proposalId, attempt]);

  const model = loaded.state === 'ready' ? loaded.model : null;
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
    setLoaded({ state: 'loading' });
    setAttempt((n) => n + 1);
  }

  const options: ApprovalCardOption[] = [
    { id: 'reject', label: pending === 'reject' ? 'Rejecting…' : 'Reject' },
    { id: 'approve', label: pending === 'approve' ? 'Approving…' : 'Approve' },
  ];

  return (
    <div
      data-slot="memory-gate-card"
      className="animate-in fade-in-0 flex flex-col gap-2 duration-100 motion-reduce:animate-none"
    >
      <ApprovalCard
        className="max-w-none"
        question={model?.ask ?? 'A memory proposal is waiting for a decision'}
        detail={
          loaded.state === 'ready' ? (
            <ProposalDetail model={loaded.model} />
          ) : loaded.state === 'failed' ? (
            <span className="flex flex-wrap items-center gap-x-1.5">
              <span role="alert" className="text-red">
                Could not read the proposal: {loaded.error}
              </span>
              <Button
                variant="link"
                size="xs"
                className="h-auto px-0 text-[12px]"
                onClick={retry}
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
      <DecideUnavailableNotice
        availability={availability}
        onRestartDaemon={onRestartDaemon}
      />
      {error !== null && <div className="text-red text-[12px]">{error}</div>}
    </div>
  );
}

// The proposal itself. Titles and notes are author-written, so they render as
// plain text; bodies go through Markdown as other agent text does.
function ProposalDetail({ model }: { model: ProposalCardModel }) {
  return (
    <div className="flex flex-col gap-2">
      {model.diff === null ? (
        <>
          <div className="text-foreground font-medium">{model.title}</div>
          <Markdown content={model.body} />
        </>
      ) : (
        <>
          {model.diff.retired ? (
            <span className="text-foreground">
              This entry was retired after this was proposed; approving saves
              this version as a new entry.
            </span>
          ) : (
            model.diff.base !== null && (
              <span className="text-foreground">
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
        <span className="text-foreground">Already {model.decided}.</span>
      )}
    </div>
  );
}

// One labelled version of a superseded entry: its title, then its body.
function Version({ label, version }: { label: string; version: EntryVersion }) {
  return (
    <div
      data-slot="memory-version"
      className="rounded-control border-border-chip border-[0.5px] px-2.5 py-2"
    >
      <div className="text-muted-foreground mb-1 text-[11px] font-medium">
        {label}
      </div>
      <div className="text-foreground font-medium">{version.title}</div>
      <Markdown content={version.body} />
    </div>
  );
}
