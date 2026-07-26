import { useQuery } from '@tanstack/react-query';
import { Inbox, OctagonAlert, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { ExportControl } from '../components/sessions/ExportControl';
import { SessionDetailModal } from '../components/sessions/SessionDetailModal';
import { projectNameFor } from '../components/sessions/sessionDisplay';
import { SessionRow } from '../components/sessions/SessionRow';
import { SessionsEmptyState } from '../components/sessions/SessionsEmptyState';
import { SpendTable } from '../components/sessions/SpendTable';
import { StatTile } from '../components/ui/StatTile';
import { modelDisplayName } from '../lib/models';
import {
  exportReport,
  generateReport,
  getDashboardStats,
  listProjects,
  listSessions,
} from '../lib/tauri';
import { Skeleton } from '@/ui/skeleton';

/** Window used for the header's "Spend (Nd)" tile and the header export — a fixed recent
 * range rather than a user-facing picker, since the range control (and the standalone Reports
 * tab it lived on) was cut along with Dashboard/Projects/Timeline in this hub consolidation.
 * 30 days matches `ReportView`'s own former default. */
const RECENT_WINDOW_DAYS = 30;

/**
 * Relay's entire observability surface, collapsed from five tabs (Dashboard, Projects,
 * Sessions, Timeline, Reports) into one view: headline spend tiles, spend by model, spend by
 * project (click a row to filter the session list below to that project), the session list
 * itself, and a single export action in the header. Everything here reads Relay's own local
 * session/project data — no dispatch task/plan state lives on this page.
 */
export function SessionsHubView() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const [projectFilter, setProjectFilter] = useState<string | null>(null);

  const {
    data: stats,
    isLoading: statsLoading,
    isError: statsError,
    refetch: refetchStats,
  } = useQuery({ queryKey: ['dashboard'], queryFn: getDashboardStats });

  // Powers the "Spend (Nd)" headline tile — the one piece of the old Reports tab's windowed
  // totals worth surfacing without a full range picker.
  const { data: recentReport } = useQuery({
    queryKey: ['report', RECENT_WINDOW_DAYS],
    queryFn: () => generateReport(RECENT_WINDOW_DAYS),
  });

  const {
    data: projects,
    isLoading: projectsLoading,
    isError: projectsError,
    refetch: refetchProjects,
  } = useQuery({ queryKey: ['projects'], queryFn: listProjects });

  const {
    data: sessions,
    isLoading: sessionsLoading,
    isError: sessionsError,
    refetch: refetchSessions,
  } = useQuery({ queryKey: ['sessions'], queryFn: listSessions });

  const projectsBySpend = useMemo(
    () =>
      projects
        ? [...projects].sort((a, b) => b.total_cost_usd - a.total_cost_usd)
        : [],
    [projects]
  );

  const filteredProject = projectFilter
    ? (projects?.find((p) => p.id === projectFilter) ?? null)
    : null;

  const filteredSessions = useMemo(() => {
    if (!sessions) return [];
    if (!projectFilter) return sessions;
    return sessions.filter((s) => s.project_id === projectFilter);
  }, [sessions, projectFilter]);

  // Toggles the clicked project as the active filter — clicking the already-active row
  // clears it, matching the header chip's "✕" affordance.
  function toggleProjectFilter(projectId: string) {
    setProjectFilter((current) => (current === projectId ? null : projectId));
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-foreground text-[13px] font-semibold">Sessions</h1>
        <ExportControl
          label="Export spend report"
          onExport={() => exportReport(RECENT_WINDOW_DAYS)}
        />
      </div>

      {statsError ? (
        <SessionsEmptyState
          icon={<OctagonAlert className="size-5" />}
          message="Couldn’t load spend stats. Is the backend running?"
          tone="destructive"
          onRetry={() => void refetchStats()}
        />
      ) : statsLoading || !stats ? (
        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-3">
          <StatTile
            value={`$${stats.total_cost_usd.toFixed(2)}`}
            label="Total spend"
          />
          <StatTile
            value={`$${(recentReport?.totals.total_cost_usd ?? 0).toFixed(2)}`}
            label={`Spend (${RECENT_WINDOW_DAYS}d)`}
          />
          <StatTile value={stats.total_sessions} label="Total sessions" />
          <StatTile value={stats.total_projects} label="Active projects" />
        </div>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          Spend by model
        </h2>
        <div className="border-border bg-card rounded-lg border p-4">
          <SpendTable
            columnLabel="Model"
            rows={(stats?.model_usage ?? []).map((m) => ({
              key: m.model ?? 'unknown',
              label: modelDisplayName(m.model) ?? 'Unknown',
              sessionCount: m.session_count,
              totalCostUsd: m.total_cost_usd,
            }))}
            emptyMessage="No model usage yet."
          />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          Spend by project
        </h2>
        <div className="border-border bg-card rounded-lg border p-4">
          {projectsError ? (
            <SessionsEmptyState
              icon={<OctagonAlert className="size-5" />}
              message="Couldn’t load projects."
              tone="destructive"
              onRetry={() => void refetchProjects()}
            />
          ) : projectsLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <SpendTable
              columnLabel="Project"
              emptyMessage="No projects yet — start a Claude Code session in any repo and it will appear here."
              rows={projectsBySpend.map((project) => ({
                key: project.id,
                label: project.name,
                sessionCount: project.session_count,
                totalCostUsd: project.total_cost_usd,
              }))}
              activeKey={projectFilter ?? undefined}
              onRowClick={toggleProjectFilter}
            />
          )}
        </div>
      </section>

      <section className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            Sessions
          </h2>
          {filteredProject && (
            <span className="border-border bg-accent/40 text-foreground inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]">
              {filteredProject.name}
              <button
                type="button"
                onClick={() => setProjectFilter(null)}
                aria-label="Clear project filter"
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          )}
        </div>

        {sessionsLoading && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {sessionsError && (
          <SessionsEmptyState
            icon={<OctagonAlert className="size-5" />}
            message="Couldn’t load sessions. Is the backend running?"
            tone="destructive"
            onRetry={() => void refetchSessions()}
          />
        )}

        {!sessionsLoading &&
          !sessionsError &&
          filteredSessions.length === 0 && (
            <SessionsEmptyState
              icon={<Inbox className="size-5" />}
              message={
                projectFilter
                  ? 'No sessions for this project yet.'
                  : 'No sessions yet — start a Claude Code session in any repo and it will appear here.'
              }
            />
          )}

        {!sessionsLoading && !sessionsError && filteredSessions.length > 0 && (
          <div className="flex flex-col gap-2">
            {filteredSessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                projectName={projectNameFor(projects, session.project_id)}
                onClick={() => setSelectedSessionId(session.id)}
              />
            ))}
          </div>
        )}
      </section>

      <SessionDetailModal
        sessionId={selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
      />
    </div>
  );
}
