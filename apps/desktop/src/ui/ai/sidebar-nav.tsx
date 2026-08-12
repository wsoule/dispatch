import type { ReactNode } from 'react';

export type SidebarNavItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  count?: number;
  state?: 'default' | 'attention';
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
}: SidebarNavProps) {
  return (
    <div className="bg-background flex w-60 flex-col gap-2 p-2">
      {header !== undefined && <div>{header}</div>}
      <nav className="flex flex-col gap-2">
        {sections.map((section) => (
          <div key={section.id}>
            {section.label !== undefined && (
              <div className="dense-label px-2 pt-1 pb-1">{section.label}</div>
            )}
            <div className="flex flex-col gap-px">
              {section.items.map((item) => {
                const isActive = item.id === activeId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => onSelect(item.id)}
                    className={`rounded-control ease-out-expo flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13px] transition-colors duration-150 active:scale-[0.96] motion-reduce:active:scale-100 ${
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
                  </button>
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
