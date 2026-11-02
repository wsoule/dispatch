import type { ComponentType, KeyboardEvent, ReactNode } from 'react';

// Shared prop vocabulary. Deliberately free of any planner/Linear types so
// the components port to other apps (e.g. Dispatch): hosts map their own
// models onto these shapes in a thin adapter.

/**
 * A milestone's status as drawn by StatusMark, a diamond coloured by the
 * status hues (docs/architecture.md §8.2): done = solid neutral with a
 * tick (never green: a green fill reads as the red one without red-green
 * vision), on_track = green outline, at_risk = amber with the bottom half
 * filled, overdue = solid red, missing = dotted grey outline (an input is
 * missing), open = neutral outline (open work that makes no status claim
 * of its own, such as an issue box on the graph, whose status is its
 * milestone's).
 */
export type UiStatus =
  | 'done'
  | 'on_track'
  | 'at_risk'
  | 'overdue'
  | 'missing'
  | 'open';

/**
 * A status colour (owner decision 2026-10-22, docs/architecture.md §8.2):
 * danger = red (overdue, failed, urgent), warning = amber (at risk,
 * blocked, unassigned, a missing input), success = green (on track, done,
 * met, succeeded), info = blue (in progress, running, live).
 */
export type SemanticTone = 'danger' | 'warning' | 'success' | 'info';

/**
 * The colour of a piece of text, a chip, a notice, a count or a fill:
 * default neutral, muted grey (inactive, nothing to do), accent (the brand
 * purple: new, unread, selected, progress; never a status), or a status
 * tone. Components emit it as `data-tone`, which gives their CSS --tone
 * (the hue), --tone-ink (text), --tone-soft (a tint), --tone-line (a
 * tinted border) and --on-tone (text on a solid fill) (tokens.css, TONE
 * HOOK).
 */
export type UiTone = 'default' | 'muted' | 'accent' | SemanticTone;

/**
 * `data-*` attributes a host puts on a component (its `data-testid` and
 * `data-slot` hooks). The components whose props extend it (Button,
 * Popover, PickerPopover, Dialog, ConfirmDialog, StatsStrip and each of its
 * StatCells, ProgressRule, and the others whose props say so) spread them,
 * untouched, on their root element (a StatCell's on its cell), so a host
 * keeps its test and styling hooks without the package knowing their
 * names. A component's own `data-*` attributes win over a host's of the
 * same name.
 */
export type DataAttributes = {
  [key: `data-${string}`]: string | number | boolean | undefined;
};

/** What a link (Button with `href`) hands the host's link component. A
    host component spreads the rest onto its anchor, so the `data-*`
    hooks, `aria-describedby` and `onKeyDown` reach the element. */
export interface UiLinkProps extends DataAttributes {
  href: string;
  className?: string;
  children?: ReactNode;
  'aria-current'?: 'page' | undefined;
  'aria-label'?: string;
  'aria-describedby'?: string;
  title?: string;
  target?: string;
  rel?: string;
  onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLAnchorElement>) => void;
}

/** The host's link component (next/link, a router Link, or a plain <a>). */
export type UiLinkComponent = ComponentType<UiLinkProps>;
