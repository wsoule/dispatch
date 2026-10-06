import { useState } from 'react';

import type { DecideAvailability } from '../../lib/daemonAuth';
import { DecideUnavailableNotice } from './DecideUnavailableNotice';
import { Markdown } from './Markdown';
import type { ApprovalCardOption } from '@/ui/ai/approval-card';
import { ApprovalCard } from '@/ui/ai/approval-card';

interface ScopeRequestCardProps {
  paths: string[];
  reason: string;
  onDecide: (granted: boolean) => Promise<void>;
  /** Whether this window holds the app token deciding requires — see
   *  `decideAvailability`. Grant/Deny are inert without it. */
  availability: DecideAvailability;
  onRestartDaemon: () => Promise<void>;
}

const DENY_ID = 'deny';
const GRANT_ID = 'grant';

/** An agent's scope gate: it waits on permission to edit outside its declared fence — grant
 *  or deny, no ruling text required (a grant is advisory and logged). Built on the
 *  `ui/ai/approval-card` primitive for the question/options chrome; the affected paths and the
 *  daemon-unavailable notice render as their own blocks below since the primitive has no slot
 *  for either. */
export function ScopeRequestCard({
  paths,
  reason,
  onDecide,
  availability,
  onRestartDaemon,
}: ScopeRequestCardProps) {
  const [pending, setPending] = useState<'grant' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>();

  async function decide(granted: boolean) {
    setPending(granted ? 'grant' : 'deny');
    setError(null);
    try {
      await onDecide(granted);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  function handleSelect(id: string) {
    if (pending !== null || !availability.enabled) return;
    setSelectedId(id);
    void decide(id === GRANT_ID);
  }

  const options: ApprovalCardOption[] = [
    { id: DENY_ID, label: pending === 'deny' ? 'Denying…' : 'Deny' },
    {
      id: GRANT_ID,
      label: pending === 'grant' ? 'Granting…' : 'Grant',
      recommended: true,
    },
  ];

  return (
    <div
      data-slot="scope-request-card"
      className="animate-in fade-in-0 flex flex-col gap-2 duration-100 motion-reduce:animate-none"
    >
      <ApprovalCard
        // Full-width in the transcript; `reason` is agent-authored text, so it renders as
        // markdown rather than flattening to a plain string.
        className="max-w-none"
        question="The agent wants to edit outside its scope"
        detail={<Markdown content={reason} />}
        options={options}
        onSelect={handleSelect}
        selectedId={selectedId}
        disabled={pending !== null || !availability.enabled}
      />
      {/* Wrapped, never truncated: this is what the grant applies to, so a
          path the user cannot read in full is a permission they cannot judge. */}
      <ul className="flex min-w-0 flex-col gap-0.5">
        {paths.map((path) => (
          <li
            key={path}
            title={path}
            className="text-muted-foreground max-w-full min-w-0 font-mono text-[11px] break-all"
          >
            {path}
          </li>
        ))}
      </ul>
      <DecideUnavailableNotice
        availability={availability}
        onRestartDaemon={onRestartDaemon}
      />
      {error !== null && <div className="text-red text-[12px]">{error}</div>}
    </div>
  );
}
