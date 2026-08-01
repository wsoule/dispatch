import { MessageCircleQuestion } from 'lucide-react';
import { useState } from 'react';

import { Markdown } from './Markdown';
import { formatRelativeTimeFromIso } from '@/lib/format';
import { Button } from '@/ui/button';

interface QuestionCardProps {
  question: string;
  /** Suggested answers, submitted in one click. Free text is always available too. */
  options: string[];
  /** When it was asked, so the card can say how long the agent has been stuck. */
  askedAt?: string;
  onAnswer: (answer: string) => Promise<void>;
}

/**
 * An agent's blocking question, with the answer form. The agent is parked inside a tool call
 * until this is submitted, so the card is deliberately loud and the options are one click:
 * the common case is picking one of the answers it already offered.
 */
export function QuestionCard({
  question,
  options,
  askedAt,
  onAnswer,
}: QuestionCardProps) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answer(text: string) {
    if (text.trim() === '') return;
    setSending(true);
    setError(null);
    try {
      await onAnswer(text.trim());
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="animate-in fade-in-0 bg-state-waiting-surface border-state-waiting-edge flex flex-col gap-2 rounded-md border px-3 py-2.5 duration-150">
      <div className="flex items-center gap-2">
        <MessageCircleQuestion className="text-state-waiting size-3.5 shrink-0" />
        <span className="dense-label text-state-waiting font-medium">
          The agent is asking you
        </span>
        {askedAt !== undefined && (
          <span className="dense-meta text-state-waiting">
            asked {formatRelativeTimeFromIso(askedAt)}
          </span>
        )}
      </div>
      <Markdown content={question} className="text-[13px]" />
      {options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              key={option}
              variant="secondary"
              size="sm"
              disabled={sending}
              onClick={() => void answer(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      {error !== null && (
        <div className="text-destructive text-[12px]">{error}</div>
      )}
      <div className="flex gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void answer(draft);
            }
          }}
          placeholder={
            options.length > 0
              ? 'Or answer in your own words…'
              : 'Answer the agent…'
          }
          disabled={sending}
          className="shadow-hairline min-h-[52px] flex-1 resize-y rounded-md px-2 py-1.5 text-[12.5px] outline-none"
        />
        <Button
          size="sm"
          className="self-end"
          disabled={sending || draft.trim() === ''}
          onClick={() => void answer(draft)}
        >
          Answer
        </Button>
      </div>
    </div>
  );
}
