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

// One radio-style option row. A plain `<button>` carries the keyboard behavior for free —
// focusable by default, Enter/Space fires `onClick` — so there's no custom key handler to
// test; `role="radio"` layered on top only changes what assistive tech announces.
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
      className={`ease-out-expo rounded-control flex items-start gap-2.5 border px-3 py-2.5 text-left transition-colors duration-100 disabled:pointer-events-none disabled:opacity-60 ${
        selected
          ? 'bg-accent-tint border-[var(--border-selected)] ring-1 ring-[var(--border-selected)]'
          : 'hover:bg-surface-hover border-transparent'
      }`}
    >
      <span
        aria-hidden
        className={`ease-out-expo mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-150 ${
          selected ? 'border-[var(--border-selected)]' : 'border-border'
        }`}
      >
        <span
          className={`ease-out-expo size-1.5 rounded-full bg-[var(--border-selected)] transition-transform duration-150 motion-reduce:transition-none ${
            selected ? 'scale-100' : 'scale-0'
          }`}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-foreground text-[13px] font-medium">
            {option.label}
          </span>
          {option.recommended === true && (
            <span className="rounded-chip bg-accent-tint text-primary shrink-0 px-1.5 py-0.5 text-[11px] font-medium">
              Recommended
            </span>
          )}
        </span>
        {option.description !== undefined && (
          <span className="text-muted-foreground mt-0.5 block text-[12px] leading-relaxed">
            {option.description}
          </span>
        )}
      </span>
    </button>
  );
}

/** Human-in-the-loop question card: an agent's question with icon and optional detail,
 * radio-style option rows (hover, selected wash + ring, an optional "Recommended" chip),
 * and a confirmation row that appears once an option is picked. Fully controlled —
 * `selectedId` and `onSelect` live with the caller — so it also covers the disabled
 * "answered" state once a decision has already been made. Matches the showcase's
 * "Approval Card" primitive, adapted to a single-question options model so it can back
 * ApprovalCard/QuestionCard/ScopeRequestCard. */
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
      className={cn(
        'bg-card rounded-card shadow-card w-full max-w-sm overflow-hidden',
        className
      )}
    >
      <div className="flex items-start gap-2.5 px-4 pt-4 pb-3">
        <span className="bg-accent-tint text-primary flex size-7 shrink-0 items-center justify-center rounded-full">
          <MessageCircleQuestionIcon aria-hidden className="size-4" />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          {/* divs, not <p>s: a pre-rendered Markdown `question`/`detail` contains its own
              block elements, which are invalid inside a paragraph. */}
          <div
            id={questionId}
            className="text-foreground text-[13px] font-medium text-pretty"
          >
            {question}
          </div>
          {detail !== undefined && (
            <div className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">
              {detail}
            </div>
          )}
        </div>
      </div>

      <div
        role="radiogroup"
        aria-labelledby={questionId}
        className="flex flex-col gap-1 px-2 pb-2"
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

      {selectedOption && (
        <div className="border-border bg-muted/40 flex items-center gap-2 border-t px-4 py-2.5">
          <CheckIcon aria-hidden className="text-primary size-3.5 shrink-0" />
          <span className="text-foreground text-[12.5px]">
            {disabled ? 'Answered — ' : 'Selected — '}
            <span className="font-medium">{selectedOption.label}</span>
          </span>
        </div>
      )}
    </div>
  );
}
