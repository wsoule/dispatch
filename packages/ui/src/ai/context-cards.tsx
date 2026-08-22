import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export type ContextCardProps = {
  source: string;
  snippet: string;
  charCount: number;
  icon: LucideIcon;
  onOpen?: () => void;
};

/** One retrieved context chunk: a compact inset card with a source header (icon + mono
 * label), a 3-line clamped snippet, and a mono char-count footer. Renders as a
 * `<button>` when `onOpen` is given so the card is keyboard-operable, a plain `<div>`
 * otherwise. Matches the showcase's "Context Cards" primitive. */
export function ContextCard({
  source,
  snippet,
  charCount,
  icon: Icon,
  onOpen,
}: ContextCardProps) {
  const content = (
    <>
      <div className="border-border flex min-w-0 items-center gap-1.5 border-b px-3 py-2">
        <Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-foreground min-w-0 truncate font-mono text-[12.5px] font-medium">
          {source}
        </span>
      </div>
      <p className="text-muted-foreground line-clamp-3 px-3 pt-2 pb-1 text-left text-[12.5px] leading-relaxed">
        {snippet}
      </p>
      <div className="px-3 pb-2">
        <span className="text-muted-foreground font-mono text-[11px] tabular-nums">
          {charCount.toLocaleString()} characters
        </span>
      </div>
    </>
  );

  const className =
    'bg-surface-inset rounded-card shadow-hairline w-56 shrink-0 overflow-hidden text-left';

  if (onOpen) {
    return (
      <button type="button" onClick={onOpen} className={className}>
        {content}
      </button>
    );
  }

  return <div className={className}>{content}</div>;
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
