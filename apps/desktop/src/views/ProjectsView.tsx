import {
  BlockBar,
  Button,
  Chip,
  EmptyState,
  ProgressRule,
  Register,
  RegisterCell,
  RegisterRow,
  SegmentedControl,
  StatusMark,
  ViewToolbar,
} from '@dispatch/ui';
import { ArrowUpRight, Network } from 'lucide-react';
import { memo, useMemo, useRef, useState } from 'react';

import { plural } from '../adapters/planningFormat';
import {
  buildProjectsPage,
  countProjectRows,
  filterProjectGroups,
  parseProjectFilter,
  type ProjectFilterId,
  type ProjectRowModel,
} from '../adapters/projects';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { useShellActions } from '../components/shell/ShellActionsContext';
import { TasksBackButton } from '../components/tasks/TasksPageHeader';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { type Planning, usePlanningContext } from '../hooks/usePlanning';
import styles from './ProjectsView.module.css';

// The Projects register (the planner's /projects page, ported): every project
// that is not completed or canceled, grouped by initiative, with its status,
// next milestone, lead and allocation (agents working, else what the planning
// would do), on @dispatch/ui's Register. The data is the planning App computed
// once over the open project (hooks/usePlanning, through PlanningContext)
// mapped by adapters/projects; this view keeps only the toolbar's search and
// filter. Every link is a real href: the row opens the project's timeline
// lane, the end cell its graph and its page, the group's Graph button the
// initiative's graph; DispatchShell's link provider resolves them to routes.
// A page under Tasks (the Projects section's "All", the palette's Open
// Projects), led by "‹ tasks" when hosted and carrying New project.

const ICON = { size: 14, strokeWidth: 1.8 } as const;

/* Seven columns readable down to a register 900px wide: each keeps a floor
   that fits its content (a "2 agents working" chip on one line, the end
   cell its two 26px ghost icon buttons). Narrower, the rows become cards:
   the project on top, the other cells in as many 150px columns as fit. */
const COLUMNS =
  'minmax(150px, 1.3fr) 100px minmax(140px, 1.4fr) 96px minmax(84px, 0.8fr) minmax(116px, 1fr) 64px';
const STACKED_COLUMNS = 'repeat(auto-fill, minmax(150px, 1fr))';

const HEADER = [
  { id: 'name', label: 'Project' },
  { id: 'status', label: 'Status' },
  { id: 'next', label: 'Next milestone' },
  { id: 'progress', label: 'Progress' },
  { id: 'lead', label: 'Lead' },
  { id: 'allocation', label: 'Allocation' },
  { id: 'links', label: 'Links', align: 'end' as const },
];

export interface ProjectsViewProps {
  data: DispatchProjectData;
  /** Hosted under Tasks: the page leads with "‹ tasks" back to the list. */
  onBack?: () => void;
}

/**
 * The Projects page under Tasks. Without a daemon it shows the daemon state;
 * without a planning (outside App) it says so instead of an empty register.
 */
export function ProjectsView({ data, onBack }: ProjectsViewProps) {
  const planning = usePlanningContext();
  const daemonReady =
    !data.portLoading && !data.portError && data.client !== null;
  if (!daemonReady) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }
  if (planning === null) {
    return (
      <div className={styles.root} data-testid="projects-view">
        <EmptyState>The projects register is not available here.</EmptyState>
      </div>
    );
  }
  return <ProjectsLoaded planning={planning} data={data} onBack={onBack} />;
}

function ProjectsLoaded({
  planning,
  data,
  onBack,
}: ProjectsViewProps & { planning: Planning }) {
  const shell = useShellActions();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ProjectFilterId>('all');
  const searchRef = useRef<HTMLInputElement>(null);

  // The page model is rebuilt only with the planning or the fan-out progress
  // (what agents are doing): typing in the search never rebuilds the rows.
  const page = useMemo(
    () =>
      buildProjectsPage({
        timeline: planning.timeline,
        projects: planning.snapshot.projects,
        epicProgressById: data.epicProgressById,
      }),
    [planning, data.epicProgressById]
  );
  const shown = useMemo(
    () => filterProjectGroups(page.groups, query, filter),
    [page, query, filter]
  );
  const shownCount = countProjectRows(shown);
  const narrowed = query.trim() !== '' || filter !== 'all';

  const newProject = () => shell.openCreateTask({ kind: 'project' });
  const showAll = () => {
    setQuery('');
    setFilter('all');
    // The button goes away with the empty state; keep the keyboard user in
    // the toolbar instead of on <body>.
    searchRef.current?.focus();
  };

  return (
    <div className={styles.root} data-testid="projects-view">
      <header className={styles.head}>
        {onBack === undefined ? null : <TasksBackButton onBack={onBack} />}
        <h1 className={styles.title}>Projects</h1>
        <p className={styles.receipts}>{page.receipts}</p>
        {page.total > 0 ? (
          <span className={styles.headActions}>
            <Button size="sm" onClick={newProject}>
              New project
            </Button>
          </span>
        ) : null}
      </header>

      {page.total === 0 ? (
        <EmptyState
          label="No projects yet"
          action={
            <Button variant="primary" size="sm" onClick={newProject}>
              New project
            </Button>
          }
        >
          Initiatives, projects and milestones, made here or synced from Linear,
          are listed here with their next milestone, lead and what the agents
          are doing.
        </EmptyState>
      ) : (
        <>
          <ViewToolbar
            label="Project view options"
            search={{
              value: query,
              onChange: setQuery,
              placeholder: 'Search projects',
              label: 'Search projects',
              inputRef: searchRef,
            }}
            controls={
              <SegmentedControl
                label="Project status"
                options={page.filters}
                value={filter}
                onChange={(id) => setFilter(parseProjectFilter(id))}
                size="sm"
              />
            }
            end={
              <p className={styles.count} aria-live="polite">
                {narrowed
                  ? `${shownCount} of ${plural(page.total, 'project')}`
                  : plural(page.total, 'project')}
              </p>
            }
          />
          {shown.length === 0 ? (
            <EmptyState
              action={
                <Button size="sm" onClick={showAll}>
                  Show all projects
                </Button>
              }
            >
              No projects match
              {query.trim() === '' ? ' this filter' : ` "${query.trim()}"`}
            </EmptyState>
          ) : (
            shown.map((group) => (
              <section
                key={group.id}
                className={styles.group}
                aria-label={group.name}
              >
                <BlockBar
                  title={group.name}
                  meta={plural(group.rows.length, 'project')}
                >
                  <Button
                    href={group.graphHref}
                    variant="quiet"
                    size="sm"
                    icon={<Network {...ICON} />}
                    aria-label={`Dependency graph of ${group.name}`}
                  >
                    Graph
                  </Button>
                </BlockBar>
                <Register
                  label={`${group.name} projects`}
                  columns={COLUMNS}
                  header={HEADER}
                  stackWithin={900}
                  stackedColumns={STACKED_COLUMNS}
                >
                  {group.rows.map((row) => (
                    <ProjectRow key={row.id} row={row} />
                  ))}
                </Register>
              </section>
            ))
          )}
        </>
      )}
    </div>
  );
}

// One register row, memoized on its model: a search that narrows the groups
// redraws only the rows that come and go.
const ProjectRow = memo(function ProjectRow({ row }: { row: ProjectRowModel }) {
  const { next, allocation } = row;
  return (
    <RegisterRow
      href={row.timelineHref}
      rowLabel={`${row.name} on the timeline`}
      tone={row.rowTone}
    >
      <RegisterCell label="Project" variant="name" sub={row.initiative}>
        {row.name}
      </RegisterCell>
      {/* An inactive project's status is muted (no status hue in the row)
          but still a status: the grey-dot pill keeps the column a column of
          pills. */}
      <RegisterCell label="Status">
        <Chip tone={row.statusTone} dot={!row.active}>
          {row.status}
        </Chip>
      </RegisterCell>
      {next === null ? (
        <RegisterCell label="Next milestone" variant="mono" tone="muted">
          No open milestone
        </RegisterCell>
      ) : (
        <RegisterCell
          label="Next milestone"
          sub={
            next.dueTone !== 'default' && next.dueTone !== 'muted' ? (
              <span className={styles.toneText} data-tone={next.dueTone}>
                {next.dueLabel}
              </span>
            ) : (
              next.dueLabel
            )
          }
        >
          <span className={styles.milestone}>
            <StatusMark
              status={next.status}
              label={next.statusLabel}
              muted={next.muted}
            />
            <span className={styles.milestoneName}>{next.name}</span>
          </span>
        </RegisterCell>
      )}
      <RegisterCell label="Progress">
        {next === null ? (
          <span className={styles.dash}>—</span>
        ) : (
          <ProgressRule
            done={next.done}
            total={next.total}
            tone={next.progressTone}
            aria-label={`${next.name} progress`}
          />
        )}
      </RegisterCell>
      <RegisterCell
        label="Lead"
        variant={row.lead === null ? 'mono' : 'value'}
        tone={row.lead !== null ? 'default' : row.active ? 'warning' : 'muted'}
      >
        {row.lead ?? 'No lead'}
      </RegisterCell>
      {/* The chip carries the tone; a blocked project's reason line under it
          takes the amber too (the adapter's toneDetail opts it in). A muted
          cell greys its value; the blue and neutral chips colour only
          themselves. */}
      <RegisterCell
        label="Allocation"
        tone={
          allocation.tone === 'warning' || allocation.tone === 'muted'
            ? allocation.tone
            : 'default'
        }
        toneSub={allocation.toneDetail === true}
        sub={allocation.detail}
      >
        {allocation.plain === true ? (
          <span className={styles.plainValue}>{allocation.label}</span>
        ) : (
          <Chip tone={allocation.tone} filled={allocation.filled}>
            {allocation.label}
          </Chip>
        )}
      </RegisterCell>
      <RegisterCell align="end">
        <span className={styles.links}>
          <Button
            href={row.graphHref}
            variant="quiet"
            size="sm"
            icon={<Network {...ICON} />}
            title="Dependency graph"
            aria-label={`Graph of ${row.name}`}
          />
          <Button
            href={row.openHref}
            variant="quiet"
            size="sm"
            icon={<ArrowUpRight {...ICON} />}
            title="Open the project"
            aria-label={`Open ${row.name}`}
          />
        </span>
      </RegisterCell>
    </RegisterRow>
  );
});
