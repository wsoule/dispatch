import type { KeyboardEvent } from 'react';

import { focusRovingItem, nextRovingIndex } from '../lib/roving';
import { cn } from '../lib/utils';

export type InlineSegmentedOption<T extends string> = {
  id: T;
  label: string;
};

export type InlineSegmentedProps<T extends string> = {
  options: readonly InlineSegmentedOption<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Accessible name for the group. */
  label: string;
  className?: string;
};

/** The one-line, text-only `SegmentedControl`: 24px cells in a half-pixel ring, for a
 * toolbar or composer row (People | All, Message | Question | Notice). A radiogroup with a
 * single tab stop; arrows/Home/End move the selection. */
export function InlineSegmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: InlineSegmentedProps<T>) {
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
      data-slot="inline-segmented"
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-0.5 rounded-control border-[0.5px] border-border-chip bg-surface-secondary p-0.5',
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
              'h-full rounded-[6px] px-2 text-[12px] font-medium whitespace-nowrap transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-surface-active text-foreground'
                : 'text-muted-foreground hover:text-(--text-secondary)'
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
