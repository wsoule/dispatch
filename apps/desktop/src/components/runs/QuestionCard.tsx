import { useState } from 'react';

import { Markdown } from './Markdown';
import { formatRelativeTimeFromIso } from '@/lib/format';
import type { ApprovalCardOption } from '@/ui/ai/approval-card';
import { ApprovalCard } from '@/ui/ai/approval-card';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';

interface QuestionCardProps {
  question: string;
  /** Suggested answers, submitted in one click. Free text is always available too. */
  options: string[];
  /** When it was asked, so the card can say how long the agent has been stuck. */
  askedAt?: string;
  onAnswer: (answer: string) => Promise<void>;
}

/** An agent's blocking question and the form that answers it. Loud, and its options are one
 * click, because the agent is parked inside a tool call until this is submitted. Built on the
 * `ui/ai/approval-card` primitive for the question header and suggested-answer options; a
 * free-text answer stays a separate textarea below since the primitive has no slot for one. */
export function QuestionCard({
  question,
  options,
  askedAt,
  onAnswer,
}: QuestionCardProps) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>();

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

  const optionItems: ApprovalCardOption[] = options.map((option, index) => ({
    id: String(index),
    label: option,
  }));

  function handleSelect(id: string) {
    if (sending) return;
    setSelectedId(id);
    const option = options[Number(id)];
    if (option !== undefined) void answer(option);
  }

  return (
    <div className="animate-in fade-in-0 flex flex-col gap-2 duration-150">
      <ApprovalCard
        // Full-width in the transcript, and the question is agent-authored text — render it
        // as markdown so lists/`code`/emphasis survive instead of flattening to plain text.
        className="max-w-none"
        question={<Markdown content={question} />}
        detail={
          askedAt !== undefined
            ? `asked ${formatRelativeTimeFromIso(askedAt)}`
            : undefined
        }
        options={optionItems}
        onSelect={handleSelect}
        selectedId={selectedId}
        disabled={sending}
      />
      {error !== null && (
        <div className="text-destructive text-[12px]">{error}</div>
      )}
      <div className="flex gap-2">
        <Textarea
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
          className="min-h-[52px] flex-1 resize-y text-[12.5px]"
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
