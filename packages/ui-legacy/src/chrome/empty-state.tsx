import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { PillButton } from '../ai/pill';
import { Button } from '../button';
import { Kbd } from '../kbd';
import { cn } from '../lib/utils';

export type EmptyStateProps = {
  /** A ~60px line-art illustration, stroked at 1px in muted ink. */
  illustration?: ReactNode;
  /** Legacy: a lucide icon in the illustration slot. */
  icon?: LucideIcon;
  /** 13px/500. */
  heading?: ReactNode;
  /** 13px/450 muted, wraps at 340px. */
  description?: ReactNode;
  /** Legacy alias for `description`. */
  message?: ReactNode;
  /** The indigo pill, with an optional inline keycap hint (`N then P`). */
  primary?: { label: ReactNode; onClick: () => void; hint?: ReactNode };
  /** The control-surface pill beside it. */
  secondary?: { label: ReactNode; onClick: () => void };
  /** Legacy: arbitrary action markup under the text. */
  action?: ReactNode;
  className?: string;
};

/** What a surface shows when it has nothing: a centred line-art illustration, a 13px
 * heading, a short muted description, and a primary + secondary pill. `message` and
 * `action` are the pre-Linear props and keep working. */
export function EmptyState({
  illustration,
  icon: Icon,
  heading,
  description,
  message,
  primary,
  secondary,
  action,
  className,
}: EmptyStateProps) {
  const descriptionText = description ?? message;
  const art =
    illustration ??
    (Icon !== undefined ? (
      <Icon className="size-[60px]" strokeWidth={1} />
    ) : undefined);
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-4 py-8 text-center',
        className
      )}
    >
      {art !== undefined && (
        <div
          aria-hidden
          className="text-muted-foreground/60 mb-1 flex h-[60px] items-center justify-center [&_svg]:size-[60px] [&_svg]:stroke-1"
        >
          {art}
        </div>
      )}
      {heading !== undefined && (
        <p className="text-[13px] font-medium text-(--text-secondary)">
          {heading}
        </p>
      )}
      {descriptionText !== undefined && (
        <p className="font-book text-muted-foreground max-w-[340px] text-[13px]">
          {descriptionText}
        </p>
      )}
      {(primary !== undefined || secondary !== undefined) && (
        <div className="mt-2 flex items-center gap-2">
          {primary !== undefined && (
            <Button onClick={primary.onClick} className="rounded-pill">
              {primary.label}
              {primary.hint !== undefined && (
                <Kbd className="border-white/20 bg-white/15 text-white">
                  {primary.hint}
                </Kbd>
              )}
            </Button>
          )}
          {secondary !== undefined && (
            <PillButton onClick={secondary.onClick}>
              {secondary.label}
            </PillButton>
          )}
        </div>
      )}
      {action !== undefined && (
        <div className="mt-1 flex items-center gap-2">{action}</div>
      )}
    </div>
  );
}
