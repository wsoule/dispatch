import {
  ListFilterIcon,
  PanelLeftIcon,
  PanelRightIcon,
  SlidersHorizontalIcon,
} from 'lucide-react';
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
} from 'react';

import { focusRovingItem, nextRovingIndex } from '../lib/roving';
import { cn } from '../lib/utils';
import { IconButton, type IconButtonProps } from './icon-button';

/** What the shell tells every page header: whether the sidebar is hidden (so the header
 * grows a show-sidebar button and, on macOS, clears the traffic lights) and whether its
 * first row doubles as the window drag region. Optional — a header outside the shell
 * (the gallery, a test) renders without any of it. */
export type PageHeaderShell = {
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
  /** Leave 76px on the left for the macOS traffic lights when the sidebar is hidden. */
  trafficLightInset: boolean;
  /** Mark row 1 as the Tauri window drag region. */
  dragRegion: boolean;
};

export const PageHeaderShellContext = createContext<PageHeaderShell | null>(
  null
);

export type PageHeaderProps = {
  /** Before the crumb: a team icon, a back button. */
  leading?: ReactNode;
  /** Breadcrumb segments, joined by `›`; the last one is the page. */
  crumb?: ReactNode[];
  /** The favourite star, right after the crumb. */
  star?: ReactNode;
  /** Right-aligned contextual actions (ghost buttons, a bell). */
  actions?: ReactNode;
  /** Row 2, left: `ViewTabs`. Row 2 renders only when `tabs` or `controls` is given. */
  tabs?: ReactNode;
  /** Row 2, right: the `HeaderIconTriad`. */
  controls?: ReactNode;
  className?: string;
};

/** The panel header: a 44px crumb/title row and an optional 44px tabs/controls row, each
 * closed by a hairline. Reads `PageHeaderShellContext` for the sidebar toggle and drag
 * region so no view has to know about the window. */
export function PageHeader({
  leading,
  crumb,
  star,
  actions,
  tabs,
  controls,
  className,
}: PageHeaderProps) {
  const shell = useContext(PageHeaderShellContext);
  const showSidebarToggle = shell?.sidebarHidden === true;
  const inset = showSidebarToggle && shell.trafficLightInset;
  const hasRow2 = tabs !== undefined || controls !== undefined;
  return (
    <header data-slot="page-header" className={cn('shrink-0', className)}>
      <div
        data-slot="page-header-row"
        data-tauri-drag-region={shell?.dragRegion ? true : undefined}
        className={cn(
          'flex h-11 items-center gap-2 px-4 shadow-hairline-bottom',
          inset && 'pl-[76px]'
        )}
      >
        {showSidebarToggle && (
          <IconButton label="Show sidebar" onClick={shell.onToggleSidebar}>
            <PanelLeftIcon aria-hidden />
          </IconButton>
        )}
        {leading}
        {crumb !== undefined && crumb.length > 0 && <Crumb segments={crumb} />}
        {star}
        {actions !== undefined && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {actions}
          </div>
        )}
      </div>
      {hasRow2 && (
        <div
          data-slot="page-header-row"
          // `min-h` rather than a fixed height: a tab row that wraps at a narrow window grows
          // the header instead of spilling over the crumb above and the list below.
          className="shadow-hairline-bottom flex min-h-11 flex-wrap items-center gap-2 px-4 py-1.5"
        >
          {tabs}
          {controls !== undefined && (
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {controls}
            </div>
          )}
        </div>
      )}
    </header>
  );
}

// `Team › Issues`: every segment but the last is secondary, the page itself is bright.
function Crumb({ segments }: { segments: ReactNode[] }) {
  return (
    <div
      data-slot="page-header-crumb"
      className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-(--text-secondary)"
    >
      {segments.map((segment, index) => {
        const last = index === segments.length - 1;
        return (
          <span key={index} className="flex min-w-0 items-center gap-1.5">
            {index > 0 && (
              <span aria-hidden className="text-muted-foreground">
                ›
              </span>
            )}
            <span
              className={cn(
                'flex min-w-0 items-center gap-1.5 truncate',
                last && 'text-foreground'
              )}
              aria-current={last ? 'page' : undefined}
            >
              {segment}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export type ViewTab = {
  id: string;
  label: string;
  icon?: ReactNode;
};

export type ViewTabsProps = {
  tabs: ViewTab[];
  active: string;
  onChange: (id: string) => void;
  /** Accessible name for the tab list. */
  label?: string;
  className?: string;
};

export const VIEW_TAB_CLASS =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-pill px-2.5 text-[12px] font-medium whitespace-nowrap transition-colors duration-100 outline-none [&_svg]:size-3.5 [&_svg]:shrink-0';
export const VIEW_TAB_ACTIVE_CLASS = 'bg-surface-active text-foreground';
export const VIEW_TAB_INACTIVE_CLASS =
  'bg-surface-control text-muted-foreground hover:text-(--text-secondary)';

/** The view tabs under a page title — `Active` `Backlog` `All issues` — as 28px pills
 * with no shared track: the active one lifts to `bg-surface-active`. One tab stop:
 * only the active tab is tabbable and arrows/Home/End move (and select) between them. */
export function ViewTabs({
  tabs,
  active,
  onChange,
  label = 'Views',
  className,
}: ViewTabsProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = tabs.findIndex((tab) => tab.id === active);
    const next = nextRovingIndex(event.key, current, tabs.length);
    if (next === null) return;
    event.preventDefault();
    onChange(tabs[next].id);
    focusRovingItem(event.currentTarget, '[role="tab"]', next);
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      data-slot="view-tabs"
      className={cn('flex items-center gap-1', className)}
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-active={selected || undefined}
            onClick={() => onChange(tab.id)}
            className={cn(
              VIEW_TAB_CLASS,
              selected ? VIEW_TAB_ACTIVE_CLASS : VIEW_TAB_INACTIVE_CLASS
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

type TriadButtonProps = Omit<IconButtonProps, 'label' | 'children'> & {
  label?: string;
};

/** The funnel. `active` adds the 6px indigo dot Linear shows when a filter is applied. */
export function FilterIconButton({
  active = false,
  className,
  label = 'Filter',
  ...props
}: TriadButtonProps) {
  return (
    <IconButton
      label={label}
      data-filter-active={active || undefined}
      className={cn('relative', className)}
      {...props}
    >
      <ListFilterIcon aria-hidden />
      {active && (
        <span
          aria-hidden
          data-slot="filter-active-dot"
          className="rounded-pill bg-primary absolute top-1 right-1 size-1.5"
        />
      )}
    </IconButton>
  );
}

/** The sliders. */
export function DisplayIconButton({
  label = 'Display',
  ...props
}: TriadButtonProps) {
  return (
    <IconButton label={label} {...props}>
      <SlidersHorizontalIcon aria-hidden />
    </IconButton>
  );
}

/** The side-panel toggle; `active` while the panel is open. */
export function SidePanelIconButton({
  label = 'Toggle side panel',
  ...props
}: TriadButtonProps) {
  return (
    <IconButton label={label} {...props}>
      <PanelRightIcon aria-hidden />
    </IconButton>
  );
}

export type HeaderIconTriadProps = {
  filterActive?: boolean;
  onFilter?: () => void;
  onDisplay?: () => void;
  sidePanelOpen?: boolean;
  onSidePanel?: () => void;
  /** Replace a button outright — to wrap it in a popover trigger, say:
   * `display={<PopoverTrigger render={<DisplayIconButton />} />}`. */
  filter?: ReactNode;
  display?: ReactNode;
  sidePanel?: ReactNode;
  className?: string;
};

/** Filter · Display · side panel — the three round icon buttons at the right of a
 * page header's second row. */
export function HeaderIconTriad({
  filterActive,
  onFilter,
  onDisplay,
  sidePanelOpen,
  onSidePanel,
  filter,
  display,
  sidePanel,
  className,
}: HeaderIconTriadProps) {
  return (
    <div
      data-slot="header-icon-triad"
      className={cn('flex items-center gap-1', className)}
    >
      {filter ?? <FilterIconButton active={filterActive} onClick={onFilter} />}
      {display ?? <DisplayIconButton onClick={onDisplay} />}
      {sidePanel ?? (
        <SidePanelIconButton active={sidePanelOpen} onClick={onSidePanel} />
      )}
    </div>
  );
}
