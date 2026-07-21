import { useQuery } from '@tanstack/react-query';

import { ActivityBars } from '../components/ui/ActivityBars';
import { ProjectDot } from '../components/ui/ProjectDot';
import { agentMeta } from '../lib/agents';
import { formatRelativeTime } from '../lib/format';
import { getProjectActivity } from '../lib/tauri';
import type { ProjectSummary } from '../lib/types';
import { Badge } from '@/ui/badge';

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
    <button
      onClick={onClick}
      className="border-border bg-card hover:border-foreground/15 flex w-full flex-col gap-2 rounded-lg border p-4 text-left transition-all duration-150 hover:-translate-y-0.5 hover:shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-foreground inline-flex min-w-0 items-center gap-2 truncate text-[13px] font-medium">
          <ProjectDot projectId={project.id} />
          {project.name}
        </span>
        <span className="inline-flex flex-wrap items-center gap-1">
          {project.agents.map((agentId) => {
            const meta = agentMeta(agentId);
            return (
              <Badge
                key={agentId}
                variant="secondary"
                className="bg-accent text-accent-foreground border-transparent"
              >
                {meta.icon} {meta.label}
              </Badge>
            );
          })}
        </span>
      </div>
      <div className="text-muted-foreground truncate font-mono text-[12px]">
        {project.path}
      </div>
      <div className="text-muted-foreground flex gap-3 text-[12px]">
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
