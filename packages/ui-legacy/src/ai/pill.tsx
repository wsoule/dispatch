import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { ChevronDownIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/utils';

/** A 24px read-only chip — label pills, project chips, due-date chips on rows and
 * cards. Quaternary surface with a half-pixel chip ring; no hover. */
export function Pill({
  className,
  children,
  ...props
}: ComponentProps<'span'>) {
  return (
    <span
      data-slot="pill"
      className={cn(
        "inline-flex h-6 max-w-full shrink-0 items-center gap-1.5 rounded-pill border-[0.5px] border-border-chip bg-surface-quaternary px-2 text-[12px] font-medium whitespace-nowrap text-(--text-secondary) [&_svg:not([class*='size-'])]:size-3 [&_svg]:shrink-0",
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}

/** A `Pill` led by an 8px colour dot — the label chip. `color` is any CSS colour. */
export function LabelPill({
  color,
  children,
  ...props
}: ComponentProps<'span'> & { color: string }) {
  return (
    <Pill data-slot="label-pill" {...props}>
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="min-w-0 truncate">{children}</span>
    </Pill>
  );
}

/** The 28px pill-button recipe, shared with `SelectTrigger` so a select and a
 * `SelectPill` are literally the same control. */
export const PILL_BUTTON_CLASS =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-pill border-[0.5px] border-border-chip bg-surface-control px-2.5 text-[12px] font-medium whitespace-nowrap text-(--text-secondary) transition-colors duration-100 outline-none hover:bg-surface-active disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:shrink-0";

/** The 28px secondary button: a pill on the control surface. A real `<button>` unless
 * `render` names another element. */
export function PillButton({ className, ...props }: ButtonPrimitive.Props) {
  return (
    <ButtonPrimitive
      data-slot="pill-button"
      className={cn(PILL_BUTTON_CLASS, className)}
      {...props}
    />
  );
}

/** A `PillButton` with a trailing 12px chevron — the face of a menu or popover. Pass
 * it as a Base UI trigger's `render` (`<DropdownMenuTrigger render={<SelectPill />}>`,
 * `<PopoverTrigger render={<SelectPill />}>`) and the trigger's props merge onto it.
 * `SelectTrigger` is already this pill and draws its own chevron, so do not wrap it. */
export function SelectPill({
  className,
  children,
  icon,
  ...props
}: ComponentProps<'button'> & { icon?: ReactNode }) {
  return (
    <button
      type="button"
      data-slot="select-pill"
      className={cn(PILL_BUTTON_CLASS, className)}
      {...props}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      <ChevronDownIcon
        aria-hidden
        className="text-muted-foreground size-3"
        strokeWidth={2}
      />
    </button>
  );
}
