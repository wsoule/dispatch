import { useQuery } from '@tanstack/react-query';
import { Coins, Inbox, OctagonAlert, X } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

import { ExportControl } from '../components/sessions/ExportControl';
import { SessionDetailModal } from '../components/sessions/SessionDetailModal';
import {
  DEFAULT_SPEND_WINDOW,
  projectNameFor,
  SPEND_WINDOWS,
  spendWindowLabel,
} from '../components/sessions/sessionDisplay';
import { SessionRow } from '../components/sessions/SessionRow';
import { SpendTable } from '../components/sessions/SpendTable';
import { modelDisplayName } from '../lib/models';
import {
  exportReport,
  generateReport,
  getDashboardStats,
  isTauri,
  listProjects,
  listSessions,
} from '../lib/tauri';
import { PageHeader, ViewTabs } from '@/ui/ai/page-header';
import { Pill } from '@/ui/ai/pill';
import { TaskRowList } from '@/ui/ai/task-rows';
import { EmptyState, SectionLabel } from '@/ui/chrome';
import { StatTile } from '@/ui/chrome/StatTile';
import { Skeleton } from '@/ui/skeleton';

/** The spend windows as header view tabs — `7 days` `30 days` `90 days`. */
const WINDOW_TABS = SPEND_WINDOWS.map((days) => ({
  id: String(days),
  label: spendWindowLabel(days),
}));

/** A card the spend tables and the session list sit in. */
function Card({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-card bg-card shadow-card px-3 py-1">{children}</div>
  );
}

/** A failed fetch, with its retry. */
function FetchError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <EmptyState
      icon={OctagonAlert}
      heading={message}
      secondary={{ label: 'Retry', onClick: onRetry }}
    />
  );
}

/**
 * The entire observability surface, collapsed from five tabs (Dashboard, Projects,
 * Sessions, Timeline, Reports) into one view: headline spend tiles, spend by model, spend by
 * project (click a row to filter the session list below to that project), the session list
 * itself, and a single export action in the header. The header's view tabs pick the window
 * the "Spend (Nd)" tile and the export cover. Everything here reads the app's own local
 * session/project data — no dispatch task/plan state lives on this page.
 */
/**
 * Usage reads the agent session logs on this machine through the desktop
 * app's native side; a browser (a teammate on team-local, or dev) has no way
 * to, so it says so instead of loading forever.
 */
export function SessionsHubView() {
  if (!isTauri()) {
    return (
      <EmptyState
        icon={Coins}
        heading="Usage lives in the desktop app"
        description="It reads the agent session logs on the machine running Dispatch, which a browser can't. Open Dispatch on that machine to see spend by model and project."
        className="h-full justify-center"
      />
    );
  }
  return <SessionsHubBody />;
}

function SessionsHubBody() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState(DEFAULT_SPEND_WINDOW);

  const {
    data: stats,
    isLoading: statsLoading,
    isError: statsError,
    refetch: refetchStats,
  } = useQuery({ queryKey: ['dashboard'], queryFn: getDashboardStats });

  // Powers the "Spend (Nd)" headline tile — the one piece of the old Reports tab's windowed
  // totals worth surfacing, with the window as header tabs rather than a full range picker.
  const { data: recentReport } = useQuery({
    queryKey: ['report', windowDays],
    queryFn: () => generateReport(windowDays),
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
  // clears it, matching the filter pill's "✕" affordance.
  function toggleProjectFilter(projectId: string) {
    setProjectFilter((current) => (current === projectId ? null : projectId));
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        crumb={['Sessions']}
        actions={
          <ExportControl
            variant="ghost"
            label="Export spend report"
            onExport={() => exportReport(windowDays)}
          />
        }
        tabs={
          <ViewTabs
            label="Spend window"
            tabs={WINDOW_TABS}
            active={String(windowDays)}
            onChange={(id) => setWindowDays(Number(id))}
          />
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-4">
        {statsError ? (
          <FetchError
            message="Couldn’t load spend stats. Is the backend running?"
            onRetry={() => void refetchStats()}
          />
        ) : statsLoading || !stats ? (
          <div className="grid grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="rounded-card h-16" />
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
              label={`Spend (${String(windowDays)}d)`}
            />
            <StatTile value={stats.total_sessions} label="Total sessions" />
            <StatTile value={stats.total_projects} label="Active projects" />
          </div>
        )}

        <section className="flex flex-col gap-2">
          <SectionLabel>Spend by model</SectionLabel>
          <Card>
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
          </Card>
        </section>

        <section className="flex flex-col gap-2">
          <SectionLabel>Spend by project</SectionLabel>
          <Card>
            {projectsError ? (
              <FetchError
                message="Couldn’t load projects."
                onRetry={() => void refetchProjects()}
              />
            ) : projectsLoading ? (
              <Skeleton className="my-2 h-24 w-full" />
            ) : (
              <SpendTable
                columnLabel="Project"
                emptyMessage="No projects yet. Start a Claude Code session and it shows up here."
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
          </Card>
        </section>

        <section className="flex min-h-0 flex-col gap-2">
          <div className="flex items-center gap-2">
            <SectionLabel>Sessions</SectionLabel>
            {filteredProject && (
              <Pill className="pr-1">
                {filteredProject.name}
                <button
                  type="button"
                  onClick={() => setProjectFilter(null)}
                  aria-label="Clear project filter"
                  className="text-muted-foreground hover:bg-surface-active hover:text-foreground rounded-pill flex size-4 shrink-0 items-center justify-center transition-colors duration-100"
                >
                  <X className="size-3" />
                </button>
              </Pill>
            )}
          </div>

          {sessionsLoading && (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          )}

          {sessionsError && (
            <FetchError
              message="Couldn’t load sessions. Is the backend running?"
              onRetry={() => void refetchSessions()}
            />
          )}

          {!sessionsLoading &&
            !sessionsError &&
            filteredSessions.length === 0 && (
              <EmptyState
                icon={Inbox}
                heading={
                  projectFilter
                    ? 'No sessions for this project yet'
                    : 'No sessions yet'
                }
                description={
                  projectFilter
                    ? undefined
                    : 'Start a Claude Code session and it shows up here.'
                }
              />
            )}

          {!sessionsLoading &&
            !sessionsError &&
            filteredSessions.length > 0 && (
              <TaskRowList>
                {filteredSessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    projectName={projectNameFor(projects, session.project_id)}
                    onClick={() => setSelectedSessionId(session.id)}
                  />
                ))}
              </TaskRowList>
            )}
        </section>
      </div>

      <SessionDetailModal
        sessionId={selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
      />
    </div>
  );
}
