import type {
  OverseerPendingQuestion,
  OverseerQuestion,
  OverseerQuestionReply,
} from '@dispatch/client';
import { Button, Checkbox, Chip, TextField } from '@dispatch/ui';
import { useState } from 'react';

import { DecisionCard } from '../gates/DecisionCard';
import styles from './OverseerQuestionCard.module.css';

// The radio id of a single-choice question's "Other" answer.
const OTHER = '__other__';

/** What the human has picked or typed for one question so far. */
interface Draft {
  /** The chosen labels: one for a single choice, any number for several. */
  picked: string[];
  /** "Other" is picked, with `other` as its text. */
  otherOn: boolean;
  other: string;
}

const EMPTY: Draft = { picked: [], otherOn: false, other: '' };

/**
 * The answer a draft gives, as text: the picked labels joined, with the typed
 * "Other" last. Empty when the question has no answer yet (Other picked but
 * still blank counts as none).
 */
export function draftAnswer(draft: Draft): string {
  const other = draft.otherOn ? draft.other.trim() : '';
  if (draft.otherOn && other === '') return '';
  return [...draft.picked, ...(other === '' ? [] : [other])].join(', ');
}

export interface OverseerQuestionCardProps {
  pending: OverseerPendingQuestion;
  /** Some answer or decision is in flight; the card locks. */
  locked: boolean;
  /** Sends every reply; resolves true once they went out. */
  onAnswer: (replies: OverseerQuestionReply[]) => Promise<boolean>;
}

/**
 * An AskUserQuestion call the Overseer's turn waits on, answered in place: one
 * DecisionCard per question, its options as radios (one answer) or
 * checkboxes (several), and an Other answer in the human's own words. Nothing
 * here is a permission. Send answers replies to each question's bus message,
 * so Needs you shows the same questions and an answer there lands here too: a
 * question answered elsewhere shows its answer instead of its options.
 */
export function OverseerQuestionCard({
  pending,
  locked,
  onAnswer,
}: OverseerQuestionCardProps) {
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const draftOf = (index: number): Draft => drafts[index] ?? EMPTY;
  const update = (index: number, next: Partial<Draft>) =>
    setDrafts((prev) => ({
      ...prev,
      [index]: { ...(prev[index] ?? EMPTY), ...next },
    }));

  const open = pending.questions
    .map((question, index) => ({ question, index }))
    .filter(({ question }) => pending.answers[question.question] === undefined);
  const ready =
    open.length > 0 &&
    open.every(({ index }) => draftAnswer(draftOf(index)) !== '');

  async function send() {
    if (!ready || locked) return;
    await onAnswer(
      open.map(({ index }) => ({ index, body: draftAnswer(draftOf(index)) }))
    );
  }

  return (
    <div data-testid="overseer-question" className={styles.stack}>
      {pending.questions.map((question, index) => (
        <QuestionPart
          key={`${pending.requestId}-${index}`}
          question={question}
          answered={pending.answers[question.question]}
          draft={draftOf(index)}
          disabled={locked}
          onChange={(next) => update(index, next)}
        />
      ))}
      {open.length > 0 && (
        <div className={styles.actions}>
          <Button
            size="sm"
            disabled={!ready}
            busy={locked}
            onClick={() => void send()}
          >
            {open.length === 1 ? 'Send answer' : 'Send answers'}
          </Button>
        </div>
      )}
    </div>
  );
}

// One question of the call: answered (its answer), one choice, or several.
function QuestionPart({
  question,
  answered,
  draft,
  disabled,
  onChange,
}: {
  question: OverseerQuestion;
  answered: string | undefined;
  draft: Draft;
  disabled: boolean;
  onChange: (next: Partial<Draft>) => void;
}) {
  const detail =
    question.header.trim() === '' ? undefined : <Chip>{question.header}</Chip>;
  if (answered !== undefined) {
    return (
      <DecisionCard
        tone="warning"
        question={question.question}
        detail={detail}
        disabled
        data-slot="overseer-question-part"
      >
        <p className={styles.answered}>Answered — {answered}</p>
      </DecisionCard>
    );
  }
  const otherField = draft.otherOn && (
    <TextField
      size="sm"
      aria-label={`Your answer to: ${question.question}`}
      placeholder="Type your answer"
      value={draft.other}
      disabled={disabled}
      onChange={(e) => onChange({ other: e.target.value })}
    />
  );
  if (!question.multiSelect) {
    const selectedId = draft.otherOn ? OTHER : draft.picked[0];
    return (
      <DecisionCard
        tone="warning"
        question={question.question}
        detail={detail}
        options={[
          ...question.options.map((o) => ({
            id: o.label,
            label: o.label,
            ...(o.description !== '' ? { description: o.description } : {}),
          })),
          { id: OTHER, label: 'Other', description: 'Answer in your words' },
        ]}
        selectedId={selectedId}
        onSelect={(id) =>
          onChange(
            id === OTHER
              ? { picked: [], otherOn: true }
              : { picked: [id], otherOn: false }
          )
        }
        disabled={disabled}
        answered={false}
        data-slot="overseer-question-part"
      >
        {otherField}
      </DecisionCard>
    );
  }
  const toggle = (label: string, on: boolean) =>
    onChange({
      picked: on
        ? [...draft.picked.filter((l) => l !== label), label]
        : draft.picked.filter((l) => l !== label),
    });
  return (
    <DecisionCard
      tone="warning"
      question={question.question}
      detail={detail}
      disabled={disabled}
      answered={false}
      data-slot="overseer-question-part"
    >
      <div
        role="group"
        aria-label={question.question}
        className={styles.checks}
      >
        {question.options.map((o) => (
          <Checkbox
            key={o.label}
            label={o.label}
            {...(o.description !== '' ? { note: o.description } : {})}
            checked={draft.picked.includes(o.label)}
            disabled={disabled}
            onChange={(on) => toggle(o.label, on)}
          />
        ))}
        <Checkbox
          label="Other"
          note="Answer in your words"
          checked={draft.otherOn}
          disabled={disabled}
          onChange={(on) => onChange({ otherOn: on })}
        />
      </div>
      {otherField}
    </DecisionCard>
  );
}
