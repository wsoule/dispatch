import { ShieldQuestion } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/ui/button';

interface ScopeRequestCardProps {
  paths: string[];
  reason: string;
  onDecide: (granted: boolean) => Promise<void>;
}

/** An agent parked on permission to edit outside its declared fence — grant
 *  or deny, no ruling text required (this only gates one tool call). */
export function ScopeRequestCard({
  paths,
  reason,
  onDecide,
}: ScopeRequestCardProps) {
  const [pending, setPending] = useState<'grant' | 'deny' | null>(null);
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

  return (
    <div className="animate-in fade-in-0 bg-state-waiting-surface border-state-waiting-edge flex flex-col gap-2 rounded-md border px-3 py-2.5 duration-150">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="text-state-waiting size-3.5 shrink-0" />
        <span className="dense-label text-state-waiting font-medium">
          The agent wants to edit outside its scope
        </span>
      </div>
      <p className="text-[13px]">{reason}</p>
      <ul className="flex flex-col gap-0.5">
        {paths.map((path) => (
          <li
            key={path}
            className="text-muted-foreground font-mono text-[11px]"
          >
            {path}
          </li>
        ))}
      </ul>
      {error !== null && (
        <div className="text-destructive text-[12px]">{error}</div>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={pending !== null}
          onClick={() => void decide(false)}
        >
          {pending === 'deny' ? 'Denying…' : 'Deny'}
        </Button>
        <Button
          size="sm"
          disabled={pending !== null}
          onClick={() => void decide(true)}
        >
          {pending === 'grant' ? 'Granting…' : 'Grant'}
        </Button>
      </div>
    </div>
  );
}
