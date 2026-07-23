import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Cog,
  GitPullRequest,
  LayoutDashboard,
  ListChecks,
  NotebookPen,
  Play,
  Plus,
  Radar,
  StickyNote,
  Target,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import type { GlobalView, ProjectView } from '../../lib/appNav';
import { colorForProject } from '../../lib/projectColor';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';

// `board` hosts both the Kanban and dense-list layouts behind its own in-view toggle now (see
// `BoardView`), so it gets one "Tasks" row rather than the old separate Board/Tasks pair —
// Linear itself doesn't split those into two nav destinations either.
const PROJECT_VIEWS: {
  id: ProjectView;
  label: string;
  icon: typeof ListChecks;
}[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'board', label: 'Tasks', icon: ListChecks },
  { id: 'milestones', label: 'Milestones', icon: Target },
  { id: 'runs', label: 'Runs', icon: Play },
  { id: 'pull-requests', label: 'Pull requests', icon: GitPullRequest },
  { id: 'notes', label: 'Notes & triage', icon: StickyNote },
  { id: 'plans', label: 'Plans', icon: NotebookPen },
];

const GLOBAL_VIEWS: { id: GlobalView; label: string; icon: typeof Radar }[] = [
  { id: 'all-agents', label: 'All Agents', icon: Radar },
  { id: 'sessions', label: 'Sessions', icon: Play },
  { id: 'settings', label: 'Settings', icon: Cog },
];

export interface SwitchProject {
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
  /** Count of runs with an open PR — the "Pull requests" nav badge. */
  prCount: number;
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
  /** Opens the add-project dialog (local folder or GitHub clone) — the last item in the
   * switcher dropdown. */
  onAddProject: () => void;
}

/**
 * Persistent, Linear-style left rail: wordmark, the one active project's name (not a
 * switcher — this app pivoted from a multi-project switcher to a single-project workspace),
 * that project's primary nav (Board/Tasks/Runs/Plans), and the global section (All Agents/
 * Sessions/Settings) below a divider. Restyled onto shadcn's `DropdownMenu` for the project
 * switcher (same open/select props/behavior as the hand-rolled version it replaces) and
 * lucide icons for every nav row.
 */
export function Sidebar({
  projectName,
  projectPath,
  hasActiveProject,
  section,
  projectView,
  globalView,
  liveAgentCount,
  prCount,
  onSetProjectView,
  onSetGlobalView,
  switcherOpen,
  onToggleSwitcher,
  switchProjects,
  onSelectProject,
  onAddProject,
}: SidebarProps) {
  // Other dispatch-enabled projects to show in the dropdown, excluding the one
  // already active.
  const otherProjects = switchProjects.filter((p) => p.path !== projectPath);

  // Collapsed rail state — narrows the sidebar to icon-only so a deeply nested project (many
  // Workspace rows) doesn't dominate the window. Read from localStorage once on mount and
  // written back on every change so the choice survives a reload.
  const [collapsed, setCollapsed] = useState(readStoredSidebarCollapsed);
  useEffect(() => {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      collapsed ? '1' : '0'
    );
  }, [collapsed]);

  return (
    <aside
      className={cn(
        'border-border bg-background flex shrink-0 flex-col overflow-y-auto border-r py-4 transition-[width] duration-150',
        collapsed ? 'w-14 items-center px-2' : 'w-60 px-3'
      )}
    >
      <div
        className={cn(
          'text-foreground mb-4 flex items-center font-mono text-[13px] font-semibold',
          collapsed ? 'justify-center' : 'gap-2 px-2'
        )}
      >
        {/* The Hydrogen mark — a circle with an orbiting satellite node, matching the app
            icon (see app-icon.svg). White tile + black mark so it reads at 20px in both themes. */}
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

      {!collapsed && (
        <div className="text-muted-foreground px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-wide uppercase">
          Project
        </div>
      )}
      {projectName !== null ? (
        <DropdownMenu
          open={switcherOpen}
          onOpenChange={() => onToggleSwitcher()}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={projectPath ?? projectName}
              className={cn(
                'text-foreground hover:bg-accent flex items-center rounded-md py-1.5 text-left text-[13px] font-medium transition-colors duration-150',
                collapsed ? 'w-full justify-center' : 'w-full gap-2 px-2'
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
            </button>
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
      ) : (
        !collapsed && (
          <p className="text-muted-foreground px-2 text-[13px]">
            Resolving project…
          </p>
        )
      )}

      {!collapsed && (
        <div className="text-muted-foreground px-2 pt-3 pb-1.5 text-[11px] font-medium tracking-wide uppercase">
          Workspace
        </div>
      )}
      <nav className={cn('flex w-full flex-col gap-0.5', collapsed && 'mt-3')}>
        {PROJECT_VIEWS.map((item) => {
          const Icon = item.icon;
          const active = section === 'project' && projectView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              title={item.label}
              disabled={!hasActiveProject}
              onClick={() => onSetProjectView(item.id)}
              className={cn(
                'flex items-center rounded-md py-1.5 text-left text-[13px] transition-colors duration-150',
                collapsed ? 'w-full justify-center' : 'w-full gap-2 px-2',
                active
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-foreground/80 hover:bg-accent/60',
                !hasActiveProject &&
                  'pointer-events-none text-muted-foreground/50'
              )}
            >
              <Icon className="size-4 shrink-0" strokeWidth={2} />
              {!collapsed && (
                <>
                  <span className="flex-1">{item.label}</span>
                  {item.id === 'pull-requests' && prCount > 0 && (
                    <span className="bg-secondary text-secondary-foreground flex min-w-[1.1rem] items-center justify-center rounded-full px-1 text-[10px] font-medium">
                      {prCount}
                    </span>
                  )}
                </>
              )}
            </button>
          );
        })}
      </nav>

      <div className="bg-border my-3 h-px w-full" />

      <nav className="flex w-full flex-col gap-0.5">
        {GLOBAL_VIEWS.map((item) => {
          const Icon = item.icon;
          const active = section === 'global' && globalView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              title={item.label}
              onClick={() => onSetGlobalView(item.id)}
              className={cn(
                'flex items-center rounded-md py-1.5 text-left text-[13px] transition-colors duration-150',
                collapsed ? 'w-full justify-center' : 'w-full gap-2 px-2',
                active
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-foreground/80 hover:bg-accent/60'
              )}
            >
              <Icon className="size-4 shrink-0" strokeWidth={2} />
              {!collapsed && (
                <>
                  <span className="flex-1">{item.label}</span>
                  {item.id === 'all-agents' && liveAgentCount > 0 && (
                    <span className="bg-primary text-primary-foreground flex min-w-[1.1rem] items-center justify-center rounded-full px-1 text-[10px] font-medium">
                      {liveAgentCount}
                    </span>
                  )}
                </>
              )}
            </button>
          );
        })}
      </nav>

      <div
        className={cn(
          'mt-auto flex items-center pt-3',
          collapsed ? 'justify-center' : 'justify-between px-2'
        )}
      >
        {!collapsed && (
          <span className="text-muted-foreground text-[11px]">
            <kbd className="border-border bg-secondary rounded border px-1 py-0.5 font-mono text-[10px]">
              ⌘K
            </kbd>{' '}
            to jump anywhere
          </span>
        )}
        <button
          type="button"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={() => setCollapsed((value) => !value)}
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex shrink-0 items-center justify-center rounded-md p-1 transition-colors duration-150"
        >
          {collapsed ? (
            <ChevronRight className="size-4" />
          ) : (
            <ChevronLeft className="size-4" />
          )}
        </button>
      </div>
    </aside>
  );
}
