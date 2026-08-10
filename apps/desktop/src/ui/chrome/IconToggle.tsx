import { cn } from '@/lib/utils';
import { Toggle } from '@/ui/toggle';

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
 *
 * Built on radix Toggle, which keeps the plain button/aria-pressed semantics
 * this already relied on (unlike ToggleGroupItem, which reports radio/aria-checked).
 */
export function IconToggle({
  on,
  onClick,
  label,
  children,
  className,
}: IconToggleProps) {
  return (
    <Toggle
      pressed={on}
      onPressedChange={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'border-border h-auto min-w-0 rounded-md border p-1 transition-colors duration-150',
        // toggleVariants sets text-sm/font-medium; the old markup had no size
        // class (icon-only today, but keep future text children un-shifted).
        'text-[length:inherit] font-[weight:inherit]',
        'text-muted-foreground hover:bg-transparent hover:text-foreground',
        className
      )}
    >
      {children}
    </Toggle>
  );
}
