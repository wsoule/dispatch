import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { ProjectBoard } from '../components/board/ProjectBoard';
import { TasksPanel } from '../components/tasks/TasksPanel';
import { ActivityHeatmap } from '../components/ui/ActivityHeatmap';
import { StatTile } from '../components/ui/StatTile';
import { formatRelativeTime } from '../lib/format';
import { getProjectGitInsights, hasDispatch, listSessions } from '../lib/tauri';
import type { ProjectSummary } from '../lib/types';
import { SessionDetailModal } from './SessionDetailModal';
import { SessionRow } from './SessionRow';
import './ProjectDetail.css';

interface ProjectDetailProps {
  project: ProjectSummary;
  /** Which tab opens first — defaults to 'overview'. TasksView jumps straight to 'tasks'
   * when it opens a dispatch-enabled project from the global Tasks nav item. */
  initialTab?: ProjectTab;
}

type ProjectTab = 'overview' | 'board' | 'sessions' | 'tasks';

const BASE_TABS: { id: ProjectTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'board', label: 'Board' },
  { id: 'sessions', label: 'Sessions' },
];

/**
 * Full-page detail shown in `ProjectsView` once a project card is clicked. Tabs (Overview /
 * Board / Sessions, plus Tasks when the project has a `.dispatch/` tracker) behind a top tab
 * bar rather than one long scrolling column — the Kanban board in particular wants its own
 * uncluttered page. Reuses `SessionRow` (shared with `SessionsView`) rather than
 * re-implementing row rendering here, `ProjectBoard` (shared with the old standalone Board
 * page) for the Kanban tab, and `TasksPanel` (Phase 2R Slice R2) for the dispatchd-backed
 * Tasks tab.
 */
export function ProjectDetail({
  project,
  initialTab = 'overview',
}: ProjectDetailProps) {
  const [activeTab, setActiveTab] = useState<ProjectTab>(initialTab);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );

  // Gates the Tasks tab: only dispatch-enabled projects (those with a `.dispatch/`
  // directory) get one. `retry: false` — a failure here (e.g. the path no longer exists)
  // should just leave the tab hidden, not retry noisily.
  const { data: dispatchEnabled } = useQuery({
    queryKey: ['has-dispatch', project.path],
    queryFn: () => hasDispatch(project.path),
    retry: false,
  });

  const tabs = dispatchEnabled
    ? [...BASE_TABS, { id: 'tasks' as const, label: 'Tasks' }]
    : BASE_TABS;

  const {
    data: sessions,
    isLoading,
    isError,
  } = useQuery({ queryKey: ['sessions'], queryFn: listSessions });

  const { data: gitInsights } = useQuery({
    queryKey: ['project-git-insights', project.path],
    queryFn: () => getProjectGitInsights(project.path),
    retry: false,
  });

  const projectSessions = useMemo(
    () =>
      sessions?.filter((session) => session.project_id === project.id) ?? [],
    [sessions, project.id]
  );

  return (
    <div className="project-detail">
      <div className="project-detail-header">
        <h1 className="project-detail-name">{project.name}</h1>
        <div className="project-detail-path">{project.path}</div>
      </div>

      <div className="project-detail-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`project-detail-tab${activeTab === tab.id ? ' project-detail-tab-active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="project-detail-overview">
          <div className="project-detail-stats">
            <StatTile value={project.session_count} label="Sessions" />
            <StatTile
              value={`$${project.total_cost_usd.toFixed(2)}`}
              label="Total cost"
            />
          </div>

          <ActivityHeatmap data={gitInsights?.commit_heatmap ?? []} />

          <div className="project-detail-commits">
            <h2 className="project-detail-commits-title">Recent commits</h2>

            {!gitInsights && (
              <p className="project-detail-status">Loading commit history…</p>
            )}

            {gitInsights && gitInsights.recent_commits.length === 0 && (
              <p className="project-detail-status">
                No git history detected for this project.
              </p>
            )}

            {gitInsights && gitInsights.recent_commits.length > 0 && (
              <ul className="project-detail-commit-list">
                {gitInsights.recent_commits.map((commit) => (
                  <li key={commit.hash} className="project-detail-commit">
                    <span className="project-detail-commit-hash">
                      {commit.hash}
                    </span>
                    <span className="project-detail-commit-message">
                      {commit.message}
                    </span>
                    <span className="project-detail-commit-meta">
                      {commit.author} · {formatRelativeTime(commit.timestamp)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {activeTab === 'board' && (
        <div className="project-detail-board">
          <ProjectBoard projectId={project.id} />
        </div>
      )}

      {activeTab === 'tasks' && dispatchEnabled && (
        <div className="project-detail-tasks">
          <TasksPanel projectPath={project.path} />
        </div>
      )}

      {activeTab === 'sessions' && (
        <div className="project-detail-sessions">
          {isLoading && (
            <p className="project-detail-status">Loading sessions…</p>
          )}

          {isError && (
            <p className="project-detail-status">Couldn't load sessions.</p>
          )}

          {!isLoading && !isError && projectSessions.length === 0 && (
            <p className="project-detail-status">
              No sessions yet for this project.
            </p>
          )}

          {!isLoading && !isError && projectSessions.length > 0 && (
            <div className="project-detail-session-list">
              {projectSessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  projectName={project.name}
                  onClick={() => setSelectedSessionId(session.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <SessionDetailModal
        sessionId={selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
      />
    </div>
  );
}
