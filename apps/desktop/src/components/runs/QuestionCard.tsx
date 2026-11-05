import { Button, cx, TextArea } from '@dispatch/ui';
import { useState } from 'react';

import { DecisionCard } from '../gates/DecisionCard';
import { Markdown } from './Markdown';
import styles from './QuestionCard.module.css';
import { formatRelativeTimeFromIso } from '@/lib/format';

interface QuestionCardProps {
  question: string;
  /** Suggested answers, submitted in one click. Free text is always available too. */
  options: string[];
  /** When it was asked, so the card can say how long the agent has been stuck. */
  askedAt?: string;
  onAnswer: (answer: string) => Promise<void>;
}

/** An agent's blocking question and the form that answers it. Built on `DecisionCard`: the
 * question is agent-authored Markdown (lists, `code` and emphasis survive), the suggested
 * answers are its radio cards and go out on one pick, because the agent waits on the answer
 * until it is submitted. A free-text answer sits under them (Enter sends, Shift+Enter adds a
 * line), with the primary `Answer`. `data-slot="question-card"` is on the card's root. */
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

  // An option's id is its index, so two suggestions with the same words stay distinct.
  const optionItems = options.map((option, index) => ({
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
    <DecisionCard
      data-slot="question-card"
      question={<Markdown content={question} />}
      detail={
        askedAt !== undefined
          ? `Asked ${formatRelativeTimeFromIso(askedAt)}`
          : undefined
      }
      options={optionItems}
      onSelect={handleSelect}
      selectedId={selectedId}
      disabled={sending}
    >
      {error !== null && (
        <p
          role="alert"
          className={cx('toneText', styles.error)}
          data-tone="danger"
        >
          {error}
        </p>
      )}
      <div className={styles.answer}>
        <TextArea
          className={styles.field}
          aria-label="Your answer"
          value={draft}
          rows={2}
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
        />
        <Button
          variant="primary"
          disabled={sending || draft.trim() === ''}
          onClick={() => void answer(draft)}
        >
          Answer
        </Button>
      </div>
    </DecisionCard>
  );
}
