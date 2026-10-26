'use client';

import { Popover as PopoverPrimitive } from '@base-ui/react/popover';

import { cn } from './lib/utils';

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

// Renders a `<button>` unless `render` names the element to become
// (`<PopoverTrigger render={<Button … />}>…</PopoverTrigger>`).
function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

// `anchor` lets a popover open against an element that is not its trigger
// (the prompt bar's slash-command list anchors to the textarea) — Base UI's
// replacement for radix's `Popover.Anchor` part. Focus movement is the
// Popup's own `initialFocus`/`finalFocus`, passed straight through.
function PopoverContent({
  className,
  align = 'center',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 6,
  anchor,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    'align' | 'alignOffset' | 'side' | 'sideOffset' | 'anchor'
  >) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        anchor={anchor}
        className="isolate z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            'z-50 w-72 origin-(--transform-origin) rounded-popover bg-popover p-2 text-popover-foreground shadow-overlay transition-[opacity,scale] duration-100 outline-hidden data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0',
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverContent, PopoverTrigger };
