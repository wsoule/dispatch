import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { ShimmerLabel } from './shimmer';

export type ToolChipState = 'running' | 'done' | 'failed';

export type ToolChipProps = {
  icon: LucideIcon;
  label: string;
  meta?: ReactNode;
  state?: ToolChipState;
  onClick?: () => void;
};

/** One tool call as a compact inline chip: icon, label, and an optional mono `meta`
 * slot (a diff stat like `+24 −3`, a command, a filename). Running chips shimmer the
 * label; failed chips wash red. Renders a `<button>` when `onClick` is given, a plain
 * `<span>` otherwise. Matches the showcase's "Tool Chips" primitive. */
export function ToolChip({
  icon: Icon,
  label,
  meta,
  state = 'done',
  onClick,
}: ToolChipProps) {
  const isFailed = state === 'failed';
  const isRunning = state === 'running';

  const className = `ease-out-expo rounded-chip inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 px-2 text-xs transition-colors duration-100 ${
    isFailed
      ? 'bg-[var(--red-bg)] text-red'
      : 'bg-surface-inset text-foreground'
  } ${onClick ? 'hover:bg-surface-hover-strong cursor-pointer' : ''}`;

  const content = (
    <>
      <Icon
        aria-hidden
        className={`size-3.5 shrink-0 ${isFailed ? 'text-red' : 'text-muted-foreground'}`}
      />
      <span className="min-w-0 truncate font-medium">
        {isRunning ? <ShimmerLabel>{label}</ShimmerLabel> : label}
      </span>
      {meta !== undefined && (
        <span
          className={`shrink-0 font-mono text-[11px] tabular-nums ${
            isFailed ? 'text-red' : 'text-muted-foreground'
          }`}
        >
          {meta}
        </span>
      )}
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {content}
      </button>
    );
  }

  return <span className={className}>{content}</span>;
}

export type ToolChipGroupProps = {
  children: ReactNode;
  overflowCount?: number;
};

/** Wraps a row of `ToolChip`s and appends a muted "+N" overflow chip once the caller
 * has more tool calls than fit — the count is supplied, not computed, so the caller
 * decides how many chips to render before handing off the remainder. */
export function ToolChipGroup({ children, overflowCount }: ToolChipGroupProps) {
  return (
    <div className="flex max-w-full flex-wrap items-center gap-1.5">
      {children}
      {overflowCount !== undefined && overflowCount > 0 && (
        <span
          aria-label={`${overflowCount} more tool calls`}
          className="rounded-chip bg-surface-inset text-muted-foreground inline-flex h-6 shrink-0 items-center px-2 font-mono text-xs tabular-nums"
        >
          +{overflowCount}
        </span>
      )}
    </div>
  );
}
