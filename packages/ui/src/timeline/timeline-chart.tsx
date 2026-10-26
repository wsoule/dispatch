'use client';

import { CalendarRange, Crosshair } from 'lucide-react';
import {
  type CSSProperties,
  type FocusEvent,
  memo,
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import StatusMark from '../components/status-mark';
import { Link } from '../lib/link';
import { Button } from '../tasks/button';
import { cx } from '../tasks/class-names';
import { EmptyState } from '../tasks/notice';
import { SegmentedControl } from '../tasks/segmented-control';
import { Switch } from '../tasks/switch';
import { formatDay, formatDayLong, type TimeScale } from './dates';
import {
  computeConnectors,
  computeLayout,
  type Connector,
  HEADER_HEIGHT,
  LANE_WIDTH,
  type LaneRow,
  type SummaryRow,
  type TimelineLayout,
} from './layout';
import { TimelineBarView } from './timeline-bar';
import { TimelineCards } from './timeline-cards';
import styles from './timeline-chart.module.css';
import { TimelineGridLayer, TimelineScaleHeader } from './timeline-scale';
import { laneSublabelTone, undatedTone } from './tones';
import type {
  TimelineChartProps,
  TimelineGroup,
  TimelineLegendItem,
  TimelineZoom,
} from './types';

// Gr8r Studio's Gantt (architecture §8.4 Timeline): a flat toolbar, a
// legend of status marks, then one panel. One scroll container owns both
// axes so the two-row header and
// the lane column stay sticky without scroll syncing; geometry comes from
// the pure layout module, memoised per data/zoom change; a drag re-renders
// only the dragged bar. Below 900px the chart gives way to per-project
// cards (CSS only, so server and client render the same markup).

const DEFAULT_LEGEND: TimelineLegendItem[] = [
  { status: 'overdue', label: 'Overdue' },
  { status: 'at_risk', label: 'At risk' },
  { status: 'on_track', label: 'On track' },
  { status: 'done', label: 'Complete' },
  { status: 'missing', label: 'Missing input' },
];

/* The lane column width for the CSS (sticky offsets, grid and connector
   layers), from the same constant the layout maths uses. */
const ROOT_STYLE = {
  '--timeline-lane-width': `${LANE_WIDTH}px`,
} as CSSProperties;

const ZOOM_OPTIONS = [
  { id: 'weeks', label: 'Weeks' },
  { id: 'months', label: 'Months' },
];

/** A dropped date waiting on (or confirmed by) the host's onRedate.
 * `base` is the prop due date it replaced: once the host's props move off
 * it, the host's data wins and the override is dropped. */
interface Override {
  end: string;
  base: string;
  saving: boolean;
}

interface LiveMessage {
  tone: 'status' | 'error';
  /** Lead-in word before the sentence: Saving, Saved, Not saved. */
  key: string;
  text: string;
}

function toZoom(id: string): TimelineZoom {
  return id === 'months' ? 'months' : 'weeks';
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Drops overrides whose prop date has moved off the one they replaced
 * (saving ones stay until their promise settles); same map when none. */
function pruneOverrides(
  overrides: ReadonlyMap<string, Override>,
  ends: ReadonlyMap<string, string>
): ReadonlyMap<string, Override> {
  let next: Map<string, Override> | null = null;
  for (const [id, o] of overrides) {
    if (o.saving || ends.get(id) === o.base) continue;
    next ??= new Map(overrides);
    next.delete(id);
  }
  return next ?? overrides;
}

/* Scrolls the chart so x lands a third of the way into the visible track,
   where Gr8r parks today: enough past to read what just slipped. */
function scrollTrackTo(
  el: HTMLElement,
  x: number,
  behavior: ScrollBehavior
): void {
  const visible = Math.max(0, el.clientWidth - LANE_WIDTH);
  const left = Math.max(0, x - visible / 3);
  if (typeof el.scrollTo === 'function') el.scrollTo({ left, behavior });
  else el.scrollLeft = left;
}

/* Centres a lane vertically in the visible body (under the sticky header),
   so the focused project sits among its neighbours rather than flush. */
function scrollLaneIntoView(el: HTMLElement, lane: LaneRow): void {
  const visible = Math.max(0, el.clientHeight - HEADER_HEIGHT);
  el.scrollTop = Math.max(0, lane.top + lane.height / 2 - visible / 2);
}

/* Keeps a keyboard-focused bar, handle or chip clear of the sticky lane
   column and header (WCAG 2.4.11). The browser only scrolls a focused
   element that is outside the scroll box, and one under the sticky column
   is inside it, so it would stay hidden. Pointer focus (not
   :focus-visible) is left alone, so a click never moves the chart, and
   the sticky cells themselves (lane names, group links) only need the
   vertical check. */
function revealFocused(el: HTMLElement, target: HTMLElement): void {
  if (target === el) return;
  let keyboard = true;
  try {
    keyboard = target.matches(':focus-visible');
  } catch {
    // An engine without :focus-visible: treat focus as keyboard focus.
  }
  if (!keyboard) return;
  const port = el.getBoundingClientRect();
  const box = target.getBoundingClientRect();
  const top = port.top + HEADER_HEIGHT + 8;
  const bottom = port.top + el.clientHeight - 8;
  if (box.top < top) el.scrollTop -= top - box.top;
  else if (box.bottom > bottom) el.scrollTop += box.bottom - bottom;
  if (target.closest('[data-timeline-sticky]') !== null) return;
  const left = port.left + LANE_WIDTH + 12;
  const right = port.left + el.clientWidth - 12;
  if (box.left < left) el.scrollLeft -= left - box.left;
  else if (box.right > right) {
    el.scrollLeft += Math.min(box.right - right, box.left - left);
  }
}

/* Brings the chart itself into the page's view (block: nearest, so a chart
   already on screen does not move), for a lane focused from outside
   (?project=). The chart's own scroll position is set separately. A
   hidden chart (the phone cards are showing) does not move the page. */
function revealInPage(el: HTMLElement): void {
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

/* ---- rows ------------------------------------------------------------- */

const SummaryRowView = memo(function SummaryRowView({
  row,
  onOpen,
}: {
  row: SummaryRow;
  onOpen: (barId: string) => void;
}): ReactElement {
  return (
    // Every milestone is reachable from its lane; this row is a pointer
    // shortcut and an at-a-glance summary, so it is hidden from AT.
    <div
      className={cx(styles.row, styles.summaryRow)}
      style={{ height: row.height }}
      aria-hidden="true"
    >
      <div className={cx(styles.laneCell, styles.summaryCell)}>
        <span className={styles.summaryGlyph} />
        <span className={styles.summaryLabel}>Milestones</span>
        <span className={styles.summaryCount}>{row.count}</span>
      </div>
      <div className={styles.track}>
        {row.points.map((point) => {
          const first = point.bars[0];
          if (first === undefined) return null;
          const more = point.bars.length - 1;
          const tip = `${point.bars.map((b) => b.label).join(' · ')} · ${formatDay(point.end)}`;
          return (
            // Hidden from AT on its own too (its row already is): a
            // pointer shortcut to a bar the lane below offers by keyboard.
            <span
              key={point.end}
              className={cx(
                styles.point,
                point.muted ? styles.pointMuted : undefined
              )}
              style={{ left: point.x }}
              title={tip}
              aria-hidden="true"
              onClick={() => onOpen(first.id)}
            >
              <span
                className={cx(
                  styles.pointMark,
                  point.muted ? styles.m_muted : styles[`m_${point.status}`]
                )}
              />
              {point.labelRoom === null ? null : (
                <span
                  className={styles.pointLabel}
                  style={{ maxWidth: point.labelRoom }}
                >
                  {first.label}
                  {more > 0 ? ` +${more}` : ''}
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
});

const GroupRowView = memo(function GroupRowView({
  group,
  height,
}: {
  group: TimelineGroup;
  height: number;
}): ReactElement {
  const count = group.lanes.length;
  return (
    <div className={cx(styles.row, styles.groupRow)} style={{ height }}>
      <div
        className={cx(styles.laneCell, styles.groupCell)}
        data-timeline-sticky=""
      >
        {/* The title shows the whole name when the count and the link
            have ellipsized it. */}
        <h3 className={styles.groupLabel} title={group.label}>
          {group.label}
        </h3>
        <span className={styles.groupCount}>
          {count} {count === 1 ? 'project' : 'projects'}
        </span>
        {/* The quiet link sits at the cell's right edge, after the count
            that stays beside the name. */}
        {group.link !== undefined ? (
          <Link
            href={group.link.href}
            className={styles.groupLink}
            aria-label={group.link.ariaLabel}
          >
            {group.link.label}
          </Link>
        ) : null}
      </div>
      <div className={styles.track} />
    </div>
  );
});

interface LaneRowViewProps {
  row: LaneRow;
  scale: TimeScale;
  today: string;
  selectedBarId: string | undefined;
  focused: boolean;
  saving: ReadonlySet<string>;
  canEdit: boolean;
  onOpen: (barId: string) => void;
  onCommit: (barId: string, newEnd: string) => void;
}

const LaneRowView = memo(function LaneRowView({
  row,
  scale,
  today,
  selectedBarId,
  focused,
  saving,
  canEdit,
  onOpen,
  onCommit,
}: LaneRowViewProps): ReactElement {
  const { lane } = row;
  const subTone = laneSublabelTone(lane);
  const chipTone = undatedTone(lane.muted !== true);
  const groupName =
    lane.sublabel === undefined
      ? lane.label
      : `${lane.label}, ${lane.sublabel}`;
  // Milestones outside the window, as "◂ 2 earlier · 1 later ▸"; the
  // arrows are drawing, so they are hidden from screen readers.
  const edges: ReactElement[] = [];
  if (row.earlier > 0) {
    edges.push(
      <span key="earlier">
        <span aria-hidden="true">◂ </span>
        {row.earlier} earlier
      </span>
    );
  }
  if (row.later > 0) {
    edges.push(
      <span key="later">
        {edges.length > 0 ? ' · ' : null}
        {row.later} later
        <span aria-hidden="true"> ▸</span>
      </span>
    );
  }

  return (
    <div
      role="group"
      aria-label={groupName}
      className={cx(
        styles.row,
        lane.muted === true ? styles.laneMuted : undefined,
        focused ? styles.laneFocus : undefined
      )}
      style={{ height: row.height }}
      data-lane-id={lane.id}
    >
      <div className={styles.laneCell} data-timeline-sticky="">
        <div className={styles.laneText}>
          {lane.href !== undefined ? (
            <Link href={lane.href} className={styles.laneName}>
              {lane.label}
            </Link>
          ) : (
            <span className={styles.laneName}>{lane.label}</span>
          )}
          {lane.sublabel !== undefined || edges.length > 0 ? (
            <span className={styles.laneSubLine}>
              {lane.sublabel !== undefined ? (
                <span
                  className={cx(
                    styles.laneSub,
                    subTone === undefined ? undefined : styles.laneSubToned
                  )}
                  data-tone={subTone}
                >
                  {lane.sublabel}
                </span>
              ) : null}
              {edges.length > 0 ? (
                <span className={styles.laneEdges}>{edges}</span>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
      <div className={styles.track}>
        {row.bars.map((geometry) => (
          <TimelineBarView
            key={geometry.bar.id}
            geometry={geometry}
            scale={scale}
            today={today}
            selected={geometry.bar.id === selectedBarId}
            saving={saving.has(geometry.bar.id)}
            editable={
              canEdit && geometry.bar.editable === true && !geometry.clippedEnd
            }
            onOpen={onOpen}
            onCommit={onCommit}
          />
        ))}
        {lane.undated.length > 0 ? (
          <div
            className={styles.undated}
            style={
              row.undatedAlign === 'left'
                ? { left: row.undatedX }
                : { right: 10 }
            }
          >
            {lane.undated.map((chip) => (
              <button
                key={chip.id}
                type="button"
                className={cx(
                  styles.chip,
                  chip.id === selectedBarId ? styles.chipSelected : undefined
                )}
                aria-label={`${chip.label}, ${chip.statusLabel}, no due date`}
                aria-current={chip.id === selectedBarId ? 'true' : undefined}
                onClick={() => onOpen(chip.id)}
              >
                {/* Drawing only: the chip's name says the status. */}
                <span className={styles.chipMark} aria-hidden="true">
                  <StatusMark
                    status={chip.status}
                    label={chip.statusLabel}
                    muted={lane.muted === true}
                  />
                </span>
                <span className={styles.chipLabel}>{chip.label}</span>
                <span
                  className={cx(
                    styles.chipNote,
                    chipTone === 'default' ? undefined : styles.chipNoteToned
                  )}
                  data-tone={chipTone}
                >
                  No date
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
});

const Connectors = memo(function Connectors({
  connectors,
  width,
  height,
  selectedBarId,
}: {
  connectors: Connector[];
  width: number;
  height: number;
  selectedBarId: string | undefined;
}): ReactElement {
  return (
    <svg
      className={styles.connectors}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      data-testid="timeline-connectors"
    >
      {connectors.map((c) => (
        <g
          key={c.key}
          className={cx(
            styles.edge,
            c.onRiskChain ? styles.edgeRisk : undefined,
            c.conflict ? styles.edgeConflict : undefined,
            selectedBarId !== undefined &&
              (c.from === selectedBarId || c.to === selectedBarId)
              ? styles.edgeSelected
              : undefined
          )}
          data-edge={c.key}
        >
          <path d={c.d} />
          <path d={c.head} className={styles.edgeHead} />
        </g>
      ))}
    </svg>
  );
});

/* ---- the chart -------------------------------------------------------- */

export function TimelineChart({
  today,
  windowStart,
  windowEnd,
  zoom,
  onZoomChange,
  groups,
  dependencies,
  showDependencies,
  defaultShowDependencies = true,
  onShowDependenciesChange,
  selectedBarId,
  focusLaneId,
  onOpenBar,
  onRedate,
  toolbarStart,
  toolbarEnd,
  legend = DEFAULT_LEGEND,
  label = 'Timeline',
  emptyLabel = 'Nothing on the timeline',
  maxHeight,
}: TimelineChartProps): ReactElement {
  const [innerShowDeps, setInnerShowDeps] = useState(defaultShowDependencies);
  const depsOn = showDependencies ?? innerShowDeps;
  const [overrides, setOverrides] = useState<ReadonlyMap<string, Override>>(
    () => new Map()
  );
  const [message, setMessage] = useState<LiveMessage | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Prop due dates and names by bar id: the base every override is
  // checked against, and the words for the live messages.
  const index = useMemo(() => {
    const ends = new Map<string, string>();
    const labels = new Map<string, string>();
    for (const group of groups) {
      for (const lane of group.lanes) {
        for (const bar of lane.bars) {
          ends.set(bar.id, bar.end);
          labels.set(bar.id, bar.label);
        }
      }
    }
    return { ends, labels };
  }, [groups]);

  // Overrides still on top of the props they were made against.
  const { effective, saving } = useMemo(() => {
    const live = new Map<string, string>();
    const busy = new Set<string>();
    for (const [id, o] of overrides) {
      if (index.ends.get(id) !== o.base) continue;
      live.set(id, o.end);
      if (o.saving) busy.add(id);
    }
    return { effective: live, saving: busy };
  }, [overrides, index]);

  // Once the host's data moves on, its dates win: stale overrides are
  // dropped while rendering the new props (React's "adjust state when a
  // prop changes" pattern), so one cannot resurface if a date later
  // returns to its old value.
  const [prunedFor, setPrunedFor] = useState(index);
  if (prunedFor !== index) {
    setPrunedFor(index);
    const next = pruneOverrides(overrides, index.ends);
    if (next !== overrides) setOverrides(next);
  }

  const layout: TimelineLayout = useMemo(
    () =>
      computeLayout({
        groups,
        windowStart,
        windowEnd,
        today,
        zoom,
        overrides: effective,
      }),
    [groups, windowStart, windowEnd, today, zoom, effective]
  );

  const deps = useMemo(() => dependencies ?? [], [dependencies]);
  const connectors = useMemo(
    () => (depsOn ? computeConnectors(layout, deps) : []),
    [layout, deps, depsOn]
  );

  // Latest props for the stable callbacks handed to memoised rows.
  const latest = useRef({
    onOpenBar,
    onRedate,
    index,
    today,
    layout,
    selectedBarId,
    focusLaneId,
  });
  useLayoutEffect(() => {
    latest.current = {
      onOpenBar,
      onRedate,
      index,
      today,
      layout,
      selectedBarId,
      focusLaneId,
    };
  });

  const open = useCallback((barId: string) => {
    latest.current.onOpenBar(barId);
  }, []);

  /* Saves a dropped/entered date: the bar moves at once (optimistic), the
     host's promise decides. A rejection restores what was there before
     (the prop date, or an earlier confirmed move) and says why. */
  const commit = useCallback((barId: string, newEnd: string) => {
    const { onRedate: redate, index: idx, today: day } = latest.current;
    const base = idx.ends.get(barId);
    if (redate === undefined || base === undefined) return;
    const name = idx.labels.get(barId) ?? barId;
    let previous: Override | undefined;
    setOverrides((prev) => {
      previous = prev.get(barId);
      return new Map(prev).set(barId, { end: newEnd, base, saving: true });
    });
    setMessage({
      tone: 'status',
      key: 'Saving',
      text: `Moving ${name} to ${formatDayLong(newEnd, day)}.`,
    });
    void Promise.resolve()
      .then(() => redate(barId, newEnd))
      .then(
        () => {
          setOverrides((prev) => {
            const o = prev.get(barId);
            if (o?.end !== newEnd) return prev;
            return new Map(prev).set(barId, { ...o, saving: false });
          });
          setMessage({
            tone: 'status',
            key: 'Saved',
            text: `${name} is now due ${formatDayLong(newEnd, day)}.`,
          });
        },
        (error: unknown) => {
          const restore =
            previous !== undefined && previous.base === base
              ? { ...previous, saving: false }
              : undefined;
          setOverrides((prev) => {
            if (prev.get(barId)?.end !== newEnd) return prev;
            const next = new Map(prev);
            if (restore === undefined) next.delete(barId);
            else next.set(barId, restore);
            return next;
          });
          const reason =
            error instanceof Error && error.message !== ''
              ? ` ${error.message.replace(/\.$/, '')}.`
              : '';
          setMessage({
            tone: 'error',
            key: 'Not saved',
            text: `Could not move ${name}.${reason} Due date restored to ${formatDayLong(restore?.end ?? base, day)}.`,
          });
        }
      );
  }, []);

  // Status lines clear themselves; errors stay until the next action.
  useEffect(() => {
    if (message?.tone !== 'status' || message.key === 'Saving')
      return undefined;
    const timer = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(timer);
  }, [message]);

  /* ---- scrolling ---- */

  // The date at the centre of the visible track, kept so a zoom change
  // re-scales around what the reader was looking at.
  const centerDay = useRef<number | null>(null);
  const dayWidth = layout.scale.dayWidth;
  const dayWidthRef = useRef(dayWidth);

  const onFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const el = scrollerRef.current;
    if (el !== null && event.target instanceof HTMLElement) {
      revealFocused(el, event.target);
    }
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    // Bars narrow their sticky label to the part of the bar that is not
    // under the lane column (timeline-bar.module.css, .content).
    el.style.setProperty('--timeline-scroll-x', `${el.scrollLeft}px`);
    const visible = Math.max(0, el.clientWidth - LANE_WIDTH);
    centerDay.current = (el.scrollLeft + visible / 2) / dayWidthRef.current;
  }, []);

  const scrollToToday = useCallback(() => {
    const el = scrollerRef.current;
    const x = latest.current.layout.todayX;
    if (el === null || x === null) return;
    scrollTrackTo(el, x, prefersReducedMotion() ? 'auto' : 'smooth');
  }, []);

  // First paint: the selected bar (and its lane), else today and the
  // focused lane. Later changes are handled by the effects below.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    const {
      layout: current,
      selectedBarId: barId,
      focusLaneId: laneId,
    } = latest.current;
    const bar = barId === undefined ? undefined : current.bars.get(barId);
    const x = bar?.endX ?? current.todayX;
    if (x !== null) scrollTrackTo(el, x, 'auto');
    const laneKey = bar?.laneId ?? laneId;
    const lane = laneKey === undefined ? undefined : current.lanes.get(laneKey);
    if (lane !== undefined) {
      scrollLaneIntoView(el, lane);
      if (bar === undefined) revealInPage(el);
    }
    onScroll();
  }, [onScroll]);

  // Zoom: keep the same date at the centre.
  useLayoutEffect(() => {
    if (dayWidthRef.current === dayWidth) return;
    dayWidthRef.current = dayWidth;
    const el = scrollerRef.current;
    if (el === null || centerDay.current === null) return;
    const visible = Math.max(0, el.clientWidth - LANE_WIDTH);
    el.scrollLeft = Math.max(0, centerDay.current * dayWidth - visible / 2);
    onScroll();
  }, [dayWidth, onScroll]);

  // A newly selected bar (palette, ?milestone=) is brought into view.
  const firstSelect = useRef(true);
  useEffect(() => {
    if (firstSelect.current) {
      firstSelect.current = false;
      return;
    }
    const el = scrollerRef.current;
    if (el === null || selectedBarId === undefined) return;
    const bar = latest.current.layout.bars.get(selectedBarId);
    if (bar === undefined) return;
    const visible = el.clientWidth - LANE_WIDTH;
    const inView =
      bar.left + bar.width > el.scrollLeft &&
      bar.left < el.scrollLeft + visible;
    if (!inView) {
      scrollTrackTo(el, bar.endX, prefersReducedMotion() ? 'auto' : 'smooth');
    }
  }, [selectedBarId]);

  const firstFocus = useRef(true);
  useEffect(() => {
    if (firstFocus.current) {
      firstFocus.current = false;
      return;
    }
    const el = scrollerRef.current;
    if (el === null || focusLaneId === undefined) return;
    const lane = latest.current.layout.lanes.get(focusLaneId);
    if (lane !== undefined) {
      scrollLaneIntoView(el, lane);
      revealInPage(el);
    }
  }, [focusLaneId]);

  /* ---- render ---- */

  const setDeps = useCallback(
    (next: boolean) => {
      if (showDependencies === undefined) setInnerShowDeps(next);
      onShowDependenciesChange?.(next);
    },
    [showDependencies, onShowDependenciesChange]
  );

  const laneCount = layout.lanes.size;
  const canEdit = onRedate !== undefined;
  const { scale } = layout;
  const riskEdges = deps.filter((d) => d.onRiskChain).length;

  const scrollerStyle =
    maxHeight === undefined
      ? undefined
      : ({ '--timeline-max-height': maxHeight } as CSSProperties);

  return (
    <div className={styles.root} style={ROOT_STYLE}>
      <div className={styles.toolbar}>
        {toolbarStart}
        <div className={styles.controls}>
          {onZoomChange !== undefined ? (
            <SegmentedControl
              size="sm"
              label="Zoom"
              options={ZOOM_OPTIONS}
              value={zoom}
              onChange={(id) => onZoomChange(toZoom(id))}
            />
          ) : null}
          <Button
            size="sm"
            variant="quiet"
            icon={<Crosshair size={14} strokeWidth={1.8} />}
            onClick={scrollToToday}
            disabled={layout.todayX === null || laneCount === 0}
          >
            Today
          </Button>
          {deps.length > 0 ? (
            <Switch
              checked={depsOn}
              onChange={setDeps}
              label="Dependencies"
              note={
                riskEdges > 0
                  ? `${deps.length} · ${riskEdges} on a risk chain`
                  : `${deps.length}`
              }
            />
          ) : null}
        </div>
        {toolbarEnd !== undefined ? (
          <div className={styles.toolbarEnd}>{toolbarEnd}</div>
        ) : null}
      </div>

      {/* The live line always exists (live regions must be in the DOM
          before they speak); with no legend and nothing to say it is
          visually hidden rather than an empty bordered row. */}
      <div
        className={
          legend === false && message === null ? 'srOnly' : styles.legendRow
        }
      >
        {legend === false ? null : (
          <ul className={styles.legend} aria-label="Legend">
            {legend.map((item) => (
              <li key={item.status} className={styles.legendItem}>
                {/* The mark is drawing: the label beside it says it. */}
                <span className={styles.legendMark} aria-hidden="true">
                  <StatusMark status={item.status} label={item.label} />
                </span>
                <span className={styles.legendLabel}>{item.label}</span>
              </li>
            ))}
            <li className={styles.legendItem}>
              <span className={styles.legendDiamond} aria-hidden="true" />
              <span className={styles.legendLabel}>Due date</span>
            </li>
          </ul>
        )}
        <p className={styles.live} role="status">
          {message?.tone === 'status' ? (
            <>
              <span className={styles.liveKey}>{message.key}</span>{' '}
              {message.text}
            </>
          ) : null}
        </p>
        <p className={cx(styles.live, styles.liveError)} role="alert">
          {message?.tone === 'error' ? (
            <>
              <span className={styles.liveKey}>{message.key}</span>{' '}
              {message.text}
            </>
          ) : null}
        </p>
      </div>

      {laneCount === 0 ? (
        // Gr8r's centred empty state (icon, sentence), as every list has.
        <EmptyState icon={<CalendarRange size={22} strokeWidth={1.8} />}>
          {emptyLabel}
        </EmptyState>
      ) : (
        <>
          <div
            ref={scrollerRef}
            className={styles.scroller}
            style={scrollerStyle}
            role="region"
            aria-label={`${label}, ${formatDayLong(scale.windowStart, today)} to ${formatDayLong(scale.windowEnd, today)}`}
            onScroll={onScroll}
            onFocus={onFocus}
          >
            <div
              className={styles.canvas}
              style={{ width: LANE_WIDTH + scale.width }}
            >
              <div
                className={styles.head}
                style={{ height: HEADER_HEIGHT }}
                aria-hidden="true"
              >
                <div className={styles.corner}>
                  <span className={styles.cornerLabel}>Project</span>
                </div>
                <TimelineScaleHeader
                  windowStart={windowStart}
                  windowEnd={windowEnd}
                  dayWidth={scale.dayWidth}
                  zoom={zoom}
                  today={today}
                  todayX={layout.todayX}
                />
              </div>
              <div className={styles.body} style={{ height: layout.height }}>
                <TimelineGridLayer
                  windowStart={windowStart}
                  windowEnd={windowEnd}
                  dayWidth={scale.dayWidth}
                  zoom={zoom}
                  today={today}
                  todayX={layout.todayX}
                  height={layout.height}
                />
                {layout.rows.map((row) => {
                  if (row.kind === 'summary') {
                    return (
                      <SummaryRowView key={row.key} row={row} onOpen={open} />
                    );
                  }
                  if (row.kind === 'group') {
                    return (
                      <GroupRowView
                        key={row.key}
                        group={row.group}
                        height={row.height}
                      />
                    );
                  }
                  return (
                    <LaneRowView
                      key={row.key}
                      row={row}
                      scale={scale}
                      today={today}
                      selectedBarId={selectedBarId}
                      focused={row.lane.id === focusLaneId}
                      saving={saving}
                      canEdit={canEdit}
                      onOpen={open}
                      onCommit={commit}
                    />
                  );
                })}
                {depsOn ? (
                  <Connectors
                    connectors={connectors}
                    width={scale.width}
                    height={layout.height}
                    selectedBarId={selectedBarId}
                  />
                ) : null}
              </div>
            </div>
          </div>
          <TimelineCards
            groups={groups}
            today={today}
            overrides={effective}
            selectedBarId={selectedBarId}
            focusLaneId={focusLaneId}
            onOpenBar={open}
          />
        </>
      )}
    </div>
  );
}
