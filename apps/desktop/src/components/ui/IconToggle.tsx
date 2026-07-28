import { cn } from '@/lib/utils';

interface IconToggleProps {
  on: boolean;
  onClick: () => void;
  /** The accessible name and the tooltip. Say what pressing it will do, not
   * what the current state is — "Hide details" while details are showing. */
  label: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * A single on/off icon button for a toolbar.
 *
 * Separate from `Segmented` because the semantics differ: a segmented control
 * is one-of-several and always has a selection, while this is a thing that is
 * either on or off. Rendering the second as a one-option group would report the
 * wrong shape to a screen reader.
 */
export function IconToggle({
  on,
  onClick,
  label,
  children,
  className,
}: IconToggleProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={label}
      aria-label={label}
      className={cn(
        'border-border rounded-md border p-1 transition-colors duration-150',
        on
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:text-foreground',
        className
      )}
    >
      {children}
    </button>
  );
}
