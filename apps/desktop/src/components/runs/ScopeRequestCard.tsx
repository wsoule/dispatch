import { RotateCw } from 'lucide-react';
import { useState } from 'react';

import type { DecideAvailability } from '../../lib/daemonAuth';
import type { ApprovalCardOption } from '@/ui/ai/approval-card';
import { ApprovalCard } from '@/ui/ai/approval-card';
import { Button } from '@/ui/button';

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

/** An agent parked on permission to edit outside its declared fence — grant
 *  or deny, no ruling text required (this only gates one tool call). Built on the
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
  const [restarting, setRestarting] = useState(false);
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

  async function restart() {
    setRestarting(true);
    setError(null);
    try {
      await onRestartDaemon();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestarting(false);
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
    <div className="animate-in fade-in-0 flex flex-col gap-2 duration-150">
      <ApprovalCard
        question="The agent wants to edit outside its scope"
        detail={reason}
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
      {!availability.enabled && (
        <div className="border-border bg-muted/40 flex flex-col gap-1.5 rounded-md border px-2.5 py-2">
          <span className="text-[12px] font-medium">{availability.notice}</span>
          <span className="text-muted-foreground text-[11px]">
            {availability.explanation}
          </span>
          {availability.restart?.safe === true ? (
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              disabled={restarting}
              onClick={() => void restart()}
            >
              <RotateCw className="size-3" />
              {restarting ? 'Restarting…' : 'Restart daemon'}
            </Button>
          ) : (
            <span className="text-muted-foreground text-[11px]">
              {availability.restart?.blockedReason}
            </span>
          )}
        </div>
      )}
      {error !== null && (
        <div className="text-destructive text-[12px]">{error}</div>
      )}
    </div>
  );
}
