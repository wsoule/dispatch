import { ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../lib/utils';

export type SidebarNavItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Trailing count — plain 11px text, no pill. */
  count?: number | string;
  state?: 'default' | 'attention';
  /** Blocks selection and greys the row out — the "Overview" row before a project has
   * resolved, for example. */
  disabled?: boolean;
  /** Accessible name when the visible label is not the whole story — a row whose name
   * should fold in its count ("Inbox (4)"). Falls back to `label` when omitted. */
  ariaLabel?: string;
  /** Nested one level (16px), as a team's Home/Issues/Projects rows sit under the team. */
  indent?: 1;
};

export type SidebarNavSection = {
  id: string;
  /** Sentence-case heading. A section without one is the fixed top group. */
  label?: string;
  items: SidebarNavItem[];
  /** The heading becomes a button with a chevron that hides the items. Owned by the
   * caller: `collapsed` says which way it is, `onToggle` is asked to flip it. */
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  /** Rendered in place of `items` (a live-agents list that isn't a list of destinations)
   * — still hidden when collapsed. */
  content?: ReactNode;
};

export type SidebarNavProps = {
  /** The top strip above the sections — the project switcher row in the app. */
  header?: ReactNode;
  sections: SidebarNavSection[];
  activeId: string;
  onSelect: (id: string) => void;
  className?: string;
};

export const SIDEBAR_ROW_CLASS =
  'flex h-7 w-full items-center gap-2 rounded-control pr-[9px] pl-2 text-left text-[13px] font-medium transition-colors duration-100 outline-none disabled:pointer-events-none disabled:opacity-50 [&>svg]:size-3.5';
export const SIDEBAR_ROW_INACTIVE_CLASS =
  'text-muted-foreground hover:bg-surface-hover';
export const SIDEBAR_ROW_ACTIVE_CLASS =
  'bg-surface-selected text-(--text-secondary) [&>svg]:text-foreground';

/** Linear's rail grammar: 28px rows, 14px icons, 13px/500 labels, muted at rest and lifted
 * onto the selected surface when active (neutral, never the accent). Headings are 12px
 * sentence case with a chevron when the section collapses. Counts are plain 11px text;
 * `state: 'attention'` adds the 6px indigo dot. The rail never has an icon-only mode —
 * the shell hides it entirely instead. */
export function SidebarNav({
  header,
  sections,
  activeId,
  onSelect,
  className,
}: SidebarNavProps) {
  return (
    <div
      data-slot="sidebar-nav"
      className={cn('flex h-full flex-col gap-2 px-2 pt-1', className)}
    >
      {header !== undefined && <div>{header}</div>}
      <nav className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
        {sections.map((section) => {
          const collapsed = section.collapsible === true && section.collapsed;
          return (
            <div key={section.id} data-section={section.id}>
              {section.label !== undefined &&
                (section.collapsible ? (
                  <button
                    type="button"
                    aria-expanded={!collapsed}
                    onClick={section.onToggle}
                    className="text-muted-foreground rounded-control flex h-7 w-full items-center gap-1 px-2 text-left text-[12px] font-medium transition-colors duration-100 outline-none hover:text-(--text-secondary)"
                  >
                    <span className="min-w-0 truncate">{section.label}</span>
                    <ChevronDownIcon
                      aria-hidden
                      className={cn(
                        'size-3 shrink-0 transition-transform duration-100',
                        collapsed && '-rotate-90'
                      )}
                      strokeWidth={2}
                    />
                  </button>
                ) : (
                  <div className="text-muted-foreground flex h-7 items-center px-2 text-[12px] font-medium">
                    {section.label}
                  </div>
                ))}
              {!collapsed &&
                (section.content !== undefined ? (
                  section.content
                ) : (
                  <div className="flex flex-col gap-px">
                    {section.items.map((item) => {
                      const isActive = item.id === activeId;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          data-nav-item={item.id}
                          aria-current={isActive ? 'page' : undefined}
                          aria-label={item.ariaLabel}
                          disabled={item.disabled}
                          onClick={() => onSelect(item.id)}
                          className={cn(
                            SIDEBAR_ROW_CLASS,
                            isActive
                              ? SIDEBAR_ROW_ACTIVE_CLASS
                              : SIDEBAR_ROW_INACTIVE_CLASS,
                            item.indent === 1 && 'pl-6'
                          )}
                        >
                          {item.icon !== undefined && (
                            <span
                              aria-hidden
                              className={cn(
                                'shrink-0 [&>svg]:size-3.5',
                                isActive && '[&>svg]:text-foreground'
                              )}
                            >
                              {item.icon}
                            </span>
                          )}
                          <span className="min-w-0 flex-1 truncate">
                            {item.label}
                          </span>
                          {item.state === 'attention' && (
                            <span
                              aria-hidden
                              className="bg-primary size-1.5 shrink-0 rounded-full"
                            />
                          )}
                          {item.count !== undefined && (
                            <span className="text-muted-foreground font-book shrink-0 text-[11px] tabular-nums">
                              {item.count}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))}
            </div>
          );
        })}
      </nav>
    </div>
  );
}
