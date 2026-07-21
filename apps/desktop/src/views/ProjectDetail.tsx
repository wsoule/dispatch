import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { ProjectBoard } from '../components/board/ProjectBoard';
import { ActivityHeatmap } from '../components/ui/ActivityHeatmap';
import { StatTile } from '../components/ui/StatTile';
import { formatRelativeTime } from '../lib/format';
import { getProjectGitInsights, listSessions } from '../lib/tauri';
import type { ProjectSummary } from '../lib/types';
import { SessionDetailModal } from './SessionDetailModal';
import { SessionRow } from './SessionRow';
import { cn } from '@/lib/utils';

type ProjectDetailTab = 'overview' | 'board' | 'sessions';

interface ProjectDetailProps {
  project: ProjectSummary;
}

const TABS: { id: ProjectDetailTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'board', label: 'Board' },
  { id: 'sessions', label: 'Sessions' },
];

/**
 * Full-page detail shown in the Sessions hub's Projects tab once a project card is clicked.
 * Three tabs — Overview / Board (Relay's own session-linked kanban, unrelated to the
 * dispatch task Board) / Sessions — behind a top tab bar rather than one long scrolling
 * column. There is deliberately no Tasks tab here anymore: dispatch task/run/plan work lives
 * in the primary Board/Tasks/Runs/Plans nav for whichever project is active, not nested
 * inside this Relay-observability page — the whole point of the redesign this view is part
 * of is that Dispatch stops reading as "Relay with a Tasks tab" wired in here.
 */
export function ProjectDetail({ project }: ProjectDetailProps) {
  const [activeTab, setActiveTab] = useState<ProjectDetailTab>('overview');
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
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-foreground text-[15px] font-medium">
          {project.name}
        </h1>
        <div className="text-muted-foreground truncate font-mono text-[12px]">
          {project.path}
        </div>
      </div>

      <div className="border-border flex gap-4 border-b">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'text-muted-foreground -mb-px border-b-2 border-transparent py-2 text-[13px] font-medium transition-colors',
              activeTab === tab.id
                ? 'border-primary text-foreground'
                : 'hover:text-foreground'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="flex flex-col gap-3">
          <div className="flex gap-3">
            <StatTile value={project.session_count} label="Sessions" />
            <StatTile
              value={`$${project.total_cost_usd.toFixed(2)}`}
              label="Total cost"
            />
          </div>

          <div className="border-border bg-card rounded-lg border p-4">
            <ActivityHeatmap data={gitInsights?.commit_heatmap ?? []} />
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
              Recent commits
            </h2>

            {!gitInsights && (
              <div className="text-muted-foreground flex items-center gap-2 text-[13px]">
                <Loader2 className="size-3.5 animate-spin" />
                Loading commit history…
              </div>
            )}

            {gitInsights && gitInsights.recent_commits.length === 0 && (
              <p className="text-muted-foreground text-[13px]">
                No git history detected for this project.
              </p>
            )}

            {gitInsights && gitInsights.recent_commits.length > 0 && (
              <ul className="flex flex-col">
                {gitInsights.recent_commits.map((commit) => (
                  <li
                    key={commit.hash}
                    className="border-border flex items-baseline gap-3 border-b py-2 last:border-b-0"
                  >
                    <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                      {commit.hash}
                    </span>
                    <span className="text-foreground min-w-0 flex-1 truncate text-[13px]">
                      {commit.message}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-[11px] whitespace-nowrap">
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
        <div className="flex flex-col gap-2">
          <ProjectBoard projectId={project.id} />
        </div>
      )}

      {activeTab === 'sessions' && (
        <div className="flex flex-col gap-2">
          {isLoading && (
            <div className="text-muted-foreground flex items-center gap-2 text-[13px]">
              <Loader2 className="size-3.5 animate-spin" />
              Loading sessions…
            </div>
          )}

          {isError && (
            <p className="text-muted-foreground text-[13px]">
              Couldn&rsquo;t load sessions.
            </p>
          )}

          {!isLoading && !isError && projectSessions.length === 0 && (
            <p className="text-muted-foreground text-[13px]">
              No sessions yet for this project.
            </p>
          )}

          {!isLoading && !isError && projectSessions.length > 0 && (
            <div className="flex flex-col gap-2">
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
