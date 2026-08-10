import { cn } from '@/lib/utils';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';

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
 *
 * Built on radix ToggleGroup so roving focus and single-selection semantics
 * come from the primitive rather than being hand-rolled here.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: SegmentedProps<T>) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      // A segmented control always has a selection; ignore radix's deselect.
      onValueChange={(next) => next !== '' && onChange(next as T)}
      aria-label={label}
      // Non-zero spacing opts out of ToggleGroupItem's joined-pill corner
      // trimming (data-[spacing=0]:rounded-*), which would otherwise square
      // off the middle items' corners; the actual gap is set via className.
      spacing={1}
      className={cn(
        'border-border flex items-center gap-0.5 rounded-md border p-0.5',
        className
      )}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          title={option.label}
          className={cn(
            'flex h-auto items-center gap-1.5 rounded-[5px] px-2 py-0.5 transition-colors duration-150',
            'data-[state=on]:bg-accent data-[state=on]:text-accent-foreground',
            'text-muted-foreground hover:bg-transparent hover:text-foreground'
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
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
