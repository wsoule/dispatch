import type { ApiClient, Message } from '@dispatch/client';
import { useEffect, useId, useRef, useState } from 'react';

import { canDecline } from '../../lib/a2a';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';

export interface A2ADeclineActionProps {
  message: Message;
  client: Pick<ApiClient, 'declineA2ATask'> | null;
  canDecide: boolean;
}

/** Decline on a question from an A2A client: the owner closes it unanswered,
 *  with an optional reason, and the client's task ends REJECTED. */
export function A2ADeclineAction({
  message,
  client,
  canDecide,
}: A2ADeclineActionProps) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const reasonRef = useRef<HTMLInputElement>(null);
  // Opening the form puts the cursor in the reason, where typing starts.
  useEffect(() => {
    if (confirming) reasonRef.current?.focus();
  }, [confirming]);
  if (client === null || !canDecline(message, canDecide)) return null;

  const decline = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const typed = reason.trim();
      await client.declineA2ATask(message.id, typed === '' ? undefined : typed);
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  if (!confirming) {
    return (
      <div>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
          Decline
        </Button>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void decline();
      }}
    >
      <label htmlFor={reasonId} className="text-muted-foreground text-[12px]">
        Reason
      </label>
      <Input
        id={reasonId}
        value={reason}
        placeholder="Optional; the client sees it"
        onChange={(e) => setReason(e.target.value)}
        ref={reasonRef}
      />
      <div className="flex gap-1.5">
        <Button
          type="submit"
          size="sm"
          variant="destructive"
          disabled={pending}
        >
          {pending ? 'Declining…' : 'Decline question'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      )}
    </form>
  );
}
