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
  Tooltip,
  ViewToolbar,
} from '@dispatch/ui';
import { CalendarRange, ListTodo, Network } from 'lucide-react';
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
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { type Planning, usePlanningContext } from '../hooks/usePlanning';
import { issuesHref } from '../lib/routes';
import { AssignMilestones } from './AssignMilestonesDialog';
import styles from './ProjectsView.module.css';

// The Projects register (the planner's /projects page, ported): every project
// that is not completed or canceled, grouped by initiative, with its status,
// next milestone and lead, on @dispatch/ui's Register. The data is the planning App computed
// once over the open project (hooks/usePlanning, through PlanningContext)
// mapped by adapters/projects; this view keeps only the toolbar's search and
// filter. Every link is a real href: the row opens the project's timeline
// lane, the end cell its issues (the Issues list narrowed to the project),
// its graph and its page, the group's Graph button the initiative's graph;
// DispatchShell's link provider resolves them to routes.
// Opened from the sidebar's Projects "All" or the palette; its head carries
// Assign next milestones (AssignMilestonesDialog) and New project.

const ICON = { size: 14, strokeWidth: 1.8 } as const;

/* Six columns readable down to a register 900px wide (stackWithin 900):
   each keeps a floor that fits its content (the end cell its three 26px
   ghost icon buttons and their two 2px gaps, the milestone's name
   wrapping). The floors add up to 636px, which with five 20px gaps and the
   row's 28px of padding fits well inside the 900px the register stacks
   under (ProjectsView.test.tsx checks the sum). Narrower, the rows become
   cards: the project on top, the other cells in as many 150px columns as
   fit. */
const COLUMNS =
  'minmax(150px, 1.3fr) 100px minmax(124px, 1.4fr) 96px minmax(84px, 0.8fr) 82px';
const STACKED_COLUMNS = 'repeat(auto-fill, minmax(150px, 1fr))';

const HEADER = [
  { id: 'name', label: 'Project' },
  { id: 'status', label: 'Status' },
  { id: 'next', label: 'Next milestone' },
  { id: 'progress', label: 'Progress' },
  { id: 'lead', label: 'Lead' },
  { id: 'links', label: 'Links', align: 'end' as const },
];

export interface ProjectsViewProps {
  data: DispatchProjectData;
}

/**
 * The Projects page. Without a daemon it shows the daemon state;
 * without a planning (outside App) it says so instead of an empty register.
 */
export function ProjectsView({ data }: ProjectsViewProps) {
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
  return <ProjectsLoaded planning={planning} data={data} />;
}

function ProjectsLoaded({
  planning,
  data,
}: ProjectsViewProps & { planning: Planning }) {
  const shell = useShellActions();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ProjectFilterId>('all');
  const searchRef = useRef<HTMLInputElement>(null);

  // The page model is rebuilt only with the planning: typing in the search
  // never rebuilds the rows.
  const page = useMemo(
    () =>
      buildProjectsPage({
        timeline: planning.timeline,
        projects: planning.snapshot.projects,
      }),
    [planning]
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
        <h1 className={styles.title}>Projects</h1>
        <p className={styles.receipts}>{page.receipts}</p>
        {page.total > 0 ? (
          <span className={styles.headActions}>
            <AssignMilestones data={data} planning={planning} />
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
                // An empty filter is a tab with nothing behind it; All and the open one stay.
                options={page.filters.filter(
                  (option) =>
                    option.count > 0 ||
                    option.id === 'all' ||
                    option.id === filter
                )}
                value={filter}
                onChange={(id) => setFilter(parseProjectFilter(id))}
                size="sm"
              />
            }
            // The header already counts them; the toolbar says so only when narrowed.
            end={
              narrowed ? (
                <p className={styles.count} aria-live="polite">
                  {`${shownCount} of ${plural(page.total, 'project')}`}
                </p>
              ) : undefined
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
                {group.headless ? null : (
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
                )}
                <Register
                  label={group.headless ? 'Projects' : `${group.name} projects`}
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
  const { next } = row;
  return (
    <RegisterRow
      // The row opens the project, as every other list's row opens its item.
      href={row.openHref}
      rowLabel={`Open ${row.name}`}
      tone={row.rowTone}
    >
      <RegisterCell
        label="Project"
        variant="name"
        sub={row.initiative === '' ? undefined : row.initiative}
      >
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
        tone={row.lead === null ? 'muted' : 'default'}
      >
        {row.lead ?? 'No lead'}
      </RegisterCell>
      <RegisterCell align="end">
        <span className={styles.links}>
          <Tooltip content="Issues">
            <Button
              href={issuesHref('all', row.id)}
              variant="quiet"
              size="sm"
              icon={<ListTodo {...ICON} />}
              aria-label={`Issues of ${row.name}`}
            />
          </Tooltip>
          <Tooltip content="Dependency graph">
            <Button
              href={row.graphHref}
              variant="quiet"
              size="sm"
              icon={<Network {...ICON} />}
              aria-label={`Graph of ${row.name}`}
            />
          </Tooltip>
          <Tooltip content="Timeline">
            <Button
              href={row.timelineHref}
              variant="quiet"
              size="sm"
              icon={<CalendarRange {...ICON} />}
              aria-label={`${row.name} on the timeline`}
            />
          </Tooltip>
        </span>
      </RegisterCell>
    </RegisterRow>
  );
});
