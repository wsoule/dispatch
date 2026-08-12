import type { PlannerQuestion } from '@dispatch/client';
import { MessageCircleQuestion } from 'lucide-react';
import { useState } from 'react';

import { Markdown } from '../runs/Markdown';
import {
  composeAnswers,
  questionsSignature,
  unansweredCount,
} from '@/lib/planQuestions';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';

interface PlanQuestionsFormProps {
  questions: PlannerQuestion[];
  /** A turn is already in flight — the form stays visible (so the user's answers-in-progress
   * aren't lost) but its controls are disabled until it lands. */
  disabled: boolean;
  onSend: (message: string) => Promise<void>;
}

/** The planner's batch of clarifying questions, answered together in local state and sent
 * as one composed follow-up — "Skip" sends that same composition with nothing filled in. */
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
    <div className="animate-in fade-in-0 bg-state-waiting-surface rounded-control flex flex-col gap-3 px-3 py-2.5 duration-150">
      <div className="flex items-center gap-2">
        <MessageCircleQuestion className="text-state-waiting size-3.5 shrink-0" />
        <span className="dense-label text-state-waiting font-medium">
          The planner is asking you
        </span>
      </div>
      {questions.map((q) => (
        <div key={q.id} className="flex flex-col gap-1.5">
          <Markdown content={q.question} className="text-[13px]" />
          {q.options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {q.options.map((option) => (
                <Button
                  key={option}
                  type="button"
                  variant={answers[q.id] === option ? 'default' : 'secondary'}
                  size="sm"
                  disabled={busy}
                  onClick={() => setAnswer(q.id, option)}
                >
                  {option}
                </Button>
              ))}
            </div>
          )}
          <Textarea
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
            className="min-h-0 resize-y text-[12.5px]"
          />
        </div>
      ))}
      {error !== null && (
        <div className="text-destructive text-[12px]">{error}</div>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void send({})}
        >
          Skip
        </Button>
        <Button
          type="button"
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
      </div>
    </div>
  );
}
