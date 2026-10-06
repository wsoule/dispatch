import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';

import { IconButton } from '@/ui/ai/icon-button';

/** A drawer above the composer, over either view; it never changes the view underneath. */
export function PeekDrawer({
  label,
  title,
  actions,
  onClose,
  testId,
  children,
}: {
  label: string;
  title: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  testId: string;
  children: ReactNode;
}) {
  // Focus moves into the drawer and back to whatever opened it.
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeRef.current?.focus();
    return () => opener?.focus();
  }, []);
  return (
    <aside
      role="dialog"
      aria-label={label}
      data-testid={testId}
      className="bg-background border-border-strong rounded-popover shadow-raised absolute top-3 right-3 bottom-[96px] z-20 flex w-[420px] max-w-[calc(100%-24px)] flex-col overflow-hidden border-[0.5px]"
    >
      <div className="border-border flex items-center gap-2 border-b-[0.5px] px-3 py-2">
        <div className="min-w-0 flex-1 truncate text-[13px] font-semibold">
          {title}
        </div>
        {actions}
        <IconButton ref={closeRef} label="Close" onClick={onClose}>
          <X aria-hidden />
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </aside>
  );
}
