import type { TaskListItem } from '@dispatch-foo/core/browser';
import { isContainerKind } from '@dispatch-foo/core/browser';
import type { GraphHighlight, GraphScope } from '@dispatch/planning';
import {
  BlockBar,
  Button,
  DependencyGraph,
  EmptyState,
  GraphLegend,
  type GraphNodeData,
  MermaidSource,
  NavTabs,
  SegmentedControl,
  type SegmentedOption,
  SLIDE_OVER_WIDTH,
  TaskCrumbs,
  type UiLinkProps,
  UiLinkProvider,
} from '@dispatch/ui';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  buildGraphPage,
  type GraphHrefs,
  type GraphPageModel,
  lockedNodeId,
} from '../adapters/graph';
import {
  applyDispatchOverlay,
  type DispatchOverlayContext,
} from '../adapters/graphOverlay';
import {
  DEFAULT_GRAPH_HIGHLIGHT,
  GRAPH_HIGHLIGHT_LABEL,
  GRAPH_HIGHLIGHTS,
  GRAPH_PATH,
  graphHref,
  parseGraphScope,
  parseHighlight,
} from '../adapters/graphScope';
import { GraphTooLarge } from '../components/graph/GraphTooLarge';
import { useShellActions } from '../components/shell/ShellActionsContext';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { isAnyModalOpen, isTypingTarget } from '../hooks/useGlobalKeyboard';
import { type Planning, usePlanningContext } from '../hooks/usePlanning';
import { hrefFor, resolveShellHref, taskHref } from '../lib/shellRoutes';
import type { TaskBucket } from '../lib/taskStatus';
import styles from './GraphView.module.css';

// The Graph destination (architecture §8.4 "Graph", §2.10): which boxes wait
// on which, from the tasks' blocking relations, at four levels (initiatives,
// projects, milestones, issues) inside the workspace, an initiative, a
// project, a milestone, or one issue's blocking chain, on @dispatch/ui's
// DependencyGraph. The planning App computed once over the open project
// (hooks/usePlanning, through PlanningContext) builds the graph of the scope
// on screen; adapters/graph maps it to the page model (boxes, arrows, frames,
// the layout, the trail, the level tabs, the legends, the readouts, the
// Mermaid text, the too-large state) and adapters/graphOverlay lays
// Dispatch's live facts over the issue boxes (Needs you, Failed, Agent
// working; readiness from the ready set). This view keeps the page's state:
// the scope (a link's in-memory `#/graph?…` descriptor, read back with
// parseGraphScope: the planner's query vocabulary until Phase 6's route), the
// highlight (remembered per window), the locked box and the Mermaid toggle.
// Every box is a task: a second press on the locked box, or Open on its
// strip, quick-looks it in the shell's task drawer, which is the graph's
// selection; a double-click (Shift + Enter) drills into the box's own graph
// one level down. The graph is read-only by nature.

const HIGHLIGHT_KEY = 'dispatch:graph-highlight';

/** Where the graph's links go: every box is a task, another graph is a scope
 * descriptor this view follows itself, and the Issues list and the Timeline
 * are the unfiltered destinations until Phase 6 adds query routes. */
const HREFS: GraphHrefs = {
  task: taskHref,
  graph: graphHref,
  issues: () => hrefFor('issues'),
  timeline: () => hrefFor('timeline'),
};

/** The highlight switch's options, in switch order. */
const HIGHLIGHT_OPTIONS: SegmentedOption[] = GRAPH_HIGHLIGHTS.map((id) => ({
  id,
  label: GRAPH_HIGHLIGHT_LABEL[id],
}));

/** The highlight remembered on this window, else the default. */
function readHighlight(): GraphHighlight {
  try {
    return (
      parseHighlight(window.localStorage.getItem(HIGHLIGHT_KEY)) ??
      DEFAULT_GRAPH_HIGHLIGHT
    );
  } catch {
    return DEFAULT_GRAPH_HIGHLIGHT;
  }
}

function writeHighlight(value: GraphHighlight): void {
  try {
    window.localStorage.setItem(HIGHLIGHT_KEY, value);
  } catch {
    // A blocked store just means the next window opens on the default.
  }
}

/** Where the graph opens: a project's milestones when a link named one
 * (`#/graph?project=`), else the workspace's milestones. */
function initialScope(focus: GraphViewProps['focus']): GraphScope {
  const projectId = focus?.projectId;
  return projectId === undefined
    ? { level: 'milestone' }
    : { level: 'milestone', projectId };
}

/** Handles a link's href in this view; true when it did, so the click is kept. */
type FollowHref = (href: string) => boolean;

const FollowContext = createContext<FollowHref>(() => false);

// The link every component inside the view renders (the trail's crumbs, the
// level tabs' hrefs, the lock strip's "Open graph", the too-large rows): a
// real anchor, so a middle or modified click still opens the hash as the
// browser would, while a plain left click on a graph link moves this view's
// scope and on a task link opens the task; the shell's own link component
// (DispatchShell) does not know the graph's scope parameters.
function GraphLink({ href, onClick, children, ...rest }: UiLinkProps) {
  const follow = useContext(FollowContext);
  return (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        if (follow(href)) event.preventDefault();
      }}
    >
      {children}
    </a>
  );
}

export interface GraphViewProps {
  /** The window's live facts the overlay reads beside the planning. */
  data: Pick<
    DispatchProjectData,
    'tasks' | 'readyIds' | 'liveRunStateByTaskId' | 'latestRunByTaskId'
  >;
  /** An open task's one bucket (App's `itemBucket` over the window's asks,
   * failures, runs and merge queue), the Issues list's chip in the box. */
  bucketOf: (task: TaskListItem) => TaskBucket | null;
  /** The task quick-looked in the drawer right now: the graph's selection. */
  selectedId: string | null;
  /** What the graph opens scoped to, when a link names it (`#/graph?project=`). */
  focus?: { projectId?: string };
}

/**
 * The Graph page under Tasks. Without a planning (outside App) it says so
 * instead of drawing an empty graph.
 */
export function GraphView(props: GraphViewProps) {
  const planning = usePlanningContext();
  if (planning === null) {
    return (
      <div className={styles.root} data-testid="graph-view">
        <EmptyState>The graph is not available here.</EmptyState>
      </div>
    );
  }
  return <GraphLoaded planning={planning} {...props} />;
}

/** Where the view is: the scope drawn, and a link's box to open on arrival. */
interface Place {
  scope: GraphScope;
  nodeId: string | null;
}

function GraphLoaded({
  planning,
  data,
  bucketOf,
  selectedId,
  focus,
}: GraphViewProps & { planning: Planning }) {
  const { peekTask, openTask } = useShellActions();
  const [place, setPlace] = useState<Place>(() => ({
    scope: initialScope(focus),
    nodeId: null,
  }));
  const [highlight, setHighlight] = useState<GraphHighlight>(readHighlight);
  const [lockedId, setLockedId] = useState<string | null>(null);
  const [showMermaid, setShowMermaid] = useState(false);

  // Every box is a task, except the synthetic groups the workspace synthesis
  // makes for what has no parent ("No initiative", a "No project" lane):
  // those open nothing. The overlay reads the issue boxes only; containers
  // keep their planning facts alone.
  const tasksById = useMemo(
    () => new Map(data.tasks.map((task) => [task.meta.id, task])),
    [data.tasks]
  );
  const { readyIds, liveRunStateByTaskId, latestRunByTaskId } = data;
  const overlayContext = useMemo<DispatchOverlayContext>(
    () => ({
      bucketOf: (id) => {
        const task = tasksById.get(id);
        return task === undefined ? null : bucketOf(task);
      },
      readyIds,
      liveRunStateByTaskId,
      latestRunByTaskId,
      isTaskNode: (id) => {
        const task = tasksById.get(id);
        return task !== undefined && !isContainerKind(task.meta.kind);
      },
    }),
    [tasksById, bucketOf, readyIds, liveRunStateByTaskId, latestRunByTaskId]
  );
  const overlay = useCallback(
    (nodes: GraphNodeData[]) => applyDispatchOverlay(nodes, overlayContext),
    [overlayContext]
  );

  // The graph of the scope comes from the planning's own cache, and the page
  // model (its framed dagre layout included, through cachedLayoutGraph) is
  // rebuilt only when the graph, the arrival box or the overlay's facts
  // change: opening the drawer or switching the highlight re-renders the
  // view with the same model, so dagre never runs on a render.
  const graph = planning.graph(place.scope);
  const page: GraphPageModel = useMemo(
    () =>
      buildGraphPage({
        graph,
        snapshot: planning.snapshot,
        assessments: planning.assessments,
        allocationPlan: planning.allocation,
        today: planning.ctx.today,
        hrefs: HREFS,
        nodeId: place.nodeId,
        overlay,
      }),
    [graph, planning, place.nodeId, overlay]
  );
  // A lock on a box that is not drawn (the scope moved, the task went) is
  // no lock.
  const lock = lockedNodeId(page.nodes, lockedId);

  /** Opens a box: the task's quick look in the shell's drawer. Idempotent,
   * never a toggle (a second Open on the open task leaves it open); the
   * drawer's own × and Escape close it. */
  const open = useCallback(
    (id: string) => {
      if (tasksById.has(id)) peekTask(id);
    },
    [tasksById, peekTask]
  );

  /** Follows a graph link: the scope it names, with its box opened on
   * arrival when the link selects one. The lock is dropped: the box drilled
   * into is the next graph's subject, not a box in it. */
  const go = useCallback(
    (href: string) => {
      const { scope, nodeId } = parseGraphScope(href);
      setPlace({ scope, nodeId });
      setLockedId(null);
      if (nodeId !== null) open(nodeId);
    },
    [open]
  );
  const followRef = useRef<FollowHref>(() => false);
  followRef.current = (href) => {
    if (href === GRAPH_PATH || href.startsWith(`${GRAPH_PATH}?`)) {
      go(href);
      return true;
    }
    const target = resolveShellHref(href);
    if (target?.kind === 'task') {
      openTask(target.taskId);
      return true;
    }
    return false;
  };
  const follow = useCallback<FollowHref>((href) => followRef.current(href), []);

  // Escape while a box is locked drops the lock and nothing else. The graph
  // hears Escape on the window after every nearer handler; the shell's own
  // window listener (useGlobalKeyboard) was added before it and would take
  // the key first, leaving this page for the Issues list with the lock
  // still on. Heard on the document, after the graph's own frame handler
  // (which marks the event handled), before the window: a locked box is
  // unlocked first, and the next Escape goes on to the shell. An open panel
  // goes before the lock, whichever mounted first, as the ui's
  // DependencyGraph documents: the task drawer the second press opened
  // (`selectedId`, the peeked task; the SlideOver is modal on a phone only,
  // so the DOM cannot tell) and any modal (a menu, the palette) take the
  // key, so Escape closes the drawer over the lit paths, the next Escape
  // unlocks, and the shell hears neither.
  const lockRef = useRef(lock);
  lockRef.current = lock;
  const drawerRef = useRef(selectedId !== null);
  drawerRef.current = selectedId !== null;
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (lockRef.current === null) return;
      if (event.isComposing || isTypingTarget(event.target)) return;
      if (drawerRef.current || isAnyModalOpen()) return;
      event.preventDefault();
      setLockedId(null);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const choose = useCallback((id: string) => {
    const mode = parseHighlight(id);
    if (mode === null) return;
    setHighlight(mode);
    writeHighlight(mode);
  }, []);

  const drawn = page.nodes.length > 0;
  // The level tabs: a plain click moves the scope in place (the href stays
  // for a new tab). DependencyGraph renders only its empty state without
  // nodes (no toolbar), so the tabs move to the section title row then:
  // they are the way to another level exactly when this one shows nothing.
  const tabs =
    page.tabs.length > 0 ? (
      <NavTabs
        label="Graph level"
        size="sm"
        items={page.tabs.map((tab) => {
          const { href } = tab;
          return href === undefined
            ? tab
            : { ...tab, onFollow: () => go(href) };
        })}
        className={drawn ? styles.toolbarTabs : undefined}
      />
    ) : null;
  const switcher = (
    <div className={styles.highlightSwitch}>
      <SegmentedControl
        label="Highlight"
        size="sm"
        options={HIGHLIGHT_OPTIONS}
        value={highlight}
        onChange={choose}
      />
    </div>
  );
  const mermaid =
    page.mermaid === null
      ? null
      : `${page.mermaid.body}${page.mermaid.styles[highlight]}`;

  return (
    <FollowContext.Provider value={follow}>
      <UiLinkProvider link={GraphLink}>
        <div className={styles.root} data-testid="graph-view">
          <header className={styles.head}>
            {page.trail.length > 0 ? (
              <div className={styles.trail}>
                <TaskCrumbs
                  label="Graph scope"
                  breadcrumb={page.trail}
                  taskKey=""
                />
              </div>
            ) : null}
            <h1 className={styles.title}>{page.heading}</h1>
            <p className={styles.receipts}>{page.receipts}</p>
            {page.notices.map((notice) => (
              <p
                key={notice.id}
                className={styles.notice}
                data-notice={notice.id}
              >
                {notice.text}
              </p>
            ))}
          </header>
          <section className={styles.body} aria-label={page.heading}>
            <div>
              <BlockBar title={page.blockTitle} meta={page.meta}>
                {drawn ? null : tabs}
              </BlockBar>
              {page.tooLarge !== null ? (
                <GraphTooLarge tooLarge={page.tooLarge} />
              ) : (
                <DependencyGraph
                  nodes={page.nodes}
                  edges={page.edges}
                  clusters={page.clusters}
                  layout={page.layout ?? undefined}
                  selectedId={selectedId}
                  lockedId={lock}
                  onLockChange={setLockedId}
                  onSelect={open}
                  onDrill={go}
                  focusId={page.focusId}
                  focusLabel="the issue this chain is about"
                  // The drawer covers the frame's right: keep room beside it,
                  // so the box opened is not hidden under its own panel.
                  coveredRight={
                    selectedId === null ? undefined : SLIDE_OVER_WIDTH
                  }
                  ariaSummary={page.ariaSummary}
                  emptyMessage={page.emptyMessage}
                  toolbar={
                    drawn ? (
                      <>
                        {tabs}
                        {switcher}
                      </>
                    ) : null
                  }
                  highlight={highlight}
                  readout={page.readouts[highlight]}
                  pathWords={page.pathWords}
                />
              )}
            </div>
            {drawn ? (
              // The key under the drawing, as under a figure. Every
              // highlight's legend in one grid cell, the others hidden (and
              // inert), so the cell is always as tall as the tallest and
              // switching never moves what follows it.
              <div className={styles.legends}>
                {GRAPH_HIGHLIGHTS.map((mode) => (
                  <div
                    key={mode}
                    className={styles.legendSlot}
                    data-shown={mode === highlight ? '' : undefined}
                    aria-hidden={mode === highlight ? undefined : true}
                    inert={mode !== highlight}
                  >
                    <GraphLegend
                      items={page.legends[mode]}
                      label={`Graph legend: ${GRAPH_HIGHLIGHT_LABEL[mode]}`}
                    />
                  </div>
                ))}
              </div>
            ) : null}
            {drawn && mermaid !== null ? (
              <div className={styles.mermaid}>
                <Button
                  variant="quiet"
                  size="sm"
                  aria-pressed={showMermaid}
                  onClick={() => setShowMermaid((shown) => !shown)}
                >
                  Mermaid
                </Button>
                {showMermaid ? <MermaidSource source={mermaid} /> : null}
              </div>
            ) : null}
          </section>
        </div>
      </UiLinkProvider>
    </FollowContext.Provider>
  );
}
