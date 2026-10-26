'use client';

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { Maximize2Icon, XIcon } from 'lucide-react';
import * as React from 'react';

import { IconButton } from './ai/icon-button';
import { Button } from './button';
import { cn } from './lib/utils';

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

// Base UI drives enter/exit through `data-starting-style`/`data-ending-style`
// on the element, so the animation is a plain CSS transition between those
// states rather than the keyframe pair radix's `data-state` used to trigger.
function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-[var(--overlay)] transition-opacity duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0',
        className
      )}
      {...props}
    />
  );
}

const FOCUSABLE_SELECTOR =
  'input, textarea, select, button, a[href], [tabindex]';
const CHROME_SELECTOR =
  '[data-slot="dialog-chrome"], [data-slot="dialog-corner-close"]';

// Where a dialog's focus lands when it opens: the first field or control in its body,
// skipping the chrome row's Expand/Close and the corner close that Base UI's own
// "first tabbable" rule would pick — so `c` opens the creator with the caret in the title,
// not a ring on `×`. A dialog with nothing but chrome (the shortcuts reference) focuses
// the popup itself, which Base UI gives `tabIndex=-1` for exactly this.
export function initialFocusTarget(
  popup: HTMLElement | null
): HTMLElement | null {
  if (popup === null) return null;
  const candidates = Array.from(
    popup.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  );
  return (
    candidates.find(
      (el) =>
        el.getAttribute('tabindex') !== '-1' &&
        !el.matches(':disabled') &&
        !el.hasAttribute('hidden') &&
        el.closest(CHROME_SELECTOR) === null
    ) ?? popup
  );
}

// The corner close is a fallback for dialogs without a `DialogChrome` row: once a
// chrome row is anywhere inside the popup, its own close takes over and the corner one
// hides, so consumers do not need to pass `showCloseButton={false}` to avoid two.
function DialogContent({
  className,
  children,
  showCloseButton = true,
  ref,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
}) {
  const popupRef = React.useRef<HTMLDivElement | null>(null);
  // One callback ref feeds both the focus lookup above and whatever ref the consumer
  // passed (`TaskPeekDialog` keeps its own for `initialFocus`).
  const mergedRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      popupRef.current = node;
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref !== undefined && ref !== null) {
        ref.current = node;
      }
    },
    [ref]
  );
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        ref={mergedRef}
        data-slot="dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-0 rounded-popover bg-popover p-0 shadow-overlay transition-[opacity,scale] duration-100 outline-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 sm:max-w-lg',
          className
        )}
        // Before `{...props}` so a consumer's explicit `initialFocus` still wins. A touch
        // open keeps Base UI's default (the popup) so the virtual keyboard stays closed.
        initialFocus={(openType) =>
          openType === 'touch'
            ? popupRef.current
            : initialFocusTarget(popupRef.current)
        }
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-corner-close"
            className="absolute top-2 right-2 [[data-slot=dialog-content]:has([data-slot=dialog-chrome])>&]:hidden"
            render={<IconButton label="Close" />}
          >
            <XIcon />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

// The 40px chrome row at the top of a dialog: a 12px crumb (`[team] › New issue`) on the
// left, expand and close icon buttons on the right. Its presence hides
// `DialogContent`'s corner close, so the close lives here and nowhere else.
function DialogChrome({
  className,
  children,
  onExpand,
  expanded = false,
  showCloseButton = true,
  ...props
}: React.ComponentProps<'div'> & {
  onExpand?: () => void;
  /** Whether `onExpand` has already been taken up — flips the button's label to Collapse. */
  expanded?: boolean;
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-chrome"
      className={cn(
        'flex h-10 shrink-0 items-center gap-1.5 pr-2 pl-4 text-[12px] font-medium text-muted-foreground',
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
        {children}
      </div>
      {onExpand !== undefined && (
        <IconButton
          label={expanded ? 'Collapse' : 'Expand'}
          aria-pressed={expanded}
          onClick={onExpand}
        >
          <Maximize2Icon />
        </IconButton>
      )}
      {showCloseButton && (
        <DialogPrimitive.Close
          data-slot="dialog-close"
          render={<IconButton label="Close" />}
        >
          <XIcon />
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-1 px-4 pt-4 pb-2 text-left', className)}
      {...props}
    />
  );
}

// The dialog's content between header and footer; the popup itself has no padding.
function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-body"
      className={cn('flex min-h-0 flex-col gap-4 px-4 py-3', className)}
      {...props}
    />
  );
}

// Footer: `leading` sits on the left (an attach icon, a `Create more` switch), the
// action buttons on the right.
function DialogFooter({
  className,
  showCloseButton = false,
  leading,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean;
  leading?: React.ReactNode;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'flex items-center justify-between gap-2 px-4 py-3',
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2">{leading}</div>
      <div className="flex shrink-0 items-center gap-2">
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close render={<Button variant="outline" />}>
            Close
          </DialogPrimitive.Close>
        )}
      </div>
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-[15px] leading-5 font-semibold', className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-[13px] font-book text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBody,
  DialogChrome,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
