import {
  Chip,
  cx,
  type DataAttributes,
  RadioGroup,
  type UiTone,
} from '@dispatch/ui';
import { Check, MessageCircleQuestion } from 'lucide-react';
import { type ReactNode, useId } from 'react';

import styles from './DecisionCard.module.css';

/** One answer a DecisionCard offers. */
type DecisionOption = {
  id: string;
  /** The radio's name: unit tests and e2e specs click it ("Approve"). */
  label: string;
  /** A quiet line under the label, read as the radio's description. */
  description?: ReactNode;
  /** Carries an accent "Recommended" chip, part of the radio's name. */
  recommended?: boolean;
  disabled?: boolean;
};

/** The props of DecisionCard, the answer-in-place card for an agent's ask. */
export type DecisionCardProps = {
  /** The ask. It may be pre-rendered Markdown blocks, so it sits in a div;
   * it names the answers' radiogroup. */
  question: ReactNode;
  /** A line under the question (the tool's name, a path). */
  detail?: ReactNode;
  /** Replaces the leading question mark. */
  icon?: ReactNode;
  /** Tints the card (the Overseer's in-chat asks, a plan's questions). */
  tone?: UiTone;
  /** The answers, as boxed radio rows; none renders no group. */
  options?: readonly DecisionOption[];
  selectedId?: string;
  /** An answer was picked: a click, Space or Enter (an arrow key only
   * moves between the answers). Picking the selected one again calls it
   * again. */
  onSelect?: (id: string) => void;
  /** Buttons in a right-aligned row at the end of the card. */
  actions?: ReactNode;
  /** No answer can be picked (it was answered, or this window cannot). */
  disabled?: boolean;
  /** Whether the selected answer has gone out: the line under the answers
   * reads "Answered — X" rather than "Selected — X". Defaults to
   * `disabled`, since a card is usually disabled because it was answered;
   * a host that disables it for another reason (a denial whose reason is
   * still being written) passes false. */
  answered?: boolean;
  /** Under the answers: input previews, paths, the notice that deciding is
   * unavailable, errors. */
  children?: ReactNode;
  className?: string;
} & DataAttributes;

/**
 * The card an agent's ask is answered in, wherever it parks (a run's
 * approval, a question, a scope request, a doc or memory gate, a plan
 * question, an Overseer ask): a question-mark heading in 12px medium
 * sentence case with a detail line, the answers as RadioGroup cards, a
 * confirmation line once one is picked, then the host's notices and
 * actions. The answers move by arrow key without picking (manual
 * activation), so arrowing past "Approve" never approves. A tone tints the
 * card (`--tone-soft` under a `--tone-line` edge) and its heading takes the
 * tone's ink; the rest of the words stay `--text`. A host's data-* hooks
 * (its `data-slot`) land on the root.
 */
export function DecisionCard({
  question,
  detail,
  icon,
  tone,
  options,
  selectedId,
  onSelect,
  actions,
  disabled = false,
  answered = disabled,
  children,
  className,
  ...data
}: DecisionCardProps) {
  const questionId = useId();
  const toned = tone !== undefined && tone !== 'default';
  const selected = options?.find((option) => option.id === selectedId);
  return (
    <div
      {...data}
      className={cx(styles.card, toned ? styles.toned : undefined, className)}
      data-tone={toned ? tone : undefined}
    >
      <div className={styles.head}>
        <span className={styles.icon}>
          {icon ?? (
            <MessageCircleQuestion size={14} strokeWidth={1.8} aria-hidden />
          )}
        </span>
        <div className={styles.heading}>
          <div id={questionId} className={styles.question}>
            {question}
          </div>
          {detail === undefined ? null : (
            <div className={styles.detail}>{detail}</div>
          )}
        </div>
      </div>
      {options !== undefined && options.length > 0 ? (
        <RadioGroup
          variant="cards"
          activation="manual"
          aria-labelledby={questionId}
          value={selectedId ?? null}
          onChange={(id) => {
            if (!disabled) onSelect?.(id);
          }}
          options={options.map((option) => ({
            value: option.id,
            label: option.label,
            hint: option.description,
            badge:
              option.recommended === true ? (
                <Chip tone="accent">Recommended</Chip>
              ) : undefined,
            disabled: disabled || option.disabled === true,
          }))}
        />
      ) : null}
      {selected === undefined ? null : (
        <div className={styles.confirm}>
          <span className={styles.check} data-tone="success">
            <Check size={14} strokeWidth={1.8} aria-hidden />
          </span>
          <span>
            {`${answered ? 'Answered' : 'Selected'} — `}
            <strong className={styles.choice}>{selected.label}</strong>
          </span>
        </div>
      )}
      {children}
      {actions === undefined ? null : (
        <div className={styles.actions}>{actions}</div>
      )}
    </div>
  );
}
