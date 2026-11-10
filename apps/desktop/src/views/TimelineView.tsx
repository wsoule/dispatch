import {
  EmptyState,
  SegmentedControl,
  TimelineChart,
  type TimelineZoom,
} from '@dispatch/ui';
import { useCallback, useMemo, useState } from 'react';

import {
  buildTimelineBanners,
  chartDependencies,
  filterTimelineGroups,
  parseTimelineShow,
  SHOW_OPTIONS,
  type TimelineHrefs,
  timelineReceipts,
  type TimelineShow,
  timelineWindow,
  toChartGroups,
  type UnplannedIssue,
  visibleDependencies,
} from '../adapters/timeline';
import { useShellActions } from '../components/shell/ShellActionsContext';
import { TimelineBanners } from '../components/timeline/TimelineBanners';
import { type Planning, usePlanningContext } from '../hooks/usePlanning';
import { hrefFor, taskHref } from '../lib/shellRoutes';
import styles from './TimelineView.module.css';

// The Timeline destination (architecture §8.4 "Timeline"): every project as a
// lane of milestone bars grouped by initiative, on @dispatch/ui's
// TimelineChart, with the missing-input banners under it. The data is the
// planning App computed once over the open project (hooks/usePlanning,
// through PlanningContext) mapped by adapters/timeline; this view only keeps
// the toolbar's state (zoom and the Show filter, remembered per window) and
// attaches the callbacks: a bar or chip quick-looks its milestone in the
// shell's slide-over, and a drag or keyboard re-date writes the milestone's
// due date through the unwrapped update verb, whose refusal rolls the bar
// back. A request-tier window is read-only: no handles.

const ZOOM_KEY = 'dispatch:timeline-zoom';
const SHOW_KEY = 'dispatch:timeline-show';

/** Where the chart's links go: a project, a milestone and an issue are all
 * tasks; "Plan in Issues" is the Issues list. */
const HREFS: TimelineHrefs = {
  task: taskHref,
  issues: () => hrefFor('issues'),
};

/** A remembered toolbar choice, or the default when storage is blocked or empty. */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A blocked store just means the next window opens on the defaults.
  }
}

function toZoom(value: string | null): TimelineZoom {
  return value === 'months' ? 'months' : 'weeks';
}

export interface TimelineViewProps {
  /** The window may not write (a request-tier token): no re-date handles. */
  readOnly: boolean;
  /** The container quick-looked in the drawer right now, ringed on the chart. */
  selectedId: string | null;
  /** A project whose lane to bring into view (`#/timeline?project=<id>`). */
  focusProjectId?: string | null;
  /** Writes a milestone's due date, rejecting when the daemon refuses, so the
   * chart announces the reason and rolls the bar back. */
  onRedate: (milestoneId: string, dueDate: string) => Promise<void>;
}

/**
 * The timeline page under Tasks. Without a planning (outside App) it says so
 * instead of drawing an empty chart.
 */
export function TimelineView(props: TimelineViewProps) {
  const planning = usePlanningContext();
  if (planning === null) {
    return (
      <div className={styles.root} data-testid="timeline-view">
        <EmptyState>The timeline is not available here.</EmptyState>
      </div>
    );
  }
  return <TimelineLoaded planning={planning} {...props} />;
}

function TimelineLoaded({
  planning,
  readOnly,
  selectedId,
  focusProjectId,
  onRedate,
}: TimelineViewProps & { planning: Planning }) {
  const { peekTask } = useShellActions();
  const { timeline, milestoneGraph, snapshot } = planning;
  const [zoom, setZoom] = useState<TimelineZoom>(() =>
    toZoom(readStored(ZOOM_KEY))
  );
  const [show, setShow] = useState<TimelineShow>(() =>
    parseTimelineShow(readStored(SHOW_KEY) ?? 'all')
  );

  // The chart recomputes its layout whenever `groups` changes identity, so
  // the groups (and their filtered view) are rebuilt only with the timeline.
  const groups = useMemo(
    () => toChartGroups(timeline, { canEdit: !readOnly, hrefs: HREFS }),
    [timeline, readOnly]
  );
  const visible = useMemo(
    () => filterTimelineGroups(groups, show),
    [groups, show]
  );
  const dependencies = useMemo(
    () => chartDependencies(milestoneGraph),
    [milestoneGraph]
  );
  const visibleDeps = useMemo(
    () => visibleDependencies(dependencies, visible),
    [dependencies, visible]
  );
  const calendar = useMemo(() => timelineWindow(timeline), [timeline]);

  // The unplanned banner names each issue: the planning counts ids, the
  // snapshot has their titles.
  const banners = useMemo(() => {
    const unplanned: UnplannedIssue[] = [];
    for (const project of timeline.banners.issuesWithoutMilestone.byProject) {
      for (const id of project.issueIds) {
        const issue = snapshot.issues.get(id);
        if (issue !== undefined) unplanned.push({ id, title: issue.title });
      }
    }
    return buildTimelineBanners(timeline, unplanned, HREFS);
  }, [timeline, snapshot]);

  const totalLanes = groups.reduce((n, group) => n + group.lanes.length, 0);

  const onZoomChange = useCallback((next: TimelineZoom) => {
    setZoom(next);
    writeStored(ZOOM_KEY, next);
  }, []);
  const onShowChange = useCallback((id: string) => {
    const next = parseTimelineShow(id);
    setShow(next);
    writeStored(SHOW_KEY, next);
  }, []);
  // The bar id is the milestone's task id, so the quick look is the task drawer.
  const openBar = useCallback((barId: string) => peekTask(barId), [peekTask]);
  const redate = useCallback(
    (barId: string, newEnd: string) => onRedate(barId, newEnd),
    [onRedate]
  );

  return (
    <div className={styles.root} data-testid="timeline-view">
      <header className={styles.head}>
        <h1 className={styles.title}>Timeline</h1>
        <p className={styles.receipts}>{timelineReceipts(timeline)}</p>
      </header>
      <section className={styles.chart} aria-label="Milestone timeline">
        <TimelineChart
          today={calendar.today}
          windowStart={calendar.windowStart}
          windowEnd={calendar.windowEnd}
          zoom={zoom}
          onZoomChange={onZoomChange}
          groups={visible}
          dependencies={visibleDeps}
          selectedBarId={selectedId ?? undefined}
          focusLaneId={focusProjectId ?? undefined}
          onOpenBar={openBar}
          onRedate={readOnly ? undefined : redate}
          label="Timeline"
          emptyLabel={
            totalLanes === 0
              ? 'No milestones with a target date yet. Add a milestone under a project and give it a due date to draw it here.'
              : 'No projects match this filter. Show all projects to see every lane.'
          }
          toolbarStart={
            <SegmentedControl
              size="sm"
              label="Show projects"
              options={[...SHOW_OPTIONS]}
              value={show}
              onChange={onShowChange}
            />
          }
          maxHeight="calc(100dvh - var(--topbar-h) - 240px)"
        />
      </section>
      <TimelineBanners banners={banners} />
    </div>
  );
}
