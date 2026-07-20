import { useQuery } from '@tanstack/react-query';

import { ActivityBars } from '../components/ui/ActivityBars';
import { Pill } from '../components/ui/Pill';
import { ProjectDot } from '../components/ui/ProjectDot';
import { agentMeta } from '../lib/agents';
import { formatRelativeTime } from '../lib/format';
import { getProjectActivity } from '../lib/tauri';
import type { ProjectSummary } from '../lib/types';
import './ProjectCard.css';

interface ProjectCardProps {
  project: ProjectSummary;
  onClick?: () => void;
}

/** All-zero 14-day placeholder shown while activity data hasn't loaded yet (or failed to,
 * e.g. outside a real Tauri context) — never blocks the rest of the card's render. */
const EMPTY_ACTIVITY = new Array(14).fill(0);

export function ProjectCard({ project, onClick }: ProjectCardProps) {
  const { data: activity } = useQuery({
    queryKey: ['project-activity', project.path],
    queryFn: () => getProjectActivity(project.path),
    // Decorative only — a failure here (e.g. dev-server smoke test outside a real Tauri
    // context) should just leave the placeholder shown, not retry noisily or surface an error.
    retry: false,
  });

  return (
    <button className="project-card" onClick={onClick}>
      <div className="project-card-header">
        <span className="project-card-name">
          <ProjectDot projectId={project.id} />
          {project.name}
        </span>
        <span className="project-card-agents">
          {project.agents.map((agentId) => {
            const meta = agentMeta(agentId);
            return (
              <Pill variant="agent" tone="accent" key={agentId}>
                {meta.icon} {meta.label}
              </Pill>
            );
          })}
        </span>
      </div>
      <div className="project-card-path">{project.path}</div>
      <div className="project-card-stats">
        <span>
          {project.session_count} session
          {project.session_count === 1 ? '' : 's'}
        </span>
        <span>${project.total_cost_usd.toFixed(2)} spent</span>
        <span>active {formatRelativeTime(project.last_active)}</span>
      </div>
      <ActivityBars data={activity ?? EMPTY_ACTIVITY} />
    </button>
  );
}
