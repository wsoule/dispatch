'use client';

import { Dialog as SheetPrimitive } from '@base-ui/react/dialog';

import { cn } from './lib/utils';

/**
 * A `Sheet` that docks inside a positioned container instead of covering the window: no
 * backdrop, the page around it stays clickable, and it is portalled into `container` so the
 * caller places it with `absolute` classes. Focus is trapped inside while it is open; Escape
 * or a `SheetClose` inside asks `onOpenChange(false)`.
 */
function SheetPanel({
  open = true,
  onOpenChange,
  container,
  className,
  ...props
}: SheetPrimitive.Popup.Props & {
  open?: boolean;
  onOpenChange: (open: boolean) => void;
  /** The positioned element the panel renders into. */
  container: HTMLElement;
}) {
  return (
    <SheetPrimitive.Root
      open={open}
      onOpenChange={(next) => onOpenChange(next)}
      modal="trap-focus"
      disablePointerDismissal
    >
      <SheetPrimitive.Portal container={container}>
        <SheetPrimitive.Popup
          data-slot="sheet-panel"
          className={cn(
            'pointer-events-auto absolute flex flex-col bg-background outline-none transition-[translate,opacity] duration-150 ease-out data-ending-style:translate-x-2 data-ending-style:opacity-0 data-starting-style:translate-x-2 data-starting-style:opacity-0',
            className
          )}
          {...props}
        />
      </SheetPrimitive.Portal>
    </SheetPrimitive.Root>
  );
}

export { SheetPanel };
