import type { ApiClient } from '@dispatch/client';
import { buildWeekView, type RecentAllocation } from '@dispatch/planning';
import {
  BlockBar,
  Chip,
  DeadlineList,
  EmptyState,
  Register,
  RegisterCell,
  RegisterRow,
  Select,
  StatsStrip,
  TaskGroupTable,
} from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';
import {
  CalendarX,
  CircleDot,
  type LucideIcon,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { recentAllocationsFrom } from '../adapters/allocation';
import {
  buildWeekPage,
  resolveWeekUserId,
  WEEK_TASK_COLUMNS,
  weekPeopleOptions,
} from '../adapters/week';
import { useShellActions } from '../components/shell/ShellActionsContext';
import { type Planning, usePlanningContext } from '../hooks/usePlanning';
import styles from './WeekView.module.css';

// My week (Better Tracker's /week, ported): one person's open issues grouped
// This week / Later / No milestone, their upcoming deadlines, and the projects
// they lead that need attention. The data is App's planning (PlanningContext)
// through @dispatch/planning's buildWeekView and adapters/week; this view
// keeps only whose week is shown. A row quick-looks its task in the drawer;
// group headings, deadlines and attention rows are task hrefs the shell's
// link provider resolves.

const NO_ALLOCATIONS: RecentAllocation[] = [];

/**
 * Issues an applied allocation run gave someone within the "new" window, for
 * the "New to you" mark; refetched with the run log (same query key root).
 */
function useRecentAllocations(
  client: Pick<ApiClient, 'fetchAppliedAllocationRuns'> | null,
  port: number | undefined,
  now: string,
  newBadgeDays: number
): RecentAllocation[] {
  // The window's start moves by the day, not the minute, so the key is stable.
  const since = new Date(
    Date.parse(now.slice(0, 10)) - newBadgeDays * 86_400_000
  ).toISOString();
  const q = useQuery({
    queryKey: ['allocation-runs', port, 'applied-since', since],
    enabled: client !== null,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchAppliedAllocationRuns(since);
    },
  });
  return useMemo(
    () =>
      q.data === undefined ? NO_ALLOCATIONS : recentAllocationsFrom(q.data),
    [q.data]
  );
}

const STAT_ICONS: Record<string, LucideIcon> = {
  open: CircleDot,
  overdue: CalendarX,
  new: Sparkles,
  risk: TriangleAlert,
};

export interface WeekViewProps {
  /** This window's own `human:<handle>` ref, or null until the daemon says. */
  me: string | null;
  /** Reads the applied allocation runs for "New to you"; none without it. */
  client?: Pick<ApiClient, 'fetchAppliedAllocationRuns'> | null;
  port?: number;
}

/** The My week page. Without a planning (outside App) it says so. */
export function WeekView({ me, client, port }: WeekViewProps) {
  const planning = usePlanningContext();
  if (planning === null) {
    return (
      <div className={styles.root} data-testid="week-view">
        <EmptyState>My week is not available here.</EmptyState>
      </div>
    );
  }
  return <WeekLoaded planning={planning} me={me} client={client} port={port} />;
}

function WeekLoaded({
  planning,
  me,
  client = null,
  port,
}: WeekViewProps & { planning: Planning }) {
  const { peekTask } = useShellActions();
  const recentAllocations = useRecentAllocations(
    client,
    port,
    planning.ctx.now,
    planning.ctx.tuning.newBadgeDays
  );
  const [requested, setRequested] = useState<string | null>(null);
  const { snapshot, ctx, assessments, timeline } = planning;

  const people = useMemo(
    () => weekPeopleOptions(snapshot.users.values(), me),
    [snapshot, me]
  );
  const userId = resolveWeekUserId({
    requested,
    viewerId: me,
    knownUserIds: new Set(people.map((person) => person.value)),
  });

  const page = useMemo(() => {
    if (userId === null) return null;
    const week = buildWeekView({
      snapshot,
      ctx,
      assessments,
      userId,
      recentAllocations,
    });
    // The planning's "No milestone" rows carry no project: the snapshot does.
    const issueProjects = new Map<
      string,
      { projectId: string; name: string }
    >();
    for (const section of week.sections) {
      if (section.milestoneId !== null) continue;
      for (const row of section.rows) {
        const projectId = snapshot.issues.get(row.issueId)?.projectId ?? null;
        const project =
          projectId === null ? undefined : snapshot.projects.get(projectId);
        if (project !== undefined) {
          issueProjects.set(row.issueId, {
            projectId: project.id,
            name: project.name,
          });
        }
      }
    }
    return buildWeekPage({
      week,
      timeline,
      viewerId: me,
      hour: new Date(ctx.now).getHours(),
      newBadgeDays: ctx.tuning.newBadgeDays,
      issueProjects,
    });
  }, [snapshot, ctx, assessments, timeline, userId, me, recentAllocations]);

  if (page === null) {
    return (
      <div className={styles.root} data-testid="week-view">
        <EmptyState label="No people yet">
          Add people to the project, or connect Linear, and each person's week
          shows here.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className={styles.root} data-testid="week-view">
      <header className={styles.head}>
        <div className={styles.headText}>
          <h1 className={styles.title}>{page.heading}</h1>
          <p className={styles.receipts}>{page.receipts}</p>
        </div>
        <Select
          label="Showing"
          value={page.userId}
          options={people}
          onChange={setRequested}
          className={styles.picker}
        />
      </header>

      <StatsStrip
        cells={page.stats.map((cell) => {
          const Icon = STAT_ICONS[cell.id];
          return Icon === undefined
            ? cell
            : { ...cell, icon: <Icon size={14} strokeWidth={1.8} /> };
        })}
        label={page.isSelf ? 'Your week at a glance' : 'Week at a glance'}
      />

      <div className={styles.columns}>
        <div className={styles.grid}>
          <section className={styles.main} aria-label={page.issuesTitle}>
            <BlockBar title={page.issuesTitle} meta={page.issuesMeta} />
            <TaskGroupTable
              sections={page.sections}
              columns={WEEK_TASK_COLUMNS}
              label={page.isSelf ? 'My issues' : `${page.issuesTitle}`}
              headingLevel={2}
              storageKey="dispatch:week:collapsed"
              emptyMessage={page.emptyMessage}
              onOpenRow={(row) => peekTask(row.id)}
            />
          </section>
          <aside className={styles.side} aria-label="Deadlines and attention">
            <section aria-label="Upcoming deadlines">
              <BlockBar title="Upcoming deadlines" meta="Next 7 days" />
              {page.deadlines.every((group) => group.items.length === 0) ? (
                <EmptyState>Nothing due in the next 7 days</EmptyState>
              ) : (
                <DeadlineList groups={page.deadlines} />
              )}
            </section>
            <section aria-label="Needs attention">
              <BlockBar
                title="Needs attention"
                meta={page.isSelf ? 'Projects you lead' : 'Projects they lead'}
              />
              {page.attention.length === 0 ? (
                <EmptyState>{page.attentionEmpty}</EmptyState>
              ) : (
                <Register
                  columns="minmax(0, 1fr) auto"
                  label="Projects that need attention"
                  stackWithin={480}
                  stackedColumns="minmax(0, 1fr)"
                >
                  {page.attention.map((item) => (
                    <RegisterRow
                      key={item.id}
                      href={item.href}
                      rowLabel={item.rowLabel}
                      tone={item.tone}
                    >
                      <RegisterCell variant="name" sub={item.detail}>
                        {item.projectName}
                      </RegisterCell>
                      <RegisterCell align="end">
                        <Chip tone={item.tone} filled>
                          {item.flag}
                        </Chip>
                      </RegisterCell>
                    </RegisterRow>
                  ))}
                </Register>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
