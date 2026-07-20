import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { ProjectBoard } from '../components/board/ProjectBoard';
import { ActivityHeatmap } from '../components/ui/ActivityHeatmap';
import { StatTile } from '../components/ui/StatTile';
import { formatRelativeTime } from '../lib/format';
import { getProjectGitInsights, listSessions } from '../lib/tauri';
import type { ProjectSummary } from '../lib/types';
import { SessionDetailModal } from './SessionDetailModal';
import { SessionRow } from './SessionRow';
import './ProjectDetail.css';

interface ProjectDetailProps {
  project: ProjectSummary;
}

type ProjectTab = 'overview' | 'board' | 'sessions';

const TABS: { id: ProjectTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'board', label: 'Board' },
  { id: 'sessions', label: 'Sessions' },
];

/**
 * Full-page detail shown in `ProjectsView` once a project card is clicked. Three tabs
 * (Overview / Board / Sessions) behind a top tab bar rather than one long scrolling
 * column — the Kanban board in particular wants its own uncluttered page. Reuses
 * `SessionRow` (shared with `SessionsView`) rather than re-implementing row rendering
 * here, and `ProjectBoard` (shared with the old standalone Board page) for the Kanban tab.
 */
export function ProjectDetail({ project }: ProjectDetailProps) {
  const [activeTab, setActiveTab] = useState<ProjectTab>('overview');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );

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
        {TABS.map((tab) => (
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
