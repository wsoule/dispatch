import type { ApiClient, Message } from '@dispatch/client';
import { Button, cx, Field, TextField } from '@dispatch/ui';
import { useEffect, useId, useRef, useState } from 'react';

import { canDecline } from '../../lib/a2a';
import styles from './A2ADeclineAction.module.css';

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
        <Button size="sm" variant="quiet" onClick={() => setConfirming(true)}>
          Decline
        </Button>
      </div>
    );
  }
  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        void decline();
      }}
    >
      <Field label="Reason" id={reasonId}>
        <TextField
          size="sm"
          value={reason}
          placeholder="Optional; the client sees it"
          onChange={(e) => setReason(e.target.value)}
          ref={reasonRef}
        />
      </Field>
      <div className={styles.actions}>
        <Button type="submit" size="sm" variant="danger" disabled={pending}>
          {pending ? 'Declining…' : 'Decline question'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="quiet"
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
        <p
          role="alert"
          className={cx(styles.error, 'toneText')}
          data-tone="danger"
        >
          {error}
        </p>
      )}
    </form>
  );
}
