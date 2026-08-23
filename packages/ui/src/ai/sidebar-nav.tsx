import { Fragment, type ReactNode } from 'react';

import { cn } from '../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';

export type SidebarNavItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  count?: number | string;
  state?: 'default' | 'attention';
  /** Blocks selection and greys the row out — the "Overview" row before a project has
   * resolved, for example. */
  disabled?: boolean;
  /** Trailing content shown only when the rail is expanded, after the count — a
   * keyboard-shortcut hint (`⌘1`) in Dispatch's own rail. */
  hint?: ReactNode;
  /** Accessible name to use once `collapsed` hides the visible label — e.g. a
   * notifications row whose collapsed name should fold in the unread count
   * ("Notifications (4 unread)"). Falls back to `label` when omitted. */
  ariaLabel?: string;
  /** Extra content rendered directly below the row while the rail is expanded — a nested
   * control that belongs to this destination (Dispatch's Tasks row hangs its layout
   * switcher here). Hidden entirely when collapsed, like `hint`. */
  children?: ReactNode;
};

export type SidebarNavSection = {
  id: string;
  label?: string;
  items: SidebarNavItem[];
};

export type SidebarNavProps = {
  header?: ReactNode;
  sections: SidebarNavSection[];
  activeId: string;
  onSelect: (id: string) => void;
  footer?: ReactNode;
  /** Icon-only rail: hides labels, section headings, counts, and hints, sizing each row
   * to a square, exposing the label through `aria-label`/`title`, and showing it again
   * in a themed tooltip on hover (via `ui/tooltip.tsx`) since there's nowhere left for
   * it to sit inline. Task 25 extension — the showcase only specs the expanded rail,
   * but the real app sidebar has always had a collapsible icon strip and this is the
   * minimal way to keep it without forking the primitive's markup. */
  collapsed?: boolean;
  /** Escape hatch for the root's width classes, merged in via `cn` (later classes win
   * on conflicting Tailwind groups). Standalone uses (the gallery story) get the
   * primitive's own animated `w-60`/`w-14`; an embedding shell that already animates
   * its own container's width — the app's shadcn `Sidebar`, which transitions
   * `--sidebar-width`/`--sidebar-width-icon` — should pass `"w-full"` here instead of
   * letting two widths animate in parallel and drift out of sync. */
  className?: string;
};

/** Workspace navigation column: an optional `header` slot (workspace switcher, quick
 * search), stacked `sections` of items with dense uppercase labels, and an optional
 * `footer` slot. The active item gets a flat `bg-surface-hover-strong` fill — not the
 * accent color, matching the showcase's neutral-selection treatment — while other
 * items only shade on hover. Items with `state: 'attention'` show a small accent dot
 * next to their trailing count. Task 25 rebuilds the real app sidebar on this exact
 * prop contract. Matches the showcase's "Sidebar Nav" primitive. */
export function SidebarNav({
  header,
  sections,
  activeId,
  onSelect,
  footer,
  collapsed = false,
  className,
}: SidebarNavProps) {
  return (
    <div
      className={cn(
        'bg-background ease-out-expo flex h-full flex-col gap-2 p-2 transition-[width] duration-200 motion-reduce:transition-none',
        collapsed ? 'w-14' : 'w-60',
        className
      )}
    >
      {header !== undefined && <div>{header}</div>}
      <nav className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
        {sections.map((section) => (
          <div key={section.id}>
            {section.label !== undefined && !collapsed && (
              <div className="dense-label px-2 pt-1 pb-1">{section.label}</div>
            )}
            <div className="flex flex-col gap-px">
              {section.items.map((item) => {
                const isActive = item.id === activeId;
                const accessibleLabel = item.ariaLabel ?? item.label;
                const row = (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={isActive ? 'page' : undefined}
                    aria-label={collapsed ? accessibleLabel : undefined}
                    title={collapsed ? accessibleLabel : undefined}
                    disabled={item.disabled}
                    onClick={() => onSelect(item.id)}
                    className={`rounded-control ease-out-expo flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13px] transition-colors duration-150 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 motion-reduce:active:scale-100 ${
                      collapsed ? 'justify-center' : ''
                    } ${
                      isActive
                        ? 'bg-surface-hover-strong text-foreground font-medium'
                        : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground'
                    }`}
                  >
                    {item.icon !== undefined && (
                      <span aria-hidden className="shrink-0 [&>svg]:size-3.5">
                        {item.icon}
                      </span>
                    )}
                    {!collapsed && (
                      <>
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
                          <span className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums">
                            {item.count}
                          </span>
                        )}
                        {item.hint}
                      </>
                    )}
                  </button>
                );
                // Collapsed, the label text is gone from the row itself — `aria-label`/
                // `title` cover accessibility and a bare hover, but the rail has always
                // shown a themed flyout naming the row too (shadcn's `SidebarMenuButton`
                // `tooltip` prop did this before the reskin), so it's restored here
                // rather than left to the browser's native title tooltip alone.
                return collapsed ? (
                  <Tooltip key={item.id}>
                    <TooltipTrigger asChild>{row}</TooltipTrigger>
                    <TooltipContent side="right">
                      {accessibleLabel}
                    </TooltipContent>
                  </Tooltip>
                ) : item.children !== undefined ? (
                  <Fragment key={item.id}>
                    {row}
                    {item.children}
                  </Fragment>
                ) : (
                  row
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      {footer !== undefined && <div>{footer}</div>}
    </div>
  );
}
