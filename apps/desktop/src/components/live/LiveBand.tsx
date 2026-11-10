import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { StatusModel } from '@dispatch-foo/core/browser';
import type { MilestoneProgress } from '@dispatch/client';
import { Button, cx } from '@dispatch/ui';
import { Network, Shapes, Waypoints } from 'lucide-react';
import { memo, type ReactNode, useDeferredValue, useMemo } from 'react';

import { containerGraphHref } from '../../adapters/graphScope';
import type { TaskTab } from '../../lib/appNav';
import type { ListGroup } from '../../lib/listGrouping';
import { kindLabel } from '../../lib/taskDisplay';
import type { TaskBucket } from '../../lib/taskStatus';
import { FlightPlanMini } from '../flightplan/FlightPlanMini';
import { type ChartView, MilestoneMapView } from '../graph/MilestoneMap';
import { FanoutControls } from '../milestones/FanoutControls';
import { ContainerIcon } from '../tasks/page/ContainerIcon';
import styles from './LiveBand.module.css';
import type { LiveBandModel } from './liveBandModel';

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

/** The band's title row. */
const LIVE_BAND_HEAD = 44;
/** The band's chart: a fixed height, so the band list knows every band's height. */
const LIVE_BAND_CHART = 340;
/** Space under each band, before the next one's title. */
const LIVE_BAND_GAP = 12;
/** A band with nothing to draw says so in one line this tall. */
const EMPTY_BODY = 36;
/** A band's chart draws its tasks only, landed ones hidden; the inspector opens on a
 * selection. */
const LIVE_VIEWS: readonly ChartView[] = ['tasks'];
const LIVE_PREFS = { showUnlinked: true, hideLanded: true, inspector: false };

/** A band's full height — exact, so the band list sizes the gaps of the bands it has not
 * drawn (the row windows' `rowHeight`). */
export function liveBandHeight(band: LiveBandModel): number {
  const body =
    band.spec.scope.nodes.length === 0 ? EMPTY_BODY : LIVE_BAND_CHART;
  return LIVE_BAND_HEAD + body + LIVE_BAND_GAP;
}

/** What every band's chart reads, built once by the view. */
export interface LiveBandContext {
  /** A band's tasks under their milestones, as the Issues list groups them. */
  groupsOf: (tasks: TaskListItem[]) => ListGroup[];
  /** An open task's one bucket, for the chart's state words. */
  bucketOf: (task: TaskListItem) => TaskBucket | null;
  asksByTask: ReadonlyMap<string, number>;
  /** The project's path: keys each band's remembered chart choices. */
  projectKey: string;
  refFor: (id: string) => string;
  /** Send agent in a selected card's inspector, where the card may start now. */
  taskActions: (taskId: string) => ReactNode;
}

/** The band's verbs, held stable by the view so a cursor move never re-renders a band. */
export interface LiveBandActions {
  model: StatusModel;
  progressOf: (containerId: string) => MilestoneProgress | undefined;
  onSendAgents: (containerId: string) => void;
  /** Omitted under `orchestrator.unlimitedSpend`: there is no ceiling to raise. */
  onRaiseCeiling?: (containerId: string) => void;
  onPause: (containerId: string) => Promise<void>;
  onResume: (containerId: string) => Promise<void>;
  onStop: (containerId: string) => Promise<void>;
  onLand: (containerId: string) => Promise<void>;
  onOpenPlan: (containerId: string) => void;
  /** A card's open: the quick look, or a page for a tab. */
  onOpenTask: (taskId: string, tab?: TaskTab) => void;
}

interface LiveBandProps {
  band: LiveBandModel;
  ctx: LiveBandContext;
  actions: LiveBandActions;
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
  return (
    <FanoutControls
      milestone={container}
      model={actions.model}
      progress={progress}
      phases={false}
      waves={false}
      showOpen={false}
      onSendAgents={actions.onSendAgents}
      onPause={actions.onPause}
      onResume={actions.onResume}
      onRaiseCeiling={actions.onRaiseCeiling}
      onStop={actions.onStop}
      onLand={actions.onLand}
      onOpenMilestone={actions.onOpenPlan}
    />
  );
}

// The title row: what the band is, how it is moving, then the verbs. The left side clips
// from its end when the row runs short, so the title always shows.
function BandHead({
  band,
  actions,
  refLabel,
}: {
  band: LiveBandModel;
  actions: LiveBandActions;
  refLabel: string | null;
}) {
  const { spec, stats, plan } = band;
  const container = spec.container;
  return (
    <div
      data-slot="live-band-head"
      className={styles.head}
      style={{ height: LIVE_BAND_HEAD }}
    >
      <div className={styles.headMain}>
        {container === null ? (
          <Shapes {...ICON} className={cx(styles.glyph, styles.looseGlyph)} />
        ) : (
          <ContainerIcon
            kind={container.meta.kind}
            icon={container.meta.icon}
            color={container.meta.color}
            className={styles.glyph}
          />
        )}
        <span data-slot="live-band-title" className={styles.title}>
          {container?.meta.title ?? 'Loose work'}
        </span>
        {refLabel !== null && <span className={styles.ref}>{refLabel}</span>}
        <span className={styles.quiet}>
          {container === null
            ? 'Outside any container'
            : containerLabel(container)}
        </span>
        {band.showWaves && plan.waves.length > 0 && (
          <FlightPlanMini plan={plan} />
        )}
        {stats.queued > 0 && (
          <span className={styles.count}>{stats.queued} queued</span>
        )}
        <span className={styles.count}>
          {stats.done}/{stats.total} landed
        </span>
      </div>
      {container !== null && (
        <div className={styles.controls}>
          <BandControls container={container} actions={actions} />
          <Button
            variant="quiet"
            size="sm"
            data-slot="live-band-open-plan"
            aria-label={`Open the Flight Plan for ${container.meta.title}`}
            icon={<Waypoints {...ICON} />}
            onClick={() => actions.onOpenPlan(container.meta.id)}
          />
          <Button
            variant="quiet"
            size="sm"
            data-slot="live-band-open-graph"
            href={containerGraphHref(container)}
            aria-label={`Open ${container.meta.title} in Graph`}
            title="Open in Graph"
            icon={<Network {...ICON} />}
          />
        </div>
      )}
    </div>
  );
}

/**
 * One container's work in motion: a title row (what it is, the mini wave bar, counts, its
 * fan-out verbs and ways into the full Flight Plan and the Graph) over the compact
 * dependency chart of its scope (the Graph page's chart, embedded: a plain scroll scrolls the page, a pinch or
 * the zoom buttons zoom, a drag pans). Landed tasks start hidden; a click traces a card,
 * a double click quick-looks it, and the inspector sends an agent where one may start.
 */
export const LiveBand = memo(function LiveBand({
  band,
  ctx,
  actions,
}: LiveBandProps) {
  const { spec } = band;
  // A band coming into reach draws its title row at once and its chart at low priority,
  // so a fast scroll never spends a whole frame on one band.
  const drawn = useDeferredValue(true, false);
  const groups = useMemo(
    () => ctx.groupsOf(spec.scope.nodes),
    [ctx, spec.scope.nodes]
  );

  const container = spec.container;
  const refLabel = container === null ? null : ctx.refFor(spec.key);
  return (
    <section
      data-slot="live-band"
      data-live-band={spec.key}
      data-kind={spec.kind}
      aria-label={container?.meta.title ?? 'Loose work'}
      className={styles.band}
      style={{ height: liveBandHeight(band) }}
    >
      <BandHead band={band} actions={actions} refLabel={refLabel} />
      {spec.scope.nodes.length === 0 ? (
        <p className={styles.empty} style={{ height: EMPTY_BODY }}>
          Nothing under this container yet.
        </p>
      ) : (
        <div
          data-slot="live-band-canvas"
          className={styles.canvas}
          style={{ height: LIVE_BAND_CHART }}
        >
          {drawn && (
            <MilestoneMapView
              groups={groups}
              bucketOf={ctx.bucketOf}
              asksByTask={ctx.asksByTask}
              projectKey={`${ctx.projectKey}|live:${spec.key}`}
              views={LIVE_VIEWS}
              defaultPrefs={LIVE_PREFS}
              taskActions={ctx.taskActions}
              onOpenTask={actions.onOpenTask}
              embedded
              inspectorOnSelect
              variant="compact"
              className={styles.chart}
            />
          )}
        </div>
      )}
    </section>
  );
});
