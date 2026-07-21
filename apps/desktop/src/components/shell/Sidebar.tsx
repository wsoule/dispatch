import type { GlobalView, ProjectView } from '../../lib/appNav';
import { colorForProject } from '../../lib/projectColor';
import './Sidebar.css';

const PROJECT_VIEWS: { id: ProjectView; label: string; icon: string }[] = [
  { id: 'board', label: 'Board', icon: '▦' },
  { id: 'tasks', label: 'Tasks', icon: '☑' },
  { id: 'runs', label: 'Runs', icon: '▶' },
  { id: 'plans', label: 'Plans', icon: '✎' },
];

const GLOBAL_VIEWS: { id: GlobalView; label: string; icon: string }[] = [
  { id: 'all-agents', label: 'All Agents', icon: '◉' },
  { id: 'sessions', label: 'Sessions', icon: '◷' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
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
 * Sessions/Settings) below a divider.
 */
export function Sidebar({
  projectName,
  projectPath,
  hasActiveProject,
  section,
  projectView,
  globalView,
  liveAgentCount,
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
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark">D</span>
        Dispatch
      </div>

      <div className="sidebar-section-label">Project</div>
      {projectName !== null ? (
        <div className="sidebar-project-switcher">
          <button
            type="button"
            className="sidebar-project-current"
            title={projectPath ?? undefined}
            aria-haspopup="listbox"
            aria-expanded={switcherOpen}
            onClick={onToggleSwitcher}
          >
            <span
              className="sidebar-project-dot"
              style={{ background: colorForProject(projectName) }}
            />
            <span className="sidebar-project-name">{projectName}</span>
            <span className="sidebar-project-caret">
              {switcherOpen ? '▴' : '▾'}
            </span>
          </button>
          {switcherOpen && (
            <div className="sidebar-project-menu" role="listbox">
              <div
                className="sidebar-project-menu-active"
                role="option"
                aria-selected="true"
              >
                <span
                  className="sidebar-project-dot"
                  style={{ background: colorForProject(projectName) }}
                />
                {projectName}
                <span className="sidebar-project-menu-check">✓</span>
              </div>
              {otherProjects.length === 0 ? (
                <div className="sidebar-project-menu-empty">
                  No other dispatch projects
                </div>
              ) : (
                otherProjects.map((p) => (
                  <button
                    key={p.path}
                    type="button"
                    className="sidebar-project-menu-item"
                    role="option"
                    aria-selected="false"
                    title={p.path}
                    onClick={() => onSelectProject(p.path)}
                  >
                    <span
                      className="sidebar-project-dot"
                      style={{ background: colorForProject(p.name) }}
                    />
                    {p.name}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      ) : (
        <p className="sidebar-project-empty">Resolving project…</p>
      )}

      <div className="sidebar-section-label">Workspace</div>
      <nav>
        {PROJECT_VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`sidebar-nav-item${
              section === 'project' && projectView === item.id ? ' active' : ''
            }${!hasActiveProject ? ' disabled' : ''}`}
            disabled={!hasActiveProject}
            onClick={() => onSetProjectView(item.id)}
          >
            <span className="sidebar-nav-icon">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>

      <div className="sidebar-divider" />

      <nav>
        {GLOBAL_VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`sidebar-nav-item${
              section === 'global' && globalView === item.id ? ' active' : ''
            }`}
            onClick={() => onSetGlobalView(item.id)}
          >
            <span className="sidebar-nav-icon">{item.icon}</span>
            {item.label}
            {item.id === 'all-agents' && liveAgentCount > 0 && (
              <span className="sidebar-nav-badge">{liveAgentCount}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <kbd className="sidebar-footer-kbd">⌘K</kbd> to jump anywhere
      </div>
    </aside>
  );
}
