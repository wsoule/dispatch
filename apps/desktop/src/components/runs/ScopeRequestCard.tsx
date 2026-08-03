import { RotateCw, ShieldQuestion } from 'lucide-react';
import { useState } from 'react';

import type { DecideAvailability } from '../../lib/daemonAuth';
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

/** An agent parked on permission to edit outside its declared fence — grant
 *  or deny, no ruling text required (this only gates one tool call). */
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

  return (
    <div className="animate-in fade-in-0 bg-state-waiting-surface border-state-waiting-edge flex flex-col gap-2 rounded-md border px-3 py-2.5 duration-150">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="text-state-waiting size-3.5 shrink-0" />
        <span className="dense-label text-state-waiting font-medium">
          The agent wants to edit outside its scope
        </span>
      </div>
      <p className="text-[13px]">{reason}</p>
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
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={pending !== null || !availability.enabled}
          onClick={() => void decide(false)}
        >
          {pending === 'deny' ? 'Denying…' : 'Deny'}
        </Button>
        <Button
          size="sm"
          disabled={pending !== null || !availability.enabled}
          onClick={() => void decide(true)}
        >
          {pending === 'grant' ? 'Granting…' : 'Grant'}
        </Button>
      </div>
    </div>
  );
}
