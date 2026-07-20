import { useQuery } from '@tanstack/react-query';

import { ActivityHeatmap } from '../components/ui/ActivityHeatmap';
import { ProjectDot } from '../components/ui/ProjectDot';
import { StatTile } from '../components/ui/StatTile';
import { agentMeta, KNOWN_AGENT_IDS } from '../lib/agents';
import { sessionDisplayName } from '../lib/format';
import { colorForProject } from '../lib/projectColor';
import { getDashboardStats } from '../lib/tauri';
import type { AgentUsage } from '../lib/types';
import './DashboardView.css';

export function DashboardView() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['dashboard'],
    queryFn: getDashboardStats,
  });

  if (isLoading) {
    return <p className="dashboard-view-status">Loading dashboard…</p>;
  }

  if (isError || !data) {
    return (
      <p className="dashboard-view-status">
        Couldn't load dashboard stats. Is the backend running?
      </p>
    );
  }

  const usageByAgent = new Map<string, AgentUsage>(
    data.agent_usage.map((u) => [u.agent, u])
  );
  const topProject = data.top_projects[0];

  return (
    <div className="dashboard-view">
      <h1 className="view-topbar-title">Dashboard</h1>

      <div className="dashboard-stats-row">
        <StatTile
          value={`$${data.total_cost_usd.toFixed(2)}`}
          label="Total spend"
        />
        <StatTile value={data.total_sessions} label="Total sessions" />
        <StatTile value={data.total_projects} label="Active projects" />
        <StatTile
          value={topProject ? topProject.name : '—'}
          label="Highest usage project"
        />
      </div>

      <section className="dashboard-section">
        <h2 className="dashboard-section-title">Active now</h2>
        <div className="dashboard-card dashboard-active-now">
          {data.active_session ? (
            <>
              <ProjectDot projectId={data.active_session.project_id} />
              <div className="dashboard-active-now-info">
                <span className="dashboard-active-now-project">
                  {data.active_session.project_name}
                </span>
                <span className="dashboard-active-now-session">
                  {sessionDisplayName(
                    data.active_session.session_title,
                    data.active_session.session_summary
                  )}
                </span>
              </div>
            </>
          ) : (
            <p className="dashboard-view-status">
              No active session right now.
            </p>
          )}
        </div>
      </section>

      <section className="dashboard-section">
        <h2 className="dashboard-section-title">Activity</h2>
        <div className="dashboard-card">
          <ActivityHeatmap data={data.daily_activity} />
        </div>
      </section>

      <div className="dashboard-columns">
        <section className="dashboard-section dashboard-column">
          <h2 className="dashboard-section-title">Highest usage projects</h2>
          <div className="dashboard-card dashboard-project-list">
            {data.top_projects.length === 0 && (
              <p className="dashboard-view-status">No projects yet.</p>
            )}
            {data.top_projects.map((project, i) => {
              const maxCost = data.top_projects[0]?.total_cost_usd || 1;
              const pct =
                maxCost > 0 ? (project.total_cost_usd / maxCost) * 100 : 0;
              return (
                <div className="dashboard-project-row" key={project.id}>
                  <span className="dashboard-project-rank">{i + 1}</span>
                  <div className="dashboard-project-info">
                    <div className="dashboard-project-top">
                      <span className="dashboard-project-name">
                        <ProjectDot projectId={project.id} />
                        {project.name}
                      </span>
                      <span className="dashboard-project-cost">
                        ${project.total_cost_usd.toFixed(2)}
                      </span>
                    </div>
                    <div className="dashboard-project-bar-track">
                      <div
                        className="dashboard-project-bar-fill"
                        style={{
                          width: `${Math.max(pct, 3)}%`,
                          backgroundColor: colorForProject(project.id),
                        }}
                      />
                    </div>
                    <span className="dashboard-project-sessions">
                      {project.session_count} session
                      {project.session_count === 1 ? '' : 's'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="dashboard-section dashboard-column">
          <h2 className="dashboard-section-title">Spend by agent</h2>
          <div className="dashboard-agent-grid">
            {KNOWN_AGENT_IDS.map((agentId) => {
              const meta = agentMeta(agentId);
              const usage = usageByAgent.get(agentId);
              return (
                <div
                  className="dashboard-card dashboard-agent-card"
                  key={agentId}
                >
                  <div className="dashboard-agent-header">
                    <span className="dashboard-agent-icon">{meta.icon}</span>
                    <span className="dashboard-agent-label">{meta.label}</span>
                  </div>
                  <div className="dashboard-agent-stats">
                    <div className="dashboard-agent-stat">
                      <span className="dashboard-agent-stat-value">
                        ${(usage?.total_cost_usd ?? 0).toFixed(2)}
                      </span>
                      <span className="dashboard-agent-stat-label">spend</span>
                    </div>
                    <div className="dashboard-agent-stat">
                      <span className="dashboard-agent-stat-value">
                        {usage?.session_count ?? 0}
                      </span>
                      <span className="dashboard-agent-stat-label">
                        sessions
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
