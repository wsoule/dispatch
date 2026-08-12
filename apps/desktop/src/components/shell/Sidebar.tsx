import type { DraftRecord, SyncStatus } from '@dispatch/client';
import {
  Bell,
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
  ListChecks,
  NotebookPen,
  Palette,
  Play,
  Plus,
  Radar,
  Shield,
  Waypoints,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { GlobalView, ProjectView } from '../../lib/appNav';
import { colorForProject } from '../../lib/projectColor';
import { DraftTray } from './DraftTray';
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
  DropdownMenuSeparator,
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
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
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

// The notifications bell is not a `ProjectView`/`GlobalView` — it toggles the inbox popover
// rather than selecting a page — so it gets an id of its own, routed by `handleSelect` below
// instead of `onSetProjectView`/`onSetGlobalView`.
const NOTIFICATIONS_ID = 'notifications';

interface SwitchProject {
  path: string;
  name: string;
}

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
  /** Basename of the single active project, or `null` before it has resolved. One project is
   * active at a time (single-project focus), but the row is a dropdown you can switch with. */
  projectName: string | null;
  /** Full path, shown as a tooltip on the project row so the exact root is always checkable
   * even though only the basename is displayed. */
  projectPath: string | null;
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
  /** Total spend across today's runs, or `null` to show nothing. Rendered at the foot of the
   * rail rather than in the window titlebar, which Tauri owns — same information, somewhere
   * this app can actually put it. */
  spendToday: number | null;
  /** Count of unread notification-inbox entries — the bell's badge (see InboxPanel/inbox.ts).
   * The bell itself is not a nav row (it doesn't select a `ProjectView`/`GlobalView`); it
   * toggles the inbox popover via `onToggleInbox` instead. */
  unreadCount: number;
  onToggleInbox: () => void;
  /** Every AI task draft currently held in memory, newest first — feeds the drafts tray
   * rendered next to the notifications bell (see `components/shell/DraftTray.tsx`). */
  drafts: DraftRecord[];
  /** Opens the review dialog for a ready draft. */
  onOpenDraft: (id: string) => void;
  onDismissDraft: (id: string) => void;
  onSetProjectView: (view: ProjectView) => void;
  onSetGlobalView: (view: GlobalView) => void;
  /** Whether the project switcher dropdown is open (its project list is loaded lazily on
   * open — see App). */
  switcherOpen: boolean;
  onToggleSwitcher: () => void;
  /** Other dispatch-enabled projects to offer in the dropdown; empty until the list resolves
   * (or always empty in the browser dev harness, where only the active project is reachable). */
  switchProjects: SwitchProject[];
  onSelectProject: (path: string) => void;
  /** The board syncer's status — `null` until it has ever loaded, in which case the chip
   * renders nothing. */
  syncStatus: SyncStatus | null;
  /** Flips `.dispatch/config.yml`'s `autoCommit` off — the sync chip's kill switch. */
  onDisableAutoCommit: () => void;
  /** True once project resolution has settled with no active project (a genuine first run:
   * empty registry, no launch arg, no dev checkout above the binary) — swaps the "Resolving
   * project…" placeholder for an actionable "Add project…" row instead of leaving the sidebar
   * stuck on a spinner with no way forward. `false` both before resolution settles and once a
   * project is active. */
  noProjectYet: boolean;
  /** Opens the add-project dialog (local folder or GitHub clone) — the last item in the
   * switcher dropdown, and also the first-run "Add project…" row when `noProjectYet`. */
  onAddProject: () => void;
}

/**
 * Persistent, Linear-style left rail: wordmark, the one active project's name (not a
 * switcher — this app pivoted from a multi-project switcher to a single-project workspace),
 * that project's primary nav (Board/Tasks/Runs/Plans), and the global section (All Agents/
 * Sessions/Settings) below it. Built on the `SidebarNav` primitive (`ui/ai/sidebar-nav.tsx`)
 * for its rows/sections, still wrapped in the shadcn `Sidebar` shell purely for the
 * fixed-position/icon-collapse/mobile mechanics App.tsx's `SidebarProvider` already owns —
 * this reads that back through `useSidebar` so the icon-only strip still works.
 */
export function Sidebar({
  projectName,
  projectPath,
  hasActiveProject,
  section,
  projectView,
  globalView,
  liveAgentCount,
  badges,
  spendToday,
  unreadCount,
  onToggleInbox,
  drafts,
  onOpenDraft,
  onDismissDraft,
  onSetProjectView,
  onSetGlobalView,
  switcherOpen,
  onToggleSwitcher,
  switchProjects,
  onSelectProject,
  syncStatus,
  onDisableAutoCommit,
  noProjectYet,
  onAddProject,
}: SidebarProps) {
  // Other dispatch-enabled projects to show in the dropdown, excluding the one
  // already active.
  const otherProjects = switchProjects.filter((p) => p.path !== projectPath);

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
        } satisfies SidebarNavItem;
      }),
    })
  );

  const globalItems: SidebarNavItem[] = [
    {
      id: NOTIFICATIONS_ID,
      label: 'Notifications',
      icon: <Bell strokeWidth={2} />,
      count:
        unreadCount > 0 ? (unreadCount > 99 ? '99+' : unreadCount) : undefined,
      state: unreadCount > 0 ? 'attention' : undefined,
      ariaLabel: `Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`,
    },
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

  // `SidebarNav` has one `onSelect(id)` for every row; the notifications row isn't a
  // navigation target (it toggles the inbox popover), so it's routed here instead of into
  // `onSetProjectView`/`onSetGlobalView`.
  const handleSelect = useCallback(
    (id: string) => {
      if (id === NOTIFICATIONS_ID) {
        onToggleInbox();
        return;
      }
      if ((PROJECT_VIEW_ORDER as string[]).includes(id)) {
        onSetProjectView(id as ProjectView);
        return;
      }
      onSetGlobalView(id as GlobalView);
    },
    [onToggleInbox, onSetProjectView, onSetGlobalView]
  );

  const header = (
    <>
      {/* The Hydrogen mark — a circle with an orbiting satellite node, matching the app icon
        (see app-icon.svg). White tile + black mark so it reads at 20px in both themes. */}
      <div
        className={cn(
          'text-foreground mb-2 flex items-center font-mono text-[13px] font-semibold',
          collapsed ? 'justify-center' : 'gap-2 px-2'
        )}
      >
        <span className="border-border inline-flex size-5 shrink-0 items-center justify-center rounded-md border bg-white">
          <svg
            viewBox="0 0 34 36"
            className="size-3.5"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M17 0C26.3888 0 34 7.61116 34 17C34 19.6624 33.3869 22.1813 32.2959 24.4248C33.3569 25.6519 34 27.2505 34 29C34 32.866 30.866 36 27 36C24.7943 36 22.828 34.979 21.5449 33.3848C20.0982 33.7852 18.5742 34 17 34C7.61116 34 0 26.3888 0 17C0 13.7085 0.935188 10.6354 2.55469 8.03223C2.20259 7.43659 2 6.74205 2 6C2 3.79086 3.79086 2 6 2C6.74205 2 7.43659 2.20259 8.03223 2.55469C10.6354 0.935188 13.7085 0 17 0ZM17 3.40039C14.4188 3.40039 12.0051 4.11849 9.94922 5.36719C9.98199 5.57335 10 5.78461 10 6C10 8.20914 8.20914 10 6 10C5.78461 10 5.57335 9.98199 5.36719 9.94922C4.11849 12.0051 3.40039 14.4188 3.40039 17C3.40039 24.5111 9.48893 30.5996 17 30.5996C18.0707 30.5996 19.112 30.4741 20.1113 30.2402C20.0393 29.8376 20 29.4233 20 29C20 25.134 23.134 22 27 22C27.8672 22 28.6974 22.158 29.4639 22.4463C30.1936 20.7786 30.5996 18.9369 30.5996 17C30.5996 9.48893 24.5111 3.40039 17 3.40039Z"
              fill="#000000"
            />
          </svg>
        </span>
        {!collapsed && 'Dispatch'}
      </div>

      {!collapsed && <div className="dense-label px-2 pb-1">Project</div>}

      {projectName !== null ? (
        <DropdownMenu
          open={switcherOpen}
          onOpenChange={() => onToggleSwitcher()}
        >
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              title={projectPath ?? projectName}
              aria-label={
                collapsed
                  ? `Switch project (current: ${projectName})`
                  : undefined
              }
              className={cn(
                'h-auto rounded-md py-1.5 text-left text-[13px] font-medium text-foreground hover:text-foreground transition-colors duration-150',
                collapsed
                  ? 'w-full px-0 has-[>svg]:px-0'
                  : 'w-full justify-start px-2 has-[>svg]:px-2'
              )}
            >
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: colorForProject(projectName) }}
              />
              {!collapsed && (
                <>
                  <span className="min-w-0 flex-1 truncate">{projectName}</span>
                  <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" />
                </>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem disabled className="text-muted-foreground">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: colorForProject(projectName) }}
              />
              <span className="text-foreground min-w-0 flex-1 truncate">
                {projectName}
              </span>
              <Check className="text-primary size-3.5" />
            </DropdownMenuItem>
            {otherProjects.length === 0 ? (
              <div className="text-muted-foreground px-2 py-1.5 text-[12px]">
                No other dispatch projects
              </div>
            ) : (
              otherProjects.map((p) => (
                <DropdownMenuItem
                  key={p.path}
                  title={p.path}
                  onSelect={() => onSelectProject(p.path)}
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: colorForProject(p.name) }}
                  />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onAddProject()}>
              <Plus className="text-muted-foreground size-3.5" />
              <span className="flex-1">Add project</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : noProjectYet ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => onAddProject()}
          className={cn(
            'h-auto rounded-md py-1.5 text-left text-[13px] font-normal text-muted-foreground hover:text-foreground transition-colors duration-150',
            collapsed
              ? 'w-full px-0 has-[>svg]:px-0'
              : 'w-full justify-start px-2 has-[>svg]:px-2'
          )}
        >
          <Plus className="size-3.5 shrink-0" />
          {!collapsed && <span className="flex-1">Add project…</span>}
        </Button>
      ) : (
        !collapsed && (
          <p className="text-muted-foreground px-2 text-[13px]">
            Resolving project…
          </p>
        )
      )}
    </>
  );

  const footer = (
    <>
      <DraftTray
        drafts={drafts}
        collapsed={collapsed}
        onOpenDraft={onOpenDraft}
        onDismissDraft={onDismissDraft}
      />

      {/* The board syncer's status. Hidden when collapsed, same as the spend line below — an
          icon-only rail has no room for a sentence. */}
      {!collapsed && hasActiveProject && (
        <SyncChip
          status={syncStatus}
          onDisableAutoCommit={onDisableAutoCommit}
        />
      )}

      {/* Today's spend. The mockup put this in the window titlebar, which Tauri owns and this
          app cannot draw into — the foot of the rail is the same glanceable place we can
          actually reach. Hidden entirely at zero rather than showing "$0.00": a running cost
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
        header={header}
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
