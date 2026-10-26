import type { KeyboardEvent, ReactNode } from 'react';

import { focusRovingItem, nextRovingIndex } from '../lib/roving';
import { cn } from '../lib/utils';

export type SegmentedOption = {
  id: string;
  label: string;
  icon?: ReactNode;
};

export type SegmentedControlProps = {
  options: SegmentedOption[];
  value: string;
  onChange: (id: string) => void;
  /** Accessible name for the group. */
  label: string;
  className?: string;
};

/** The List | Board switch at the top of the Display popover: equal cells inside one
 * half-pixel ring, icon above label, the active cell lifted onto `bg-surface-active`. A
 * radiogroup, so a screen reader hears one choice rather than N buttons — and like a
 * radio group it is one tab stop, with arrows/Home/End moving the selection. */
export function SegmentedControl({
  options,
  value,
  onChange,
  label,
  className,
}: SegmentedControlProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = options.findIndex((option) => option.id === value);
    const next = nextRovingIndex(event.key, current, options.length);
    if (next === null) return;
    event.preventDefault();
    onChange(options[next].id);
    focusRovingItem(event.currentTarget, '[role="radio"]', next);
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-slot="segmented"
      className={cn(
        'grid auto-cols-fr grid-flow-col gap-0.5 rounded-control border-[0.5px] border-border-chip bg-surface-secondary p-0.5',
        className
      )}
      onKeyDown={handleKeyDown}
    >
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            data-active={active || undefined}
            onClick={() => onChange(option.id)}
            className={cn(
              'flex min-h-12 flex-col items-center justify-center gap-1 rounded-[6px] px-2 text-[12px] font-medium transition-colors duration-100 outline-none [&_svg]:size-3.5 [&_svg]:shrink-0',
              active
                ? 'bg-surface-active text-foreground'
                : 'text-muted-foreground hover:text-(--text-secondary)'
            )}
          >
            {option.icon}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
