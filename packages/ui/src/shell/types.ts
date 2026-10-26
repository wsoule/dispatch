import type { ComponentType, ReactNode } from 'react';

import type { UiStatus, UiTone } from '../types';

// Prop vocabulary of the shell family (app frame, command palette, toasts,
// slide-over, skeletons). Plain data plus callbacks only: hosts (the
// planner's Next layout, Dispatch's Vite shell) map their own models onto
// these shapes, so nothing here knows about milestones or Linear.

/** Props the shell passes to an icon component (lucide-react compatible). */
export interface ShellIconProps {
  size?: number | string;
  strokeWidth?: number | string;
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}

/**
 * An icon: a component the shell renders at its own size (a lucide icon such
 * as `CalendarCheck`), or a ready node (`<CalendarCheck />`, an inline SVG).
 * Server-rendered hosts must pass a node: a component is a function and
 * cannot cross the server/client boundary. Either way the shell draws it at
 * 16px (19px in the phone tab bar) with a 1.8 stroke.
 */
export type ShellIcon = ComponentType<ShellIconProps> | ReactNode;

/** One primary-nav row in the sidebar. */
export interface ShellNavItem {
  id: string;
  label: string;
  href: string;
  icon: ShellIcon;
  /** Right-aligned count, e.g. this week's open issues. Hidden when 0. */
  count?: number;
  /** Spoken after the label instead of the bare number ("4 issues this week"). */
  countLabel?: string;
  /** A tone turns the count into a Gr8r badge (docs/architecture.md
   * §8.2): `accent` (new, unread) the solid accent pill, a status tone
   * (danger, warning, success, info) its tinted pill, e.g. warning for "2
   * projects blocked". Unset, `default` or `muted`: a quiet number. */
  countTone?: UiTone;
  current?: boolean;
  /** Display-only key sequence shown on hover, e.g. ['G', 'W']. */
  shortcut?: string[];
}

/** One row in a titled sidebar section (e.g. a project and its status). */
export interface ShellSectionItem {
  id: string;
  label: string;
  href: string;
  status: UiStatus;
  /** Human wording of the status, read by assistive tech ("At risk"). */
  statusLabel: string;
  current?: boolean;
}

/** A titled list under the primary nav, e.g. Projects (its title is
    drawn as a small uppercase eyebrow). */
export interface ShellSection {
  id: string;
  title: string;
  items: ShellSectionItem[];
  /** Shown when `items` is empty ("No active projects"). */
  emptyLabel?: string;
  /** A small link beside the title ("All" → /projects). */
  action?: { label: string; href: string };
}

/** One breadcrumb in the topbar. The last one is the current page. */
export interface ShellCrumb {
  label: string;
  href?: string;
}

/** A cell of the phone bottom tab bar. A final "More" cell is added. */
export interface ShellTab {
  id: string;
  label: string;
  href: string;
  icon: ShellIcon;
  current?: boolean;
}

export interface ShellUser {
  name: string;
  /** Short badge beside the name ("Guest"). */
  badge?: string;
  href?: string;
}

/** Sign out as a real form post, so it works before (or without) JS (a
    server-rendered host with a logout route). */
export interface ShellSignOutForm {
  action: string;
  method: 'post';
  label?: string;
}

/** Sign out as a callback (a desktop host with no logout URL): the same
    button, `type="button"`, calling `onSignOut`. */
export interface ShellSignOutAction {
  onSignOut: () => void;
  label?: string;
}

/** Either shape; `isSignOutForm` tells them apart (an `in` check, which
    narrows without strictNullChecks, as a host compiles this source). */
export type ShellSignOut = ShellSignOutForm | ShellSignOutAction;

export function isSignOutForm(
  signOut: ShellSignOut
): signOut is ShellSignOutForm {
  return 'action' in signOut;
}

export interface ShellSettingsLink {
  href: string;
  label?: string;
  current?: boolean;
}

export interface AppShellProps {
  /** Product name in the brand row ("Milestone Planner"). */
  appName: string;
  /** Workspace name under the product name in the brand row. */
  workspaceName?: string;
  brandHref: string;
  nav: ShellNavItem[];
  sections?: ShellSection[];
  settings?: ShellSettingsLink;
  user?: ShellUser;
  signOut?: ShellSignOut;
  /** Renders the theme toggle; must match the key given to themeScript(). */
  themeStorageKey?: string;
  /** Extra footer content above the user row. */
  footer?: ReactNode;
  crumbs?: ShellCrumb[];
  /** Controls placed right of the search trigger. */
  topbarActions?: ReactNode;
  /** Opens search. Defaults to the CommandPaletteProvider's open(); the
      trigger is hidden when neither exists. */
  onSearch?: () => void;
  /** Label of the search trigger. */
  searchLabel?: string;
  /** Strip above the content (e.g. the demo-mode notice). */
  banner?: ReactNode;
  /** Phone bottom tab bar cells; "More" (opens the drawer) is appended. */
  tabs?: ShellTab[];
  moreLabel?: string;
  /** localStorage key remembering the collapsed rail; pair it with
      sidebarCollapseScript() to avoid a flash on load. */
  storageKey?: string;
  defaultCollapsed?: boolean;
  /** Bind "[" on the document to collapse or expand the sidebar and list
      it in the palette's shortcuts sheet (default true). False for a host
      that owns "[" itself (Dispatch binds its own shortcuts): the brand-row
      button still toggles the rail. */
  sidebarShortcut?: boolean;
  /** Attributes spread onto the brand row and the topbar, the shell's
      window chrome: a Tauri host passes `{ 'data-tauri-drag-region': '' }`
      so dragging either moves the window. */
  chromeAttributes?: Record<string, string>;
  /** id of the <main> element (the skip link's target). */
  mainId?: string;
  children?: ReactNode;
}

export interface SignedOutFrameProps {
  appName: string;
  brandHref: string;
  /** Quiet label beside the brand ("Demo"). */
  label?: string;
  themeStorageKey?: string;
  /** Controls left of the theme toggle. */
  actions?: ReactNode;
  mainId?: string;
  children?: ReactNode;
}

/** One entry of the command palette. */
export interface PaletteItem {
  id: string;
  label: string;
  /** Matched too: an identifier ("ATL-142") or context ("Atlas · M3"). */
  hint?: string;
  /** Group heading ("Suggestions", "Jump to", "Navigation"). */
  section: string;
  /** Followed through the provider's navigate() when selected. */
  href?: string;
  /** Runs when selected; wins over href. */
  onSelect?: () => void;
  /**
   * Key sequence, e.g. ['G', 'W']. One or two plain keys register a global
   * shortcut; sequences naming a modifier (Ctrl, ⌘, Shift, Alt) are shown
   * but not registered.
   */
  shortcut?: string[];
  status?: UiStatus;
  statusLabel?: string;
  /** Draw the status mark in greys (e.g. a paused project's milestone,
   * which is never loud); statusLabel still names the status. */
  statusMuted?: boolean;
  icon?: ShellIcon;
}

/** A row of the "?" shortcuts sheet. */
export interface ShortcutRow {
  label: string;
  keys: string[];
}

export interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

export interface CommandPaletteProviderProps {
  items?: PaletteItem[];
  /** Called once, on first open; its items join the static ones. */
  loadItems?: () => Promise<PaletteItem[]>;
  /** Section order; unlisted sections follow in first-seen order. */
  sectionOrder?: string[];
  /** Client-side navigation for href items (router.push). Defaults to a
      full page load. */
  navigate?: (href: string) => void;
  /** Extra groups for the "?" sheet. */
  shortcutGroups?: ShortcutGroup[];
  placeholder?: string;
  /** Rows shown per section before "keep typing" (default 50). */
  maxPerSection?: number;
  /** Passed to the palette (CommandPaletteProps.refuseQuery). */
  refuseQuery?: (query: string) => string | null;
  /** Passed to the palette (CommandPaletteProps.onSubmitFreeText); the
      palette closes before it runs. */
  onSubmitFreeText?: (query: string) => void;
  /** Passed to the palette (CommandPaletteProps.freeTextLabel). */
  freeTextLabel?: string;
  children?: ReactNode;
}

export type PaletteView = 'palette' | 'shortcuts';

export interface CommandPaletteApi {
  view: PaletteView | null;
  open: () => void;
  openShortcuts: () => void;
  close: () => void;
  toggle: () => void;
  /** Adds rows to the "?" sheet while mounted; returns the remover. */
  registerShortcutGroup: (group: ShortcutGroup) => () => void;
  /**
   * True between the first key of a registered two-key shortcut (G) and
   * the second, within the sequence window (1.2 s). A host's own single-key
   * commands (a list row's `s` or `p`) yield while it is true, so G S and
   * G P still reach the palette with a row focused. React handlers run
   * before the palette's document listener, so the host sees the pending
   * state the first key left behind.
   */
  isSequencePending: () => boolean;
}

export type ToastKind = 'info' | 'error';

export interface ToastInput {
  kind: ToastKind;
  /** One sentence. */
  message: string;
  /** Lead-in word before the sentence ("Synced"); defaults to Info /
   * Error. */
  label?: string;
  action?: { label: string; onClick: () => void };
  /** Milliseconds before auto-dismiss (default 4000; Infinity keeps it). */
  duration?: number;
  /** What screen readers hear in place of `message` (the visible sentence
      stays): e.g. "›" spoken as a comma, or the keyboard way to the
      action ("Press Z to undo."). */
  announce?: string;
  /** Called once when the toast leaves the stack, however it goes (timed
      out, dismissed, its action used, pushed off by newer ones). */
  onClose?: () => void;
}

export interface ToastApi {
  /** Shows a toast and returns its id. */
  toast: (input: ToastInput) => string;
  dismiss: (id: string) => void;
}

export interface SlideOverProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Crumb in the header bar above the title ("Atlas / M3 cutover"). */
  breadcrumb?: ReactNode;
  /** Header buttons placed before the close button. */
  actions?: ReactNode;
  closeLabel?: string;
  /** Receives focus on open instead of the panel itself. */
  initialFocusRef?: { readonly current: HTMLElement | null };
  /** Names what the panel shows (an issue key, a milestone id). A new key
      while open is a swap in place: the body scrolls to the top and focus
      that was in the panel (or fell to <body>) moves to the panel. */
  contentKey?: string;
  children?: ReactNode;
}

export interface PropertyListItem {
  id?: string;
  label: string;
  value: ReactNode;
  icon?: ShellIcon;
}

export interface PropertyListProps {
  items: PropertyListItem[];
  /** Accessible name for the list ("Milestone details"). */
  label?: string;
}

export interface AlertStripAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

export interface AlertStripProps {
  /** Lead-in word before the sentence ("Overdue"). */
  label?: string;
  /** The alert's colour (docs/architecture.md §8.2): danger for overdue,
   * warning for blocked / holds up / stalled / unassigned. Rendered as
   * data-tone, which gives the CSS --tone, --tone-ink, --tone-soft and
   * --tone-line. Default warning. */
  tone?: UiTone;
  /** A row of a neutral list of alerts: no fill and no border (the list
   * draws the box); only the icon and the lead-in carry the tone. */
  plain?: boolean;
  /** The sentence. */
  children: ReactNode;
  /** Follow-up: a link when it has an href, a button when it acts in place. */
  action?: AlertStripAction;
}

/** The palette dialog itself, controlled (mount = open). */
export interface CommandPaletteProps {
  items: PaletteItem[];
  onClose: () => void;
  /** Called with the chosen item; the caller closes and acts. */
  onRun: (item: PaletteItem) => void;
  loading?: boolean;
  /** An inline error with a "Retry loading" option. */
  error?: string | null;
  onRetry?: () => void;
  onShowShortcuts?: () => void;
  placeholder?: string;
  sectionOrder?: string[];
  /** Rows shown per section before "keep typing" (default 50, at least 1). */
  maxPerSection?: number;
  /**
   * A sentence when the typed text must not be used at all (the planner
   * refuses text shaped like a Linear API key): nothing is matched or run,
   * and the sentence shows instead of the results. Null lets it through.
   */
  refuseQuery?: (query: string) => string | null;
  /**
   * Takes the typed text itself (trimmed) as a command: a host that makes
   * a task, or asks an agent, from whatever was typed. While it is given
   * and the query is not blank, Tab (and the footer action in the "Tab
   * Sections" hint's place) submits the text instead of moving to the
   * next section; Shift+Tab still cycles sections, and an empty query
   * keeps Tab's section walk. Refused text (refuseQuery) is never
   * submitted.
   */
  onSubmitFreeText?: (query: string) => void;
  /** The footer action's words for onSubmitFreeText. Default "Use text". */
  freeTextLabel?: string;
}

export interface ShortcutSheetProps {
  groups: ShortcutGroup[];
  onClose: () => void;
}

export interface ToastProviderProps {
  children?: ReactNode;
  /** Accessible name of the stack region (default "Notifications"). */
  label?: string;
}

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  className?: string;
}

export interface SkeletonTextProps {
  lines?: number;
  /** What assistive tech hears while it shows (default "Loading"). */
  label?: string;
}

export interface SkeletonBlockProps {
  height?: number | string;
  label?: string;
}

export interface SkeletonRowsProps {
  rows?: number;
  label?: string;
}

export interface KbdProps {
  children: ReactNode;
  className?: string;
}

export interface KbdKeysProps {
  /** One shortcut: ['G', 'W'] pressed in turn, or ['Ctrl', 'K'] held. */
  keys: readonly string[];
  className?: string;
}
