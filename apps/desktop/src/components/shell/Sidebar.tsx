import {
  Check,
  ChevronsUpDown,
  Cog,
  GitPullRequest,
  ListChecks,
  NotebookPen,
  Play,
  Radar,
} from 'lucide-react';

import type { GlobalView, ProjectView } from '../../lib/appNav';
import { colorForProject } from '../../lib/projectColor';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  { id: 'board', label: 'Tasks', icon: ListChecks },
  { id: 'runs', label: 'Runs', icon: Play },
  { id: 'pull-requests', label: 'Pull requests', icon: GitPullRequest },
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
}: SidebarProps) {
  // Other dispatch-enabled projects to show in the dropdown, excluding the one
  // already active.
  const otherProjects = switchProjects.filter((p) => p.path !== projectPath);

  return (
    <aside className="border-border bg-background flex w-60 shrink-0 flex-col overflow-y-auto border-r px-3 py-4">
      <div className="text-foreground mb-4 flex items-center gap-2 px-2 font-mono text-[13px] font-semibold">
        <span className="bg-primary text-primary-foreground inline-flex size-5 items-center justify-center rounded-md text-[11px]">
          D
        </span>
        Dispatch
      </div>

      <div className="text-muted-foreground px-2 pt-1 pb-1.5 text-[11px] font-medium tracking-wide uppercase">
        Project
      </div>
      {projectName !== null ? (
        <DropdownMenu
          open={switcherOpen}
          onOpenChange={() => onToggleSwitcher()}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={projectPath ?? undefined}
              className="text-foreground hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors duration-150"
            >
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: colorForProject(projectName) }}
              />
              <span className="min-w-0 flex-1 truncate">{projectName}</span>
              <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" />
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
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <p className="text-muted-foreground px-2 text-[13px]">
          Resolving project…
        </p>
      )}

      <div className="text-muted-foreground px-2 pt-3 pb-1.5 text-[11px] font-medium tracking-wide uppercase">
        Workspace
      </div>
      <nav className="flex flex-col gap-0.5">
        {PROJECT_VIEWS.map((item) => {
          const Icon = item.icon;
          const active = section === 'project' && projectView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              disabled={!hasActiveProject}
              onClick={() => onSetProjectView(item.id)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150',
                active
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-foreground/80 hover:bg-accent/60',
                !hasActiveProject &&
                  'pointer-events-none text-muted-foreground/50'
              )}
            >
              <Icon className="size-4 shrink-0" strokeWidth={2} />
              <span className="flex-1">{item.label}</span>
              {item.id === 'pull-requests' && prCount > 0 && (
                <span className="bg-secondary text-secondary-foreground flex min-w-[1.1rem] items-center justify-center rounded-full px-1 text-[10px] font-medium">
                  {prCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="bg-border my-3 h-px" />

      <nav className="flex flex-col gap-0.5">
        {GLOBAL_VIEWS.map((item) => {
          const Icon = item.icon;
          const active = section === 'global' && globalView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSetGlobalView(item.id)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150',
                active
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-foreground/80 hover:bg-accent/60'
              )}
            >
              <Icon className="size-4 shrink-0" strokeWidth={2} />
              <span className="flex-1">{item.label}</span>
              {item.id === 'all-agents' && liveAgentCount > 0 && (
                <span className="bg-primary text-primary-foreground flex min-w-[1.1rem] items-center justify-center rounded-full px-1 text-[10px] font-medium">
                  {liveAgentCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="text-muted-foreground mt-auto px-2 pt-3 text-[11px]">
        <kbd className="border-border bg-secondary rounded border px-1 py-0.5 font-mono text-[10px]">
          ⌘K
        </kbd>{' '}
        to jump anywhere
      </div>
    </aside>
  );
}
