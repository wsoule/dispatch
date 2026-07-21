import type { GlobalView, ProjectView } from '../../lib/appNav';
import { colorForProject } from '../../lib/projectColor';
import type { ProjectSummary } from '../../lib/types';
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
  dispatchProjects: ProjectSummary[];
  otherProjects: ProjectSummary[];
  activeProjectId: string | null;
  section: 'project' | 'global';
  projectView: ProjectView;
  globalView: GlobalView;
  /** Count of non-terminal runs across every dispatch-enabled project — the "All Agents"
   * badge, so you can tell something is live without leaving whatever you're looking at. */
  liveAgentCount: number;
  onSelectProject: (projectId: string) => void;
  /** A project without a `.dispatch/` tracker was clicked — routes to the get-started flow
   * scoped to that project rather than doing nothing (no dead buttons in the switcher). */
  onSelectUninitialized: (project: ProjectSummary) => void;
  onSetProjectView: (view: ProjectView) => void;
  onSetGlobalView: (view: GlobalView) => void;
}

/**
 * Persistent, Linear-style left rail: wordmark, a project switcher (dispatch-enabled
 * projects first, everything else greyed under "no tracker"), the active project's primary
 * nav (Board/Tasks/Runs/Plans), and the global section (All Agents/Sessions/Settings) below
 * a divider. Replaces the old flat `nav/Sidebar.tsx` — there is no more single global "Tasks"
 * nav item that browses every project; picking a project here *is* the navigation.
 */
export function Sidebar({
  dispatchProjects,
  otherProjects,
  activeProjectId,
  section,
  projectView,
  globalView,
  liveAgentCount,
  onSelectProject,
  onSelectUninitialized,
  onSetProjectView,
  onSetGlobalView,
}: SidebarProps) {
  const hasActiveProject = activeProjectId !== null;

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-mark">D</span>
        Dispatch
      </div>

      <div className="sidebar-section-label">Projects</div>
      <nav className="sidebar-project-list">
        {dispatchProjects.map((project) => (
          <button
            key={project.id}
            type="button"
            className={`sidebar-project-item${
              activeProjectId === project.id ? ' active' : ''
            }`}
            onClick={() => onSelectProject(project.id)}
          >
            <span
              className="sidebar-project-dot"
              style={{ background: colorForProject(project.id) }}
            />
            <span className="sidebar-project-name">{project.name}</span>
          </button>
        ))}
        {otherProjects.map((project) => (
          <button
            key={project.id}
            type="button"
            className="sidebar-project-item sidebar-project-item-uninitialized"
            onClick={() => onSelectUninitialized(project)}
            title="No tracker — initialize dispatch in this project"
          >
            <span className="sidebar-project-dot sidebar-project-dot-empty" />
            <span className="sidebar-project-name">{project.name}</span>
            <span className="sidebar-project-tag">no tracker</span>
          </button>
        ))}
        {dispatchProjects.length === 0 && otherProjects.length === 0 && (
          <p className="sidebar-project-empty">No projects found yet.</p>
        )}
      </nav>

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
