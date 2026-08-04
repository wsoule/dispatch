import { cn } from '@/lib/utils';

export interface SegmentedOption<T extends string> {
  value: T;
  /** Always shown, and used as the accessible name. */
  label: string;
  /** Shown beside the label; the label collapses to sr-only under `sm`. */
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
 * Icon options show their label too, collapsing to sr-only under `sm` so a
 * toolbar cannot clip while the accessible name stays intact at every width.
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
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex items-center gap-1.5 rounded-[5px] px-2 py-0.5 transition-colors duration-150',
              active
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option.icon}
            <span
              className={cn(
                'whitespace-nowrap',
                option.icon !== undefined && 'max-sm:sr-only'
              )}
            >
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
