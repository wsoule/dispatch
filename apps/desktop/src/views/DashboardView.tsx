import { useQuery } from '@tanstack/react-query';
import { OctagonAlert } from 'lucide-react';

import { ActivityHeatmap } from '../components/ui/ActivityHeatmap';
import { ProjectDot } from '../components/ui/ProjectDot';
import { StatTile } from '../components/ui/StatTile';
import { agentMeta, KNOWN_AGENT_IDS } from '../lib/agents';
import { sessionDisplayName } from '../lib/format';
import { colorForProject } from '../lib/projectColor';
import { getDashboardStats } from '../lib/tauri';
import type { AgentUsage } from '../lib/types';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';

export function DashboardView() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: getDashboardStats,
  });

  if (isLoading) {
    return (
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-48 rounded-lg" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 pt-24 text-center">
        <OctagonAlert className="text-destructive size-5" />
        <p className="text-muted-foreground text-[13px]">
          Couldn&rsquo;t load dashboard stats. Is the backend running?
        </p>
        <Button variant="secondary" size="sm" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const usageByAgent = new Map<string, AgentUsage>(
    data.agent_usage.map((u) => [u.agent, u])
  );
  const topProject = data.top_projects[0];

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-foreground text-[15px] font-medium">Dashboard</h1>

      <div className="grid grid-cols-4 gap-3">
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

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          Active now
        </h2>
        <div className="border-border bg-card flex min-w-0 items-center gap-3 rounded-lg border p-4">
          {data.active_session ? (
            <>
              <ProjectDot projectId={data.active_session.project_id} />
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-foreground text-[13px] font-medium">
                  {data.active_session.project_name}
                </span>
                <span className="text-muted-foreground truncate text-[13px]">
                  {sessionDisplayName(
                    data.active_session.session_title,
                    data.active_session.session_summary
                  )}
                </span>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground text-[13px]">
              No active session right now.
            </p>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          Activity
        </h2>
        <div className="border-border bg-card rounded-lg border p-4">
          <ActivityHeatmap data={data.daily_activity} />
        </div>
      </section>

      <div className="grid grid-cols-[1.3fr_1fr] items-start gap-5">
        <section className="flex min-w-0 flex-col gap-2">
          <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            Highest usage projects
          </h2>
          <div className="border-border bg-card flex flex-col gap-4 rounded-lg border p-4">
            {data.top_projects.length === 0 && (
              <p className="text-muted-foreground text-[13px]">
                No projects yet.
              </p>
            )}
            {data.top_projects.map((project, i) => {
              const maxCost = data.top_projects[0]?.total_cost_usd || 1;
              const pct =
                maxCost > 0 ? (project.total_cost_usd / maxCost) * 100 : 0;
              return (
                <div className="flex items-start gap-3" key={project.id}>
                  <span className="text-muted-foreground w-5 shrink-0 pt-0.5 font-mono text-[13px]">
                    {i + 1}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-foreground inline-flex min-w-0 items-center gap-2 truncate text-[13px] font-medium">
                        <ProjectDot projectId={project.id} />
                        {project.name}
                      </span>
                      <span className="text-muted-foreground shrink-0 font-mono text-[13px]">
                        ${project.total_cost_usd.toFixed(2)}
                      </span>
                    </div>
                    <div className="bg-muted h-[5px] overflow-hidden rounded-full">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.max(pct, 3)}%`,
                          backgroundColor: colorForProject(project.id),
                        }}
                      />
                    </div>
                    <span className="text-muted-foreground text-[11px]">
                      {project.session_count} session
                      {project.session_count === 1 ? '' : 's'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="flex min-w-0 flex-col gap-2">
          <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            Spend by agent
          </h2>
          <div className="grid grid-cols-2 gap-3">
            {KNOWN_AGENT_IDS.map((agentId) => {
              const meta = agentMeta(agentId);
              const usage = usageByAgent.get(agentId);
              return (
                <div
                  className="border-border bg-card flex flex-col gap-3 rounded-lg border p-3"
                  key={agentId}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-primary text-[13px]">
                      {meta.icon}
                    </span>
                    <span className="text-foreground text-[13px] font-medium">
                      {meta.label}
                    </span>
                  </div>
                  <div className="flex gap-4">
                    <div className="flex flex-col">
                      <span className="text-foreground font-mono text-[14px]">
                        ${(usage?.total_cost_usd ?? 0).toFixed(2)}
                      </span>
                      <span className="text-muted-foreground text-[11px]">
                        spend
                      </span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-foreground font-mono text-[14px]">
                        {usage?.session_count ?? 0}
                      </span>
                      <span className="text-muted-foreground text-[11px]">
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
