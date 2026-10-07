import { Button as ButtonPrimitive } from '@base-ui/react/button';

import { cn } from '../lib/utils';

/** The 20px dense row inside a card (a graph node's open tasks): bleeds 4px each side so its
 * text lines up with the card's, takes the control fill on hover and sits above a stretched card link. */
export function RowButton({ className, ...props }: ButtonPrimitive.Props) {
  return (
    <ButtonPrimitive
      data-slot="row-button"
      className={cn(
        "relative z-10 -mx-1 flex h-5 w-[calc(100%+8px)] min-w-0 items-center gap-1.5 rounded-control px-1 text-left text-[12px] transition-colors duration-100 outline-none hover:bg-surface-control focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3",
        className
      )}
      {...props}
    />
  );
}
