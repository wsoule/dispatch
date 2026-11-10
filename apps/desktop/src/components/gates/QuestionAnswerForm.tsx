import { Button, cx, TextField } from '@dispatch/ui';
import { useEffect, useId, useRef, useState } from 'react';

import styles from './QuestionAnswerForm.module.css';

export interface QuestionAnswerFormProps {
  /** Sends the typed answer; a rejection shows as an error under the box. */
  onAnswer: (body: string) => Promise<void>;
  /** Who is asking, for the box's label. */
  asker: string;
}

/**
 * An answer box for a question only free text can answer: "Answer…" opens it,
 * and sending posts the text as the answer to that question (not a new
 * message beside it), so whoever asked, an outside A2A agent included, gets
 * it. Used where the gate card has nothing to draw: a Needs you row and the
 * middle conversation.
 */
export function QuestionAnswerForm({
  onAnswer,
  asker,
}: QuestionAnswerFormProps) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // Opening the box puts the cursor in it, where typing starts.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <div>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          Answer…
        </Button>
      </div>
    );
  }

  const submit = async (): Promise<void> => {
    const text = body.trim();
    if (text === '' || pending) return;
    setPending(true);
    setError(null);
    try {
      await onAnswer(text);
      setBody('');
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      data-slot="question-answer"
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={inputId} className={styles.label}>
        Answer {asker}
      </label>
      <div className={styles.row}>
        <TextField
          id={inputId}
          ref={inputRef}
          value={body}
          size="sm"
          className={styles.input}
          placeholder="Type your answer"
          onChange={(e) => setBody(e.target.value)}
        />
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={pending || body.trim() === ''}
        >
          {pending ? 'Sending…' : 'Send answer'}
        </Button>
        <Button
          size="sm"
          variant="quiet"
          type="button"
          onClick={() => {
            setOpen(false);
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
