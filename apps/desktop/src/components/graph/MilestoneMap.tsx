import type { TaskListItem } from '@dispatch-foo/core/browser';
import {
  Button,
  ChipButton,
  COPIED_MS,
  cx,
  EmptyState,
  type PickerOption,
  PickerPopover,
  Popover,
  SegmentedControl,
  Switch,
  writeClipboard,
} from '@dispatch/ui';
import { PanelRight, SearchIcon, SlidersHorizontal } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { TaskTab } from '../../lib/appNav';
import {
  type ChartLayout,
  type ChartSpec,
  layoutChart,
} from '../../lib/chartLayout';
import { type Box, unionBox } from '../../lib/chartViewport';
import {
  type ContainerStatus,
  containerStatus,
} from '../../lib/containerStatus';
import {
  type ChartModel,
  type ChartState,
  type ChartTask,
  dependencyChart,
  drawnTasks,
  traceChart,
} from '../../lib/dependencyChart';
import type { ListGroup } from '../../lib/listGrouping';
import { milestonesToMermaid, tasksToMermaid } from '../../lib/mermaidExport';
import { milestoneMap, milestoneMix } from '../../lib/milestoneMap';
import type { TaskBucket } from '../../lib/taskStatus';
import { StatusIcon } from '../tasks/StatusIcon';
import {
  type CanvasEdge,
  ChartCanvas,
  type EdgeTone,
  LegendItem,
  NO_MILESTONE_GROUP,
  type NodeTrace,
  PillSwatch,
  TraceSwatch,
} from './ChartCanvas';
import {
  InspectorOverview,
  LinkInspector,
  MilestoneInspector,
  SetInspector,
  TaskInspector,
} from './ChartInspector';
import {
  MILESTONE_NODE,
  MilestoneChartNode,
  StateSwatch,
  TASK_NODE,
  TaskChartNode,
} from './ChartNodes';
import { CHART_STATE, STATE_ORDER } from './chartTones';
import styles from './MilestoneMap.module.css';
import { type ChartViewportApi, useChartViewport } from './useChartViewport';

/** The chart's two views: milestones as cards, or every linked task. */
export type ChartView = 'milestones' | 'tasks';

const ALL_VIEWS: readonly ChartView[] = ['milestones', 'tasks'];

const GRAPH_MODES: { id: ChartView; label: string }[] = [
  { id: 'milestones', label: 'Milestones' },
  { id: 'tasks', label: 'Tasks' },
];

/** More task cards than this is too many for one readable chart (or one quick ELK
 * layout): the Tasks chart asks to be narrowed instead. */
export const TASK_DRAW_CAP = 400;

// Remembered per project; storage that throws just means it is not remembered. A view the
// host does not offer reads as its first one.
function storedMode(key: string, views: readonly ChartView[]): ChartView {
  const fallback = views[0] ?? 'milestones';
  try {
    const stored = localStorage.getItem(key);
    return views.find((view) => view === stored) ?? fallback;
  } catch {
    return fallback;
  }
}

function storeMode(key: string, mode: ChartView): void {
  try {
    localStorage.setItem(key, mode);
  } catch {
    // Kept for this session only.
  }
}

/** The chart's display choices, remembered per project like the layout. */
export interface ChartPrefs {
  hideLanded: boolean;
  showUnlinked: boolean;
  /** Box the Tasks chart's cards by milestone (off by default: boxes stretch the layout). */
  grouped: boolean;
  inspector: boolean;
}

const DEFAULT_PREFS: ChartPrefs = {
  hideLanded: false,
  showUnlinked: false,
  grouped: false,
  inspector: true,
};

// Reads each flag on its own, so a stored object from an older shape keeps what still fits;
// a flag never stored takes the host's default.
function storedPrefs(key: string, defaults: ChartPrefs): ChartPrefs {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return defaults;
    const flag = (name: keyof ChartPrefs) => {
      const value: unknown = Reflect.get(raw, name);
      return typeof value === 'boolean' ? value : defaults[name];
    };
    return {
      hideLanded: flag('hideLanded'),
      showUnlinked: flag('showUnlinked'),
      grouped: flag('grouped'),
      inspector: flag('inspector'),
    };
  } catch {
    return defaults;
  }
}

function storePrefs(key: string, prefs: ChartPrefs): void {
  try {
    localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    // Kept for this session only.
  }
}

/**
 * What the chart has selected: one task, one milestone, one milestone link, a highlight
 * preset, or one milestone's tasks. Presets and "tasks of" are stored by reference, not as
 * a list of ids, so they follow the live data (a task that lands leaves "In progress").
 */
type Selection =
  | { kind: 'task'; id: string }
  | { kind: 'milestone'; id: string }
  | { kind: 'link'; from: string; to: string }
  | { kind: 'preset'; id: string }
  | { kind: 'tasks-of'; milestone: string };

/** A highlighted set as the inspector and the chart see it. */
interface HighlightSet {
  label: string;
  blurb: string;
  ids: readonly string[];
}

interface Preset {
  id: string;
  label: string;
  blurb: string;
  ids: (chart: ChartModel) => readonly string[];
}

// The highlight buttons: the reference map's three, plus what needs you.
const PRESETS: readonly Preset[] = [
  {
    id: 'chain',
    label: 'Longest chain',
    blurb:
      'The longest run of open tasks where each waits on the one before. Nothing at its end can land until every step before it does.',
    ids: (chart) => chart.longestChain,
  },
  {
    id: 'ready',
    label: 'Ready',
    blurb: 'Open tasks whose blockers have all landed, or that have none.',
    ids: (chart) => chart.readyNow,
  },
  {
    id: 'moving',
    label: 'In progress',
    blurb: 'Tasks working, in review or landing.',
    ids: (chart) => chart.inProgress,
  },
  {
    id: 'needs-you',
    label: 'Needs you',
    blurb: 'Tasks with an ask waiting on you, or whose last run failed.',
    ids: (chart) => chart.needsYou,
  },
];

const ZOOM_STEP = 1.35;
// Below this stage width a whole Tasks chart is too small to read, so the first fit frames
// the head of the longest chain instead, as the reference map does on a phone.
const NARROW_STAGE_PX = 600;

/** The edge key milestoneMap and the chart model share. */
const pairKey = (from: string, to: string) => `${from}\u0000${to}`;

function groupIdOf(task: ChartTask): string {
  return task.milestoneId === null
    ? NO_MILESTONE_GROUP
    : `group:${task.milestoneId}`;
}

/** The world box around some placed nodes, with room to breathe, or null if none are placed. */
function boxOf(layout: ChartLayout, ids: Iterable<string>): Box | null {
  const boxes: Box[] = [];
  for (const id of ids) {
    const box = layout.nodes.get(id);
    if (box !== undefined) boxes.push(box);
  }
  const union = unionBox(boxes);
  if (union === null) return null;
  return {
    x: union.x - 20,
    y: union.y - 20,
    width: union.width + 40,
    height: union.height + 40,
  };
}

/** An id made safe inside an attribute selector (CSS.escape, where the engine has it). */
function cssEscape(id: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(id)
    : id.replace(/["\\]/g, '\\$&');
}

function wholeBox(layout: ChartLayout): Box {
  return { x: 0, y: 0, width: layout.width, height: layout.height };
}

/** Whether a world box shows entirely on the stage under the viewport's transform. */
function onStage(viewport: ChartViewportApi, box: Box): boolean {
  const { x, y, k } = viewport.transform();
  const { width, height } = viewport.size();
  const left = box.x * k + x;
  const top = box.y * k + y;
  return (
    left >= 0 &&
    top >= 0 &&
    left + box.width * k <= width &&
    top + box.height * k <= height
  );
}

/**
 * The Tasks spec's node order, from things a task landing or a priority change does not
 * move: milestones in list order, then tasks by created date and id. The list's own row
 * order sinks landed work and sorts by priority, so building from it would miss the layout
 * cache and reshuffle the chart every time an agent lands something.
 */
function stableOrder(chart: ChartModel, ids: readonly string[]): ChartTask[] {
  const rank = new Map<string | null, number>();
  for (const id of chart.order) {
    const milestone = chart.tasks.get(id)?.milestoneId ?? null;
    if (!rank.has(milestone)) rank.set(milestone, rank.size);
  }
  return ids
    .map((id) => chart.tasks.get(id))
    .filter((t): t is ChartTask => t !== undefined)
    .sort(
      (a, b) =>
        (rank.get(a.milestoneId) ?? 0) - (rank.get(b.milestoneId) ?? 0) ||
        a.doc.meta.created.localeCompare(b.doc.meta.created) ||
        a.id.localeCompare(b.id)
    );
}

/** Per-node and per-edge emphasis for the current selection; null fields mean "at rest". */
interface Highlight {
  node: (id: string) => NodeTrace | null;
  edge: (from: string, to: string) => EdgeTone | null;
}

const AT_REST: Highlight = { node: () => null, edge: () => null };

/**
 * What lights up for a selection. A task lights everything upstream amber and downstream
 * teal, an edge counting as traced only when both its ends are (so a blocker's other
 * dependents stay faded); a milestone lights its direct neighbours the same way; a link or a
 * set lights its members; everything else fades. An empty set lights nothing.
 */
function highlightFor(
  selection: Selection | null,
  set: HighlightSet | null,
  view: ChartView,
  chart: ChartModel,
  milestoneEdges: readonly { from: string; to: string }[]
): Highlight {
  if (selection === null) return AT_REST;
  if (selection.kind === 'task') {
    const sel = selection.id;
    const up = traceChart(chart, sel, 'up');
    const down = traceChart(chart, sel, 'down');
    return {
      node: (id) =>
        id === sel ? 'sel' : up.has(id) ? 'up' : down.has(id) ? 'down' : 'dim',
      edge: (from, to) =>
        up.has(from) && (to === sel || up.has(to))
          ? 'up'
          : down.has(to) && (from === sel || down.has(from))
            ? 'down'
            : 'dim',
    };
  }
  if (selection.kind === 'milestone') {
    const sel = selection.id;
    const ins = new Set(
      milestoneEdges.filter((e) => e.to === sel).map((e) => e.from)
    );
    const outs = new Set(
      milestoneEdges.filter((e) => e.from === sel).map((e) => e.to)
    );
    return {
      node: (id) =>
        id === sel ? 'sel' : ins.has(id) ? 'up' : outs.has(id) ? 'down' : 'dim',
      edge: (from, to) => (to === sel ? 'up' : from === sel ? 'down' : 'dim'),
    };
  }
  if (selection.kind === 'link') {
    const { from: a, to: b } = selection;
    return {
      node: (id) => (id === a ? 'up' : id === b ? 'down' : 'dim'),
      edge: (from, to) => (from === a && to === b ? 'set' : 'dim'),
    };
  }
  if (set === null || set.ids.length === 0) return AT_REST;
  const members =
    view === 'tasks'
      ? new Set(set.ids)
      : new Set(
          set.ids
            .map((id) => chart.tasks.get(id)?.milestoneId)
            .filter((m): m is string => m !== null && m !== undefined)
        );
  return {
    node: (id) => (members.has(id) ? 'set' : 'dim'),
    edge: (from, to) =>
      view === 'tasks' && members.has(from) && members.has(to) ? 'set' : 'dim',
  };
}

// Blocked and draft cards look alike (only the glyph and word differ), so the legend lists
// them as one entry.
const LEGEND_MERGED: Partial<Record<ChartState, ChartState>> = {
  draft: 'blocked',
};

/** The legend under the Tasks chart: the states actually drawn, then the trace lines. */
function TasksLegend({
  chart,
  drawn,
}: {
  chart: ChartModel;
  drawn: readonly string[];
}) {
  const present = new Set<ChartState>();
  for (const id of drawn) {
    const state = chart.tasks.get(id)?.state;
    if (state !== undefined) present.add(state);
  }
  const both = present.has('blocked') && present.has('draft');
  return (
    <>
      {STATE_ORDER.filter(
        (state) =>
          present.has(state) && !(both && LEGEND_MERGED[state] !== undefined)
      ).map((state) => (
        <LegendItem key={state} swatch={<StateSwatch state={state} />}>
          {state === 'blocked' && both
            ? 'Blocked or draft'
            : CHART_STATE[state].label}
        </LegendItem>
      ))}
      <TraceLegend />
    </>
  );
}

function TraceLegend() {
  return (
    <>
      <LegendItem swatch={<TraceSwatch dir="up" />}>Waits on</LegendItem>
      <LegendItem swatch={<TraceSwatch dir="down" />}>Unblocks</LegendItem>
    </>
  );
}

/** The legend under the Milestones chart: the trace lines and what the pills count. */
function MilestonesLegend({ attention }: { attention: boolean }) {
  return (
    <>
      <TraceLegend />
      <LegendItem swatch={<PillSwatch />}>Task waits</LegendItem>
      {attention && (
        <LegendItem swatch={<PillSwatch attention />}>
          From a milestone that needs attention
        </LegendItem>
      )}
    </>
  );
}

export interface MilestoneMapViewProps {
  groups: readonly ListGroup[];
  bucketOf: (doc: TaskListItem) => TaskBucket | null;
  asksByTask: ReadonlyMap<string, number>;
  /** Keys the remembered view (Milestones or Tasks) and display choices. Callers key the
   * component by it too, so a project switch starts from that project's own state. */
  projectKey: string;
  /** A milestone's due date, if it has one. */
  dueDateOf?: (milestoneId: string) => string | null;
  /** A task to select on arrival (a link that named one): the chart switches to Tasks and
   * frames it. */
  arrivalTaskId?: string | null;
  /** Stands in for the Tasks chart when it would draw more than TASK_DRAW_CAP cards: the
   * narrower charts to open instead. */
  renderTooLarge?: (count: number) => ReactNode;
  /** Opens a task (the drawer); `plan` asks for a milestone's own page. */
  onOpenTask: (taskId: string, tab?: TaskTab) => void;
  /** The views the toolbar offers, the first the default; one view hides the switch. */
  views?: readonly ChartView[];
  /** Display choices before the user makes their own (a plan shows its unlinked tasks). */
  defaultPrefs?: Partial<ChartPrefs>;
  /** The host's verbs in a selected task's inspector (a plan's Send agent). */
  taskActions?: (taskId: string) => ReactNode;
  /** The host's verbs in a selected milestone's inspector (a plan band's fan-out). */
  milestoneActions?: (milestoneId: string) => ReactNode;
  /** A chart inside a scrolling page: a plain scroll scrolls the page, a pinch zooms. */
  embedded?: boolean;
  /** With the inspector toggled off, a selection still opens it, for the host's verbs. */
  inspectorOnSelect?: boolean;
  className?: string;
}

/**
 * The Graph view's dependency charts. Milestones is the one-screen overview: milestones as
 * cards, the task waits between them as counted lines. Tasks draws every task that waits on
 * or unblocks another, laid out left to right by elkjs with routed lines. Both pan and zoom,
 * and clicking a node traces what it waits on and what it unblocks, with an inspector that
 * lists both; search, highlight presets and display toggles sit in the toolbar.
 */
export function MilestoneMapView({
  groups,
  bucketOf,
  asksByTask,
  projectKey,
  dueDateOf,
  arrivalTaskId = null,
  renderTooLarge,
  onOpenTask,
  views = ALL_VIEWS,
  defaultPrefs,
  taskActions,
  milestoneActions,
  embedded = false,
  inspectorOnSelect = false,
  className,
}: MilestoneMapViewProps) {
  const storageKey = `dispatch:graph-mode:${projectKey}`;
  const prefsKey = `dispatch:graph-chart:${projectKey}`;
  const [mode, setMode] = useState<ChartView>(() =>
    arrivalTaskId !== null && views.includes('tasks')
      ? 'tasks'
      : storedMode(storageKey, views)
  );
  const [prefs, setPrefs] = useState<ChartPrefs>(() =>
    storedPrefs(prefsKey, { ...DEFAULT_PREFS, ...defaultPrefs })
  );
  const view: ChartView = mode;
  const [copied, setCopied] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const viewport = useChartViewport({ pageScroll: embedded });

  const map = useMemo(() => milestoneMap(groups), [groups]);
  const chart = useMemo(
    () => dependencyChart(groups, { bucketOf }),
    [groups, bucketOf]
  );
  const statusOf = useMemo(() => {
    const out = new Map<string, ContainerStatus>();
    for (const [id, children] of map.childrenOf) {
      out.set(id, containerStatus(children, { bucketOf, asksByTask }));
    }
    return out;
  }, [map, bucketOf, asksByTask]);
  const mixOf = useMemo(() => {
    const out = new Map<string, ReturnType<typeof milestoneMix>>();
    for (const [id, children] of map.childrenOf) {
      out.set(id, milestoneMix(children, { bucketOf }));
    }
    return out;
  }, [map, bucketOf]);
  const titleOf = useMemo(
    () => new Map(map.nodes.map((n) => [n.id, n.title])),
    [map]
  );
  const edgeOf = useMemo(
    () => new Map(map.edges.map((e) => [pairKey(e.from, e.to), e])),
    [map]
  );

  const drawn = useMemo(
    () =>
      view === 'tasks'
        ? drawnTasks(chart, {
            hideLanded: prefs.hideLanded,
            showUnlinked: prefs.showUnlinked,
          })
        : [],
    [chart, view, prefs.hideLanded, prefs.showUnlinked]
  );
  const drawnSet = useMemo(() => new Set(drawn), [drawn]);
  // Everything the Tasks chart can draw with every toggle open: what search lists and what a
  // pick can trace. A landed task with no links is in neither.
  const findable = useMemo(
    () => drawnTasks(chart, { hideLanded: false, showUnlinked: true }),
    [chart]
  );
  const findableSet = useMemo(() => new Set(findable), [findable]);
  const unlinkedOpen = useMemo(() => new Set(chart.unlinkedOpen), [chart]);

  /** A milestone's tasks for its inspector: open work most urgent first, then landed. */
  const milestoneTaskIds = useCallback(
    (id: string): string[] => {
      const open = (mixOf.get(id)?.open ?? []).map((doc) => doc.meta.id);
      const openSet = new Set(open);
      const rest = (map.childrenOf.get(id) ?? [])
        .map((doc) => doc.meta.id)
        .filter((tid) => !openSet.has(tid) && chart.tasks.has(tid));
      return [...open, ...rest];
    },
    [mixOf, map, chart]
  );

  /** A preset or "tasks of" selection resolved against the current data, or null when it
   * no longer names anything (a milestone that was archived, say). */
  const resolveSet = useCallback(
    (sel: Selection | null): HighlightSet | null => {
      if (sel?.kind === 'preset') {
        const preset = PRESETS.find((p) => p.id === sel.id);
        if (preset === undefined) return null;
        return {
          label: preset.label,
          blurb: preset.blurb,
          ids: preset.ids(chart).filter((id) => findableSet.has(id)),
        };
      }
      if (sel?.kind === 'tasks-of') {
        const title = titleOf.get(sel.milestone);
        if (title === undefined) return null;
        return {
          label: title,
          blurb: `Every task in ${title} that the chart can draw.`,
          ids: milestoneTaskIds(sel.milestone).filter((id) =>
            findableSet.has(id)
          ),
        };
      }
      return null;
    },
    [chart, findableSet, titleOf, milestoneTaskIds]
  );

  // The selection as it stands against the current data and view: a task that was dropped
  // or is hidden by a toggle, a milestone that was archived or a link that no longer
  // exists reads as no selection, so the chart never fades around something it cannot show.
  const active: Selection | null = (() => {
    if (selection === null) return null;
    switch (selection.kind) {
      case 'task':
        return view === 'tasks' && drawnSet.has(selection.id)
          ? selection
          : null;
      case 'milestone':
        return view === 'milestones' && titleOf.has(selection.id)
          ? selection
          : null;
      case 'link':
        return view === 'milestones' &&
          edgeOf.has(pairKey(selection.from, selection.to))
          ? selection
          : null;
      default:
        return resolveSet(selection) === null ? null : selection;
    }
  })();
  const activeSet = useMemo(() => resolveSet(active), [resolveSet, active]);
  // Drop a selection once it stops naming anything, so it cannot come back later.
  useEffect(() => {
    if (selection !== null && active === null) {
      setSelection(null);
    }
  }, [selection, active]);

  // The spec is rebuilt from JSON so its identity changes only when its content does: a
  // data update that moves nothing on the chart neither re-runs the layout nor re-renders
  // the chart twice.
  // Past the draw cap the Tasks chart is not laid out at all: the host's narrower charts
  // stand in for it.
  const tooLarge =
    view === 'tasks' &&
    renderTooLarge !== undefined &&
    drawn.length > TASK_DRAW_CAP;
  const specJson = useMemo((): string => {
    if (view === 'milestones') {
      if (map.nodes.length === 0) return '';
      const spec: ChartSpec = {
        nodes: map.nodes.map((n) => ({
          id: n.id,
          width: MILESTONE_NODE.width,
          height: MILESTONE_NODE.height,
        })),
        edges: map.edges.map((e) => ({
          id: pairKey(e.from, e.to),
          from: e.from,
          to: e.to,
        })),
      };
      return JSON.stringify(spec);
    }
    if (view === 'tasks') {
      if (drawn.length === 0 || tooLarge) return '';
      const height = TASK_NODE.height + (prefs.grouped ? 0 : TASK_NODE.kicker);
      const tasks = stableOrder(chart, drawn);
      const boxes = new Map<string, string>();
      if (prefs.grouped) {
        for (const t of tasks) {
          if (!boxes.has(groupIdOf(t))) {
            boxes.set(groupIdOf(t), t.milestoneTitle);
          }
        }
      }
      const spec: ChartSpec = {
        nodes: tasks.map((t) => ({
          id: t.id,
          width: TASK_NODE.width,
          height,
          group: prefs.grouped ? groupIdOf(t) : null,
        })),
        edges: chart.edges
          .filter(([a, b]) => drawnSet.has(a) && drawnSet.has(b))
          .map(([a, b]) => ({ id: pairKey(a, b), from: a, to: b })),
        groups: [...boxes].map(([id, label]) => ({ id, label })),
      };
      return JSON.stringify(spec);
    }
    return '';
  }, [view, map, chart, drawn, drawnSet, prefs.grouped, tooLarge]);
  const spec = useMemo(
    (): ChartSpec | null =>
      specJson === '' ? null : (JSON.parse(specJson) as ChartSpec),
    [specJson]
  );

  // The laid-out chart, tagged with the spec and view it answers so a stale layout of the
  // other view is never drawn; a stale layout of this view stays up while the next computes.
  const [placed, setPlaced] = useState<{
    spec: ChartSpec;
    view: ChartView;
    layout: ChartLayout;
  } | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  useEffect(() => {
    if (spec === null) return;
    let live = true;
    setLayoutError(null);
    layoutChart(spec).then(
      (result) => {
        if (live) setPlaced({ spec, view, layout: result });
      },
      (error: unknown) => {
        if (!live) return;
        setLayoutError(
          `The chart could not be laid out: ${error instanceof Error ? error.message : 'unknown error'}`
        );
      }
    );
    return () => {
      live = false;
    };
  }, [spec, view]);
  const shown =
    placed !== null && placed.view === view && spec !== null
      ? placed.layout
      : null;
  const current =
    placed !== null && placed.spec === spec ? placed.layout : null;

  // What a node "anchors" on for keeping the view steady: the selected task or milestone.
  const anchorId =
    active?.kind === 'task' || active?.kind === 'milestone' ? active.id : null;
  // What the chart frames when the stage changes size while something is selected.
  const framedIds = useMemo((): string[] => {
    if (active === null) return [];
    if (active.kind === 'task' || active.kind === 'milestone') {
      return [active.id];
    }
    if (active.kind === 'link') return [active.from, active.to];
    const set = activeSet?.ids ?? [];
    return view === 'tasks'
      ? [...set]
      : set
          .map((id) => chart.tasks.get(id)?.milestoneId)
          .filter((m): m is string => m !== null && m !== undefined);
  }, [active, activeSet, view, chart]);

  // A pending "zoom to these" for the next layout (a pick that had to switch view or turn a
  // toggle on first); what the chart was last framed for (the view and the display toggles
  // that reshape it), so only those changes fit the whole chart again; and the layout last
  // placed, so a layout from new data can keep the selected node where it was on screen.
  const focusRef = useRef<{
    ids: ReadonlySet<string>;
    maxScale: number;
  } | null>(null);
  const framingKey = `${view}|${prefs.hideLanded}|${prefs.showUnlinked}|${prefs.grouped}`;
  const framedRef = useRef<string | null>(null);
  const lastLayoutRef = useRef<ChartLayout | null>(null);
  // A layout effect, so a new layout never paints a frame at the previous view's framing.
  useLayoutEffect(() => {
    if (placed === null || placed.spec !== spec) return;
    const next = placed.layout;
    const previous = lastLayoutRef.current;
    if (previous === next) return;
    lastLayoutRef.current = next;
    const focus = focusRef.current;
    focusRef.current = null;
    const focusBox = focus === null ? null : boxOf(next, focus.ids);
    if (focusBox !== null && focus !== null) {
      framedRef.current = framingKey;
      viewport.fit(focusBox, { maxScale: focus.maxScale });
      return;
    }
    if (framedRef.current !== framingKey) {
      const first = framedRef.current === null;
      framedRef.current = framingKey;
      const head = chart.longestChain[0];
      const headBox =
        first &&
        view === 'tasks' &&
        head !== undefined &&
        viewport.size().width > 0 &&
        viewport.size().width < NARROW_STAGE_PX
          ? boxOf(next, [head])
          : null;
      if (headBox !== null) {
        viewport.fit(headBox, { maxScale: 0.6, animate: false });
      } else {
        viewport.fit(wholeBox(next), { animate: false });
      }
      return;
    }
    // The same chart with new data (a task landed, a link was added). Keep the selected
    // node where it was on screen; with nothing selected, refit unless the user has moved
    // the view, which is theirs to keep.
    const anchor = anchorId;
    const before = anchor === null ? undefined : previous?.nodes.get(anchor);
    const after = anchor === null ? undefined : next.nodes.get(anchor);
    if (before !== undefined && after !== undefined) {
      const { k } = viewport.transform();
      viewport.pan((before.x - after.x) * k, (before.y - after.y) * k);
    } else if (!viewport.moved()) {
      viewport.fit(wholeBox(next), { animate: false });
    }
  }, [placed, spec, viewport, framingKey, chart, view, anchorId]);

  const fitAll = useCallback(() => {
    if (current !== null) viewport.fit(wholeBox(current));
  }, [current, viewport]);

  // On a resize, an untouched chart refits; a selection that would end up partly off the
  // stage (opening a task narrows the graph column) is framed again at no more than the
  // current zoom; a view the user moved with nothing selected is left alone.
  const resizeRef = useRef(() => {});
  useEffect(() => {
    resizeRef.current = () => {
      if (current === null) return;
      if (framedIds.length > 0) {
        const box = boxOf(current, framedIds);
        if (box !== null && !onStage(viewport, box)) {
          viewport.fit(box, {
            maxScale: viewport.transform().k,
            animate: false,
          });
        }
      } else if (!viewport.moved()) {
        viewport.fit(wholeBox(current), { animate: false });
      }
    };
  });
  useEffect(() => {
    viewport.onResize(() => resizeRef.current());
    return () => viewport.onResize(null);
  }, [viewport]);

  /** Zooms to `ids` now, or once the new layout that a pending view or toggle change
   * starts has landed. */
  const focusOn = (
    ids: ReadonlySet<string>,
    maxScale: number,
    awaitsLayout: boolean
  ) => {
    const box = !awaitsLayout && current !== null ? boxOf(current, ids) : null;
    if (box !== null) viewport.fit(box, { maxScale });
    else focusRef.current = { ids, maxScale };
  };

  const updatePrefs = (patch: Partial<ChartPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    storePrefs(prefsKey, next);
  };

  const pick = (next: ChartView) => {
    setMode(next);
    storeMode(storageKey, next);
    // A highlighted set survives the switch (the overview shows its milestones); a task,
    // milestone or link selection belongs to the view it was made in.
    setSelection((sel) =>
      sel?.kind === 'preset' || sel?.kind === 'tasks-of' ? sel : null
    );
  };

  /** The toggle changes that put `ids` on the Tasks chart: show unlinked, stop hiding landed. */
  const revealPatch = (ids: readonly string[]): Partial<ChartPrefs> => {
    const patch: Partial<ChartPrefs> = {};
    for (const id of ids) {
      const task = chart.tasks.get(id);
      if (task === undefined || !findableSet.has(id)) continue;
      if (prefs.hideLanded && task.state === 'landed') patch.hideLanded = false;
      if (
        !prefs.showUnlinked &&
        chart.linked.size > 0 &&
        unlinkedOpen.has(id)
      ) {
        patch.showUnlinked = true;
      }
    }
    return patch;
  };

  // A pick made from the inspector replaces the row that held focus; focus follows to the
  // picked node on the chart so the keyboard keeps its place (and the chart's keys work).
  const asideRef = useRef<HTMLElement | null>(null);
  const [focusNode, setFocusNode] = useState<string | null>(null);
  const fromInspector = () =>
    asideRef.current?.contains(document.activeElement) === true;

  /** Selects a task on the Tasks chart from anywhere (search, the inspector, a set),
   * switching view and opening toggles as needed, and zooms to it. A task the chart can
   * never draw (landed, with no links) opens instead. */
  const goTo = (id: string) => {
    if (!findableSet.has(id)) {
      if (chart.tasks.has(id)) onOpenTask(id);
      return;
    }
    const patch = revealPatch([id]);
    const awaitsLayout = Object.keys(patch).length > 0 || mode !== 'tasks';
    if (fromInspector()) setFocusNode(id);
    if (Object.keys(patch).length > 0) updatePrefs(patch);
    if (mode !== 'tasks') pick('tasks');
    setSelection({ kind: 'task', id });
    focusOn(new Set([id]), 1, awaitsLayout);
  };

  // A link that named a task selects and frames it once on arrival (and again only when
  // a later link names another).
  const goToRef = useRef(goTo);
  goToRef.current = goTo;
  const arrivedRef = useRef<string | null>(null);
  useEffect(() => {
    if (arrivalTaskId === null || arrivedRef.current === arrivalTaskId) return;
    arrivedRef.current = arrivalTaskId;
    goToRef.current(arrivalTaskId);
  }, [arrivalTaskId]);

  const selectMilestone = (id: string) => {
    if (fromInspector()) setFocusNode(id);
    setSelection({ kind: 'milestone', id });
  };

  useEffect(() => {
    if (focusNode === null || shown === null) return;
    const node = document
      .querySelector(`[data-chart-node="${cssEscape(focusNode)}"]`)
      ?.querySelector<HTMLElement>('button');
    if (node === null || node === undefined) return;
    setFocusNode(null);
    node.focus({ preventScroll: true });
  }, [focusNode, shown]);

  const showSet = (
    sel: Extract<Selection, { kind: 'preset' | 'tasks-of' }>,
    inView: ChartView
  ) => {
    const ids = resolveSet(sel)?.ids ?? [];
    const patch = inView === 'tasks' ? revealPatch(ids) : {};
    const awaitsLayout = Object.keys(patch).length > 0 || mode !== inView;
    if (Object.keys(patch).length > 0) updatePrefs(patch);
    if (mode !== inView) pick(inView);
    setSelection(sel);
    const focus =
      inView === 'tasks'
        ? new Set(ids)
        : new Set(
            ids
              .map((id) => chart.tasks.get(id)?.milestoneId)
              .filter((m): m is string => m !== null && m !== undefined)
          );
    focusOn(focus, 0.9, awaitsLayout);
  };

  const clear = () => setSelection(null);

  const copy = () => {
    const text =
      mode === 'milestones'
        ? milestonesToMermaid(
            map.nodes.map((n) => ({
              id: n.id,
              title: n.title,
              done: statusOf.get(n.id)?.done ?? 0,
              total: statusOf.get(n.id)?.total ?? 0,
            })),
            map.edges
          )
        : tasksToMermaid(
            map.nodes.map((n) => ({
              id: n.id,
              title: n.title,
              tasks: (map.childrenOf.get(n.id) ?? []).map((doc) => ({
                id: doc.meta.id,
                title: doc.meta.title,
                blockedBy: doc.meta.blockedBy,
              })),
            }))
          );
    void writeClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    });
  };

  // Chart keys, live while the canvas or a node has focus (the app's own `/` palette and
  // Escape still work elsewhere): a handled key is defaultPrevented, which the global
  // handler respects.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (
      target.closest(
        'input, textarea, select, [contenteditable="true"], [role="dialog"]'
      )
    ) {
      return;
    }
    let handled = true;
    if (event.key === '/') setSearchOpen(true);
    else if (event.key === 'Escape' && active !== null) clear();
    else if (event.key === '0') fitAll();
    else if (event.key === '+' || event.key === '=') viewport.zoomBy(ZOOM_STEP);
    else if (event.key === '-') viewport.zoomBy(1 / ZOOM_STEP);
    else handled = false;
    if (handled) event.preventDefault();
  };

  const highlight = useMemo(
    () => highlightFor(active, activeSet, view, chart, map.edges),
    [active, activeSet, view, chart, map.edges]
  );

  const canvasEdges = useMemo((): CanvasEdge[] => {
    if (shown === null) return [];
    return shown.edges.map((edge) => {
      const traced = highlight.edge(edge.from, edge.to);
      if (view === 'tasks') {
        return {
          id: edge.id,
          points: edge.points,
          labelAt: edge.labelAt,
          tone: traced ?? 'idle',
          dashed: chart.tasks.get(edge.from)?.state === 'landed',
        };
      }
      const counted = edgeOf.get(pairKey(edge.from, edge.to));
      const count = counted?.count ?? 0;
      const from = titleOf.get(edge.from) ?? edge.from;
      const to = titleOf.get(edge.to) ?? edge.to;
      // Heavier for more waits, as the reference weights its milestone lines; a traced line
      // is heavier still, so it always reads as the strongest.
      const weight = 1.2 + Math.min(4, count * 0.55);
      return {
        id: edge.id,
        points: edge.points,
        labelAt: edge.labelAt,
        tone:
          traced ??
          (statusOf.get(edge.from)?.health === 'attention'
            ? 'attention'
            : 'idle'),
        width: traced === null || traced === 'dim' ? weight : weight + 1.2,
        label: String(count),
        hint: `${to} waits on ${from} ${count} ${count === 1 ? 'time' : 'times'}`,
        onSelect: () =>
          setSelection({ kind: 'link', from: edge.from, to: edge.to }),
      };
    });
  }, [shown, view, highlight, chart, edgeOf, titleOf, statusOf]);
  // From the data, not the lines' tones: a selection changes every line's colour, and the
  // legend entry must not come and go with it.
  const attentionEdges = map.edges.some(
    (e) => statusOf.get(e.from)?.health === 'attention'
  );

  const waits = map.edges.reduce((sum, e) => sum + e.count, 0);
  let landed = 0;
  let total = 0;
  for (const status of statusOf.values()) {
    landed += status.done;
    total += status.total;
  }

  // Stable handlers for the memoised node cards, so a selection re-renders only the two
  // cards whose `selected` flips; they read the latest props through a ref.
  const handlersRef = useRef({ onOpenTask });
  useEffect(() => {
    handlersRef.current = { onOpenTask };
  });
  const onSelectTask = useCallback(
    (id: string) => setSelection({ kind: 'task', id }),
    []
  );
  const onSelectMilestone = useCallback(
    (id: string) => setSelection({ kind: 'milestone', id }),
    []
  );
  const onOpenTaskNode = useCallback(
    (id: string) => handlersRef.current.onOpenTask(id),
    []
  );
  const onOpenMilestoneNode = useCallback(
    (id: string) => handlersRef.current.onOpenTask(id, 'plan'),
    []
  );
  const emptyStatus = useMemo(
    () => containerStatus([], { bucketOf, asksByTask }),
    [bucketOf, asksByTask]
  );
  const emptyMix = useMemo(() => milestoneMix([], { bucketOf }), [bucketOf]);

  const renderNode = (id: string) => {
    if (view === 'tasks') {
      const task = chart.tasks.get(id);
      if (task === undefined) return null;
      return (
        <TaskChartNode
          task={task}
          showMilestone={!prefs.grouped}
          selected={active?.kind === 'task' && active.id === id}
          onSelect={onSelectTask}
          onOpen={onOpenTaskNode}
        />
      );
    }
    const title = titleOf.get(id);
    if (title === undefined) return null;
    const mix = mixOf.get(id) ?? emptyMix;
    return (
      <MilestoneChartNode
        id={id}
        title={title}
        status={statusOf.get(id) ?? emptyStatus}
        mix={mix.mix}
        next={mix.next}
        openCount={mix.open.length}
        dueDate={dueDateOf?.(id) ?? null}
        selected={active?.kind === 'milestone' && active.id === id}
        onSelect={onSelectMilestone}
        onOpen={onOpenMilestoneNode}
      />
    );
  };

  const unlinkedHidden =
    view === 'tasks' && !prefs.showUnlinked && chart.linked.size > 0
      ? chart.unlinkedOpen.length
      : 0;

  const inspector = (() => {
    if (active?.kind === 'task') {
      return (
        <TaskInspector
          chart={chart}
          id={active.id}
          onPick={goTo}
          onFitChain={(ids) => focusOn(ids, 1, false)}
          onOpen={(id) => onOpenTask(id)}
          onClear={clear}
          extraActions={taskActions?.(active.id)}
        />
      );
    }
    if (active?.kind === 'milestone') {
      const id = active.id;
      const title = titleOf.get(id) ?? id;
      const named = (other: string) => ({
        id: other,
        title: titleOf.get(other) ?? other,
      });
      return (
        <MilestoneInspector
          chart={chart}
          id={id}
          title={title}
          status={statusOf.get(id) ?? emptyStatus}
          dueDate={dueDateOf?.(id) ?? null}
          waitsOn={map.edges
            .filter((e) => e.to === id)
            .map((e) => named(e.from))}
          unblocks={map.edges
            .filter((e) => e.from === id)
            .map((e) => named(e.to))}
          taskIds={milestoneTaskIds(id)}
          onPick={goTo}
          onPickMilestone={selectMilestone}
          onOpenPlan={(mid) => onOpenTask(mid, 'plan')}
          onShowTasks={(mid) =>
            showSet({ kind: 'tasks-of', milestone: mid }, 'tasks')
          }
          onClear={clear}
          extraActions={milestoneActions?.(id)}
        />
      );
    }
    if (active?.kind === 'link') {
      return (
        <LinkInspector
          chart={chart}
          from={{
            id: active.from,
            title: titleOf.get(active.from) ?? active.from,
          }}
          to={{
            id: active.to,
            title: titleOf.get(active.to) ?? active.to,
          }}
          onPick={goTo}
          onClear={clear}
        />
      );
    }
    if (activeSet !== null) {
      return (
        <SetInspector
          chart={chart}
          label={activeSet.label}
          blurb={activeSet.blurb}
          ids={activeSet.ids}
          onPick={goTo}
          onClear={clear}
        />
      );
    }
    return (
      <InspectorOverview
        chart={chart}
        view={view}
        unlinkedHidden={unlinkedHidden}
        onPick={goTo}
        onShowUnlinked={() => updatePrefs({ showUnlinked: true })}
      />
    );
  })();

  // One line for screen readers when the selection changes; data updates stay quiet.
  const status = (() => {
    if (active?.kind === 'task') {
      const task = chart.tasks.get(active.id);
      const up = chart.blockersOf.get(active.id)?.length ?? 0;
      const down = chart.dependentsOf.get(active.id)?.length ?? 0;
      return task === undefined
        ? ''
        : `${task.id} ${task.title} selected: waits on ${up}, unblocks ${down}.`;
    }
    if (active?.kind === 'milestone') {
      return `${titleOf.get(active.id) ?? active.id} selected.`;
    }
    if (active?.kind === 'link') {
      return `${titleOf.get(active.to) ?? active.to} waits on ${titleOf.get(active.from) ?? active.from} selected.`;
    }
    if (activeSet !== null) {
      return `${activeSet.label} highlighted, ${activeSet.ids.length} ${activeSet.ids.length === 1 ? 'task' : 'tasks'}.`;
    }
    return '';
  })();

  const empty =
    view === 'milestones' && map.nodes.length === 0
      ? {
          heading: 'No milestones yet',
          description:
            'Group tasks under milestones to see how they wait on each other.',
        }
      : view === 'tasks' && chart.tasks.size === 0
        ? {
            heading: 'No tasks yet',
            description: 'Tasks show up here with the waits between them.',
          }
        : null;
  // Tasks exist but the display toggles leave nothing to draw.
  const nothingDrawn = view === 'tasks' && empty === null && drawn.length === 0;

  const searchOptions = useMemo((): PickerOption[] => {
    // A chart without the Milestones view finds tasks only.
    const out: PickerOption[] = views.includes('milestones')
      ? map.nodes.map((n) => ({
          value: `m:${n.id}`,
          label: n.title,
          group: 'Milestones',
        }))
      : [];
    for (const id of findable) {
      const task = chart.tasks.get(id);
      if (task === undefined) continue;
      out.push({
        value: `t:${id}`,
        label: task.title,
        hint: id,
        keywords: [task.milestoneTitle],
        group: 'Tasks',
        mark: {
          kind: 'node',
          node: <StatusIcon status={task.status} size={14} />,
        },
      });
    }
    return out;
  }, [map, findable, chart, views]);

  const onSearchPick = (value: string | null) => {
    if (value === null) return;
    const id = value.slice(2);
    if (value.startsWith('m:')) {
      if (mode !== 'milestones') pick('milestones');
      selectMilestone(id);
      focusOn(new Set([id]), 1, mode !== 'milestones');
    } else {
      goTo(id);
    }
  };

  const modes = GRAPH_MODES.filter((m) => views.includes(m.id));
  // A tasks-only chart counts tasks and waits; with the Milestones view, milestones too.
  const taskSummary = `${chart.tasks.size} ${chart.tasks.size === 1 ? 'task' : 'tasks'} · ${chart.edges.length} ${chart.edges.length === 1 ? 'wait' : 'waits'} · ${landed}/${total} landed`;
  const showInspector =
    prefs.inspector || (inspectorOnSelect && active !== null);
  const summary = !views.includes('milestones')
    ? taskSummary
    : `${map.nodes.length} ${map.nodes.length === 1 ? 'milestone' : 'milestones'} · ${
        waits === 0
          ? 'no waits between them'
          : `${waits} ${waits === 1 ? 'wait' : 'waits'} between them`
      } · ${landed}/${total} landed`;

  return (
    <div data-testid="milestone-map" className={cx(styles.root, className)}>
      <div data-testid="chart-toolbar" className={styles.toolbar}>
        {modes.length > 1 && (
          <SegmentedControl
            label="Graph of"
            size="sm"
            options={modes}
            value={mode}
            onChange={(next) => {
              const picked = modes.find((m) => m.id === next);
              if (picked !== undefined) pick(picked.id);
            }}
          />
        )}
        {empty === null && (
          <>
            <PickerPopover
              label="Find on the chart"
              appearance="quiet"
              action
              value={null}
              options={searchOptions}
              open={searchOpen}
              onOpenChange={setSearchOpen}
              shortcut="/"
              searchPlaceholder="Find a task or milestone"
              emptyLabel="Nothing on this chart matches."
              triggerLabel="Find on the chart"
              trigger={
                <span className={styles.find} data-testid="chart-search">
                  <SearchIcon aria-hidden size={14} strokeWidth={1.8} />
                  Find
                </span>
              }
              onChange={onSearchPick}
            />
            <span className={styles.presets}>
              {PRESETS.map((preset) => {
                const count = preset
                  .ids(chart)
                  .filter((id) => findableSet.has(id)).length;
                const pressed =
                  active?.kind === 'preset' && active.id === preset.id;
                return (
                  <ChipButton
                    key={preset.id}
                    data-testid={`chart-preset-${preset.id}`}
                    selected={pressed}
                    // A pressed preset stays clickable even once it empties, so it can be let go.
                    disabled={count === 0 && !pressed}
                    onClick={() => {
                      if (pressed) clear();
                      else showSet({ kind: 'preset', id: preset.id }, view);
                    }}
                  >
                    {preset.label} <span className={styles.count}>{count}</span>
                  </ChipButton>
                );
              })}
            </span>
          </>
        )}
        <span className={styles.spacer} />
        <span data-testid="milestone-map-summary" className={styles.summary}>
          {summary}
        </span>
        {view === 'tasks' && empty === null && (
          <Popover
            open={displayOpen}
            onOpenChange={setDisplayOpen}
            label="Chart display"
            align="end"
            width={240}
            trigger={
              <Button
                variant="quiet"
                size="sm"
                icon={
                  <SlidersHorizontal aria-hidden size={14} strokeWidth={1.8} />
                }
              >
                Display
              </Button>
            }
          >
            <div className={styles.display}>
              <Switch
                label="Hide landed tasks"
                checked={prefs.hideLanded}
                onChange={(checked) => updatePrefs({ hideLanded: checked })}
              />
              <Switch
                label="Show unlinked tasks"
                checked={prefs.showUnlinked}
                onChange={(checked) => updatePrefs({ showUnlinked: checked })}
              />
              <Switch
                label="Box by milestone"
                checked={prefs.grouped}
                onChange={(checked) => updatePrefs({ grouped: checked })}
              />
            </div>
          </Popover>
        )}
        {empty === null && (
          <Button
            variant="quiet"
            size="sm"
            icon={<PanelRight aria-hidden size={14} strokeWidth={1.8} />}
            aria-label="Inspector"
            aria-pressed={prefs.inspector}
            onClick={() => updatePrefs({ inspector: !prefs.inspector })}
          />
        )}
        <Button variant="secondary" size="sm" onClick={copy}>
          {copied ? 'Copied' : 'Copy as Mermaid'}
        </Button>
      </div>
      {empty !== null ? (
        <div className={styles.empty}>
          <EmptyState label={empty.heading}>{empty.description}</EmptyState>
        </div>
      ) : (
        <div className={styles.body}>
          {tooLarge && renderTooLarge !== undefined ? (
            <div className={styles.tooLarge}>
              {renderTooLarge(drawn.length)}
            </div>
          ) : nothingDrawn ? (
            <div className={styles.empty}>
              <EmptyState
                label={
                  chart.linked.size > 0
                    ? 'Every linked task has landed'
                    : 'Every task has landed'
                }
                action={
                  <span className={styles.emptyActions}>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => updatePrefs({ hideLanded: false })}
                    >
                      Show landed tasks
                    </Button>
                    {!prefs.showUnlinked && chart.unlinkedOpen.length > 0 && (
                      <Button
                        size="sm"
                        variant="quiet"
                        onClick={() => updatePrefs({ showUnlinked: true })}
                      >
                        Show unlinked tasks
                      </Button>
                    )}
                  </span>
                }
              >
                Landed tasks are hidden, so there is nothing left to draw.
              </EmptyState>
            </div>
          ) : (
            <ChartCanvas
              viewport={viewport}
              layout={shown}
              message={
                layoutError ??
                (spec !== null && shown === null
                  ? 'Laying out the chart…'
                  : null)
              }
              edges={canvasEdges}
              renderNode={(box) => renderNode(box.id)}
              nodeTrace={highlight.node}
              onBackgroundClick={clear}
              onKeyDown={onKeyDown}
              onFit={fitAll}
              legend={
                view === 'tasks' ? (
                  <TasksLegend chart={chart} drawn={drawn} />
                ) : (
                  <MilestonesLegend attention={attentionEdges} />
                )
              }
              ariaLabel={
                view === 'tasks' ? 'Task dependencies' : 'Milestone map'
              }
              zoomHint={embedded ? 'pinch to zoom' : undefined}
            />
          )}
          <div role="status" className={styles.srOnly}>
            {status}
          </div>
          {showInspector && (
            <aside
              ref={asideRef}
              data-testid="chart-inspector"
              aria-label="Inspector"
              className={styles.inspector}
            >
              {inspector}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
