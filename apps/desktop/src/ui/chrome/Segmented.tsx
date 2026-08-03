import { cn } from '@/lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  /** Shown when there is no icon, and used as the accessible name either way. */
  label: string;
  /** An icon renders instead of the label, with the label kept for a11y. */
  icon?: React.ReactNode;
}

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (next: T) => void;
  options: SegmentedOption<T>[];
  /** Names the group for screen readers, e.g. "View" or "Run tab". */
  label: string;
  className?: string;
}

/**
 * A small exclusive switch: pick one of two or three, in place, on a toolbar row.
 *
 * Exists because the same control had been hand-rolled in several views with
 * the same six utility classes copied each time, and they had already drifted —
 * one padded its buttons differently, another used a different active colour.
 * A switch is the kind of thing where drift is invisible per-screen and obvious
 * once you move between them.
 *
 * Icon options keep their label as the accessible name rather than dropping it,
 * so an icon-only group is still navigable by anyone not looking at it.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'border-border flex items-center gap-0.5 rounded-md border p-0.5',
        className
      )}
    >
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            title={option.label}
            aria-label={option.icon === undefined ? undefined : option.label}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-[5px] transition-colors duration-150',
              option.icon === undefined ? 'px-2 py-0.5 text-[11.5px]' : 'p-1',
              active
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option.icon ?? option.label}
          </button>
        );
      })}
    </div>
  );
}
