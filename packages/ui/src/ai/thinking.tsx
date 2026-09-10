import {
  BrainIcon,
  ChevronDownIcon,
  CircleIcon,
  CodeIcon,
  type LucideIcon,
  SearchIcon,
} from 'lucide-react';
import { useId } from 'react';

import { ShimmerLabel } from './shimmer';

export type ThinkingStep = {
  kind: 'reasoning' | 'search' | 'coding' | 'step';
  label: string;
  detail?: string;
  state: 'done' | 'active' | 'pending';
};

export type ThinkingProps = {
  steps: ThinkingStep[];
  collapsed: boolean;
  onToggle: () => void;
  elapsedLabel?: string;
};

const KIND_ICONS: Record<ThinkingStep['kind'], LucideIcon> = {
  reasoning: BrainIcon,
  search: SearchIcon,
  coding: CodeIcon,
  step: CircleIcon,
};

// The showcase's four-point spark mark that leads the header chip — a bespoke glyph
// (not a lucide icon), ported verbatim from bui.html's ThinkingState source.
function SparkGlyph({ className }: { className: string }) {
  return (
    <svg
      aria-hidden
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={`shrink-0 ${className}`}
    >
      <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
    </svg>
  );
}

// One row in the expanded trace: a kind icon, the step label (shimmering while
// active), and an optional detail line. Done/pending rows are muted so the active
// step reads as the current focus.
function ThinkingRow({ step }: { step: ThinkingStep }) {
  const Icon = KIND_ICONS[step.kind];
  const isActive = step.state === 'active';
  const isDone = step.state === 'done';
  const textTone = isActive
    ? 'text-foreground'
    : isDone
      ? 'text-muted-foreground'
      : 'text-muted-foreground/50';

  return (
    <div className="flex min-h-6 items-start gap-2 px-1.5 py-0.5">
      <Icon aria-hidden className={`mt-0.5 size-3.5 shrink-0 ${textTone}`} />
      <div className="min-w-0">
        {isActive ? (
          <ShimmerLabel className="text-[12.5px] font-medium">
            {step.label}
          </ShimmerLabel>
        ) : (
          <span className={`text-[12.5px] font-medium ${textTone}`}>
            {step.label}
          </span>
        )}
        {step.detail && (
          <p className={`mt-0.5 text-[11.5px] ${textTone}`}>{step.detail}</p>
        )}
      </div>
    </div>
  );
}

/** Expandable agent trace: a muted chip (shimmering while any step is active)
 * collapses into a chevron-toggled step list — icon per step kind, a connecting
 * hairline down the left rail, done steps muted, the active step shimmering.
 * Fully controlled: `collapsed` and `onToggle` live with the caller. Matches the
 * showcase's "Thinking" primitive. */
export function Thinking({
  steps,
  collapsed,
  onToggle,
  elapsedLabel,
}: ThinkingProps) {
  const contentId = useId();
  const isActive = steps.some((step) => step.state === 'active');

  return (
    <div className="flex w-fit min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={contentId}
        onClick={onToggle}
        className="rounded-chip bg-muted hover:bg-surface-hover-strong ease-out-expo -mx-1.5 flex w-fit items-center gap-2 px-1.5 py-1 transition-colors duration-100"
      >
        <SparkGlyph
          className={isActive ? 'text-foreground' : 'text-muted-foreground'}
        />
        {isActive ? (
          <ShimmerLabel className="text-[13px] font-medium whitespace-nowrap">
            Thinking
          </ShimmerLabel>
        ) : (
          <span className="text-muted-foreground text-[13px] font-medium whitespace-nowrap">
            Thought
          </span>
        )}
        {elapsedLabel && (
          <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
            {elapsedLabel}
          </span>
        )}
        <ChevronDownIcon
          className={`text-muted-foreground ease-out-expo size-3.5 shrink-0 transition-transform duration-300 motion-reduce:transition-none ${collapsed ? '' : 'rotate-180'}`}
        />
      </button>

      <div
        id={contentId}
        className={`ease-out-expo grid transition-[grid-template-rows,opacity] duration-300 motion-reduce:transition-none ${collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'}`}
      >
        <div className="overflow-hidden">
          <div className="relative mt-1 ml-[5px] pl-4">
            {steps.length > 1 && (
              <span
                aria-hidden
                className="bg-border absolute top-0 bottom-0 left-[3px] w-px"
              />
            )}
            <div className="flex flex-col gap-1 py-1">
              {steps.map((step, index) => (
                <ThinkingRow key={`${step.kind}-${index}`} step={step} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
