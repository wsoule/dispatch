import type { PlannerQuestion } from '@dispatch/client';
import { Button, cx, TextArea } from '@dispatch/ui';
import { useState } from 'react';

import { DecisionCard } from '../gates/DecisionCard';
import { Markdown } from '../runs/Markdown';
import styles from './PlanQuestionsForm.module.css';
import {
  composeAnswers,
  questionsSignature,
  unansweredCount,
} from '@/lib/planQuestions';

interface PlanQuestionsFormProps {
  questions: PlannerQuestion[];
  /** A turn is already in flight — the form stays visible (so the user's answers-in-progress
   * aren't lost) but its controls are disabled until it lands. */
  disabled: boolean;
  onSend: (message: string) => Promise<void>;
}

/** The planner's batch of clarifying questions, answered together in local state and sent
 * as one composed follow-up — "Skip" sends that same composition with nothing filled in.
 * A warning-toned DecisionCard (it waits on you) with no radio answers: each question's
 * option buttons and answer box sit in its children, Skip and Send in its actions. */
export function PlanQuestionsForm({
  questions,
  disabled,
  onSend,
}: PlanQuestionsFormProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resets answers only when the rendered question set genuinely changes (by id+text
  // signature, since planner ids repeat across rounds) — not on every send — so an
  // in-flight or failed turn keeps what the user typed instead of blanking it out.
  const signature = questionsSignature(questions);
  const [trackedSignature, setTrackedSignature] = useState(signature);
  if (signature !== trackedSignature) {
    setTrackedSignature(signature);
    setAnswers({});
  }

  function setAnswer(id: string, value: string) {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }

  async function send(nextAnswers: Record<string, string>) {
    setSending(true);
    setError(null);
    try {
      await onSend(composeAnswers(questions, nextAnswers));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  if (questions.length === 0) return null;

  const remaining = unansweredCount(questions, answers);
  const busy = disabled || sending;

  return (
    <DecisionCard
      tone="warning"
      question="The planner is asking you"
      actions={
        <>
          <Button
            type="button"
            variant="quiet"
            size="sm"
            disabled={busy}
            onClick={() => void send({})}
          >
            Skip
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => void send(answers)}
          >
            {sending
              ? 'Sending…'
              : remaining > 0
                ? `Send answers (${questions.length - remaining}/${questions.length})`
                : 'Send answers'}
          </Button>
        </>
      }
    >
      {questions.map((q) => (
        <div key={q.id} className={styles.question}>
          <Markdown content={q.question} className={styles.prompt} />
          {q.options.length > 0 && (
            <div className={styles.options}>
              {q.options.map((option) => (
                <Button
                  key={option}
                  type="button"
                  variant="secondary"
                  size="sm"
                  aria-pressed={answers[q.id] === option}
                  disabled={busy}
                  onClick={() => setAnswer(q.id, option)}
                >
                  {option}
                </Button>
              ))}
            </div>
          )}
          <TextArea
            rows={1}
            value={answers[q.id] ?? ''}
            onChange={(e) => setAnswer(q.id, e.target.value)}
            placeholder={
              q.options.length > 0
                ? 'Or answer in your own words…'
                : 'Your answer…'
            }
            disabled={busy}
            aria-label={q.question}
          />
        </div>
      ))}
      {error !== null && (
        <div
          role="alert"
          className={cx(styles.error, 'toneText')}
          data-tone="danger"
        >
          {error}
        </div>
      )}
    </DecisionCard>
  );
}
