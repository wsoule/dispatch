import type {
  FocusEvent,
  HTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactNode,
  Ref,
} from 'react';

import type { AvatarHue } from '../components/initials-avatar';
import type { PickerMark } from '../edit/types';
import type { DataAttributes, UiStatus, UiTone } from '../types';

// Prop vocabulary of the "tasks" family: primitives, the grouped task table,
// deadlines, stats and registers. Plain data + callbacks only, so the
// planner (Next) and Dispatch (Vite + Tauri) can map their own models onto
// these shapes in a thin adapter.

/* ---- primitives -------------------------------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonCommonProps extends DataAttributes {
  /** primary = purple fill (one per view), secondary = white with a strong
   * border, quiet = Gr8r's ghost (no box until hover), danger = red fill
   * (a destructive or irreversible write, e.g. "Assign in Linear now"; the
   * accent never means risk). */
  variant?: ButtonVariant;
  /** sm 26px (toolbars), md 30px (the default), lg 36px (the one call to
   * action of a card, e.g. "Sign in with Linear"). */
  size?: ButtonSize;
  /** Stretch across the container (a sign-in card's button). */
  block?: boolean;
  /** Where the content sits along the button: center (the default) or
   * start, for a block button whose content is a summary read left to
   * right (a quiet block button holding a task's mini Flight Plan). */
  align?: 'center' | 'start';
  /** Leading icon, e.g. a 14px lucide icon (strokeWidth 1.8). */
  icon?: ReactNode;
  /** Trailing icon. */
  iconAfter?: ReactNode;
  children?: ReactNode;
  className?: string;
  'aria-label'?: string;
  /** The id of an element that describes it (a hint, a Tooltip). */
  'aria-describedby'?: string;
  title?: string;
}

export interface ButtonAsButtonProps extends ButtonCommonProps {
  href?: undefined;
  /** The <button> element (a Popover's or Tooltip's anchor, a host's
      focus return). */
  ref?: Ref<HTMLButtonElement>;
  id?: string;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  /** Saving or sending: the button is disabled with `aria-busy`, and its
      text reads `busyLabel` instead (never a spinner). An icon-only
      button keeps its icon. */
  busy?: boolean;
  /** The text while busy. Default "Saving…". */
  busyLabel?: string;
  tabIndex?: number;
  form?: string;
  name?: string;
  autoFocus?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLButtonElement>) => void;
  onMouseDown?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Hover in and out (a Tooltip's trigger). */
  onPointerEnter?: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLButtonElement>) => void;
  onFocus?: (event: FocusEvent<HTMLButtonElement>) => void;
  onBlur?: (event: FocusEvent<HTMLButtonElement>) => void;
  'aria-pressed'?: boolean;
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
  'aria-haspopup'?: 'dialog' | 'menu' | 'listbox' | 'true' | boolean;
}

export interface ButtonAsLinkProps extends ButtonCommonProps {
  /** Renders through the host's <Link>. */
  href: string;
  /** Opens in a new tab with a screen-reader note. */
  external?: boolean;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLAnchorElement>) => void;
}

export type ButtonProps = ButtonAsButtonProps | ButtonAsLinkProps;

/** default = Gr8r's neutral badge, muted = plain quiet text (no box),
 * accent = the accent's text on its soft tint (new, unread), inverse = the
 * dark slab (prefer a status tone), and a status tone (danger, warning,
 * success, info) = Gr8r's status pill (neutral, bordered, the hue in a 6px
 * dot), or with `filled` Gr8r's tinted badge, the tone's text on its soft
 * tint (docs/architecture.md §8.2). */
export type ChipTone = UiTone | 'inverse';

export interface ChipProps extends DataAttributes {
  tone?: ChipTone;
  /**
   * A status tone (danger, warning, success, info) drawn as Gr8r's tinted
   * badge (the tone's text on its soft tint) instead of the dot pill: for
   * the chips that state the stronger claim (blocked, live, failed,
   * assigned, sent). Ignored for default, muted, accent and inverse.
   */
  filled?: boolean;
  /**
   * Muted only: draw it as Gr8r's status pill with a grey (--gray) dot
   * instead of plain quiet text, for a lifecycle status that is inactive
   * (an inactive project's Linear status, "Paused"). Grey still means
   * inactive; ignored for every other tone.
   */
  dot?: boolean;
  /** Optional leading status mark; needs statusLabel for assistive tech. */
  status?: UiStatus;
  statusLabel?: string;
  /**
   * Default tone only (ignored for every other tone and with `status`): a
   * 6px dot in a decorative hue before the words (a project's or a
   * label's colour when the host has no colour of its own for it, e.g.
   * `avatarHue(name)`). Decoration only (aria-hidden): the words carry
   * the meaning. `mark` wins when both are given.
   */
  hue?: AvatarHue;
  /**
   * Default tone only (ignored for every other tone and with `status`): a
   * picker mark drawn before the words through PickerMarkView, at chip
   * size: Gr8r's label chip is `{ kind: 'swatch', color }` (the label's
   * own colour in a small square; a colour that is not a plain hex draws
   * the hollow square). Wins over `hue`.
   */
  mark?: PickerMark;
  title?: string;
  children: ReactNode;
  /**
   * Draws a trailing 14px quiet × button, the chip's only interactive
   * child (the chip stays a `<span>`), that calls this: a reference or
   * an attachment the host lets the person take back. Not on ChipButton,
   * which is a button itself (a button inside a button is invalid).
   */
  onRemove?: () => void;
  /** The × button's accessible name. Default `Remove {children}` when the
      children are a plain string, else "Remove"; pass one whenever the
      children are not plain words ("Remove about DIS-12"). */
  removeLabel?: string;
}

/**
 * A Chip that does something: a filter or a starter that toggles
 * (`selected`), a door to a place (`href`), a reference to open. Drawn in
 * the chip's look with a hover fill and the focus ring; its accessible name
 * is its visible text. It takes no `onRemove`: it is a button itself, and
 * a × button inside it would nest one button in another.
 */
export interface ChipButtonProps extends Omit<
  ChipProps,
  'onRemove' | 'removeLabel'
> {
  /** A press: a `<button type="button">`, or the link when `href` is set. */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  /** Button only: the `<button>` element (a Tooltip's anchor, a host's
      focus return). The link and the disabled link's text take none. */
  ref?: Ref<HTMLButtonElement>;
  /** The id of an element that describes it (a hint, a Tooltip's tip). */
  'aria-describedby'?: string;
  /** Button only: hover in and out, a press, focus and blur, what a
      Tooltip wires on its trigger (`<Tooltip><ChipButton/></Tooltip>`). */
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  /** Renders through the host's <Link> instead of a button. */
  href?: string;
  /** Button only: a toggle that is on (aria-pressed), drawn in the
      accent's selection tint. Omit for a plain action (no aria-pressed);
      false says it is a toggle that is off. */
  selected?: boolean;
  /** Cannot be pressed: a disabled button, or (with `href`) the chip's
      text marked aria-disabled, not a link. */
  disabled?: boolean;
}

export interface SegmentedOption {
  id: string;
  label: string;
  /** Quiet count after the label, e.g. "Upcoming 6". */
  count?: number;
  disabled?: boolean;
}

export interface SegmentedControlProps {
  options: SegmentedOption[];
  /** Controlled selection. Omit (and pass defaultValue) for uncontrolled. */
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  /** Accessible name of the radio group, e.g. "Zoom". */
  label: string;
  size?: 'sm' | 'md';
  /** Stretch the cells across the container (tab-strip form). */
  fill?: boolean;
}

export interface SwitchProps extends DataAttributes {
  /** Controlled state. Omit (and pass defaultChecked) for uncontrolled. */
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  /** The visible label beside the switch, and its accessible name unless
      aria-label or aria-labelledby names it. */
  label: string;
  /** Quiet note after the label. */
  note?: string;
  disabled?: boolean;
  id?: string;
  /** Overrides the accessible name; keep the visible label inside it
      (WCAG 2.5.3). */
  'aria-label'?: string;
  /** Names the switch by another element (a row heading), in place of
      the label. */
  'aria-labelledby'?: string;
  /** Keep the label for assistive tech only: a settings row whose title
      (its `<label htmlFor>` or `aria-labelledby`) already names the switch
      draws just the track. aria-label and aria-labelledby still win. */
  hideLabel?: boolean;
}

export interface CheckboxProps extends DataAttributes {
  /** Controlled state. Omit (and pass defaultChecked) for uncontrolled. */
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  /** The label beside the box (and the accessible name). */
  label: string;
  /** Quiet note after the label. */
  note?: string;
  disabled?: boolean;
  id?: string;
  /** Form field name and value, for hosts that submit a native form. */
  name?: string;
  value?: string;
  /** Keep the label for assistive tech only (a register column names it). */
  hideLabel?: boolean;
  /** Overrides the accessible name; keep the visible label inside it
      ("Ana Moreno: Watcher"). */
  'aria-label'?: string;
  /** Some but not all of what the box stands for is on (a group of rows
      partly selected): a dash in the accent box, aria-checked="mixed".
      A click then reports `true` (select the rest). */
  indeterminate?: boolean;
  /** The native input's click, before it toggles: a box inside a clickable
      header calls `event.stopPropagation()` here so ticking it does not
      also press the header. */
  onClick?: (event: MouseEvent<HTMLInputElement>) => void;
}

/** One cell of a NavTabs strip: a destination, not a state. */
export interface NavTabItem {
  id: string;
  label: string;
  /** A 16px icon before the label (14px at size sm), e.g. a lucide icon
      (strokeWidth 1.8); drawn in the idle icon step, the accent when
      current. Decoration: the label names the cell. */
  icon?: ReactNode;
  /** Where the cell goes. Omit for a cell that cannot be followed yet
      (drawn quiet with a dashed edge; say why in `note`). */
  href?: string;
  /** The page being shown: the raised current pill (the sidebar's) and
      aria-current="page". */
  current?: boolean;
  /** Quiet count after the label. */
  count?: number;
  /** Short muted note after the label ("select a milestone"). */
  note?: string;
  /** A plain click (primary button, no modifier) calls this instead of
      following `href`, so the host can show the change at once and
      navigate itself; `href` stays for a new tab or a middle click. */
  onFollow?: () => void;
}

/** A titled run of NavTabs cells in a grouped sub-nav (Settings'
    "Project", "Team", "This machine"). */
export interface NavTabsGroup {
  /** The group's title, in the eyebrow voice above its cells, and the
      accessible name of its `role="group"`. */
  label: string;
  items: NavTabItem[];
}

interface NavTabsCommonProps {
  /** Accessible name of the <nav> ("Graph level", "Settings sections"). */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}

/** One run of cells, as a tab strip or a sub-nav column. */
export interface NavTabsItemsProps extends NavTabsCommonProps {
  items: NavTabItem[];
  groups?: undefined;
  /** horizontal = a tab strip; vertical = a sub-nav column that becomes
      one sideways-scrolling strip at 900px and below. */
  orientation?: 'horizontal' | 'vertical';
  /** Horizontal only: stretch the cells across the container. */
  fill?: boolean;
}

/** A grouped sub-nav column (vertical only, so `items`, `fill` and a
    horizontal orientation do not apply): each group's eyebrow title over
    its cells. At 900px and below the column becomes the one strip of
    every cell, the titles hidden. */
export interface NavTabsGroupsProps extends NavTabsCommonProps {
  groups: readonly NavTabsGroup[];
  items?: undefined;
  orientation?: 'vertical';
  fill?: undefined;
}

export type NavTabsProps = NavTabsItemsProps | NavTabsGroupsProps;

/**
 * A section or group heading row (Gr8r's group header): an optional fold
 * chevron, a tone's status diamond, the host's icon, the name and its
 * count inside one heading element, then the host's actions and a "+".
 * The host's data-* hooks land on the root (a `data-slot="group-header"`).
 */
export interface SectionHeaderProps extends DataAttributes {
  /** The heading's words ("Coming in", "In progress"). */
  name: ReactNode;
  /** Printed after the name inside the heading, in tabular figures, so
      the heading's accessible name reads "Coming in 2". */
  count?: number;
  /** A 14px glyph before the heading (a state glyph, an avatar). */
  icon?: ReactNode;
  /** A status tone: the status diamond in the tone's shape and hue and a
      2px edge in the hue at the left (data-tone on the root). Never the
      only signal: the name says the status. Default (or omitted) draws
      neither. */
  tone?: UiTone;
  /** The heading element. Default 'h3'; 'div' when the host's own
      heading wraps it or the row is not a heading at all. */
  as?: 'h2' | 'h3' | 'h4' | 'div';
  /** Folded: the chevron turns to point right, aria-expanded is false
      and the root carries data-collapsed. */
  collapsed?: boolean;
  /** Draws the fold chevron, a quiet icon button that calls this. No
      chevron without it. */
  onToggle?: () => void;
  /** The chevron button's name. Default "Collapse group" / "Expand
      group" (by `collapsed`); aria-expanded says the state either way. */
  toggleLabel?: string;
  /** The host's controls at the end of the row (a "…" menu, chevrons). */
  actions?: ReactNode;
  /** Draws a quiet "+" icon button after `actions` that calls this. */
  onAdd?: () => void;
  /** The "+" button's name and title. Default "New". */
  addLabel?: string;
  /** A --divider rule under the row. */
  rule?: boolean;
  /** Sticks to the top of its scroller on --bg, above the rows under it. */
  sticky?: boolean;
  className?: string;
}

/**
 * Linear's progress pie: a ring and a pie filled to done / total, as the
 * status icons draw a task in progress ("◔ 3/8" beside a count).
 */
export interface ProgressPieProps {
  done: number;
  /** 0 draws an empty pie (never NaN). */
  total: number;
  /** px. Default 12. */
  size?: 12 | 14 | 16 | 20;
  /** The pie in the tone's hue and the ring in its tinted line (data-tone);
      default the secondary ink in the strong border. */
  tone?: UiTone;
  /** What it says ("3 of 8 done"): the svg is role="img" named by it.
      '' makes it decorative (aria-hidden) for a host that prints the
      count beside it. */
  label: string;
  className?: string;
}

/** The host's `data-*` hooks land on the root span (Dispatch's
 * `data-slot="flight-slots"`), beside the component's own `data-tone`. */
export interface ProgressRuleProps extends DataAttributes {
  done: number;
  total: number;
  /** The fill's colour: default = the accent (Gr8r's progress fill);
   * danger when the milestone is overdue, warning when it is behind pace,
   * success once complete, muted in an inactive project. The receipt
   * ("3/7") stays quiet text whatever the tone. */
  tone?: UiTone;
  /** Visible label; defaults to "done/total". Pass null to hide it. */
  label?: string | null;
  /** Accessible name, e.g. "Cutover rehearsal progress". */
  'aria-label'?: string;
  /** The track's aria-valuetext, for a meter that counts something other
   * than work done ("3 of 4 slots in use" for agent slots). Default (and
   * when '') "<done> of <total> done", with the clamped numbers. */
  valueText?: string;
}

export interface NoticeProps extends DataAttributes {
  /** Lead-in word before the copy, sentence case: "Blocked", "Demo data". */
  label?: string;
  children: ReactNode;
  /** The box and the lead-in's colour. accent = the accent's soft tint
   * (the default: plain notes); default = a bordered neutral box (demo
   * data, read only, not found); muted = the same box with a grey lead-in;
   * a status tone = its soft tint with the lead-in in its text colour
   * (danger for errors and failures, warning for blocked or a missing
   * input, success, info). */
  tone?: UiTone;
  /** status (polite) for updates, alert for errors, note for an aside
      that qualifies the page (a read-only reason). Omit for static copy. */
  role?: 'status' | 'alert' | 'note';
  /** Trailing control, e.g. a quiet Button. */
  action?: ReactNode;
}

export interface EmptyStateProps {
  /** The explanation: "Nothing due this week." */
  children: ReactNode;
  /** A short title above it ("No runs"), when the sentence is long. */
  label?: string;
  action?: ReactNode;
  /** A dashed edge (an input is missing rather than nothing to show). */
  hatched?: boolean;
  /** The 22px glyph above the title (Gr8r's empty state): defaults to an
   * empty tray, or a dashed circle when hatched; null for none. */
  icon?: ReactNode;
}

/**
 * A summary that shows or hides a panel under it (Gr8r's fold): "Details"
 * under an error, a tool call's arguments, "+3 more". Controlled through
 * `open` and `onOpenChange`, or uncontrolled from `defaultOpen`.
 */
export interface DisclosureProps extends DataAttributes {
  /** Controlled open state. */
  open?: boolean;
  /** Uncontrolled: open on the first render. Default false. */
  defaultOpen?: boolean;
  /** Called with the new state when the trigger is pressed. */
  onOpenChange?: (open: boolean) => void;
  /** The default trigger's words, or a function of the state ("Show
      details" / "Hide details"). */
  summary?: ReactNode | ((state: { open: boolean }) => ReactNode);
  /**
   * Replaces the default trigger: draw any button (a chip, a quiet
   * Button, a full-width bar) and spread `props` on it, which wires
   * aria-expanded, aria-controls, the toggling click and type="button".
   */
  trigger?: (state: {
    open: boolean;
    props: {
      'aria-expanded': boolean;
      'aria-controls': string;
      onClick: () => void;
      type: 'button';
    };
  }) => ReactNode;
  /** inline (default): a quiet text button in the secondary ink; bar: a
      full-width row on --surface-2; plain: no chrome of its own. */
  variant?: 'inline' | 'bar' | 'plain';
  /** The leading chevron, turned down while open. Default true. */
  chevron?: boolean;
  /** Keep the panel's content mounted (hidden) while closed: a form's
      state, a scroll position, a running log. Default false: the content
      unmounts. */
  keepMounted?: boolean;
  /** The panel's id (aria-controls points at it). Default: a generated
      one. */
  id?: string;
  children: ReactNode;
}

export interface ChecklistItem {
  id?: string;
  label: string;
  met: boolean;
  /** Sans note under the label, e.g. "Add a target date in Linear". */
  note?: string;
}

export interface ChecklistProps {
  items: ChecklistItem[];
  /** Accessible name of the list, e.g. "Rubric". */
  label?: string;
  /** Right-aligned state words; defaults to Met / Missing. Read-only mode
      only: a list with onToggle has no state column. */
  metLabel?: string;
  missingLabel?: string;
  /** Lets a person tick the list: each item is a Checkbox row named by its
      label, checked when `met`, and a tick calls `onToggle(id, next)`
      (the host stores it and passes the new `met` back). `id` is the
      item's `id`, or `String(index)` when the item has none (ReviewMode
      stores its criteria ticks by index). Without it the list is the
      read-only rubric (a met disc, a "Missing" chip). */
  onToggle?: (id: string, met: boolean) => void;
}

/* ---- list item, panel -------------------------------------------------- */

/**
 * One row of a host's own list (a conversation, a draft, a notification,
 * a thread, a stack step): a 40px row of slots in reading order, the
 * leading glyph, the title with its crumb, the meta line under them, the
 * trailing controls and the date. Clickable with `onClick` (focusable,
 * Enter and Space on the row itself), or a plain `as="button"`. The
 * host's data-* hooks land on the root.
 */
export interface ListItemProps extends DataAttributes {
  /** The row's words: 13.5px, medium, one line that truncates. */
  title: ReactNode;
  /** A 14px glyph before the title (a state mark, an avatar). */
  leading?: ReactNode;
  /** A second line under the title, 12px in the secondary ink with
      tabular figures ("3 replies · Ana"): the row grows to fit it. */
  meta?: ReactNode;
  /** Context after the title, printed " › crumb" in the secondary ink;
      it truncates with the title. */
  crumb?: ReactNode;
  /** The host's controls at the end of the row (a chip, a count, a quiet
      Button). A click or a key inside them stays there: the row never
      activates from them. With `as="button"` they are drawn beside the
      button, never inside it. */
  trailing?: ReactNode;
  /** At the far right, 12px in the secondary ink with tabular figures
      ("Sep 13", "running"). */
  date?: ReactNode;
  /** An accent dot before the row, with an sr-only "Unread" (the dot is
      never the only signal), and `data-unread` on the root. */
  unread?: boolean;
  /** The row the host has open or picked: the accent tint (and, with
      `role="option"`, aria-selected). */
  selected?: boolean;
  /** The keyboard cursor of a host's list (j/k, aria-activedescendant):
      the focus ring, drawn whether or not the row holds DOM focus. */
  active?: boolean;
  /** 1 nests the row one step under the row before it, with a connector
      on the border colour at the left. */
  indent?: 0 | 1;
  /** The root element. Default 'div'; 'li' inside a host's list;
      'button' for a plain action row (a native button: Enter and Space
      are its own). */
  as?: 'div' | 'li' | 'button';
  /** The row's role, set by the host's list: 'listitem', 'option' under
      a host listbox (aria-selected then follows `selected`), 'none'. The
      slots never carry a role. */
  role?: string;
  /** The DOM id, for a host listbox's aria-activedescendant. */
  domId?: string;
  /** Overrides the tab stop: a host with a roving tab stop passes -1 to
      every row but its current one. Default 0 for a clickable row. */
  tabIndex?: number;
  /** A click on the row (with the event), or Enter or Space typed on the
      row itself (with no event), never from its trailing controls. */
  onClick?: (event?: MouseEvent<HTMLElement>) => void;
  /** Right-click (desktop): call event.preventDefault() to open the
      host's own menu. */
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
  className?: string;
  /** The row element (the button with `as="button"`): a Tooltip's
      anchor, a host's focus or scroll target. */
  ref?: Ref<HTMLElement>;
  /** The id of an element that describes it (a Tooltip's tip). */
  'aria-describedby'?: string;
  /** Hover in and out, a press, focus and blur, on the row element: what
      a Tooltip wires on its trigger (`<Tooltip><ListItem/></Tooltip>`). */
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
}

/**
 * A bordered box with a 40px heading row (heading, count, actions) over
 * its body: a section embedded in another surface (the Overseer's
 * columns, an impact summary, the first-task guide card). The host's
 * data-* hooks land on the root.
 */
export interface PanelProps extends DataAttributes {
  /** The heading at the left of the heading row (13.5px, medium). No
      heading row without a heading, a count or actions. */
  heading?: ReactNode;
  /** A quiet count after the heading, in tabular figures (outside the
      heading element, so the heading's name stays its words). */
  count?: number;
  /** Chips or quiet Buttons at the right end of the heading row. */
  actions?: ReactNode;
  /** A status tone: data-tone on the root and a 2px edge in the tone's
      hue at the left, nothing else (the heading's words say it). Default
      draws none. */
  tone?: UiTone;
  /** The floating card (--shadow-pop): only for a panel that floats over
      the page, such as the first-task guide. */
  floating?: boolean;
  /** No padding and no gap in the body: for a list whose rows pad
      themselves (PanelRow, ListItem). */
  flush?: boolean;
  /** The root element. Default 'section'. */
  as?: 'section' | 'div';
  /** The heading element. Default 'h3'. */
  headingLevel?: 'h2' | 'h3';
  className?: string;
  children: ReactNode;
}

/**
 * A row inside a Panel, divided from the next by the divider colour.
 * With `onActivate` the whole row is a `div role="button"` (so the
 * buttons it holds stay valid HTML), focusable, and activated by a click
 * or by Enter or Space typed on the row itself. The rest of the props go
 * to the `<div>`.
 */
export interface PanelRowProps
  extends DataAttributes, Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  children: ReactNode;
  /** Needs attention first: a 2px warning edge (data-tone="warning") and
      a word that says why (`urgentLabel`, or an sr-only "Urgent"). */
  urgent?: boolean;
  /** The visible word an urgent row leads with, in the tone's ink
      ("Failed", "Needs you"). Without it the row says "Urgent" to
      assistive tech only, so its own words must say it on screen. */
  urgentLabel?: string;
  /** Makes the row a button: a click (not one on a control inside it),
      or Enter or Space typed on the row itself. */
  onActivate?: () => void;
  ref?: Ref<HTMLDivElement>;
}

/* ---- stats ------------------------------------------------------------- */

/** A cell's `data-*` hooks land on its `<li>` (Dispatch's
 * `data-slot="flight-stat"`), beside the cell's own `data-tone`. */
export interface StatCell extends DataAttributes {
  id: string;
  label: string;
  /** Rendered in tabular figures. */
  value: ReactNode;
  note?: string;
  /** A 14px icon before the label (Gr8r's stat key), e.g. a lucide icon
   * at strokeWidth 1.8; decorative. */
  icon?: ReactNode;
  /** The value and note's colour: a status tone for a status count
   * (overdue milestones = danger, at risk = warning), accent for new /
   * unread, muted = quiet. */
  tone?: UiTone;
  /** Makes the cell a link (Gr8r stat cards navigate to the filtered list). */
  href?: string;
  /** A hover hint over the whole cell (the `<li>`'s title), for what the
   * number counts or how it was worked out ("Queued: waiting for a free
   * slot"). Pointer-only, so the same fact must also be in words somewhere
   * a keyboard reaches (the label, the note, or the page). */
  title?: string;
}

/** The host's `data-*` hooks land on the `<ul>` (Dispatch's
 * `data-slot="live-header"`). */
export interface StatsStripProps extends DataAttributes {
  cells: StatCell[];
  /** Accessible name of the strip. */
  label?: string;
  /** panel (default): the rounded panel of cells, a 22px value under each
   * key, four across (two on phones). compact: a page header's one-row
   * strip (Live, Flight Plan) with no panel: each cell's icon, key, value
   * and note inline on a 26px row, cells parted by soft rules, a meter
   * value (ProgressRule) 120px wide. The cells never wrap: when the column
   * is too narrow the strip scrolls sideways inside itself, fading the
   * edges that hide cells, and takes a tab stop (a group named
   * "<label>, scrolls sideways") only while it does. Same list, terms and
   * tones as the panel. */
  variant?: 'panel' | 'compact';
  /** compact only (the panel ignores it): the header's own controls (Pause
   * all, a slots picker, Stop), drawn at the end of the strip's row, right
   * aligned, outside the list. They wrap under the strip only when a 12rem
   * strip and the controls cannot share the row. */
  end?: ReactNode;
}

/* ---- the grouped task table -------------------------------------------- */

/** Linear's state types. */
export type TaskStateKind =
  | 'triage'
  | 'backlog'
  | 'unstarted'
  | 'started'
  | 'completed'
  | 'canceled';

/** Linear's priority scale: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export type TaskPriority = 0 | 1 | 2 | 3 | 4;

/** Optional meta columns; the key + title column is always shown. */
export type TaskColumnId =
  | 'project'
  | 'state'
  | 'priority'
  | 'due'
  | 'assignee'
  | 'milestone';

export interface TaskChipData {
  label: string;
  tone?: ChipTone;
  /** A status tone drawn as Gr8r's tinted badge (Chip `filled`): for the
      stronger claims, such as Blocked (architecture §8.2). */
  filled?: boolean;
}

export interface TaskRowData {
  id: string;
  /** Issue identifier, e.g. "ATL-142" (Geist Mono: an id). */
  key: string;
  title: string;
  /** Where the row opens. Omit and pass onOpenRow for a callback-only row. */
  href?: string;
  /** Opens in a new tab (e.g. straight to Linear). */
  external?: boolean;
  /** A second, separate link after the title, drawn as a small ↗ icon
   * that opens in a new tab (the issue in the tracker, while the title
   * opens the host's own view). */
  externalHref?: string;
  /** Accessible name of that icon link ("Open ATL-142 in Linear").
   * Default "Open {key} in a new tab". */
  externalLabel?: string;
  project?: string;
  /** Human state name, e.g. "In Progress". */
  state: string;
  stateKind: TaskStateKind;
  priority: TaskPriority;
  /** e.g. "Urgent", "No priority". */
  priorityLabel: string;
  /** Short due label, e.g. "Oct 23". */
  due?: string;
  dueTone?: UiTone;
  /** The due date's state in a word ("Overdue", "Tomorrow"), printed under
      the date in its voice and tone (beside it on a stacked card), so a
      toned date never says its state by colour alone. Ignored without
      `due`. */
  dueNote?: string;
  chips?: TaskChipData[];
  /** The assignee column's name, beside its round InitialsAvatar; null
      (or absent) reads "Unassigned" beside the dashed empty avatar. */
  assignee?: string | null;
  /** The "Unassigned" placeholder's tone: warning (amber) when the issue
      needs a person (open, in an active project); muted by default. */
  assigneeTone?: UiTone;
  /** The words for no assignee, default "Unassigned". Give a toned
      placeholder its own words ("Needs assignee"), so its hue repeats a
      word instead of being the only difference. */
  unassignedLabel?: string;
  /** The milestone column's name ("Dual-write"); null (or absent) reads
      "No milestone", muted. */
  milestone?: string | null;
  /** The milestone's project, drawn muted after the name and cut first
      when the cell is narrow ("Dual-write · Atlas billing migration").
      Leave it out where the group or section already names the project. */
  milestoneProject?: string;
  /** A closed issue: the title muted, with a strike-through. */
  done?: boolean;
  /** A change to this row is in flight: the row takes the hover fill
      (and is marked aria-busy) while `note` says what is happening
      ("Moving to Dual-write…"). */
  pending?: boolean;
  /** A short line after the title: what is happening to the row, or why
      a change did not happen ("Not moved · …": danger, as every "Not
      saved"). Any tone but default and muted draws the line in its TEXT
      colour. */
  note?: { text: string; tone?: UiTone };
  /** A sub-issue nested under the row before it: its title cell (key and
      title) moves in by one 20px step per level (`data-indent` on the
      row), the grid columns stay where they are, and the row's name and
      words are unchanged (the nesting is layout, kept in forced colours).
      Dispatch nests sub-tasks one level under their parent. 0 and absent
      are the same. */
  indent?: 0 | 1 | 2;
}

export interface TaskGroupProgress {
  done: number;
  total: number;
  /** ProgressRule's tone: danger overdue, warning behind pace, success
   * complete, default otherwise. */
  tone?: UiTone;
}

export interface TaskGroupData {
  id: string;
  /** The project before the title (Project / Milestone), in secondary
      text. */
  eyebrow?: string;
  /** The group's name, typically the milestone. */
  title: string;
  /** Opens the milestone (drawer, timeline). */
  href?: string;
  status?: UiStatus;
  statusLabel?: string;
  /** e.g. "Oct 19". */
  dueLabel?: string;
  /** e.g. "2 days overdue", "5 days left". */
  daysLeftLabel?: string;
  dueTone?: UiTone;
  progress?: TaskGroupProgress;
  /** Drawn quietly (e.g. a paused project's milestone): the status mark in
   * greys, and the due date and progress never in a status hue or the
   * accent, whatever dueTone and progress.tone say. */
  muted?: boolean;
  /** The rows shown (in order). May be fewer than `count`. */
  rows: TaskRowData[];
  /** Every matching row, shown or not: the header's count (and the
   * section's). Defaults to rows.length. */
  count?: number;
  /** A glyph drawn where the status mark goes (a state, priority or avatar
   * mark of the edit family) for groups that are not milestones. */
  mark?: PickerMark;
  /** Small pills after the title ("Next", "↑2"). */
  tags?: string[];
  /** A small line under the heading, in amber (as the checklist draws a
   * missing input, architecture §8.2): an input the group is missing
   * ("Missing: done means…", "No lead"). */
  missingLabel?: string;
  /** A footer row after the rows ("Showing 12 of 212") with host actions
   * ("Show more", "Only this milestone"). Drawn while the group is open. */
  footer?: {
    text: string;
    actions: { label: string; onActivate: () => void; disabled?: boolean }[];
  };
  /** The body when there are no rows. Default "No open issues". A group
   * with no rows and a footer shows only the footer (it says what the
   * group holds: "212 issues not shown · Show more"). */
  emptyLabel?: string;
  /** With TaskGroupTableProps.drag: false = never a drop target (the table
   * does not ask drag.canDrop and shows nothing while a row is dragged
   * over it). Default: every group is asked. */
  droppable?: boolean;
  /** A "+" icon button at the end of the header (before the groupActions
   * slot) that adds a row here ("New task in Dual-write"): `addLabel` is
   * its accessible name and tooltip, `onAdd` what a click does. Both or
   * neither. Verbs that act on the group (Send agents…, Pause, Land) go
   * through TaskGroupTableProps.groupActions as the host's "…" menu, so
   * every header keeps one quiet control however many verbs apply. */
  addLabel?: string;
  onAdd?: () => void;
}

export interface TaskSectionData {
  id: string;
  /** Divider label, e.g. "This week", "Later", "No milestone". Without
   * one no divider is drawn (a list with a single, unnamed section). */
  label?: string;
  /** Quiet note after the label; defaults to the issue count. */
  note?: string;
  /** Said when the section has no groups; defaults to "Nothing in this
   * section". */
  emptyLabel?: string;
  groups: TaskGroupData[];
}

export interface TaskGroupTableProps {
  sections: TaskSectionData[];
  /** Visible meta columns in order. Default: project, state, priority, due. */
  columns?: TaskColumnId[];
  /**
   * Columns that give way, first to last, when the table is too narrow to
   * show them beside a readable title (at least 260px): the table steps
   * at 1160, 1000 and 860px of its own width, dropping as few of these as
   * that step needs; below 720px rows become cards with every column, as
   * without it. Without it no column drops (My week's few columns fit).
   */
  dropColumns?: readonly TaskColumnId[];
  /** Header wording; defaults: Issue / Project / State / Priority / Due. */
  columnLabels?: Partial<Record<TaskColumnId | 'title', string>>;
  /** Accessible name of the table. */
  label?: string;
  /** Heading level of the section dividers; group titles sit one below.
   * Default 3 (under a page h1 and a block h2). */
  headingLevel?: 2 | 3 | 4 | 5;
  /** Persist collapsed group ids under this storage key. */
  storageKey?: string;
  /** localStorage (default) survives restarts; session suits a desktop app. */
  storage?: 'local' | 'session';
  /** Groups collapsed when nothing is stored. */
  defaultCollapsed?: string[];
  /** Shown when there are no groups at all. */
  emptyMessage?: ReactNode;
  /** Plain click / ↵ on a row. Without it the row's link navigates. */
  onOpenRow?: (row: TaskRowData, group: TaskGroupData) => void;
  /** ↵ / click on a group title. Without it the group's link navigates. */
  onOpenGroup?: (group: TaskGroupData) => void;
  onToggleGroup?: (groupId: string, collapsed: boolean) => void;
  /** The row the host has open (in a drawer, a detail pane): it takes the
   * accent tint and bar (Gr8r's selected row) and is marked aria-current. */
  activeRowId?: string;
  /** Keys on a focused row that the table's own model leaves alone,
   * modified keys included: lets a host layer single-key commands
   * (Dispatch's s / p / a / m / d, Space, o, ⌘C) without owning focus.
   * Rows are mounted lazily above `windowAbove`: act on the `row` and
   * `group` given, never on a row element kept from an earlier call.
   * The table keeps ↑/↓, j/k, Home/End and ← (and with `selection` x,
   * Shift+↑/↓ and ⌘/Ctrl+A); everything else reaches this first, Enter
   * and Space included: Enter then activates the row's link or button
   * (onOpenRow) unless the host calls event.preventDefault(), and Space
   * would scroll the page (or press a callback-only row's button), so a
   * host that binds it prevents it too. Keys typed into a host control in
   * a row (a cell picker) never arrive. */
  onRowKeyDown?: (
    event: KeyboardEvent<HTMLElement>,
    row: TaskRowData,
    group: TaskGroupData
  ) => void;
  /** Turns on selection: a checkbox per row, a tri-state one per group
   * header and in the column header, shift-click ranges, `x`, Shift+↑/↓
   * and ⌘/Ctrl+A. The host owns the set (see task-selection.ts). Rows in
   * folded groups are not shown, so they leave the selection. */
  selection?: TaskSelectionProps;
  /** Replaces a meta cell's value with a host control (a picker trigger,
   * appearance 'cell'). Return undefined to keep the plain value. */
  renderCell?: (
    column: TaskColumnId,
    row: TaskRowData,
    group: TaskGroupData
  ) => ReactNode | undefined;
  /** A trailing 40px cell per row (its "…" menu). */
  rowActions?: (row: TaskRowData, group: TaskGroupData) => ReactNode;
  /** Right-click on a row (desktop): call event.preventDefault() to open
   * the host's own menu instead of the browser's. */
  onRowContextMenu?: (
    event: MouseEvent<HTMLElement>,
    row: TaskRowData,
    group: TaskGroupData
  ) => void;
  /** A slot at the end of each group header (its "…" menu). */
  groupActions?: (group: TaskGroupData) => ReactNode;
  /** Drag rows onto groups (desktop, fine pointers only): an 18px grip
   * per row. Dragging a selected row drags the whole selection. There is
   * no reordering: a drop targets a group, never a position. */
  drag?: TaskDragProps;
  /** The element the table scrolls in, for row windowing: an element, a
   * function returning it (read when windowing starts; keep it stable), or
   * 'window' for the document's own scroll. Default: the nearest ancestor
   * with overflow-y auto or scroll, found in an effect, else the window. */
  scrollParent?: TaskScrollParent;
  /** Above this many rows in total (folded groups included) only the rows
   * near the viewport are mounted, per group, with gaps of their measured
   * height standing for the rest; at or below it every row is drawn.
   * Default 150. Rows are then mounted lazily: a host must not cache row
   * elements, and a key that lands on an unmounted row scrolls it into
   * view and focuses it once it mounts. */
  windowAbove?: number;
}

/** Where a windowed table scrolls (TaskGroupTableProps.scrollParent). */
export type TaskScrollParent =
  | HTMLElement
  | (() => HTMLElement | null)
  | 'window';

export interface TaskSelectionProps {
  selected: ReadonlySet<string>;
  /** The complete new set after each change. */
  onChange: (next: ReadonlySet<string>) => void;
  /** Selection mode on a touch screen: a plain click on a row toggles it
   * instead of opening it (the title is then a checkbox button named by
   * the title, its state the selection, not a link). */
  toggleOnClick?: boolean;
  /** Hide the checkboxes on touch screens and phones ((pointer: coarse),
   * (width <= 640px)) in CSS, so the server's markup and the hydrated
   * page agree; the host turns this off in its own selection mode (a
   * Select button). Rows keep their selected accent tint either way. */
  hideOnTouch?: boolean;
}

export interface TaskDragProps {
  /** true when dropping these rows on the group would do something, or
   * the reason it would not (shown as the group's title while dragging). */
  canDrop: (rowIds: readonly string[], groupId: string) => true | string;
  onDrop: (rowIds: readonly string[], groupId: string) => void;
  /** The drag image's text, e.g. n => `${n} issues`. */
  label: (count: number) => string;
}

/* ---- search field, copy value ------------------------------------------ */

/**
 * A search box: a native `type="search"` input named by `label`, a leading
 * magnifier, and a quiet "Clear search" button while it holds text.
 */
export interface SearchFieldProps extends DataAttributes {
  value: string;
  /** Every keystroke, and '' when the field is cleared. */
  onChange: (value: string) => void;
  /** Accessible name of the field ("Search settings"). */
  label: string;
  placeholder?: string;
  /** The clear button's accessible name. Default "Clear search". */
  clearLabel?: string;
  /** Escape in a non-empty field clears it and stops there
      (preventDefault and stopPropagation); in an empty field Escape is
      left alone, so it reaches the page (a second Escape closes Settings).
      Default true. */
  escapeClears?: boolean;
  /** The input, for a host's own shortcut (`/` or ⌘F focuses it). */
  inputRef?: Ref<HTMLInputElement>;
  /** sm 26px (a toolbar's), md 30px (the default). */
  size?: 'sm' | 'md';
  /** The search is final: Enter (not while an IME is composing), leaving
      the field, and a clear (the button or Escape). Enter is kept from
      submitting a surrounding form only when this is set. */
  onCommit?: (value: string) => void;
  /** Draw the clear button while the field holds text. Default true;
      false leaves the browser's own clear control (ViewToolbar). */
  clearable?: boolean;
}

/**
 * A value to copy (a token, a pairing code, an invite link) shown in a
 * recessed code well, with a Copy button that says Copied for COPIED_MS,
 * or "Select it" when the clipboard is refused.
 */
export interface CopyValueProps extends DataAttributes {
  /** The text shown and copied. */
  value: string;
  /** What it is, for the button's name: "Copy {label}" ("Copy token"). */
  label: string;
  /** Geist Mono, for a machine-read string (the default). False for a
      value people read (an address said aloud). */
  mono?: boolean;
  /** One line with an ellipsis, the whole value in the title. Default
      false: a long value wraps, so all of it can be read and selected. */
  truncate?: boolean;
}

/* ---- code block -------------------------------------------------------- */

/**
 * One run of a highlighted line: its text, and the custom properties a
 * host's stylesheet colours it from (a highlighter's per-theme colours,
 * such as `--shiki-light` and `--shiki-dark`). CodeBlock sets no colour of
 * its own: the run is a `[data-code-token]` span carrying `vars` as its
 * inline style, and the host's sheet reads them.
 */
export interface CodeBlockToken {
  content: string;
  vars?: Readonly<Record<`--${string}`, string>>;
}

/**
 * A block of code or machine output (a Markdown fence, a tool call's JSON)
 * in a recessed Geist Mono well, with an optional header naming the file
 * and the language, host controls and a quiet Copy button. No colour of
 * its own: syntax colour comes only from a host's highlighter, through
 * `tokens`. A host's `data-*` hooks land on the root.
 */
export interface CodeBlockProps extends DataAttributes {
  /** The text shown and copied, exactly; split on newlines into lines. */
  code: string;
  /** A display label in the header ("TypeScript", "json"). Only a label:
      nothing is tokenized or coloured by it. */
  language?: string;
  /** The file the code comes from, in the header in Geist Mono. */
  filename?: string;
  /** Draw the Copy button. Default true. */
  copy?: boolean;
  /** The Copy button's accessible name. Default "Copy code". */
  copyLabel?: string;
  /** Caps the body's height; it scrolls inside past it. A number means
      px; a string is any CSS length ("50vh"). */
  maxHeight?: number | string;
  /** Wrap long lines instead of scrolling sideways. Default false. */
  wrap?: boolean;
  /** `code` as the host's highlighter split it: one array of runs per
      line. Drawn only when it holds exactly the lines the block draws and
      each line's runs join to that line's text; otherwise the plain lines
      are. */
  tokens?: ReadonlyArray<ReadonlyArray<CodeBlockToken>>;
  /** Host controls in the header, before Copy (a wrap toggle, a switch
      between the code and a diagram drawn from it). */
  actions?: ReactNode;
  /** Drawn in place of the code (a diagram drawn from it). The header and
      Copy stay, and Copy still writes `code`. */
  children?: ReactNode;
  className?: string;
}

/* ---- list toolbar, filter chips, bulk bar ------------------------------ */

export interface ViewToolbarSearch {
  value: string;
  /** Every keystroke (a host may debounce before acting). */
  onChange: (value: string) => void;
  /** Enter, or leaving the field: the search is final. */
  onCommit?: (value: string) => void;
  placeholder: string;
  /** Accessible name of the field ("Search issues"). */
  label: string;
  /** The field, for a host's own shortcut (`/` focuses the search). */
  inputRef?: Ref<HTMLInputElement>;
}

export interface ViewToolbarProps {
  /** The search field at the left edge. Omit it for a toolbar of controls
      only, on a page people scan down a column rather than search (Runs,
      Usage): the controls then start at the left edge. */
  search?: ViewToolbarSearch;
  /** Filter / Sort / Group triggers (host pickers), left to right. */
  controls: ReactNode;
  /** Trailing actions at the right edge ("Open as graph", "Copy link"). */
  end?: ReactNode;
  /** A view change is loading: a 2px accent progress line under the bar,
   * and the region is marked aria-busy. */
  busy?: boolean;
  /** Accessible name of the toolbar. Default "View options". */
  label?: string;
}

export interface FilterChipData {
  id: string;
  /** A 12px icon before the field name. */
  icon?: ReactNode;
  /** The field's name: "Project". */
  field: string;
  /** The values: "Atlas billing migration, Beacon search" or
   * "3 projects". Read after "is". */
  summary: string;
  /** A value the host does not know ("Not found"): the chip is tinted
   * amber (a missing input), its summary in the amber text. */
  unknown?: boolean;
  /** Wraps the chip's face in the host's picker, so a click on the chip
   * reopens its values (the face becomes the picker's trigger). Without
   * it the face is plain text. */
  renderEditor?: (face: ReactNode) => ReactNode;
  onRemove: () => void;
  /** Accessible name of the × button ("Remove project filter"). */
  removeLabel: string;
}

export interface FilterChipsProps {
  chips: FilterChipData[];
  /** A trailing control after the chips ("+ Filter"). */
  add?: ReactNode;
  /** Shows "Clear all" at the far right. */
  onClearAll?: () => void;
  /** The filters are already the default: Clear all is disabled. */
  clearDisabled?: boolean;
  /** "Clear all" by default. */
  clearLabel?: string;
  /** Accessible name of the bar. Default "Filters". */
  label?: string;
}

export interface BulkBarConfirm {
  /** "Move 24 issues to Garnet mobile app › Push notifications? …" */
  message: string;
  /** The primary button: "Move 24 issues". */
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** "Cancel" by default. */
  cancelLabel?: string;
}

export interface BulkBarProps {
  /** How many rows are selected. The bar renders nothing at 0. */
  count: number;
  /** Default "{count} selected". */
  countLabel?: string;
  /** The action triggers (host pickers with appearance 'bar'). */
  children: ReactNode;
  /** Clears the selection: the ✕ button, and Esc anywhere in the bar.
   * The bar then unmounts, so the host returns focus to the list (the
   * last focused row). */
  onClear: () => void;
  /** The ✕ button's accessible name. Default "Clear selection". */
  clearLabel?: string;
  /** A change is being sent ("Moving 12 issues…"): shown in place of the
   * actions, which are disabled. */
  busy?: string | null;
  /** A sentence after the actions that also disables them ("At most 100
   * at a time (312 selected)."). */
  note?: string | null;
  /** An inline confirmation that replaces the actions; focus moves to its
   * primary button, and Cancel brings the actions back. */
  confirm?: BulkBarConfirm | null;
  /** Accessible name of the toolbar. Default "Actions for {count}
   * selected issues". */
  label?: string;
}

/* ---- deadlines --------------------------------------------------------- */

export interface DeadlineItem {
  id: string;
  label: string;
  /** Quiet line under the label, e.g. "3 open · Atlas billing migration". */
  sublabel?: string;
  href: string;
  status: UiStatus;
  statusLabel: string;
  dueLabel: string;
}

export interface DeadlineGroup {
  id: string;
  /** Today / Tomorrow / This week / Overdue. */
  label: string;
  /** The label's colour: danger for Overdue (when it holds something),
   * warning for Today / Tomorrow when they hold something. */
  tone?: UiTone;
  items: DeadlineItem[];
}

export interface DeadlineListProps {
  groups: DeadlineGroup[];
  /** Items shown per group before "+N more". Default 4. */
  limit?: number;
  /** Shown under a group with no items (every group is always shown).
      Default "Nothing due". */
  emptyLabel?: string;
  /** Accessible name. */
  label?: string;
  /** Heading level of the group labels. Default 3. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
}

/* ---- registers --------------------------------------------------------- */

export interface RegisterColumn {
  id: string;
  label: string;
  align?: 'start' | 'end';
}

export interface RegisterProps extends DataAttributes {
  /** CSS grid-template-columns shared by the header and every row. */
  columns: string;
  /** Optional header row; cells then hide their own labels on desktop. */
  header?: RegisterColumn[];
  /** Accessible name of the list. */
  label: string;
  children: ReactNode;
  /** Rows stack into cards below this viewport width (px). Default 900. */
  stackBelow?: 700 | 900;
  /** Stack by the register's own width instead of the viewport's: rows
   * become cards while the register is narrower than this (px). Use it
   * inside a sidebar shell, where the content column is far narrower than
   * the window, or for a wide (many-column) register. Pick the smallest
   * step the columns' minimum widths fit in (tracks, 20px gaps and 28px of
   * padding), so a narrow register (three or four short columns in a
   * settings page) stays a table at the app's default window size: 480
   * and 600 for those, 700 to 1000 for wide ones. Overrides stackBelow. */
  stackWithin?: 480 | 600 | 700 | 900 | 1000;
  /** grid-template-columns of a stacked card; the first cell (the row's
   * subject) spans the full width. Default two equal columns. */
  stackedColumns?: string;
  /** Opt-in row windowing for a long register (Runs' "Show all"): above
   * `windowAbove` rows only the rows near the scroll viewport (about eight
   * rows of overscan each side, plus the focused row) are mounted, the
   * rest standing as `<li role="presentation" aria-hidden data-row-gap>`
   * gaps of their measured height, and each mounted row carries
   * aria-posinset / aria-setsize. Each child must be one keyed element
   * that renders one RegisterRow (the key is the row's id, set on its
   * `<li>` as data-row-id exactly as written, `:` and `=` included). The
   * browser's find-in-page cannot reach rows that are not mounted, so a
   * windowed register wants a filter of its own. Default false: every row
   * is drawn, exactly as before. */
  windowed?: boolean;
  /** With `windowed`: windowing starts above this many rows; at or below
   * it every row is drawn. Default 150. */
  windowAbove?: number;
  /** With `windowed`: the element the register scrolls in, a function
   * returning it (keep it stable), or 'window'. Default the nearest
   * ancestor with overflow-y auto or scroll, else the window. */
  scrollParent?: TaskScrollParent;
}

interface RegisterRowCommonProps extends DataAttributes {
  /** The row's tone, as data only (`data-tone`): Gr8r draws no row rule,
   * so a row that needs attention (warning: allocation blocked, unassigned
   * issues; danger: overdue, failed) says so with a tinted Chip or a toned
   * cell. muted steps the row's subject back (an inactive project). */
  tone?: UiTone;
  /** The row the host has open: the accent tint with a 2px accent bar
   * inside its left edge (a Highlight outline in forced colours). */
  selected?: boolean;
  /** A hover hint over the whole row (the `<li>`'s title), for a qualifier
   * that is not worth a column ("this machine only"). Pointer-only, so the
   * same fact must also be in words somewhere a keyboard reaches. */
  title?: string;
  children: ReactNode;
}

/** The whole row is a link (stretched) and keyboard-focusable. */
export interface RegisterLinkRowProps extends RegisterRowCommonProps {
  href: string;
  external?: boolean;
  onActivate?: undefined;
  /** Accessible name of the row's link: the stretched target has no text
   * of its own, so it is required. */
  rowLabel: string;
  pressed?: undefined;
}

/** Callback row: the whole row is a button. */
export interface RegisterButtonRowProps extends RegisterRowCommonProps {
  href?: undefined;
  external?: undefined;
  onActivate: () => void;
  /** Accessible name of the row's button (required, as for links). */
  rowLabel: string;
  /** The row is a toggle (a filter row): aria-pressed on its stretched
      button. Omit for a plain action. */
  pressed?: boolean;
}

/** A plain row (settings): its controls live in the cells. */
export interface RegisterPlainRowProps extends RegisterRowCommonProps {
  href?: undefined;
  external?: undefined;
  onActivate?: undefined;
  rowLabel?: undefined;
  pressed?: undefined;
}

export type RegisterRowProps =
  | RegisterLinkRowProps
  | RegisterButtonRowProps
  | RegisterPlainRowProps;

export interface RegisterCellProps extends DataAttributes {
  /** The cell's own label in the column-header voice (12px, medium,
   * `--text-3`), above the value; visually hidden under a header row until
   * the rows stack, and always readable to assistive tech. */
  label?: string;
  /** name = the row's subject (13.5px, medium), value = body copy, mono =
   * short facts (states, counts, dates) in Geist with tabular figures, one
   * step smaller and quieter (the name is historical: no mono face). */
  variant?: 'name' | 'value' | 'mono';
  /** The secondary line under the value (12px, `--text-2`, tabular). */
  sub?: ReactNode;
  /** The value's colour: accent for new, a status tone for a status
   * ("Blocked" warning, "Failed" danger), muted for quiet. The sub line
   * stays muted unless `toneSub` is set. */
  tone?: UiTone;
  /** The sub line takes the tone too (any tone but default and muted).
   * Only for a line that is the status's reason and the point of the
   * cell, e.g. a blocked project's "Project has no lead" under Blocked;
   * a plain detail under a coloured value stays muted. */
  toneSub?: boolean;
  align?: 'start' | 'end';
  /** row = the cell takes the whole row (every column, in the table and
   * in the stacked card layout), on its own line under the cells before
   * it: an answer-in-place card inside a row. */
  span?: 'row';
  children?: ReactNode;
}
