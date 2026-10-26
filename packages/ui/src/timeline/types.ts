import type { ReactNode } from 'react';

import type { UiStatus, UiTone } from '../types';

// Prop vocabulary of the "timeline" family: Gr8r Studio's Gantt (rounded
// bars tinted by status, sunken weekends and group rows, the today line in
// the accent). Plain data + callbacks only, so the planner
// (Next) and Dispatch (Vite + Tauri) map their own models onto these shapes
// in a thin adapter. Every date is a calendar day as 'YYYY-MM-DD' (no time,
// no zone): the host decides what "today" is in its workspace timezone.

/** Day columns (32px a day, weekends sunken) or week columns (11px a day). */
export type TimelineZoom = 'weeks' | 'months';

/** One dated milestone drawn as a bar from `start` to its due date `end`. */
export interface TimelineBar {
  id: string;
  /** Milestone name, e.g. "Cutover rehearsal". */
  label: string;
  /** First day of the bar (the previous milestone's due date, the project
   * start or the window start). Clamped so it is never after `end`. */
  start: string;
  /** Due date (the milestone's target date). The diamond sits here. */
  end: string;
  status: UiStatus;
  /** Human wording of the status, e.g. "Overdue" (read out in the name). */
  statusLabel: string;
  /** Progress receipt, e.g. "3/7" (tabular figures). */
  progressLabel?: string;
  /** Small pills, e.g. "Next" for the lane's next milestone, "↑2" for a
   * weight override. */
  tags?: string[];
  /** Missing rubric input, e.g. "Missing: done means…": a warning-tone
   * line inside the bar. */
  missing?: string;
  /** Shows the right-edge handle that re-dates the milestone. */
  editable?: boolean;
}

/** A milestone with no target date: a dashed chip at the lane's end. */
export interface TimelineUndated {
  id: string;
  label: string;
  status: UiStatus;
  statusLabel: string;
}

/** One project. */
export interface TimelineLane {
  id: string;
  /** Project name. */
  label: string;
  /** Renders the name through the host's <Link>. */
  href?: string;
  /** Quiet line under the name: the lead's name, or "No lead". */
  sublabel?: string;
  /** Colours the sublabel when it asks for action: 'warning' (amber) for
   * "No lead" or a deactivated lead (docs/architecture.md §8.2 "Status
   * colours"). default and muted leave it the quiet grey; an inactive
   * (muted) lane is never coloured. */
  sublabelTone?: UiTone;
  /** An inactive project: drawn in greys, never loud. */
  muted?: boolean;
  bars: TimelineBar[];
  undated: TimelineUndated[];
}

/** A quiet link after a group's project count (host routes it through Link). */
export interface TimelineGroupLink {
  /** Short sentence-case wording, e.g. "Graph". */
  label: string;
  href: string;
  /** Fuller accessible name when the label alone is ambiguous across
   * groups, e.g. "Dependency graph of Payments platform". */
  ariaLabel?: string;
}

/** One initiative (or "No initiative") and its projects. */
export interface TimelineGroup {
  id: string;
  label: string;
  lanes: TimelineLane[];
  /** Drawn after "N projects" in the chart's group row and the phone
   * card's group head. */
  link?: TimelineGroupLink;
}

/** Milestone-level edge: `to` waits on `from` (bar ids). */
export interface TimelineDependency {
  from: string;
  to: string;
  /** The blocker is unassigned/overdue or waits on one: drawn in the
   * warning hue. */
  onRiskChain: boolean;
}

export interface TimelineLegendItem {
  status: UiStatus;
  label: string;
}

export interface TimelineChartProps {
  /** The host's calendar today, 'YYYY-MM-DD'. Draws the today line. */
  today: string;
  /** First and last day drawn, inclusive. */
  windowStart: string;
  windowEnd: string;
  zoom: TimelineZoom;
  /** Shows the Weeks / Months switch; omit to fix the zoom. */
  onZoomChange?: (zoom: TimelineZoom) => void;
  /** Keep referentially stable (memoise in the host): the layout is
   * recomputed whenever this array changes. */
  groups: TimelineGroup[];
  dependencies?: TimelineDependency[];
  /** Controlled connector visibility. Omit (and pass
   * defaultShowDependencies) to let the chart own it. */
  showDependencies?: boolean;
  defaultShowDependencies?: boolean;
  onShowDependenciesChange?: (show: boolean) => void;
  /** The bar whose details are open (accent ring, scrolled into view). */
  selectedBarId?: string;
  /** A lane to bring into view and mark, e.g. from ?project=<id>. */
  focusLaneId?: string;
  /** A bar (or undated chip) was activated: open its details. */
  onOpenBar: (barId: string) => void;
  /** Re-date an editable bar's due date. The chart moves the bar at once
   * and rolls it back if the promise rejects (the rejection's message is
   * announced). Omit to make every bar read-only. */
  onRedate?: (barId: string, newEnd: string) => Promise<void>;
  /** Toolbar slots: before the chart's own controls (search, filters) and
   * after them. */
  toolbarStart?: ReactNode;
  toolbarEnd?: ReactNode;
  /** Status legend under the toolbar; false hides it. Defaults to the five
   * status marks in English. */
  legend?: TimelineLegendItem[] | false;
  /** Accessible name of the chart region. Defaults to "Timeline". */
  label?: string;
  /** Copy for a chart with no lanes. */
  emptyLabel?: string;
  /** CSS length capping the chart's scroll area (both axes scroll inside
   * it so the header and lane column stay sticky). Defaults to
   * calc(100vh - 220px). */
  maxHeight?: string;
}
