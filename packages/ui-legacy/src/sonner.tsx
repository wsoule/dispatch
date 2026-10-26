import { Toaster as Sonner, type ToasterProps } from 'sonner';

// Linear's toast (§12): a 300px quaternary card with a half-pixel ring, a 13px/500
// title, a 12px muted description, and the follow-up as an indigo text link rather
// than a button. Unstyled so sonner's own theme never fights the tokens; the close
// button is hidden — toasts time out or are dismissed by their action. Unstyled also
// drops sonner's rule that blanks the toasts stacked behind the front one, so the
// toast class restates it: collapsed, non-front toasts hide their content.
const TOAST_CLASS_NAMES: NonNullable<
  NonNullable<ToasterProps['toastOptions']>['classNames']
> = {
  toast:
    'flex w-[300px] items-start gap-2 rounded-card border-[0.5px] border-border-strong bg-surface-quaternary p-3 font-sans text-foreground shadow-raised data-[expanded=false]:data-[front=false]:*:opacity-0',
  content: 'flex min-w-0 flex-1 flex-col gap-0.5',
  title: 'text-[13px] font-medium text-foreground',
  description: 'text-[12px] font-book text-muted-foreground',
  icon: 'mt-0.5 flex shrink-0 items-center [&_svg]:size-3.5',
  success: '[&_[data-icon]]:text-status-green',
  error: '[&_[data-icon]]:text-red',
  warning: '[&_[data-icon]]:text-state-waiting',
  info: '[&_[data-icon]]:text-muted-foreground',
  actionButton:
    'shrink-0 self-end bg-transparent p-0 text-[12px] font-medium text-primary hover:underline',
  cancelButton:
    'shrink-0 self-end bg-transparent p-0 text-[12px] font-medium text-muted-foreground hover:text-(--text-secondary)',
  closeButton: 'hidden',
};

/** Theme follows the OS like the rest of the app; sonner's "system" does that
 * without next-themes. */
const Toaster = ({ toastOptions, ...props }: ToasterProps) => (
  <Sonner
    theme="system"
    className="toaster group"
    toastOptions={{
      unstyled: true,
      ...toastOptions,
      classNames: { ...TOAST_CLASS_NAMES, ...toastOptions?.classNames },
    }}
    {...props}
  />
);

export { Toaster };
