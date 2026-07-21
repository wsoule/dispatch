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

interface SidebarProps {
  /** Basename of the single project this window is scoped to, or `null` before
   * `currentProjectRoot()` has resolved. There is no switcher anymore — this app is a
   * workspace for one project, not a project picker. */
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
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark">D</span>
        Dispatch
      </div>

      <div className="sidebar-section-label">Project</div>
      {projectName !== null ? (
        <div
          className="sidebar-project-current"
          title={projectPath ?? undefined}
        >
          <span
            className="sidebar-project-dot"
            style={{ background: colorForProject(projectName) }}
          />
          <span className="sidebar-project-name">{projectName}</span>
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
