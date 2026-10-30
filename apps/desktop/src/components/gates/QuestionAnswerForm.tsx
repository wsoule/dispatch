import { useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';

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
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
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
      className="flex min-w-0 flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={inputId} className="text-muted-foreground text-[12px]">
        Answer {asker}
      </label>
      <div className="flex min-w-0 items-center gap-1.5">
        <Input
          id={inputId}
          ref={inputRef}
          value={body}
          className="min-w-0 flex-1"
          placeholder="Type your answer"
          onChange={(e) => setBody(e.target.value)}
        />
        <Button
          size="sm"
          type="submit"
          className="shrink-0"
          disabled={pending || body.trim() === ''}
        >
          {pending ? 'Sending…' : 'Send answer'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          className="shrink-0"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="text-destructive text-[12px] break-words">
          {error}
        </p>
      )}
    </form>
  );
}
