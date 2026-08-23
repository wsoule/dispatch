import type { ComponentType, ReactNode } from 'react';

import { cn } from '../lib/utils';

export type ContextCardProps = {
  source: string;
  /** 3-line clamped body text; omit for a compact header+footer card (e.g. graph nodes). */
  snippet?: string;
  /** Classic footer line ("N characters"); `footer` wins when both are given. */
  charCount?: number;
  /** Custom footer content in place of the char count. */
  footer?: ReactNode;
  /** Any className-accepting icon component — lucide icons or the app's own glyphs
   * (StatusIcon etc.). It gets the header's muted sizing classes; a component that manages
   * its own color can ignore them. */
  icon: ComponentType<{ className?: string }>;
  onOpen?: () => void;
  className?: string;
};

/** One retrieved context chunk: a compact inset card with a source header (icon + mono
 * label), a 3-line clamped snippet, and a mono char-count footer. Renders as a
 * `<button>` when `onOpen` is given so the card is keyboard-operable, a plain `<div>`
 * otherwise. Matches the showcase's "Context Cards" primitive. */
export function ContextCard({
  source,
  snippet,
  charCount,
  footer,
  icon: Icon,
  onOpen,
  className,
}: ContextCardProps) {
  const footerContent =
    footer ??
    (charCount !== undefined ? (
      <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
        {charCount.toLocaleString()} characters
      </span>
    ) : null);

  const content = (
    <>
      <div className="border-border flex min-w-0 items-center gap-1.5 border-b px-3 py-2">
        <Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-foreground min-w-0 truncate font-mono text-[12.5px] font-medium">
          {source}
        </span>
      </div>
      {snippet !== undefined && (
        <p className="text-muted-foreground line-clamp-3 px-3 pt-2 pb-1 text-left text-[12.5px] leading-relaxed">
          {snippet}
        </p>
      )}
      {footerContent !== null && (
        <div className={cn('px-3 pb-2', snippet === undefined && 'pt-2')}>
          {footerContent}
        </div>
      )}
    </>
  );

  const cardClassName = cn(
    'bg-surface-inset rounded-card shadow-hairline w-56 shrink-0 overflow-hidden text-left',
    className
  );

  if (onOpen) {
    return (
      <button type="button" onClick={onOpen} className={cardClassName}>
        {content}
      </button>
    );
  }

  return <div className={cardClassName}>{content}</div>;
}

export type ContextCardRowProps = {
  children: ReactNode;
};

/** Horizontally scrolling row of `ContextCard`s with fade masks at each edge — a static
 * `mask-image` gradient, not an animation, so it needs no reduced-motion variant. Hides
 * the scrollbar so the fade reads as the only edge treatment. */
export function ContextCardRow({ children }: ContextCardRowProps) {
  return (
    <div
      className="flex gap-2 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{
        maskImage:
          'linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)',
        WebkitMaskImage:
          'linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)',
      }}
    >
      {children}
    </div>
  );
}
