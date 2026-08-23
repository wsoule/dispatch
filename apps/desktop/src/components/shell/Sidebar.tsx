import type { SyncStatus } from '@dispatch/client';
import {
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Cog,
  GitBranch,
  GitMerge,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  ListChecks,
  NotebookPen,
  Palette,
  Play,
  Radar,
  Rows3,
  Shield,
  Target,
  Waypoints,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

import type { GlobalView, ProjectView } from '../../lib/appNav';
import type { TasksViewMode } from '../../lib/tasksViewMode';
import { SyncChip } from './SyncChip';
import { cn } from '@/lib/utils';
import {
  SidebarNav,
  type SidebarNavItem,
  type SidebarNavSection,
} from '@/ui/ai/sidebar-nav';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Kbd } from '@/ui/kbd';
import { Sidebar as SidebarRoot, useSidebar } from '@/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

// `board` hosts both the Kanban and dense-list layouts behind its own in-view toggle now (see
// `BoardView`), so it gets one "Tasks" row rather than the old separate Board/Tasks pair —
// Linear itself doesn't split those into two nav destinations either.
/**
 * The rail, in the order work actually moves through the app.
 *
 * It used to be a flat list of nine destinations with no stated relationship,
 * so moving between them felt like nine separate apps sharing a sidebar. The
 * groups name the stage each one belongs to — you capture, you plan, the agents
 * work, you land it — and the order matches the pipeline rather than the order
 * the views happened to get built.
 *
 * `shortcut` is the cmd+N that reaches it, assigned by position so the numbers
 * stay learnable rather than tracking an id.
 */
const PROJECT_VIEWS: {
  id: ProjectView;
  label: string;
  icon: typeof ListChecks;
  /** Starts a new group, rendered above this entry. */
  group?: string;
}[] = [
  // The two pages this app is actually used from: one is where everything gets
  // captured, the other is where everything gets watched.
  { id: 'overview', label: 'Control room', icon: LayoutDashboard },
  { id: 'brain-dump', label: 'Brain dump', icon: Brain },

  { id: 'plans', label: 'Plans', icon: NotebookPen, group: 'Plan' },
  { id: 'board', label: 'Tasks', icon: ListChecks },

  // A slim, list-only "everything waiting on a human" — the whole Work stage
  // now that Runs and Review are gone: a run is watched from its own task, and
  // every past run is listed under All agents.
  { id: 'inbox', label: 'Inbox', icon: Inbox, group: 'Work' },
  // Blast radius of a file, run, or task's declared writes — reached from
  // here with nothing preselected, or from the "open in Impact" action on
  // the review case panel and the Git file pane.
  { id: 'impact', label: 'Impact', icon: Waypoints },

  { id: 'branches', label: 'Git', icon: GitBranch, group: 'Git' },
  // Every open PR with its gates plus what already landed — the one answer to
  // "what lands, when, and what landed".
  { id: 'landing', label: 'Landing', icon: GitMerge },
];

/** The rail order is the shortcut order — cmd+1 is the first entry, and so on. */
export const PROJECT_VIEW_ORDER: ProjectView[] = PROJECT_VIEWS.map((v) => v.id);

interface ProjectViewGroup {
  /** The stage heading, or `undefined` for the unlabelled first stage. */
  label: string | undefined;
  /** Each entry paired with its position in the flat `PROJECT_VIEWS` list. */
  entries: { view: (typeof PROJECT_VIEWS)[number]; index: number }[];
}

// `PROJECT_VIEWS` cut into its stages, one nav section each. The index travels with the entry
// because it is the cmd+N number, which counts across the whole rail rather than per stage.
const PROJECT_VIEW_GROUPS: ProjectViewGroup[] = [];
PROJECT_VIEWS.forEach((view, index) => {
  const current = PROJECT_VIEW_GROUPS[PROJECT_VIEW_GROUPS.length - 1];
  if (current === undefined || view.group !== undefined) {
    PROJECT_VIEW_GROUPS.push({ label: view.group, entries: [{ view, index }] });
  } else {
    current.entries.push({ view, index });
  }
});

// The Tasks destination's layout options — surfaced as a dropdown nested under the Tasks
// row while it's the active view, per the "view names belong in the sidebar" direction.
const TASKS_VIEW_OPTIONS: {
  id: TasksViewMode;
  label: string;
  icon: typeof LayoutGrid;
}[] = [
  { id: 'board', label: 'Board', icon: LayoutGrid },
  { id: 'list', label: 'List', icon: Rows3 },
  { id: 'milestones', label: 'Milestones', icon: Target },
];

const GLOBAL_VIEWS: { id: GlobalView; label: string; icon: typeof Radar }[] = [
  { id: 'all-agents', label: 'All Agents', icon: Radar },
  { id: 'sessions', label: 'Sessions', icon: Play },
  // The active project's chat assistant. Global-section, not a project row:
  // it answers about whichever project is active, from any view.
  { id: 'warden', label: 'Warden', icon: Shield },
  { id: 'settings', label: 'Settings', icon: Cog },
  // Dev-only primitive review surface — `DEV` is inlined at build time, so this
  // entry (and GalleryView itself) is dead code in a production build.
  ...(import.meta.env.DEV
    ? [{ id: 'gallery' as const, label: 'Gallery', icon: Palette }]
    : []),
];

// Persists whether the left rail is collapsed to an icon-only strip, so the choice survives a
// reload instead of resetting every time the app opens.
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'dispatch:sidebar-collapsed';

function readStoredSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1';
}

/**
 * The collapsed-rail preference, kept here beside the rail it describes but applied by App's
 * `SidebarProvider`, which owns the open/closed state the whole shell reads.
 */
export function useSidebarCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(readStoredSidebarCollapsed);
  useEffect(() => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      collapsed ? '1' : '0'
    );
  }, [collapsed]);
  // A plain setter, not React's raw one: `SidebarProvider` always hands back a resolved
  // open/closed value, so the updater overload is not part of this hook's contract.
  const set = useCallback((next: boolean) => setCollapsed(next), []);
  return [collapsed, set];
}

// The rail's cmd+N hints — bare mono text sitting at the end of a row, not `Kbd`'s usual
// filled keycap.
const ROW_HINT_CLASS =
  'text-muted-foreground/50 h-auto min-w-0 bg-transparent px-0 font-mono text-[10px] font-normal';

// The footer's cmd+K hint keeps `Kbd`'s outlined-key look.
const FOOTER_HINT_CLASS =
  'border-border h-auto min-w-0 rounded border px-1 py-0.5 font-mono text-[10px] font-normal';

interface SidebarProps {
  hasActiveProject: boolean;
  section: 'project' | 'global';
  projectView: ProjectView;
  globalView: GlobalView;
  /** Count of non-terminal runs for this project — the "All Agents" badge, so you can tell
   * something is live without leaving whatever you're looking at. */
  liveAgentCount: number;
  /** Live per-row counts. A row with no entry, or a zero, renders no badge at all — a rail of
   * "0"s is noise, and the absence of a number is itself the information. */
  badges: Partial<Record<ProjectView, number>>;
  /** Total spend across today's runs, or `null` to show nothing. Stays at the foot of the
   * rail (not in the custom titlebar) — a cost meter is glanceable context, not chrome. */
  spendToday: number | null;
  onSetProjectView: (view: ProjectView) => void;
  onSetGlobalView: (view: GlobalView) => void;
  /** The Tasks view's active layout — drives the nested switcher under its rail row. */
  tasksViewMode: TasksViewMode;
  onSetTasksViewMode: (mode: TasksViewMode) => void;
  /** The board syncer's status — `null` until it has ever loaded, in which case the chip
   * renders nothing. */
  syncStatus: SyncStatus | null;
  /** Flips `.dispatch/config.yml`'s `autoCommit` off — the sync chip's kill switch. */
  onDisableAutoCommit: () => void;
  /** The live-agents section (`LiveRail`), rendered at the top of the rail's footer — or
   * `null` outside project scope, where there are no runs to show. App owns the gating and
   * the data wiring; the rail just gives it a home. */
  liveRail: ReactNode;
}

/**
 * Persistent, Linear-style left rail: the active project's primary nav (Board/Tasks/Runs/
 * Plans), the global section (All Agents/Sessions/Settings) below it, and the live-agents
 * section in the footer. The project switcher, notifications bell, and drafts tray live in
 * the window titlebar (see `TitleBar.tsx`); branding lives in the app icon, not the rail.
 * Built on the `SidebarNav` primitive (`ui/ai/sidebar-nav.tsx`)
 * for its rows/sections, still wrapped in the shadcn `Sidebar` shell purely for the
 * fixed-position/icon-collapse/mobile mechanics App.tsx's `SidebarProvider` already owns —
 * this reads that back through `useSidebar` so the icon-only strip still works.
 */
export function Sidebar({
  hasActiveProject,
  section,
  projectView,
  globalView,
  liveAgentCount,
  badges,
  spendToday,
  onSetProjectView,
  onSetGlobalView,
  tasksViewMode,
  onSetTasksViewMode,
  syncStatus,
  onDisableAutoCommit,
  liveRail,
}: SidebarProps) {
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === 'collapsed';

  const activeId = section === 'project' ? projectView : globalView;

  // The stage groups (Workspace/Plan/Work/Git), each mapped straight onto a `SidebarNav`
  // section. The first stage carries no group name of its own in `PROJECT_VIEWS` (it's the
  // rail's unlabelled top), so it's given the "Workspace" heading here rather than in the
  // data — that heading is presentational, not part of the navigation model.
  const projectSections: SidebarNavSection[] = PROJECT_VIEW_GROUPS.map(
    (group, groupIndex) => ({
      id: group.label ?? 'workspace',
      label: groupIndex === 0 ? 'Workspace' : group.label,
      items: group.entries.map(({ view, index }) => {
        const Icon = view.icon;
        const count = badges[view.id];
        const hasCount = count !== undefined && count > 0;
        // The Tasks row grows a nested layout dropdown while it's the active view — the
        // page itself carries no view tabs any more.
        const activeTasksOption =
          TASKS_VIEW_OPTIONS.find((o) => o.id === tasksViewMode) ??
          TASKS_VIEW_OPTIONS[0];
        const ActiveTasksIcon = activeTasksOption.icon;
        const tasksSwitcher =
          view.id === 'board' &&
          section === 'project' &&
          projectView === 'board' &&
          !collapsed ? (
            <div className="pt-0.5 pb-1 pl-7">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground hover:text-foreground h-auto gap-1.5 px-1.5 py-1 text-[12px] font-normal"
                  >
                    <ActiveTasksIcon className="size-3.5" />
                    {activeTasksOption.label}
                    <ChevronsUpDown className="size-3 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-36">
                  {TASKS_VIEW_OPTIONS.map((option) => {
                    const OptionIcon = option.icon;
                    return (
                      <DropdownMenuItem
                        key={option.id}
                        onClick={() => onSetTasksViewMode(option.id)}
                        className="text-[12.5px]"
                      >
                        <OptionIcon className="size-3.5" />
                        {option.label}
                        {option.id === tasksViewMode && (
                          <Check className="ml-auto size-3.5" />
                        )}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : undefined;
        return {
          id: view.id,
          label: view.label,
          icon: <Icon strokeWidth={2} />,
          count: hasCount ? count : undefined,
          // Inbox's count is the "needs a human" queue — the one row-level badge that also
          // earns the attention dot, not just a number.
          state: view.id === 'inbox' && hasCount ? 'attention' : undefined,
          disabled: !hasActiveProject,
          // The shortcut lives on the thing it operates, which is the only way anyone finds
          // out it exists.
          hint:
            index < 9 ? (
              <Kbd className={ROW_HINT_CLASS}>⌘{index + 1}</Kbd>
            ) : undefined,
          children: tasksSwitcher,
        } satisfies SidebarNavItem;
      }),
    })
  );

  const globalItems: SidebarNavItem[] = [
    ...GLOBAL_VIEWS.map((item) => {
      const Icon = item.icon;
      const liveCount = item.id === 'all-agents' ? liveAgentCount : 0;
      return {
        id: item.id,
        label: item.label,
        icon: <Icon strokeWidth={2} />,
        count: liveCount > 0 ? liveCount : undefined,
      } satisfies SidebarNavItem;
    }),
  ];

  const sections: SidebarNavSection[] = [
    ...projectSections,
    { id: 'global', items: globalItems },
  ];

  const handleSelect = useCallback(
    (id: string) => {
      if ((PROJECT_VIEW_ORDER as string[]).includes(id)) {
        onSetProjectView(id as ProjectView);
        return;
      }
      onSetGlobalView(id as GlobalView);
    },
    [onSetProjectView, onSetGlobalView]
  );

  const footer = (
    <>
      {/* The live-agents section (see `LiveRail.tsx`) — App passes it already gated to
          project scope, so `null` here just means there is nothing to show. */}
      {liveRail}

      {/* The board syncer's status. Hidden when collapsed, same as the spend line below — an
          icon-only rail has no room for a sentence. */}
      {!collapsed && hasActiveProject && (
        <SyncChip
          status={syncStatus}
          onDisableAutoCommit={onDisableAutoCommit}
        />
      )}

      {/* Today's spend. Deliberately kept at the foot of the rail rather than promoted to the
          custom titlebar. Hidden entirely at zero rather than showing "$0.00": a running cost
          meter is only worth the pixels once there is a cost. */}
      {!collapsed && spendToday !== null && spendToday > 0 && (
        <div className="text-muted-foreground px-2 pt-3 text-[11px]">
          <span className="dense-meta">${spendToday.toFixed(2)}</span> today
        </div>
      )}

      <div
        className={cn(
          'flex items-center pt-3',
          collapsed ? 'justify-center' : 'justify-between px-2'
        )}
      >
        {!collapsed && (
          <span className="text-muted-foreground text-[11px]">
            <Kbd className={FOOTER_HINT_CLASS}>⌘K</Kbd> to jump anywhere
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
              aria-controls="dispatch-sidebar"
              onClick={() => toggleSidebar()}
              className="text-muted-foreground hover:text-foreground shrink-0 transition-colors duration-150"
            >
              {collapsed ? (
                <ChevronRight className="size-4" />
              ) : (
                <ChevronLeft className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          </TooltipContent>
        </Tooltip>
      </div>
    </>
  );

  return (
    <SidebarRoot
      id="dispatch-sidebar"
      collapsible="icon"
      className="absolute h-full"
    >
      {/* `w-full`: the shadcn shell already animates its own container between
          `--sidebar-width`/`--sidebar-width-icon` (see `ui/sidebar.tsx`'s
          `sidebar-gap`/`sidebar-container`), so this fills that box instead of also
          animating its own `w-60`/`w-14` in parallel and drifting out of sync with it. */}
      <SidebarNav
        sections={sections}
        activeId={activeId}
        onSelect={handleSelect}
        footer={footer}
        collapsed={collapsed}
        className="w-full"
      />
    </SidebarRoot>
  );
}
