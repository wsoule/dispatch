import {
  Button,
  Chip,
  EmptyState,
  Register,
  SegmentedControl,
  SkeletonBlock,
  SkeletonRows,
  StatsStrip,
  ViewToolbar,
} from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';
import { Coins, OctagonAlert, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { ExportControl } from '../components/sessions/ExportControl';
import { SessionDetailModal } from '../components/sessions/SessionDetailModal';
import {
  DEFAULT_SPEND_WINDOW,
  projectNameFor,
  SPEND_WINDOWS,
  spendWindowLabel,
} from '../components/sessions/sessionDisplay';
import {
  SESSION_COLUMNS,
  SESSION_HEADER,
  SessionRow,
} from '../components/sessions/SessionRow';
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
import styles from './SessionsHubView.module.css';

/** The spend windows as the toolbar's segmented options — `7 days` `30 days` `90 days`. */
const WINDOW_OPTIONS = SPEND_WINDOWS.map((days) => ({
  id: String(days),
  label: spendWindowLabel(days),
}));

/** A dollar amount the way every Usage figure prints it: `$12.34`. */
function dollars(amount: number): string {
  return `$${amount.toFixed(2)}`;
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
      icon={<OctagonAlert size={22} strokeWidth={1.8} />}
      action={
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      }
    >
      {message}
    </EmptyState>
  );
}

/**
 * Settings › Usage: the whole observability surface in one view. A toolbar picks the spend
 * window (7, 30 or 90 days) the "Spend (Nd)" headline and the spend-report export cover;
 * under it come the headline figures, spend by model, spend by project (click a row to
 * filter the session list below to that project, click it again or the chip's clear button
 * to drop the filter) and the session list itself, whose rows open `SessionDetailModal`.
 * Everything here reads the agent session logs on this machine through the desktop app's
 * native side, so no dispatch task or plan state lives on this page; a browser (a teammate
 * on team-local, or dev) has no way to read them, so it says so instead of loading forever.
 */
export function SessionsHubView() {
  if (!isTauri()) {
    return (
      <div className={styles.browser}>
        <EmptyState
          label="Usage lives in the desktop app"
          icon={<Coins size={22} strokeWidth={1.8} />}
        >
          {
            "It reads the agent session logs on the machine running Dispatch, which a browser can't. Open Dispatch on that machine to see spend by model and project."
          }
        </EmptyState>
      </div>
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

  // Powers the "Spend (Nd)" headline figure — the one piece of the old Reports tab's windowed
  // totals worth surfacing, with the window as a segmented control rather than a range picker.
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
  // clears it, matching the filter chip's clear button.
  function toggleProjectFilter(projectId: string) {
    setProjectFilter((current) => (current === projectId ? null : projectId));
  }

  return (
    <div className={styles.root}>
      <ViewToolbar
        label="Usage options"
        controls={
          <SegmentedControl
            label="Spend window"
            size="sm"
            options={WINDOW_OPTIONS}
            value={String(windowDays)}
            onChange={(id) => setWindowDays(Number(id))}
          />
        }
        end={
          <ExportControl
            variant="ghost"
            label="Export spend report"
            onExport={() => exportReport(windowDays)}
          />
        }
      />

      <div className={styles.scroller}>
        {statsError ? (
          <FetchError
            message="Couldn’t load spend stats. Is the backend running?"
            onRetry={() => void refetchStats()}
          />
        ) : statsLoading || !stats ? (
          <SkeletonBlock height={84} label="Loading spend summary" />
        ) : (
          <StatsStrip
            label="Spend summary"
            cells={[
              {
                id: 'total',
                label: 'Total spend',
                value: dollars(stats.total_cost_usd),
              },
              {
                id: 'window',
                label: `Spend (${String(windowDays)}d)`,
                value: dollars(recentReport?.totals.total_cost_usd ?? 0),
              },
              {
                id: 'sessions',
                label: 'Total sessions',
                value: stats.total_sessions,
              },
              {
                id: 'projects',
                label: 'Active projects',
                value: stats.total_projects,
              },
            ]}
          />
        )}

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.heading}>Spend by model</h2>
          </div>
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
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.heading}>Spend by project</h2>
          </div>
          {projectsError ? (
            <FetchError
              message="Couldn’t load projects."
              onRetry={() => void refetchProjects()}
            />
          ) : projectsLoading ? (
            <SkeletonBlock height={96} label="Loading projects" />
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
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.heading}>Sessions</h2>
            {filteredProject && (
              <span className={styles.filter}>
                <Chip>{filteredProject.name}</Chip>
                <Button
                  variant="quiet"
                  size="sm"
                  aria-label="Clear project filter"
                  icon={<X size={14} strokeWidth={1.8} aria-hidden />}
                  onClick={() => setProjectFilter(null)}
                />
              </span>
            )}
          </div>

          {sessionsLoading && (
            <SkeletonRows rows={3} label="Loading sessions" />
          )}

          {sessionsError && (
            <FetchError
              message="Couldn’t load sessions. Is the backend running?"
              onRetry={() => void refetchSessions()}
            />
          )}

          {!sessionsLoading &&
            !sessionsError &&
            filteredSessions.length === 0 &&
            (projectFilter ? (
              <EmptyState>No sessions for this project yet</EmptyState>
            ) : (
              <EmptyState label="No sessions yet">
                Start a Claude Code session and it shows up here.
              </EmptyState>
            ))}

          {!sessionsLoading &&
            !sessionsError &&
            filteredSessions.length > 0 && (
              <Register
                label="Sessions"
                columns={SESSION_COLUMNS}
                header={SESSION_HEADER}
                stackWithin={600}
              >
                {filteredSessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    projectName={projectNameFor(projects, session.project_id)}
                    onClick={() => setSelectedSessionId(session.id)}
                  />
                ))}
              </Register>
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
