import { RotateCw } from 'lucide-react';
import { useState } from 'react';

import type { DecideAvailability } from '../../lib/daemonAuth';
import { Button } from '@/ui/button';

/** Why a decide card is inert in this window (it attached to a daemon it did
 *  not start, so it lacks the app token), with a restart when one is safe. */
export function DecideUnavailableNotice({
  availability,
  onRestartDaemon,
}: {
  availability: DecideAvailability;
  onRestartDaemon?: () => Promise<void>;
}) {
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (availability.enabled) return null;

  async function restart(run: () => Promise<void>) {
    setRestarting(true);
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestarting(false);
    }
  }

  return (
    <div className="rounded-control border-border-chip bg-surface-quaternary flex flex-col gap-1.5 border-[0.5px] px-2.5 py-2">
      <span className="text-[13px] font-medium">{availability.notice}</span>
      <span className="font-book text-muted-foreground text-[12px]">
        {availability.explanation}
      </span>
      {availability.restart?.safe === true && onRestartDaemon !== undefined ? (
        <Button
          variant="secondary"
          className="self-start"
          disabled={restarting}
          onClick={() => void restart(onRestartDaemon)}
        >
          <RotateCw className="size-3" />
          {restarting ? 'Restarting…' : 'Restart daemon'}
        </Button>
      ) : (
        <span className="font-book text-muted-foreground text-[12px]">
          {availability.restart?.blockedReason}
        </span>
      )}
      {error !== null && <div className="text-red text-[12px]">{error}</div>}
    </div>
  );
}
