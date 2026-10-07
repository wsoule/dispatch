import { Button as ButtonPrimitive } from '@base-ui/react/button';

import { cn } from '../lib/utils';

export type TextButtonProps = ButtonPrimitive.Props & {
  /** Stretch the hit area over the nearest positioned ancestor (a whole card), ringing it on focus. */
  stretch?: boolean;
};

/** A bare text button: inherits the surrounding type and colour, underlines on hover, and
 * takes the shared focus ring. For a crumb segment or a card title that opens something. */
export function TextButton({
  stretch = false,
  className,
  ...props
}: TextButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="text-button"
      data-stretch={stretch || undefined}
      className={cn(
        'min-w-0 truncate rounded-control text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
        stretch &&
          'after:absolute after:inset-0 after:rounded-card hover:no-underline focus-visible:ring-0 focus-visible:after:ring-2 focus-visible:after:ring-ring',
        className
      )}
      {...props}
    />
  );
}
