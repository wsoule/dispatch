import { useMemo, useState } from 'react';

import { ControlRibbon } from '../components/overview/ControlRibbon';
import { FeedFilterBar } from '../components/overview/FeedFilterBar';
import type { FeedRowActions } from '../components/overview/FeedRow';
import { FeedRow } from '../components/overview/FeedRow';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { buildFeed } from '../lib/controlRoom';
import type { FeedState } from '../lib/feedState';
import {
  FEED_STATE_LABEL,
  isUrgentState,
  tintForState,
} from '../lib/feedState';
import { GroupHeader } from '@/ui/ai/group-header';
import { PageHeader } from '@/ui/ai/page-header';
import { EmptyState } from '@/ui/chrome/empty-state';
import { StateMark } from '@/ui/chrome/state-mark';

interface OverviewViewProps {
  data: DispatchProjectData;
  /** The first crumb segment; the page is `Control room`. */
  projectName?: string | null;
  onOpenRun: (runId: string) => void;
  /** Opens the full-page Review for a run — where a diff gets read and annotated, as opposed
   * to the Runs surface, which is where a live agent gets watched. */
  onReviewRun: (runId: string) => void;
  /** Opens the task's detail panel — where findings get ruled on. */
  onOpenTask: (taskId: string) => void;
  onGoToBoard: () => void;
}

/** Toggles membership without mutating — every filter control here does this. */
function toggle<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

/** The groups the collapse machinery applies to — the machine's tier only. Everything that
 * is your move (or broken) is pinned open: the whole point of this screen is that what needs
 * a human is visible the moment the screen is, so those groups can be neither collapsed nor
 * swept up by collapse-all. */
const COLLAPSIBLE_GROUPS: readonly FeedState[] = [
  'working',
  'fixing',
  'checking',
  'landing',
];

/**
 * The Control room — the app's landing view and its answer to "what the hell is going on with
 * my agents."
 *
 * A panel header (`Project › Control room`; the state pills and the filter controls on its
 * second row) over one continuous feed grouped by state: a status-tinted `GroupHeader` per
 * group, every row a 36px `ListRow`. Groups are never capped — the header's count is the real
 * one and every row is on screen — and the machine's groups fold while the urgent ones stay
 * pinned open.
 *
 * Every row is one click from the surface that acts on it, and urgent rows carry enough
 * context to be acted on without leaving at all.
 */
export function OverviewView({
  data,
  projectName,
  onOpenRun,
  onReviewRun,
  onOpenTask,
  onGoToBoard,
}: OverviewViewProps) {
  const [query, setQuery] = useState('');
  const [activeStates, setActiveStates] = useState<ReadonlySet<FeedState>>(
    new Set()
  );
  const [activeEpic, setActiveEpic] = useState<string | null>(null);
  const [needsYouOnly, setNeedsYouOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<FeedState>>(new Set());

  const feed = useMemo(
    () =>
      buildFeed({
        runs: data.runs,
        tasks: data.tasks,
        epics: data.epics,
        readyIds: data.readyIds,
        blockedIds: data.blockedIds,
        mergeQueue: data.mergeQueue,
        pendingApprovals: data.pendingApprovals,
        openQuestions: data.openQuestions,
        fixLoops: data.fixLoops,
        query,
        activeStates,
        collapsed,
      }),
    [
      data.runs,
      data.tasks,
      data.epics,
      data.readyIds,
      data.blockedIds,
      data.mergeQueue,
      data.pendingApprovals,
      data.openQuestions,
      data.fixLoops,
      query,
      activeStates,
      collapsed,
    ]
  );

  // The facet menu's epic and needs-you filters apply on top of the feed: a group keeps its
  // matching rows (and its header count follows), and one with none left disappears.
  const groups = useMemo(() => {
    if (activeEpic === null && !needsYouOnly) return feed.groups;
    return feed.groups.flatMap((group) => {
      if (needsYouOnly && !isUrgentState(group.state)) return [];
      const rows = group.rows.filter(
        (row) => activeEpic === null || row.epicTitle === activeEpic
      );
      if (rows.length === 0 && !group.collapsed) return [];
      return [
        { ...group, rows, total: group.collapsed ? group.total : rows.length },
      ];
    });
  }, [feed.groups, activeEpic, needsYouOnly]);

  const epics = useMemo(() => {
    const set = new Set<string>();
    for (const group of feed.groups) {
      for (const row of group.rows) {
        if (row.epicTitle !== null) set.add(row.epicTitle);
      }
    }
    return [...set].sort();
  }, [feed.groups]);

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  // Ready and blocked aren't in the feed — they're tasks, not runs — so their pills navigate
  // to where you can act on them rather than filtering a feed they'd never appear in.
  function selectRibbon(state: FeedState) {
    if (state === 'ready' || state === 'blocked') {
      onGoToBoard();
      return;
    }
    setActiveStates((prev) => toggle(prev, state));
  }

  const actions: FeedRowActions = {
    onOpen: (row) => onOpenRun(row.runId),
    onRule: (row) => onOpenTask(row.taskId),
    onStopFixLoop: (row) => void data.handleStopFixLoop(row.taskId),
    onApprove: (row, allow) => {
      const pending = data.pendingApprovals.get(row.runId);
      // Without the request id there is nothing to answer (the gate is not listed yet, or this
      // window cannot read gates), so open the run, where the log says why.
      if (pending === undefined) {
        onOpenRun(row.runId);
        return;
      }
      void data.handleApprove(row.runId, pending.requestId, allow);
    },
    onRetry: (row) => void data.handleDispatch(row.taskId),
    onReview: (row) => onReviewRun(row.runId),
    onCancelLanding: (row) => void data.handleDequeueMerge(row.runId),
  };

  const allCollapsed = collapsed.size >= COLLAPSIBLE_GROUPS.length;
  const filtered =
    query !== '' ||
    activeStates.size > 0 ||
    activeEpic !== null ||
    needsYouOnly;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        crumb={[
          ...(projectName !== undefined && projectName !== null
            ? [projectName]
            : []),
          'Overview',
        ]}
        tabs={
          <ControlRibbon
            counts={feed.counts}
            activeStates={activeStates}
            onSelect={selectRibbon}
          />
        }
        controls={
          <FeedFilterBar
            query={query}
            onQueryChange={setQuery}
            activeStates={activeStates}
            onToggleState={(state) =>
              setActiveStates((prev) => toggle(prev, state))
            }
            onClearStates={() => setActiveStates(new Set())}
            epics={epics}
            activeEpic={activeEpic}
            onEpicChange={setActiveEpic}
            needsYouOnly={needsYouOnly}
            onNeedsYouChange={setNeedsYouOnly}
            allCollapsed={allCollapsed}
            onToggleCollapseAll={() =>
              setCollapsed(
                allCollapsed ? new Set() : new Set(COLLAPSIBLE_GROUPS)
              )
            }
          />
        }
      />

      <div
        role="feed"
        aria-label="Control room"
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        {groups.length === 0 ? (
          <EmptyFeed filtered={filtered} />
        ) : (
          groups.map((group) => {
            // Urgent groups are pinned open: no chevron, no way to fold away the very rows
            // this screen exists to surface.
            const pinned = isUrgentState(group.state);
            return (
              <div key={group.state} data-group={group.state} className="pt-2">
                <GroupHeader
                  tint={tintForState(group.state)}
                  icon={<StateMark state={group.state} />}
                  name={FEED_STATE_LABEL[group.state]}
                  count={group.total}
                  collapsed={group.collapsed}
                  onToggle={
                    pinned
                      ? undefined
                      : () => setCollapsed((prev) => toggle(prev, group.state))
                  }
                />
                {!group.collapsed && (
                  <div className="flex flex-col pt-0.5">
                    {group.rows.map((row) => (
                      <FeedRow key={row.runId} row={row} actions={actions} />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Distinguishes "you filtered everything out" from "nothing is running" — the second is good
 * news and has to read that way rather than as a broken screen. */
function EmptyFeed({ filtered }: { filtered: boolean }) {
  return filtered ? (
    <EmptyState
      illustration={<FilteredOutArt />}
      heading="Nothing matches that filter"
      description="Every row is hidden by the current filter. Clear it to see the feed."
      className="flex-1 py-16"
    />
  ) : (
    <EmptyState
      illustration={<AllQuietArt />}
      heading="All quiet"
      description="Nothing running, nothing waiting on you."
      className="flex-1 py-16"
    />
  );
}

const ART_PROPS = {
  viewBox: '0 0 60 60',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** §14's line-art for a filtered-out feed: a 60px magnifier with a struck-through lens. */
function FilteredOutArt() {
  return (
    <svg {...ART_PROPS}>
      <circle cx="26" cy="26" r="15" />
      <path d="M37 37 L49 49" />
      <path d="M20 20 L32 32 M32 20 L20 32" />
    </svg>
  );
}

/** §14's line-art for a quiet feed: a 60px circle carrying a check. */
function AllQuietArt() {
  return (
    <svg {...ART_PROPS}>
      <circle cx="30" cy="30" r="20" />
      <path d="M21 30 L27 36 L39 24" />
    </svg>
  );
}
