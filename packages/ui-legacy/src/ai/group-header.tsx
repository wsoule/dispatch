import { ChevronDownIcon, PlusIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

import { cn } from '../lib/utils';
import { IconButton } from './icon-button';

export type GroupHeaderProps = {
  /** The group's status colour; the bar's left edge picks up `--tint-strength` of it. */
  tint?: string;
  /** 14px status glyph, epic swatch or milestone target. */
  icon?: ReactNode;
  /** 13px/500. */
  name: ReactNode;
  /** 13px/450 muted, after the name. */
  count?: number;
  /** Collapsed state; the chevron rotates and `onToggle` flips it. */
  collapsed?: boolean;
  onToggle?: () => void;
  /** Right-aligned; defaults to a `+` `IconButton` when `onAdd` is given. */
  actions?: ReactNode;
  onAdd?: () => void;
  /** Accessible name for the default `+`; defaults to "New". */
  addLabel?: string;
  /** Pin under the page header while the group scrolls. */
  sticky?: boolean;
  className?: string;
};

/** The 36px status group bar over a run of `ListRow`s: quaternary surface faintly tinted
 * by the status colour at its left edge, a hover-only collapse chevron, the status glyph,
 * name, count, and a `+` on the right. */
export function GroupHeader({
  tint,
  icon,
  name,
  count,
  collapsed = false,
  onToggle,
  actions,
  onAdd,
  addLabel = 'New',
  sticky = false,
  className,
}: GroupHeaderProps) {
  const style =
    tint !== undefined ? ({ '--tint': tint } as CSSProperties) : undefined;
  return (
    <div
      data-slot="group-header"
      data-collapsed={collapsed || undefined}
      style={style}
      className={cn(
        'group/header flex h-9 shrink-0 items-center gap-2 rounded-card bg-surface-quaternary px-2',
        tint !== undefined && 'status-tint',
        sticky && 'sticky top-0 z-10',
        className
      )}
    >
      {onToggle !== undefined && (
        <button
          type="button"
          aria-label={collapsed ? 'Expand group' : 'Collapse group'}
          aria-expanded={!collapsed}
          onClick={onToggle}
          className="text-muted-foreground flex size-5 shrink-0 items-center justify-center rounded-[4px] opacity-0 transition-opacity duration-100 group-hover/header:opacity-100 focus-visible:opacity-100"
        >
          <ChevronDownIcon
            aria-hidden
            className={cn(
              'size-3 transition-transform duration-100',
              collapsed && '-rotate-90'
            )}
          />
        </button>
      )}
      {icon !== undefined && (
        <span
          data-slot="group-header-icon"
          className="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5"
        >
          {icon}
        </span>
      )}
      <span
        data-slot="group-header-name"
        className="min-w-0 truncate text-[13px] font-medium text-(--text-secondary)"
      >
        {name}
      </span>
      {count !== undefined && (
        <span
          data-slot="group-header-count"
          className="font-book text-muted-foreground shrink-0 text-[13px] tabular-nums"
        >
          {count}
        </span>
      )}
      <span className="flex-1" />
      <span className="flex shrink-0 items-center gap-1">
        {actions}
        {onAdd !== undefined && (
          <IconButton label={addLabel} onClick={onAdd}>
            <PlusIcon aria-hidden />
          </IconButton>
        )}
      </span>
    </div>
  );
}
