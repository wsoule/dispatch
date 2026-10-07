import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { IconButton } from '@/ui/ai/icon-button';
import { Button } from '@/ui/button';
import { SheetClose } from '@/ui/sheet';
import { SheetPanel } from '@/ui/sheet-panel';

/** One presence line: a dot (lit while they are here) and what they are doing. */
export function PresenceLine({
  live,
  tone = 'accent',
  children,
}: {
  live: boolean;
  tone?: 'accent' | 'green';
  children: ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-(--text-secondary)">
      <i
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          !live
            ? 'bg-(--text-ghost)'
            : tone === 'green'
              ? 'bg-(--green)'
              : 'bg-(--accent)'
        )}
      />
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** A chip that opens something from a peek or a home: a task, a doc, a settings page. */
export function PeekChip({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button size="xs" variant="outline" onClick={onClick}>
      {children}
    </Button>
  );
}

/** A drawer above the composer, over either view; it never changes the view underneath. */
export function PeekDrawer({
  label,
  title,
  leading,
  subtitle,
  summary,
  actions,
  onClose,
  testId,
  children,
}: {
  label: string;
  title: ReactNode;
  /** An avatar before the title. */
  leading?: ReactNode;
  /** One mono line under the title: the address and what it is. */
  subtitle?: ReactNode;
  /** Presence, warnings and chips between the header and the timeline. */
  summary?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  testId: string;
  children: ReactNode;
}) {
  // Focus lands on × and goes back to whatever opened the peek when it unmounts.
  const closeRef = useRef<HTMLButtonElement>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => opener?.focus();
  }, []);
  return (
    <div
      ref={setHost}
      data-slot="peek-host"
      className="pointer-events-none absolute inset-0 z-20"
    >
      {host !== null && (
        <SheetPanel
          container={host}
          onOpenChange={(open) => {
            if (!open) onClose();
          }}
          initialFocus={closeRef}
          finalFocus={false}
          aria-label={label}
          data-testid={testId}
          className="border-border-strong rounded-popover shadow-raised top-3 right-3 bottom-[96px] w-[400px] max-w-[calc(100%-24px)] overflow-hidden border-[0.5px]"
        >
          <div
            data-slot="peek-header"
            className={cn(
              'flex items-center gap-2 pt-2.5 pr-2.5 pl-3',
              summary === undefined ? 'shadow-hairline-bottom pb-2' : 'pb-1.5'
            )}
          >
            {leading}
            <div className="min-w-0 flex-1 leading-[1.35]">
              <div className="truncate text-[13px] font-semibold">{title}</div>
              {subtitle !== undefined && (
                <div className="text-muted-foreground truncate font-mono text-[11px]">
                  {subtitle}
                </div>
              )}
            </div>
            {actions}
            <SheetClose render={<IconButton ref={closeRef} label="Close" />}>
              <X aria-hidden />
            </SheetClose>
          </div>
          {summary !== undefined && (
            <div
              data-slot="peek-summary"
              className="shadow-hairline-bottom flex flex-col gap-1.5 px-3 pb-2.5 text-[12px]"
            >
              {summary}
            </div>
          )}
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </SheetPanel>
      )}
    </div>
  );
}
