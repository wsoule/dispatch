import type { LucideIcon } from 'lucide-react';
import { ChevronRightIcon, XIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { ShimmerLabel } from './shimmer';

export type ToolChipState = 'running' | 'done' | 'failed';

export type ToolChipProps = {
  icon: LucideIcon;
  label: string;
  meta?: ReactNode;
  state?: ToolChipState;
  onClick?: () => void;
  /** `chip` is the compact inline pill for wrapping groups; `row` is T3 Code's flat
   * work-log line: an icon column, the label, and a chevron when it opens. */
  variant?: 'chip' | 'row';
  /** Row only: draws the trailing chevron, which turns when a surrounding Collapsible
   * trigger is open (`data-panel-open`). */
  expandable?: boolean;
};

/** One tool call: icon, label, and an optional `meta` slot (a diff stat like `+24 −3`, a
 * command, a filename). Running calls shimmer the label; failed calls turn red. Renders a
 * `<button>` when `onClick` is given, a plain `<span>` otherwise. Spread-through props let
 * a Collapsible trigger render it as its button. */
export function ToolChip({
  icon: Icon,
  label,
  meta,
  state = 'done',
  onClick,
  variant = 'chip',
  expandable = false,
  ...rest
}: ToolChipProps & Record<string, unknown>) {
  const isFailed = state === 'failed';
  const isRunning = state === 'running';
  const labelNode = isRunning ? <ShimmerLabel>{label}</ShimmerLabel> : label;

  const className =
    variant === 'row'
      ? `group/tool ease-out-expo flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-[13px] leading-relaxed transition-colors duration-100 ${
          expandable || onClick ? 'hover:bg-surface-hover cursor-pointer' : ''
        }`
      : `ease-out-expo rounded-chip inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 px-2 text-xs transition-colors duration-100 ${
          isFailed
            ? 'bg-[var(--red-bg)] text-red'
            : 'bg-surface-inset text-foreground'
        } ${onClick ? 'hover:bg-surface-hover-strong cursor-pointer' : ''}`;

  const content =
    variant === 'row' ? (
      <>
        <span className="flex w-6 shrink-0 justify-center">
          <Icon
            aria-hidden
            className={`size-4 ${isFailed ? 'text-red' : 'text-muted-foreground'}`}
          />
        </span>
        <span className="min-w-0 shrink-0 font-medium text-(--text-secondary)">
          {labelNode}
        </span>
        {meta !== undefined && (
          <span className="text-muted-foreground font-book min-w-0 truncate text-[12px] tabular-nums">
            {meta}
          </span>
        )}
        {isFailed && <XIcon aria-hidden className="text-red size-3 shrink-0" />}
        {expandable && (
          <ChevronRightIcon
            aria-hidden
            className="text-muted-foreground ms-auto size-3 shrink-0 opacity-70 transition-transform duration-200 group-data-[panel-open]/tool:rotate-90"
          />
        )}
      </>
    ) : (
      <>
        <Icon
          aria-hidden
          className={`size-3.5 shrink-0 ${isFailed ? 'text-red' : 'text-muted-foreground'}`}
        />
        <span className="min-w-0 truncate font-medium">{labelNode}</span>
        {meta !== undefined && (
          <span
            className={`font-book shrink-0 text-[12px] tabular-nums ${
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
      <button
        {...rest}
        type="button"
        data-slot="tool-chip"
        data-state={state}
        onClick={onClick}
        className={className}
      >
        {content}
      </button>
    );
  }

  return (
    <span
      {...rest}
      data-slot="tool-chip"
      data-state={state}
      className={className}
    >
      {content}
    </span>
  );
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
          className="rounded-pill border-border-chip bg-surface-quaternary text-muted-foreground font-book inline-flex h-6 shrink-0 items-center border-[0.5px] px-2 text-[12px] tabular-nums"
        >
          +{overflowCount}
        </span>
      )}
    </div>
  );
}
