import type { UiStatus } from '../types';
import { centerXForDate, createScale, minDay, type TimeScale } from './dates';
import type {
  TimelineBar,
  TimelineDependency,
  TimelineGroup,
  TimelineLane,
  TimelineZoom,
} from './types';

// Pure geometry for the timeline: where every row, bar, diamond and
// connector goes, from the props alone. Kept out of the components so it is
// computed once per data/zoom change (memoised by the chart) and so the
// maths is unit-testable without a DOM.

/** Pixels per day: Gr8r's two zooms. */
export const DAY_WIDTH: Readonly<Record<TimelineZoom, number>> = {
  weeks: 32,
  months: 11,
};
/** The sticky lane column. Mirrored in timeline-chart.module.css. */
export const LANE_WIDTH = 264;
/** Two header rows (months 26 + days 26, Gr8r's). Mirrored in the CSS. */
export const HEADER_HEIGHT = 52;
/** The "Milestones" row and the initiative rows: Gr8r's 36px bands. */
export const SUMMARY_HEIGHT = 36;
export const GROUP_HEIGHT = 36;
/** One line of bars in a lane (room for the name and the lead under it);
 * a lane grows by a line per overlap. */
export const ROW_HEIGHT = 48;
/** Gr8r's 24px bar. Mirrored in timeline-bar.module.css (.item). */
export const BAR_HEIGHT = 24;
export const MIN_BAR_WIDTH = 12;
/** Narrower bars carry their label outside, when there is room after. */
const LABEL_INSIDE_MIN = 56;
const LABEL_OUTSIDE_MIN_ROOM = 72;
/** Text room (bar width less its 21px padding and the ◂ cue) below which
 * an inside label would be an ellipsis alone. */
const LABEL_TEXT_MIN = 28;
/** Half the diagonal of the 10px end diamond (7.07px), rounded up: a
 * connector starts just past its tip. The 1.5px surface ring around the
 * diamond is not included; it may cover the connector's first pixel. */
const DIAMOND_REACH = 8;

/** Most urgent first: decides a merged summary diamond's mark. */
const STATUS_RANK: Readonly<Record<UiStatus, number>> = {
  overdue: 0,
  at_risk: 1,
  missing: 2,
  on_track: 3,
  open: 3,
  done: 4,
};

export interface BarGeometry {
  /** The bar as drawn: an optimistic due date already applied. */
  bar: TimelineBar;
  laneId: string;
  laneMuted: boolean;
  /** Left edge and width inside the lane track. */
  left: number;
  width: number;
  /** Centre of the due day (the diamond); beyond the track when clipped. */
  endX: number;
  /** Top of the bar inside its lane track. */
  top: number;
  /** Vertical centre in body coordinates (connectors attach here). */
  centerY: number;
  subRow: number;
  /** Starts before / ends after the window: drawn with ◂ / ▸ cues. */
  clippedStart: boolean;
  clippedEnd: boolean;
  /** Free pixels after the bar's end before the next bar on its line. */
  roomAfter: number;
  /** Too narrow for its label, and there is room after it. */
  labelOutside: boolean;
  /** Too narrow for a readable label and no room after it: the bar draws
   * no text (its name is still in the accessible name and the tooltip). */
  labelHidden: boolean;
  /** A zero-length milestone (start = due): drawn as its diamond alone. */
  point: boolean;
  /** The bar starts exactly at the previous bar's diamond on its line
   * (the usual case: a bar starts at the previous milestone's due date),
   * so anything aimed at its left edge would land under that diamond. */
  startsAtDiamond: boolean;
}

export interface SummaryPoint {
  /** Due date shared by every bar in this point. */
  end: string;
  x: number;
  bars: TimelineBar[];
  /** The most urgent status among them, counting only bars of active
   * lanes when there are any (an inactive lane is never loud). */
  status: UiStatus;
  /** Every bar here belongs to a muted (inactive) lane: drawn in greys. */
  muted: boolean;
  /** Max label width before the next diamond; null = diamond only. */
  labelRoom: number | null;
}

export interface SummaryRow {
  kind: 'summary';
  key: string;
  top: number;
  height: number;
  points: SummaryPoint[];
  count: number;
}

export interface GroupRow {
  kind: 'group';
  key: string;
  top: number;
  height: number;
  group: TimelineGroup;
}

export interface LaneRow {
  kind: 'lane';
  key: string;
  top: number;
  height: number;
  lane: TimelineLane;
  groupId: string;
  subRows: number;
  bars: BarGeometry[];
  /** Where the undated chips start (track coordinates), or anchor right. */
  undatedX: number;
  undatedAlign: 'left' | 'right';
  /** Bars entirely before / after the window (drawn as edge cues). */
  earlier: number;
  later: number;
}

export type TimelineRow = SummaryRow | GroupRow | LaneRow;

export interface TimelineLayout {
  scale: TimeScale;
  rows: TimelineRow[];
  /** Total body height (all rows). */
  height: number;
  /** Bar id → geometry, for connectors, scrolling and the drag maths. */
  bars: ReadonlyMap<string, BarGeometry>;
  /** Lane id → its row. */
  lanes: ReadonlyMap<string, LaneRow>;
  /** Centre of today's column, or null when today is outside the window. */
  todayX: number | null;
}

export interface LayoutInput {
  groups: TimelineGroup[];
  windowStart: string;
  windowEnd: string;
  today: string;
  zoom: TimelineZoom;
  /** Optimistic due dates by bar id (a drop waiting on onRedate). */
  overrides?: ReadonlyMap<string, string>;
}

/* Applies optimistic due dates to one lane, mirroring the engine's rule
   that a bar starts at the previous milestone's due date (§2.11): a moved
   bar's own start never passes its new end, and a bar that started at the
   old date starts at the new one. Without the second half a drop would
   make the next bar overlap, push the lane onto two lines while saving,
   and snap back when the host's data arrives. */
export function applyOverrides(
  bars: readonly TimelineBar[],
  overrides: ReadonlyMap<string, string> | undefined
): readonly TimelineBar[] {
  if (overrides === undefined || overrides.size === 0) return bars;
  const moved = new Map<string, string>(); // old end → new end
  for (const bar of bars) {
    const end = overrides.get(bar.id);
    if (end !== undefined && end !== bar.end) moved.set(bar.end, end);
  }
  if (moved.size === 0) return bars;
  return bars.map((bar) => {
    const end = overrides.get(bar.id) ?? bar.end;
    const start = moved.get(bar.start) ?? bar.start;
    if (end === bar.end && start === bar.start) return bar;
    return { ...bar, end, start: minDay(start, end) };
  });
}

/* Horizontal extent of one bar, clipped to the track. A bar starting on or
   before the window start begins flush at x=0; otherwise it starts at the
   centre of its start day, which is the previous milestone's due date, so
   consecutive milestones of a project abut exactly at the diamond. */
function barExtent(
  bar: TimelineBar,
  scale: TimeScale
): { left: number; right: number; endX: number; point: boolean } {
  const endX = centerXForDate(bar.end, scale);
  const startX =
    bar.start <= scale.windowStart ? 0 : centerXForDate(bar.start, scale);
  const right = bar.end > scale.windowEnd ? scale.width : endX;
  let left = Math.min(startX, right);
  const point = right - left < MIN_BAR_WIDTH;
  if (point) left = Math.max(0, right - MIN_BAR_WIDTH);
  return { left, right: Math.max(right, left + MIN_BAR_WIDTH), endX, point };
}

/* Greedy interval packing: each bar (by left edge) goes on the first line
   whose last bar ends at or before it starts. Sequential milestones share
   one line; only genuinely overlapping ones (same due date, a long first
   bar) push a lane taller. O(bars × lines). */
function packLane(bars: { left: number; right: number }[]): {
  lines: number;
  lineOf: number[];
} {
  const order = bars
    .map((_bar, i) => i)
    .sort((a, b) => {
      const ba = bars[a];
      const bb = bars[b];
      if (ba === undefined || bb === undefined) return 0;
      return ba.left === bb.left ? ba.right - bb.right : ba.left - bb.left;
    });
  const lineEnds: number[] = [];
  const lineOf: number[] = Array.from({ length: bars.length }, () => 0);
  for (const i of order) {
    const b = bars[i];
    if (b === undefined) continue;
    let line = lineEnds.findIndex((end) => end <= b.left + 0.5);
    if (line < 0) {
      line = lineEnds.length;
      lineEnds.push(b.right);
    } else {
      lineEnds[line] = b.right;
    }
    lineOf[i] = line;
  }
  return { lines: Math.max(1, lineEnds.length), lineOf };
}

/* Rough rendered width of the undated chips (Geist 12px ≈ 6.4px a
   character, plus the "No date" note, padding and the gap), so a lane
   whose bars run to the end of the window can anchor its chips to the
   right instead of overflowing. */
function estimateUndatedWidth(lane: TimelineLane): number {
  let width = 0;
  for (const chip of lane.undated) width += chip.label.length * 6.4 + 84;
  return width;
}

/** Lays out the whole chart. Pure: same input, same geometry. */
export function computeLayout(input: LayoutInput): TimelineLayout {
  const scale = createScale(
    input.windowStart,
    input.windowEnd,
    DAY_WIDTH[input.zoom]
  );
  const todayX =
    input.today >= scale.windowStart && input.today <= scale.windowEnd
      ? centerXForDate(input.today, scale)
      : null;

  const rows: TimelineRow[] = [];
  const bars = new Map<string, BarGeometry>();
  const lanes = new Map<string, LaneRow>();
  const summaryBars: BarGeometry[] = [];

  const summary: SummaryRow = {
    kind: 'summary',
    key: 'summary',
    top: 0,
    height: SUMMARY_HEIGHT,
    points: [],
    count: 0,
  };
  rows.push(summary);
  let y = SUMMARY_HEIGHT;

  for (const group of input.groups) {
    rows.push({
      kind: 'group',
      key: `g:${group.id}`,
      top: y,
      height: GROUP_HEIGHT,
      group,
    });
    y += GROUP_HEIGHT;

    for (const lane of group.lanes) {
      let earlier = 0;
      let later = 0;
      const drawn: {
        bar: TimelineBar;
        left: number;
        right: number;
        endX: number;
        point: boolean;
      }[] = [];
      for (const bar of applyOverrides(lane.bars, input.overrides)) {
        if (bar.end < scale.windowStart) {
          earlier++;
          continue;
        }
        if (bar.start > scale.windowEnd) {
          later++;
          continue;
        }
        drawn.push({ bar, ...barExtent(bar, scale) });
      }

      const { lines, lineOf } = packLane(drawn);
      const height = lines * ROW_HEIGHT;

      // One pass per line, left to right: the room after each bar (to the
      // next bar's left) and whether it starts on the previous bar's
      // diamond (within a pixel of its due-date centre).
      const byLine: number[][] = Array.from({ length: lines }, () => []);
      drawn.forEach((_, i) => byLine[lineOf[i] ?? 0]?.push(i));
      const roomAfter: number[] = Array.from({ length: drawn.length }, () => 0);
      const atDiamond: boolean[] = Array.from(
        { length: drawn.length },
        () => false
      );
      for (const members of byLine) {
        members.sort((a, b) => (drawn[a]?.left ?? 0) - (drawn[b]?.left ?? 0));
        members.forEach((index, k) => {
          const next = members[k + 1];
          const nextLeft =
            next === undefined ? scale.width : (drawn[next]?.left ?? 0);
          roomAfter[index] = nextLeft - (drawn[index]?.right ?? 0);
          const prev = drawn[members[k - 1] ?? -1];
          const self = drawn[index];
          atDiamond[index] =
            prev !== undefined &&
            self !== undefined &&
            prev.bar.end <= scale.windowEnd &&
            Math.abs(prev.endX - self.left) < 1;
        });
      }

      const geometries: BarGeometry[] = drawn.map((d, i) => {
        const subRow = lineOf[i] ?? 0;
        const width = d.right - d.left;
        const room = roomAfter[i] ?? 0;
        const clippedStart = d.bar.start < scale.windowStart;
        const labelOutside =
          width < LABEL_INSIDE_MIN && room >= LABEL_OUTSIDE_MIN_ROOM;
        const textRoom = width - 21 - (clippedStart ? 12 : 0);
        const geometry: BarGeometry = {
          bar: d.bar,
          laneId: lane.id,
          laneMuted: lane.muted === true,
          left: d.left,
          width,
          endX: d.endX,
          top: subRow * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2,
          centerY: y + subRow * ROW_HEIGHT + ROW_HEIGHT / 2,
          subRow,
          clippedStart,
          clippedEnd: d.bar.end > scale.windowEnd,
          roomAfter: room,
          labelOutside,
          labelHidden: !labelOutside && textRoom < LABEL_TEXT_MIN,
          point: d.point,
          startsAtDiamond: atDiamond[i] ?? false,
        };
        bars.set(d.bar.id, geometry);
        if (!geometry.clippedEnd) summaryBars.push(geometry);
        return geometry;
      });

      // Undated chips follow the last bar on the first line (past its
      // diamond), or sit just after today in a lane with no bars.
      let lastRight = -1;
      for (const g of geometries) {
        if (g.subRow === 0) lastRight = Math.max(lastRight, g.left + g.width);
      }
      const undatedX =
        lastRight >= 0 ? lastRight + DIAMOND_REACH + 10 : (todayX ?? 0) + 12;
      const undatedAlign =
        undatedX + estimateUndatedWidth(lane) > scale.width ? 'right' : 'left';

      const row: LaneRow = {
        kind: 'lane',
        key: `l:${lane.id}`,
        top: y,
        height,
        lane,
        groupId: group.id,
        subRows: lines,
        bars: geometries,
        undatedX,
        undatedAlign,
        earlier,
        later,
      };
      rows.push(row);
      lanes.set(lane.id, row);
      y += height;
    }
  }

  summary.points = summaryPoints(summaryBars, scale);
  summary.count = summaryBars.length;

  return { scale, rows, height: y, bars, lanes, todayX };
}

/* The "Milestones" row (Gr8r's milestone lane): one diamond per due date,
   same-day milestones merged, each label allowed only the room up to the
   next diamond so labels never overlap; cramped ones show the diamond
   alone (the full list is in its tooltip). A muted (inactive) lane's
   milestone never makes a diamond loud: the status comes from the active
   lanes' bars on that day, and a day with only muted bars is muted. */
function summaryPoints(
  geometries: BarGeometry[],
  scale: TimeScale
): SummaryPoint[] {
  const byEnd = new Map<string, BarGeometry[]>();
  for (const g of geometries) {
    const list = byEnd.get(g.bar.end);
    if (list === undefined) byEnd.set(g.bar.end, [g]);
    else list.push(g);
  }
  const ends = [...byEnd.keys()].sort();
  const points: SummaryPoint[] = ends.map((end) => {
    const list = byEnd.get(end) ?? [];
    const active = list.filter((g) => !g.laneMuted);
    const ranked = active.length > 0 ? active : list;
    let status: UiStatus = 'done';
    for (const { bar } of ranked) {
      if (STATUS_RANK[bar.status] < STATUS_RANK[status]) status = bar.status;
    }
    return {
      end,
      x: centerXForDate(end, scale),
      bars: list.map((g) => g.bar),
      status,
      muted: active.length === 0,
      labelRoom: null,
    };
  });
  points.forEach((point, i) => {
    const next = points[i + 1];
    const room = (next === undefined ? scale.width : next.x) - point.x - 24;
    point.labelRoom = room >= 28 ? Math.round(room) : null;
  });
  return points;
}

export interface Connector {
  key: string;
  from: string;
  to: string;
  d: string;
  /** Arrowhead chevron where the connector lands. */
  head: string;
  onRiskChain: boolean;
  /** 'start': into the waiting bar's start, which begins after the blocker
   * is due (Gr8r's arrow). 'drop': down (or up) from the blocker's
   * diamond onto the waiting bar's edge, when it is already under way or
   * its start is covered by the previous milestone's diamond. */
  route: 'start' | 'drop';
  /** The waiting milestone is due before its blocker: drawn dashed. */
  conflict: boolean;
}

/** Horizontal room a 'start' route needs to curve into the waiting bar. */
const START_ROUTE_MIN = 16;

/* Milestone-level dependency connectors, 1px cubics. When the waiting bar
   starts after the blocker's due date the edge runs from the diamond into
   its start with Gr8r's S-curve control points; when it is already under
   way (bars start at the previous milestone's date, so this is common) a
   Gantt arrow into its start would loop backwards across the chart, so the
   edge drops from the diamond onto the waiting bar's near edge instead,
   right under the date it waits for. A waiting bar that starts on its
   predecessor's diamond is dropped onto too, just past that diamond, so
   the arrowhead is never hidden under it. Edges whose bars are not drawn,
   and abutting bars on one line, are skipped. */
export function computeConnectors(
  layout: TimelineLayout,
  dependencies: readonly TimelineDependency[]
): Connector[] {
  const out: Connector[] = [];
  for (const dep of dependencies) {
    const from = layout.bars.get(dep.from);
    const to = layout.bars.get(dep.to);
    if (from === undefined || to === undefined || from === to) continue;
    const y1 = from.centerY;
    const y2 = to.centerY;
    const fromX = from.clippedEnd ? layout.scale.width : from.endX;
    const x1 = fromX + DIAMOND_REACH;
    const x2 = to.left;
    const base = {
      key: `${dep.from}->${dep.to}`,
      from: dep.from,
      to: dep.to,
      onRiskChain: dep.onRiskChain,
      conflict: to.bar.end < from.bar.end,
    };

    const sameLine = Math.abs(y2 - y1) < 1;
    // A start under the previous milestone's diamond would hide the
    // arrowhead and read as pointing at that milestone: drop onto the
    // bar's edge instead, clear of the diamond.
    if (sameLine || (x2 >= x1 + START_ROUTE_MIN && !to.startsAtDiamond)) {
      if (x2 - x1 < 6) continue; // abutting on one line
      const c1 = Math.max(x1 + 12, x2 - 12);
      const c2 = Math.min(x1 + 12, x2 - 12);
      out.push({
        ...base,
        route: 'start',
        d: `M${x1} ${y1} C${c1} ${y1} ${c2} ${y2} ${x2 - 1} ${y2}`,
        head: `M${x2 - 6} ${y2 - 3.5} L${x2 - 1} ${y2} L${x2 - 6} ${y2 + 3.5}`,
      });
      continue;
    }

    const dir = y2 > y1 ? 1 : -1;
    const y0 = y1 + dir * (DIAMOND_REACH - 1);
    const tip = y2 - dir * (BAR_HEIGHT / 2 + 1);
    const inset = to.startsAtDiamond ? DIAMOND_REACH + 6 : 6;
    const xl = Math.min(
      to.left + to.width - 6,
      Math.max(to.left + inset, fromX)
    );
    const k = Math.min(28, Math.abs(tip - y0) / 2);
    out.push({
      ...base,
      route: 'drop',
      d: `M${fromX} ${y0} C${fromX} ${y0 + dir * k} ${xl} ${tip - dir * k} ${xl} ${tip}`,
      head: `M${xl - 3.5} ${tip - dir * 5} L${xl} ${tip} L${xl + 3.5} ${tip - dir * 5}`,
    });
  }
  return out;
}
