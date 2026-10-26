import { Button as ButtonPrimitive } from '@base-ui/react/button';

import { cn } from '../lib/utils';

export type IconButtonProps = ButtonPrimitive.Props & {
  /** Accessible name — an icon button has no visible text. */
  label: string;
  /** Rests on `bg-surface-control` instead of transparent (the sidebar's new-issue button). */
  filled?: boolean;
  /** Bright icon: the control is toggled on (a starred view, a non-default Display). */
  active?: boolean;
};

/** The 28px round icon button every header and rail uses: transparent at rest, a control
 * fill on hover, a 14px icon. A real `<button>` unless `render` names another element. */
export function IconButton({
  label,
  filled = false,
  active = false,
  className,
  ...props
}: IconButtonProps) {
  return (
    <ButtonPrimitive
      aria-label={label}
      data-slot="icon-button"
      data-filled={filled || undefined}
      data-active={active || undefined}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-pill text-muted-foreground transition-colors duration-100 outline-none hover:bg-surface-control hover:text-(--text-secondary) disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:shrink-0",
        filled &&
          'bg-surface-control text-(--text-secondary) hover:bg-surface-active',
        active && 'text-foreground',
        className
      )}
      {...props}
    />
  );
}
