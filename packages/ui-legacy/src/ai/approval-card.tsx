import { CheckIcon, MessageCircleQuestionIcon } from 'lucide-react';
import { type ReactNode, useId } from 'react';

import { cn } from '../lib/utils';

export type ApprovalCardOption = {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
};

export type ApprovalCardProps = {
  /** The agent's question. A plain string renders as before; a node (e.g. agent-authored
   * text pre-rendered through the `Markdown` component) drops in as-is — the primitive
   * stays presentational and just renders whatever it's given. */
  question: ReactNode;
  detail?: ReactNode;
  options: ApprovalCardOption[];
  onSelect: (id: string) => void;
  selectedId?: string;
  disabled?: boolean;
  /** Merged over the card frame's own classes. The default keeps the gallery's `max-w-sm`;
   * full-width surfaces (transcript, inbox) pass `max-w-none` to lift it. */
  className?: string;
};

// One radio-style option row: a 0.5px chip ring on the quaternary card, a neutral wash
// when hovered or selected — never the accent. A plain `<button>` carries the keyboard
// behavior for free; `role="radio"` only changes what assistive tech announces.
function OptionRow({
  option,
  selected,
  disabled,
  onSelect,
}: {
  option: ApprovalCardOption;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex items-start gap-2.5 rounded-control border-[0.5px] border-border-chip px-3 py-2 text-left transition-colors duration-100 outline-none disabled:pointer-events-none disabled:opacity-60',
        selected ? 'bg-surface-active' : 'hover:bg-surface-hover'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border-[0.5px] transition-colors duration-100',
          selected ? 'border-primary' : 'border-(--border-strong)'
        )}
      >
        <span
          className={cn(
            'size-1.5 rounded-full bg-primary transition-transform duration-100 motion-reduce:transition-none',
            selected ? 'scale-100' : 'scale-0'
          )}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-foreground text-[13px] font-medium">
            {option.label}
          </span>
          {option.recommended === true && (
            <span className="text-primary shrink-0 text-[11px] font-medium">
              Recommended
            </span>
          )}
        </span>
        {option.description !== undefined && (
          <span className="font-book text-muted-foreground mt-0.5 block text-[12px] leading-4">
            {option.description}
          </span>
        )}
      </span>
    </button>
  );
}

/** Human-in-the-loop question card on the Linear card grammar — a quaternary surface with
 * the half-pixel ring, 12px padding, 13px/500 question, 12px muted detail — with
 * radio-style option rows (chip ring, neutral hover and selected wash, an optional
 * "Recommended" tag) and a confirmation line once an option is picked. Fully controlled —
 * `selectedId` and `onSelect` live with the caller — so it also covers the disabled
 * "answered" state once a decision has already been made. Backs ApprovalCard/
 * QuestionCard/ScopeRequestCard. */
export function ApprovalCard({
  question,
  detail,
  options,
  onSelect,
  selectedId,
  disabled = false,
  className,
}: ApprovalCardProps) {
  const selectedOption = options.find((option) => option.id === selectedId);
  // `question` may be a rendered node rather than a string, so the radio group points at the
  // question element instead of duplicating its text into an `aria-label`.
  const questionId = useId();

  return (
    <div
      data-slot="approval-card"
      className={cn(
        'flex w-full max-w-sm flex-col gap-3 rounded-card bg-surface-quaternary p-3 shadow-card',
        className
      )}
    >
      <div className="flex items-start gap-2.5">
        <MessageCircleQuestionIcon
          aria-hidden
          className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
        />
        <div className="min-w-0 flex-1">
          {/* divs, not <p>s: a pre-rendered Markdown `question`/`detail` contains its own
              block elements, which are invalid inside a paragraph. */}
          <div
            id={questionId}
            className="text-foreground text-[13px] font-medium text-pretty"
          >
            {question}
          </div>
          {detail !== undefined && (
            <div className="font-book text-muted-foreground mt-1 text-[12px] leading-4">
              {detail}
            </div>
          )}
        </div>
      </div>

      {options.length > 0 && (
        <div
          role="radiogroup"
          aria-labelledby={questionId}
          className="flex flex-col gap-1"
        >
          {options.map((option) => (
            <OptionRow
              key={option.id}
              option={option}
              selected={option.id === selectedId}
              disabled={disabled}
              onSelect={() => onSelect(option.id)}
            />
          ))}
        </div>
      )}

      {selectedOption && (
        <div className="shadow-hairline-top flex items-center gap-2 pt-2">
          <CheckIcon
            aria-hidden
            className="text-status-green size-3.5 shrink-0"
          />
          <span className="font-book text-foreground text-[12px]">
            {disabled ? 'Answered — ' : 'Selected — '}
            <span className="font-medium">{selectedOption.label}</span>
          </span>
        </div>
      )}
    </div>
  );
}
