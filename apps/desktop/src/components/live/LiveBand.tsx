import type { EpicProgress } from '@dispatch/client';
import type { StatusModel, TaskListItem } from '@dispatch/core/browser';
import { isCompletedStatus, isDoneStatus } from '@dispatch/core/browser';
import { ChevronRight, Shapes, Waypoints } from 'lucide-react';
import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { rollupMilestoneStatus } from '../../lib/milestoneRollup';
import { kindLabel } from '../../lib/taskDisplay';
import { criticalPath } from '../flightplan/criticalPath';
import {
  type FlightBandView,
  FlightCanvas,
  type FlightWaveView,
  WAVE_HEADER_HEIGHT,
} from '../flightplan/FlightCanvas';
import {
  type CullWindow,
  cullWindow,
  sameWindow,
} from '../flightplan/flightCull';
import { flightNodeDomId } from '../flightplan/FlightNodeCard';
import { FlightPlanMini } from '../flightplan/FlightPlanMini';
import {
  flightEdgeViews,
  flightNodeViews,
  type NodeViewContext,
  queuePositions,
} from '../flightplan/flightViews';
import { FanoutControls } from '../milestones/FanoutControls';
import { ContainerIcon } from '../tasks/page/ContainerIcon';
import type { LiveBandModel } from './liveBandModel';
import { cn } from '@/lib/utils';
import { IconButton } from '@/ui/ai/icon-button';

/** The band's title row. */
const LIVE_BAND_HEAD = 44;
/** Space under each band, before the next one's title. */
const LIVE_BAND_GAP = 12;
/** A band with nothing to draw says so in one line this tall. */
const EMPTY_BODY = 36;

// The part of a band's canvas worth drawing: the canvas scrolled `left` across and `width`
// wide, `top` into the page's scroller. Its rows clamp to the canvas's `height`, so a
// page scroll that keeps the whole band in reach leaves the window as it was.
function bandCull(
  left: number,
  width: number,
  scroller: HTMLElement | null,
  top: number,
  height: number
): CullWindow | null {
  const window = cullWindow(
    {
      left,
      top: (scroller?.scrollTop ?? 0) - top - LIVE_BAND_HEAD,
      width,
      height: scroller?.clientHeight ?? height,
    },
    WAVE_HEADER_HEIGHT
  );
  if (window === null) return null;
  return {
    ...window,
    y0: Math.max(window.y0, 0),
    y1: Math.min(window.y1, height),
  };
}

/** A band's full height — exact, so the band list can window without measuring. */
export function liveBandHeight(band: LiveBandModel): number {
  const body =
    band.order.length === 0
      ? EMPTY_BODY
      : WAVE_HEADER_HEIGHT + band.layout.height;
  return LIVE_BAND_HEAD + body + LIVE_BAND_GAP;
}

/** What every band reads to draw its cards, built once by the view. */
export interface LiveBandContext {
  view: NodeViewContext;
  /** The median run length the critical path weighs nodes by. */
  paceMs: number;
  now: number;
  /** When a running node's agent started: its dispatch's send time, else its run's. */
  startedAt: (id: string) => number | undefined;
}

/** The band's verbs, held stable by the view so a cursor move never re-renders a band. */
export interface LiveBandActions {
  model: StatusModel;
  progressOf: (containerId: string) => EpicProgress | undefined;
  onSendAgents: (containerId: string) => void;
  onRaiseCeiling: (containerId: string) => void;
  onPause: (containerId: string) => Promise<void>;
  onResume: (containerId: string) => Promise<void>;
  onStop: (containerId: string) => Promise<void>;
  onLand: (containerId: string) => Promise<void>;
  onOpenPlan: (containerId: string) => void;
  onToggleFold: (bandKey: string) => void;
  onActivate: (taskId: string) => void;
}

interface LiveBandProps {
  band: LiveBandModel;
  ctx: LiveBandContext;
  actions: LiveBandActions;
  focusedId: string | null;
  expanded: boolean;
  /** The page's scroller, and this band's top inside it, for culling cards off screen. */
  scroller: HTMLElement | null;
  top: number;
}

// A container by what it is; a task with children is a parent issue.
function containerLabel(container: TaskListItem): string {
  return container.meta.kind === 'task'
    ? 'Parent issue'
    : kindLabel(container.meta.kind);
}

// The container's fan-out verbs, as the Flight Plan header carries them.
function BandControls({
  container,
  actions,
}: {
  container: TaskListItem;
  actions: LiveBandActions;
}) {
  const id = container.meta.id;
  const progress = actions.progressOf(id);
  const session = progress?.session ?? null;
  const kids = progress?.children ?? [];
  const landable =
    session?.state !== 'active' &&
    session?.state !== 'paused' &&
    kids.length > 0 &&
    kids.every((c) => isDoneStatus(c.status, actions.model)) &&
    !isCompletedStatus(container.meta.status, actions.model);
  return (
    <FanoutControls
      epic={container}
      model={actions.model}
      progress={progress}
      landable={landable}
      phases={false}
      waves={false}
      showOpen={false}
      onSendAgents={actions.onSendAgents}
      onPause={actions.onPause}
      onResume={actions.onResume}
      onRaiseCeiling={actions.onRaiseCeiling}
      onStop={actions.onStop}
      onLand={actions.onLand}
      onOpenEpic={actions.onOpenPlan}
    />
  );
}

// The title row: what the band is, its fold, how it is moving, then the verbs. The left
// side clips from its end when the row runs short, so the title and fold always show.
function BandHead({
  band,
  actions,
  expanded,
  refLabel,
}: {
  band: LiveBandModel;
  actions: LiveBandActions;
  expanded: boolean;
  refLabel: string | null;
}) {
  const { spec, stats, plan } = band;
  const container = spec.container;
  const finished = band.finishedWaves;
  return (
    <div
      data-slot="live-band-head"
      className="flex shrink-0 items-center gap-3 px-4"
      style={{ height: LIVE_BAND_HEAD }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        {container === null ? (
          <Shapes
            aria-hidden
            className="text-muted-foreground size-3.5 shrink-0"
          />
        ) : (
          <ContainerIcon
            kind={container.meta.kind}
            icon={container.meta.icon}
            color={container.meta.color}
            className="size-3.5 shrink-0"
          />
        )}
        <span
          data-slot="live-band-title"
          className="text-foreground min-w-[6rem] truncate text-[13px] font-medium"
        >
          {container?.meta.title ?? 'Loose work'}
        </span>
        {refLabel !== null && (
          <span className="font-book shrink-0 text-[12px] tracking-(--id-tracking) text-(--text-muted)">
            {refLabel}
          </span>
        )}
        <span className="shrink-0 text-[12px] text-(--text-muted)">
          {container === null
            ? 'Outside any container'
            : containerLabel(container)}
        </span>
        {finished.waves > 0 && (
          <button
            type="button"
            data-slot="live-band-fold"
            aria-expanded={expanded}
            onClick={() => actions.onToggleFold(spec.key)}
            className="rounded-control hover:bg-surface-control flex h-6 shrink-0 items-center gap-1 px-1.5 text-[12px] text-(--text-muted) transition-colors duration-100 hover:text-(--text-secondary)"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                'size-3 transition-transform duration-150',
                expanded && 'rotate-90'
              )}
            />
            {expanded
              ? 'Fold landed waves'
              : `${finished.waves} landed ${finished.waves === 1 ? 'wave' : 'waves'} · ${finished.tasks}`}
          </button>
        )}
        {band.showWaves && plan.waves.length > 0 && (
          <FlightPlanMini plan={plan} />
        )}
        {stats.queued > 0 && (
          <span className="font-book shrink-0 text-[12px] text-(--text-muted) tabular-nums">
            {stats.queued} queued
          </span>
        )}
        <span className="font-book shrink-0 text-[12px] text-(--text-muted) tabular-nums">
          {stats.done}/{stats.total} landed
        </span>
      </div>
      {container !== null && (
        <div className="flex shrink-0 items-center gap-1.5">
          <BandControls container={container} actions={actions} />
          <IconButton
            data-slot="live-band-open-plan"
            label={`Open the Flight Plan for ${container.meta.title}`}
            onClick={() => actions.onOpenPlan(container.meta.id)}
          >
            <Waypoints aria-hidden />
          </IconButton>
        </div>
      )}
    </div>
  );
}

/**
 * One container's work in motion: a title row (what it is, the mini wave bar, counts,
 * the fold, its fan-out verbs and a way into the full Flight Plan) over the Flight Plan
 * canvas for its scope, finished leading waves folded to a count. The canvas scrolls
 * sideways on its own and draws only the cards near the viewport — its own scroll across,
 * the page's down — re-culling only as either crosses a tile. Memoized: a cursor move
 * re-renders the band it leaves and the band it enters, nothing else; the cursor's card
 * scrolls into view as it lands.
 */
export const LiveBand = memo(function LiveBand({
  band,
  ctx,
  actions,
  focusedId,
  expanded,
  scroller,
  top,
}: LiveBandProps) {
  const { spec, plan, layout } = band;
  const model = actions.model;
  // A band coming into reach draws its title row at once and its cards at low priority,
  // so a fast scroll never spends a whole frame on one band. The cursor's band draws at
  // once, so a J/K lands on a drawn card.
  const deferred = useDeferredValue(true, false);
  const [focusedOnce, setFocusedOnce] = useState(focusedId !== null);
  if (focusedId !== null && !focusedOnce) setFocusedOnce(true);
  const drawn = deferred || focusedOnce;

  const path = useMemo(
    () =>
      criticalPath(
        plan.nodes.map((n) => {
          const id = n.task.meta.id;
          const startedAt =
            n.state === 'running' ? ctx.startedAt(id) : undefined;
          return {
            id,
            wave: n.wave,
            blockedBy: n.task.meta.blockedBy,
            state: n.state,
            ...(startedAt === undefined ? {} : { startedAt }),
          };
        }),
        ctx.paceMs,
        ctx.now
      ),
    [plan, ctx]
  );
  const queue = useMemo(
    () =>
      queuePositions(plan.nodes, (owner) => {
        const session = actions.progressOf(owner)?.session;
        return session?.state === 'active' ? session.concurrency : null;
      }),
    [plan, actions]
  );
  const nodes = useMemo(
    () => flightNodeViews(plan, layout, path, queue, ctx.view),
    [plan, layout, path, queue, ctx.view]
  );
  const edges = useMemo(
    () => flightEdgeViews(plan, layout, path),
    [plan, layout, path]
  );
  const waves = useMemo<FlightWaveView[]>(() => {
    if (!band.showWaves) return [];
    return layout.columns.map((column) => {
      const index = column.wave + band.waveOffset;
      const wave = plan.waves[index];
      return {
        wave: index,
        x: column.x,
        width: column.width,
        total: wave?.total ?? 0,
        done: wave?.done ?? 0,
        running: wave?.running ?? 0,
        current: plan.currentWave === index,
      };
    });
  }, [band.showWaves, band.waveOffset, layout, plan]);
  const subBands = useMemo<FlightBandView[] | null>(() => {
    const defs = spec.scope.bands;
    if (defs === null) return null;
    const boxes = new Map(layout.bands.map((b) => [b.key, b]));
    const work = new Map<string, TaskListItem[]>();
    for (const node of plan.nodes) {
      const key = spec.scope.bandOf.get(node.task.meta.id);
      if (key === undefined) continue;
      const bucket = work.get(key);
      if (bucket === undefined) work.set(key, [node.task]);
      else bucket.push(node.task);
    }
    const out: FlightBandView[] = [];
    for (const def of defs) {
      const box = boxes.get(def.key);
      if (box === undefined) continue;
      const tasks = work.get(def.key) ?? [];
      out.push({
        key: def.key,
        top: box.top,
        title:
          def.container?.meta.title ??
          `Directly in ${spec.container?.meta.title ?? 'this plan'}`,
        refLabel: def.container === null ? null : ctx.view.refFor(def.key),
        status: rollupMilestoneStatus(tasks, model),
        done: tasks.filter((t) => isDoneStatus(t.meta.status, model)).length,
        total: tasks.length,
        controls: null,
      });
    }
    return out;
  }, [spec, layout, plan, ctx.view, model]);

  // The drawn window follows both scrolls, re-culling only as it crosses a tile. Until
  // the canvas is laid out it is the scroller's width from the left edge, so a band that
  // draws on its first render never draws every card.
  const canvasRef = useRef<HTMLDivElement>(null);
  const [cull, setCull] = useState<CullWindow | null>(() =>
    scroller === null
      ? null
      : bandCull(0, scroller.clientWidth, scroller, top, layout.height)
  );
  useEffect(() => {
    const el = canvasRef.current;
    if (el === null) return;
    const update = () => {
      const next = bandCull(
        el.scrollLeft,
        el.clientWidth,
        scroller,
        top,
        layout.height
      );
      setCull((prev) => (sameWindow(prev, next) ? prev : next));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    scroller?.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      scroller?.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [scroller, top, layout.height]);

  // The cursor's card comes into view once drawn: across the band, and down the page.
  useEffect(() => {
    if (focusedId === null || !drawn) return;
    const frame = requestAnimationFrame(() =>
      document
        .getElementById(flightNodeDomId(focusedId))
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    );
    return () => cancelAnimationFrame(frame);
  }, [focusedId, drawn]);

  const container = spec.container;
  const refLabel = container === null ? null : ctx.view.refFor(spec.key);
  return (
    <section
      data-slot="live-band"
      data-live-band={spec.key}
      data-kind={spec.kind}
      aria-label={container?.meta.title ?? 'Loose work'}
      className="flex flex-col"
      style={{ height: liveBandHeight(band) }}
    >
      <BandHead
        band={band}
        actions={actions}
        expanded={expanded}
        refLabel={refLabel}
      />
      {band.order.length === 0 ? (
        <p
          className="px-5 text-[12px] leading-9 text-(--text-muted)"
          style={{ height: EMPTY_BODY }}
        >
          Nothing under this container yet.
        </p>
      ) : (
        <div
          ref={canvasRef}
          data-slot="live-band-canvas"
          className="relative shrink-0 [scrollbar-width:thin] overflow-x-auto overflow-y-hidden"
          style={{ height: WAVE_HEADER_HEIGHT + layout.height }}
        >
          {drawn && (
            <FlightCanvas
              layout={layout}
              nodes={nodes}
              edges={edges}
              waves={waves}
              bands={subBands}
              focusedId={focusedId}
              onActivate={actions.onActivate}
              cull={cull}
            />
          )}
        </div>
      )}
    </section>
  );
});
