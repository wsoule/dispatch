import type { PlannerQuestion } from '@dispatch/client';

// One question's Q/A line pair, with an explicit "use your best judgement"
// placeholder standing in for a skipped or blank answer.
function formatAnswer(
  question: PlannerQuestion,
  answer: string | undefined
): string {
  const trimmed = answer?.trim() ?? '';
  const line =
    trimmed === '' ? '(no answer — use your best judgement)' : trimmed;
  return `Q: ${question.question}\nA: ${line}`;
}

/** Composes answers into the single follow-up message sent to the planner; an empty
 * `answers` map (a "Skip") composes a message telling it to use its own judgement throughout. */
export function composeAnswers(
  questions: PlannerQuestion[],
  answers: Record<string, string>
): string {
  return questions.map((q) => formatAnswer(q, answers[q.id])).join('\n\n');
}

/** How many `questions` still have no non-blank answer in `answers`. */
export function unansweredCount(
  questions: PlannerQuestion[],
  answers: Record<string, string>
): number {
  return questions.filter((q) => (answers[q.id] ?? '').trim() === '').length;
}
