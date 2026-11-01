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

/** The 28px icon button every header and rail uses (T3 Code's ghost icon button): a
 * rounded square, transparent at rest, the neutral accent fill on hover, a 16px icon. A real `<button>` unless `render` names another element. */
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
        "inline-flex size-7 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-[background-color,color,scale] duration-100 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:scale-[0.97] disabled:pointer-events-none disabled:opacity-64 aria-pressed:bg-accent [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
        filled &&
          'bg-secondary text-(--text-secondary) hover:bg-surface-active',
        active && 'text-foreground',
        className
      )}
      {...props}
    />
  );
}
