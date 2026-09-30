import type { EpicProgressChild } from '@dispatch/client';
import type { TaskListItem } from '@dispatch/core/browser';
import { isCompletedStatus, isDoneStatus } from '@dispatch/core/browser';
import { Target } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  FanoutControls,
  sessionIdle,
} from '../components/milestones/FanoutControls';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { useShellActions } from '../components/shell/ShellActionsContext';
import { DispatchDialog } from '../components/tasks/DispatchDialog';
import { StatusIcon } from '../components/tasks/StatusIcon';
import {
  VirtualRows,
  type VirtualRowsHandle,
} from '../components/virtual/VirtualRows';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { TaskTab } from '../lib/appNav';
import {
  readCollapsedGroups,
  toggleCollapsedGroup,
  TOGGLED_MILESTONES_STORAGE_KEY,
  writeCollapsedGroups,
} from '../lib/collapsedEpics';
import {
  drillTargetFor,
  showsPhasePill,
  type WorkEpicOptions,
} from '../lib/epicSession';
import { landingStateByTaskId } from '../lib/landingBadge';
import {
  groupTasks,
  type ListGroup,
  type ListGroupRow,
  visibleRowIds,
} from '../lib/listGrouping';
import {
  deriveMilestoneStatus,
  milestoneHealthPill,
} from '../lib/milestoneRisk';
import { isMilestoneFinished } from '../lib/milestoneRollup';
import { useStatusModelOf } from '../lib/statusModel';
import {
  DEFAULT_TASKS_DISPLAY,
  type TasksDisplayPrefs,
} from '../lib/tasksPrefs';
import { type FlatRow, flattenGroups, headerRowKey } from '../lib/virtualRows';
import {
  handleTaskListKeyDown,
  type OpenPicker,
  TaskListRow,
} from './TaskListRow';
import { liveClaimsFrom } from '@/lib/dispatchPreview';
import { GroupHeader } from '@/ui/ai/group-header';
import { LabelPill } from '@/ui/ai/pill';
import { EmptyState } from '@/ui/chrome';

/** A one-shot "go to this milestone" from another surface (Plans' confirm): expand it,
 * scroll it into view and, when `dispatch`, open the fan-out dialog. `nonce` distinguishes
 * two requests for the same epic. */
export interface FocusEpicRequest {
  epicId: string;
  dispatch: boolean;
  nonce: number;
}

interface MilestonesViewProps {
  data: DispatchProjectData;
  /** Opens a task; a row's phase pill picks the tab (a failed run's transcript, otherwise
   * details) the way the live rail does. */
  onOpenTask: (taskId: string, tab?: TaskTab, runId?: string) => void;
  focusEpic?: FocusEpicRequest | null;
  /** The Display popover's model; the milestones layout reads its ordering and row
   * properties and always groups by milestone. */
  display?: TasksDisplayPrefs;
  onRequestFilter?: () => void;
  onRequestDisplay?: () => void;
}

// Stable fallback while the config loads, so rows' `statuses` prop never churns.
const NO_STATUSES: string[] = [];

/** One virtual row: a milestone's header or one of its task rows, both 36px. */
type MilestoneRowModel = FlatRow<ListGroup, ListGroupRow>;

const ROW_HEIGHT = 36;
const rowHeight = () => ROW_HEIGHT;
const milestoneRowKey = (row: MilestoneRowModel) => row.key;
const taskRowKey = (row: ListGroupRow) => row.doc.meta.id;

/** The DOM id `aria-activedescendant` points at for one row; the view prefix keeps ids
 * unique across view switches. */
function rowDomId(id: string): string {
  return `milestone-row-${id}`;
}

/**
 * Milestones: every milestone is a status-tinted `GroupHeader` — the rolled-up status glyph
 * (the same vocabulary its tasks use), the title, then `FanoutControls`: a `◔ n/m` progress
 * glyph, one `At risk` / `N running` pill while nobody is fanning out, and the session's
 * own chips and verbs (Send agents…, Pause/Stop, Resume/Raise ceiling…, Land) once someone
 * is — over the same 36px `TaskListRow`s the Tasks list renders, with the same pickers and
 * single-key shortcuts, each row carrying its fan-out phase while a session exists. A
 * finished milestone (every child landed/dropped) reads as landed and sinks to the bottom,
 * starting collapsed. Groups follow the real hierarchy (initiative › project ›
 * milestone): a parent issue is a row with its sub-issues under it, and a header's "+"
 * files the new task under that container.
 */
export function MilestonesView({
  data,
  onOpenTask,
  focusEpic = null,
  display,
  onRequestFilter,
  onRequestDisplay,
}: MilestonesViewProps) {
  const shell = useShellActions();
  const model = useStatusModelOf(data.config);
  const prefs = useMemo<TasksDisplayPrefs>(
    () => ({ ...(display ?? DEFAULT_TASKS_DISPLAY), grouping: 'milestone' }),
    [display]
  );
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [picker, setPicker] = useState<OpenPicker | null>(null);
  // The fan-out dialog, open for one epic: `start` sends a fresh session, `raise` edits a
  // paused one's ceilings.
  const [dispatchEpic, setDispatchEpic] = useState<{
    epicId: string;
    mode: 'start' | 'raise';
  } | null>(null);
  // Milestones the user has flipped away from their default fold (unfinished start open,
  // finished start collapsed). Session-scoped under this page's own key so the fold survives
  // a view switch; the list's key stores "collapsed", which would read backwards here.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() =>
    readCollapsedGroups(TOGGLED_MILESTONES_STORAGE_KEY)
  );
  const listRef = useRef<HTMLDivElement>(null);
  // The scroller as state too: the virtual track needs it once it exists (see VirtualRows).
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const attachList = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    setListEl(node);
  }, []);
  const virtualRef = useRef<VirtualRowsHandle>(null);

  const epicById = useMemo(() => {
    const map = new Map<string, TaskListItem>();
    for (const epic of data.epics) map.set(epic.meta.id, epic);
    return map;
  }, [data.epics]);

  const taskById = useMemo(() => {
    const map = new Map<string, TaskListItem>();
    for (const doc of data.tasks) map.set(doc.meta.id, doc);
    return map;
  }, [data.tasks]);
  const landingByTaskId = useMemo(
    () => landingStateByTaskId(data.mergeQueue),
    [data.mergeQueue]
  );

  // Each child's fan-out phase, by epic then child id, for the epics that have a session —
  // a row under any other milestone shows no phase, so those epics are left out.
  const phaseByEpic = useMemo(() => {
    const map = new Map<string, Map<string, EpicProgressChild>>();
    for (const [epicId, progress] of data.epicProgressById) {
      if (progress.session === null) continue;
      map.set(epicId, new Map(progress.children.map((c) => [c.id, c])));
    }
    return map;
  }, [data.epicProgressById]);

  // Every milestone, empty ones included — a milestone with no tasks yet is still a plan.
  const groups = useMemo(
    () =>
      groupTasks(
        data.tasks,
        { ...prefs, showEmptyGroups: true },
        {
          statuses: data.config?.statuses ?? [],
          epics: data.epics,
          model,
        }
      ).filter((g) => g.epicId !== null),
    [data.tasks, data.config, data.epics, prefs, model]
  );

  // A finished milestone's default is folded, so its key in `toggled` means "opened".
  const collapsed = useMemo(() => {
    const set = new Set<string>();
    for (const g of groups) {
      const finished = isMilestoneFinished(
        g.rows.map((r) => r.doc),
        model
      );
      if (finished !== toggled.has(g.key)) set.add(g.key);
    }
    return set;
  }, [groups, toggled, model]);

  const orderedIds = useMemo(
    () => visibleRowIds(groups, collapsed),
    [groups, collapsed]
  );

  // Every milestone header and its rows as one flat, virtualized array.
  const flatRows = useMemo<MilestoneRowModel[]>(
    () =>
      flattenGroups(
        groups.map((g) => ({ key: g.key, header: g, items: g.rows })),
        collapsed,
        taskRowKey
      ),
    [groups, collapsed]
  );
  // The cursor's row stays mounted: the grid's `aria-activedescendant` points at it.
  const pinnedKeys = useMemo(
    () => (focusedTaskId === null ? [] : [focusedTaskId]),
    [focusedTaskId]
  );

  useEffect(() => {
    if (orderedIds.length === 0) {
      setFocusedTaskId(null);
    } else if (focusedTaskId === null || !orderedIds.includes(focusedTaskId)) {
      setFocusedTaskId(orderedIds[0] ?? null);
    }
  }, [orderedIds, focusedTaskId]);

  const daemonReady =
    !data.portLoading && !data.portError && data.client !== null;
  const showList = daemonReady && groups.length > 0;

  // The grid takes focus once it is on screen so j/k/s/p work without a click first.
  useEffect(() => {
    if (showList) listRef.current?.focus();
  }, [showList]);

  // A focus request waits for its group to exist (tasks may still be loading) and for the
  // scroller to reach the virtual track (the render after mount), then unfolds it — a finished milestone starts collapsed — scrolls to it and opens the
  // dialog when asked. Each nonce is served once.
  const servedFocusNonce = useRef<number | null>(null);
  useEffect(() => {
    if (focusEpic === null || servedFocusNonce.current === focusEpic.nonce) {
      return;
    }
    const group = groups.find((g) => g.epicId === focusEpic.epicId);
    if (group === undefined || listEl === null) return;
    servedFocusNonce.current = focusEpic.nonce;
    const finished = isMilestoneFinished(
      group.rows.map((r) => r.doc),
      model
    );
    setToggled((prev) => {
      // Open means "flipped" for a finished milestone and "not flipped" otherwise.
      if (finished === prev.has(group.key)) return prev;
      const next = toggleCollapsedGroup(prev, group.key);
      writeCollapsedGroups(TOGGLED_MILESTONES_STORAGE_KEY, next);
      return next;
    });
    virtualRef.current?.scrollToKey(headerRowKey(group.key), 'start');
    if (focusEpic.dispatch) {
      setDispatchEpic({ epicId: focusEpic.epicId, mode: 'start' });
    }
  }, [focusEpic, groups, listEl, model]);

  // Stable across renders so memo'd rows skip re-rendering on a cursor move.
  const openRow = useCallback(
    (id: string) => {
      const parent = taskById.get(id)?.meta.parent ?? null;
      const phase =
        parent === null ? undefined : phaseByEpic.get(parent)?.get(id);
      if (phase !== undefined && showsPhasePill(phase.phase)) {
        const target = drillTargetFor(phase);
        onOpenTask(id, target.tab, target.runId);
        return;
      }
      onOpenTask(id);
    },
    [taskById, phaseByEpic, onOpenTask]
  );
  // The labels picker's vocabulary, gathered only while one is open.
  const labelCandidates = useMemo(
    () =>
      picker?.kind === 'labels'
        ? [...new Set(data.tasks.flatMap((t) => t.meta.labels))].sort()
        : undefined,
    [picker?.kind, data.tasks]
  );
  const statuses = data.config?.statuses ?? NO_STATUSES;

  if (!daemonReady) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  function toggle(key: string) {
    setToggled((prev) => {
      const next = toggleCollapsedGroup(prev, key);
      writeCollapsedGroups(TOGGLED_MILESTONES_STORAGE_KEY, next);
      return next;
    });
  }

  // Only a keyboard move scrolls — a hover that set the cursor must not shift the list under
  // the pointer.
  function moveCursor(id: string | null) {
    setFocusedTaskId(id);
    if (id !== null) virtualRef.current?.scrollToKey(id);
  }

  // A row under a milestone with a session opens where its phase points (a failed run's
  // transcript, a capped loop's ruling on details); any other row opens plainly.
  function phaseFor(doc: TaskListItem) {
    const parent = doc.meta.parent;
    if (parent === null) return undefined;
    return phaseByEpic.get(parent)?.get(doc.meta.id);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    handleTaskListKeyDown(e, {
      orderedIds,
      focusedTaskId,
      setFocusedTaskId: moveCursor,
      onOpen: openRow,
      onPeek: shell.peekTask,
      onDispatch: (id) => {
        if (data.readyIds.has(id)) void data.handleDispatch(id);
      },
      onCopyId: shell.copyTaskId,
      setPicker,
      onEscape: () => {
        if (picker === null) return false;
        setPicker(null);
        return true;
      },
      onRequestFilter,
      onRequestDisplay,
    });
  }

  if (!showList) {
    return (
      <EmptyState
        icon={Target}
        heading="No milestones yet"
        description="A milestone is an epic with its tasks under it. Plan work… drafts one for you."
        primary={{
          label: 'Plan work…',
          onClick: () => shell.setProjectView('plans'),
        }}
        secondary={{
          label: 'New task',
          onClick: () => shell.openCreateTask(),
        }}
        className="h-full"
      />
    );
  }

  const dialogEpic =
    dispatchEpic !== null ? epicById.get(dispatchEpic.epicId) : undefined;
  // Only a raise pre-fills from the session; a fresh fan-out starts from the defaults.
  const dialogSession =
    dispatchEpic?.mode === 'raise'
      ? (data.epicProgressById.get(dispatchEpic.epicId)?.session ?? null)
      : null;
  const dialog =
    dispatchEpic !== null && dialogEpic !== undefined ? (
      <DispatchDialog
        title={`${dispatchEpic.mode === 'raise' ? 'Raise ceiling' : 'Send agents'} · ${dialogEpic.meta.title}`}
        tasks={
          // What a fan-out works on: the container's own children. Sub-issues nest
          // in its group but go with their parent issue.
          groups
            .find((g) => g.epicId === dispatchEpic.epicId)
            ?.rows.map((r) => r.doc)
            .filter((doc) => doc.meta.parent === dispatchEpic.epicId) ?? []
        }
        readyIds={data.readyIds}
        runningNow={data.liveRunStateByTaskId.size}
        liveClaims={liveClaimsFrom(data.runs)}
        defaultConcurrency={data.config?.orchestrator.epicConcurrency ?? 3}
        maxConcurrency={data.config?.orchestrator.maxConcurrency}
        runCostEstimateUsd={data.config?.orchestrator.runCostEstimateUsd}
        fixLoopAuto={data.config?.fixLoop.auto}
        mode={dispatchEpic.mode}
        initial={
          dialogSession !== null
            ? {
                concurrency: dialogSession.concurrency,
                maxSpendUsd: dialogSession.maxSpendUsd,
                maxRuns: dialogSession.maxRuns,
              }
            : undefined
        }
        onCancel={() => setDispatchEpic(null)}
        onConfirm={async (opts: WorkEpicOptions) => {
          if (dispatchEpic.mode === 'raise') {
            await data.handleResumeEpic(dispatchEpic.epicId, opts);
          } else {
            await data.handleWorkEpic(dispatchEpic.epicId, opts);
          }
          setDispatchEpic(null);
        }}
      />
    ) : null;

  // One milestone's header: rolled-up status glyph, title, then the fan-out controls.
  function renderHeader(group: ListGroup, isCollapsed: boolean) {
    const children = group.rows.map((r) => r.doc);
    const done = children.filter((t) =>
      isDoneStatus(t.meta.status, model)
    ).length;
    const finished = isMilestoneFinished(children, model);
    const status = deriveMilestoneStatus(
      children,
      data.latestRunByTaskId,
      finished
    );
    const health = milestoneHealthPill(status);
    const epicId = group.epicId ?? '';
    const epic = epicById.get(epicId);
    const progress = data.epicProgressById.get(epicId);
    const session = progress?.session ?? null;
    // The server's own land rule (every child done or cancelled), read off its progress
    // so the button never leads a 409 it could have predicted.
    const progressTotal = progress?.children.length ?? 0;
    const progressDone =
      progress?.children.filter((c) => isDoneStatus(c.status, model)).length ??
      0;
    const landable =
      epic !== undefined &&
      session?.state !== 'active' &&
      session?.state !== 'paused' &&
      progressTotal > 0 &&
      progressDone === progressTotal &&
      !isCompletedStatus(epic.meta.status, model);
    return (
      <div data-group-key={group.key}>
        <GroupHeader
          tint={group.tint ?? undefined}
          icon={
            group.icon?.kind === 'milestone' ? (
              <StatusIcon status={group.icon.status} />
            ) : undefined
          }
          name={group.label}
          collapsed={isCollapsed}
          onToggle={() => toggle(group.key)}
          onAdd={() => shell.openCreateTask(group.preset)}
          addLabel={`New task in ${group.label}`}
          actions={
            epic !== undefined && (
              <FanoutControls
                epic={epic}
                model={model}
                progress={progress}
                count={{ done, total: children.length }}
                landable={landable}
                onSendAgents={(id) =>
                  setDispatchEpic({ epicId: id, mode: 'start' })
                }
                onPause={data.handlePauseEpic}
                onResume={data.handleResumeEpic}
                onRaiseCeiling={(id) =>
                  setDispatchEpic({ epicId: id, mode: 'raise' })
                }
                onStop={data.handleStopEpic}
                onLand={data.handleLandEpic}
                onOpenEpic={(id) => onOpenTask(id, 'plan')}
              >
                {/* The health pill speaks for a milestone nobody is fanning out; a live
                    session's phase chips replace it. */}
                {health !== null && sessionIdle(session) && (
                  <LabelPill
                    color={health.tint}
                    title={status.reason ?? undefined}
                  >
                    {health.label}
                  </LabelPill>
                )}
              </FanoutControls>
            )
          }
        />
      </div>
    );
  }

  return (
    <div
      ref={attachList}
      tabIndex={0}
      role="grid"
      aria-label="Milestones"
      aria-activedescendant={
        focusedTaskId !== null ? rowDomId(focusedTaskId) : undefined
      }
      onKeyDown={handleKeyDown}
      className="flex h-full min-h-0 flex-col overflow-y-auto px-2 pb-2 outline-none"
    >
      <VirtualRows
        rows={flatRows}
        rowKey={milestoneRowKey}
        estimateSize={rowHeight}
        scrollElement={listEl}
        pinnedKeys={pinnedKeys}
        handleRef={virtualRef}
        renderRow={(row) =>
          row.kind === 'header' ? (
            renderHeader(row.header, row.collapsed)
          ) : (
            <TaskListRow
              doc={row.item.doc}
              prefs={prefs}
              run={data.latestRunByTaskId.get(row.key)}
              live={data.liveRunStateByTaskId.has(row.key)}
              needsYou={data.attentionByTaskId.has(row.key)}
              landing={landingByTaskId.get(row.key)}
              fixLoop={data.fixLoops.get(row.key)}
              statuses={statuses}
              epics={data.epics}
              labelCandidates={
                picker?.taskId === row.key ? labelCandidates : undefined
              }
              onUpdate={data.handleUpdate}
              onMoveStatus={data.moveTaskStatus}
              indent={row.item.indent}
              showEpicChip={false}
              picker={picker?.taskId === row.key ? picker : null}
              onPickerChange={setPicker}
              phase={phaseFor(row.item.doc)}
              selected={false}
              focused={focusedTaskId === row.key}
              onOpen={openRow}
              onFocus={setFocusedTaskId}
              rowProps={{ domId: rowDomId(row.key) }}
            />
          )
        }
      />
      {dialog}
    </div>
  );
}
