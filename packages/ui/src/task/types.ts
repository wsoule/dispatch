import type { ReactNode } from 'react';

import type {
  AlertStripAction,
  PropertyListItem,
  ShellCrumb,
  SlideOverProps,
} from '../shell/types';
import type { TaskStateKind } from '../tasks/types';
import type { UiTone } from '../types';

// Prop vocabulary of the "task" family: the detail view of one task (issue)
// and the parts it is built from. Plain data, ReactNode slots and callbacks
// only. The planner fills it read-only (Linear stays the source of truth);
// Dispatch passes its own editors (PropertyControls) as property values and
// slots, so nothing here assumes the task is read-only or editable.

/** A task's workflow state: the kind picks the glyph, the label is printed. */
export interface TaskDetailStatus {
  kind: TaskStateKind;
  /** The state's name, e.g. "In Review". */
  label: string;
  /** Replaces the printed glyph + label in the status line, e.g. Dispatch's
      inline status picker. `kind` and `label` still describe the task. */
  control?: ReactNode;
}

/** One row of the alert stack above the properties. */
export interface TaskDetailAlert {
  id?: string;
  /** Lead-in word, sentence case ("Blocked", "Stalled", "Unassigned"). */
  label: string;
  /** The alert's colour (docs/architecture.md §8.2): danger for an overdue
      milestone, warning for blocked, holds up, stalled and unassigned.
      Default warning (AlertStrip's). */
  tone?: UiTone;
  /** One sentence ("Waiting on ENG-12 (in progress)."). */
  message: ReactNode;
  /** Follow-up: a link when it has an href, a button when it acts in place. */
  action?: AlertStripAction;
}

/** Another task this one waits on, or that waits on it. */
export interface TaskRelation {
  id: string;
  /** Identifier, e.g. "ENG-12" (mono). */
  taskKey: string;
  title: string;
  /** Where the row goes: a host route or the tracker's URL (http(s) URLs
      open in a new tab). */
  href?: string;
  /** Opens the task in place (a drawer, a peek). With an href, plain clicks
      call this and modified clicks still follow the link. */
  onOpen?: () => void;
  state: { kind: TaskStateKind; label: string };
  /** The assignee's name, or null when nobody is assigned. Leave undefined
      to print nothing. */
  assignee?: string | null;
  /** Where it lives, e.g. "Atlas billing migration / Dual-write" (the
      facts around it are already separated by middots). */
  context?: string;
  /** Outside the scope the viewer is looking at (another project, a team
      they cannot see): tagged so it is not mistaken for a local task. */
  external?: boolean;
  /** No longer blocking (done or canceled): drawn struck through and
      muted. */
  resolved?: boolean;
  /** Adds a remove button beside the row (an editable host's "unlink");
      it is a sibling of the row's link or button, never inside it. A
      returned promise marks the row pending until it settles, and a
      rejection prints its message under the row. */
  onRemove?: () => void | Promise<unknown>;
}

export interface TaskRelations {
  /** Tasks this one waits on. */
  blockedBy: TaskRelation[];
  /** Tasks that wait on this one. */
  blocks: TaskRelation[];
}

/** One event in the task's history, already worded and dated by the host. */
export interface TaskActivityItem {
  id: string;
  /** Display text for when it happened ("Oct 14", "2 days ago"). */
  at: string;
  /** Machine-readable instant for <time dateTime>, e.g. an ISO string. */
  dateTime?: string;
  /** What happened ("Assigned to Ana Moreno by the planner"). A node,
      so a host can mark up the actor; plain strings print as text. */
  label: ReactNode;
  /** A sentence of context under the label. */
  detail?: ReactNode;
  /** The mark's colour: a semantic tone for what went wrong (danger a
      failed write, warning a partial one), accent for something new, muted
      for background noise, default otherwise. */
  tone?: UiTone;
  /** Makes the label a link (a run, a comment in the tracker). */
  href?: string;
}

/** The description as the tracker stores it: plain text, never HTML. */
export interface TaskDescriptionData {
  /** null or blank shows the empty state. */
  text: string | null;
  /** A body the host renders itself (its markdown renderer, or an
      editor) in place of `text`. No clamp applies, and the package never
      parses anything: whatever is safe here is the host's call. */
  content?: ReactNode;
  /** Shows a skeleton instead of the text. */
  loading?: boolean;
  /** Shows an error line instead of the text. */
  error?: string | null;
  /** Quiet note under the text, right-aligned ("From Linear · edited
      Oct 18"). */
  sourceLabel?: string;
  /** Adds a retry button to the error line. */
  onRetry?: () => void;
}

export interface TaskDescriptionProps extends TaskDescriptionData {
  /** Lines shown before "Show more". Default 12. */
  clampLines?: number;
  /** Starts expanded (e.g. a host that remembers the choice). */
  defaultExpanded?: boolean;
  emptyLabel?: string;
  loadingLabel?: string;
  /** Lead-in of the error line. Default "Error". */
  errorLabel?: string;
  retryLabel?: string;
  showMoreLabel?: string;
  showLessLabel?: string;
}

/** One comment on the task, already worded and dated by the host. */
export interface TaskComment {
  id: string;
  /** Who wrote it ("Ana Moreno", or an integration's name). */
  author: string;
  /** Display text for when ("Oct 14", "2 days ago"). */
  at: string;
  /** Machine-readable instant for <time dateTime>. */
  dateTime?: string;
  /** The text as stored (plain text or markdown source), printed as typed:
      line breaks kept, nothing parsed. */
  body: string;
  /** A body the host renders itself (its markdown renderer) in place of
      `body`. Whatever is safe here is the host's call. */
  content?: ReactNode;
  /** The comment in the tracker (opens in a new tab for http URLs). */
  href?: string;
  /** muted = written by a bot or an integration, not a person. */
  tone?: 'default' | 'muted';
}

/** The task's comments, plus the box to add one. */
export interface TaskCommentsData {
  /** Oldest first, newest last (the composer sits under the newest). */
  items: TaskComment[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** The new-comment box, e.g. <TextAreaEditor mode="compose" />. */
  composer?: ReactNode;
}

export interface TaskCommentListProps {
  items: TaskComment[];
  /** Accessible name of the list. Default "Comments". */
  label?: string;
  emptyLabel?: string;
  loading?: boolean;
  loadingLabel?: string;
  error?: string | null;
  errorLabel?: string;
  onRetry?: () => void;
  retryLabel?: string;
  /** Screen-reader name of a comment's link to the tracker. */
  openLabel?: string;
  newTabLabel?: string;
}

/** Right-aligned controls or notes in the heading of each built-in
    section, e.g. a TaskRelationPicker ("+ Add") on Blocked by, or "From
    Linear" on Comments. */
export interface TaskDetailSectionMeta {
  description?: ReactNode;
  blockedBy?: ReactNode;
  blocks?: ReactNode;
  comments?: ReactNode;
  activity?: ReactNode;
}

export interface TaskRelationListProps {
  items: TaskRelation[];
  /** Accessible name of the list ("Blocked by"). */
  label: string;
  /** Said when there are no items. */
  emptyLabel?: string;
  /** Opens a row in place when the row has no onOpen of its own. */
  onOpen?: (relation: TaskRelation) => void;
  /** Tag on external rows. Default "Outside view". */
  externalLabel?: string;
  /** Tag on resolved rows. Default "Resolved". */
  resolvedLabel?: string;
  /** Printed when assignee is null. Default "Unassigned". */
  unassignedLabel?: string;
  /** Screen-reader note on rows that open a new tab. */
  newTabLabel?: string;
  /** Name of a row's remove button; the task key is appended ("Remove
      ENG-23"). Default "Remove". */
  removeLabel?: string;
  /** Lead-in of a failed removal's error line. Default "Not saved". */
  notSavedLabel?: string;
}

export interface TaskActivityListProps {
  items: TaskActivityItem[];
  /** Accessible name of the list. Default "Activity". */
  label?: string;
  emptyLabel?: string;
  /** Items shown before "Show all N". Omit to show every item. */
  limit?: number;
  /** Button wording; the total is appended ("Show all 9"). */
  showAllLabel?: string;
  showFewerLabel?: string;
  /** Screen-reader note on links to http(s) URLs. */
  newTabLabel?: string;
}

export interface TaskDetailSectionProps {
  title: ReactNode;
  /** Level of the section's heading. Default 3. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** Count after the title, in the quiet text step. */
  count?: number;
  /** Right-aligned note or control ("From Linear", "+ Add"). */
  meta?: ReactNode;
  /** Keep the heading for assistive tech only. */
  hideTitle?: boolean;
  id?: string;
  className?: string;
  children?: ReactNode;
}

/** Wording of every built-in label, for hosts in another language. */
export interface TaskDetailLabels {
  properties: string;
  propertiesList: string;
  description: string;
  noDescription: string;
  loadingDescription: string;
  error: string;
  retry: string;
  showMore: string;
  showLess: string;
  blockedBy: string;
  blocks: string;
  nothingBlocks: string;
  blocksNothing: string;
  activity: string;
  noActivity: string;
  showAll: string;
  showFewer: string;
  external: string;
  resolved: string;
  unassigned: string;
  breadcrumb: string;
  opensInNewTab: string;
  remove: string;
  comments: string;
  noComments: string;
  loadingComments: string;
  openComment: string;
  notSaved: string;
}

/** drawer = one column for a slide-over or split pane; page = main column
    beside a properties rail when there is room (both stack when narrow). */
export type TaskDetailLayout = 'drawer' | 'page';

export interface TaskDetailProps {
  /** Identifier, e.g. "ENG-24". */
  taskKey: string;
  /** The task's name: printed as the heading and naming the view (or the
      SlideOver) for assistive tech. */
  title: string;
  /** Replaces the printed title, e.g. Dispatch's inline title editor.
      `title` still names the view. */
  titleControl?: ReactNode;
  /** The task in its tracker (Linear); the key links there, new tab. */
  href?: string;
  /** Trail in the header bar ("Beacon search / ENG-24", the key in mono):
      crumbs like the shell's, or a ready node. Defaults to the key. */
  breadcrumb?: ReactNode | readonly ShellCrumb[];
  /** Header bar controls, e.g. Open in Linear and Copy link. */
  headerActions?: ReactNode;
  status: TaskDetailStatus;
  /** Extra content in the status line (a priority glyph, "Updated 2h"). */
  statusMeta?: ReactNode;
  alerts?: TaskDetailAlert[];
  /** The host's property sheet, in the host's order. Values are nodes, so
      they may be plain text or editors. */
  properties: PropertyListItem[];
  /** Host sections that belong with the properties (labels, hierarchy,
      links, an editable relations list): in the rail under the property
      sheet in page layout, right after it in drawer layout. Build them
      with TaskDetailSection. */
  rail?: ReactNode;
  /** Omit to leave out the section; pass empty lists to say there are
      none. */
  relations?: TaskRelations;
  /** Opens a relation in place when it has no onOpen of its own. */
  onOpenRelation?: (relation: TaskRelation) => void;
  /** Omit to leave out the section. */
  description?: TaskDescriptionData;
  /** Omit to leave out the section. Drawn after Blocks, before
      Activity, with the composer under the newest comment. */
  comments?: TaskCommentsData;
  /** Controls or notes in the built-in sections' headings (an "+ Add"
      picker on Blocked by and Blocks). */
  sectionMeta?: TaskDetailSectionMeta;
  /** Omit to leave out the section; newest first, or as given. */
  activity?: TaskActivityItem[];
  /** Items shown before "Show all N". */
  activityLimit?: number;
  /** Extra host sections, after the built-in ones in the main column. */
  children?: ReactNode;
  /** Default 'drawer'. */
  layout?: TaskDetailLayout;
  /**
   * Draw the header (breadcrumb bar, actions and title). Default true.
   * Pass false when a container already draws them, e.g. inside SlideOver
   * (TaskSlideOver does this for you).
   */
  header?: boolean;
  /** Level of the title's heading, drawn here or by the container;
      sections sit one below. Default 2. */
  headingLevel?: 1 | 2 | 3 | 4 | 5;
  labels?: Partial<TaskDetailLabels>;
  id?: string;
  className?: string;
}

export interface TaskCrumbsProps {
  /** Crumbs, a ready node, or nothing (the key stands alone). */
  breadcrumb: TaskDetailProps['breadcrumb'];
  taskKey: string;
  /** Accessible name of the crumb nav ("Breadcrumb"). */
  label: string;
}

/** TaskDetail inside the shell's SlideOver: the drawer's bar carries the
    breadcrumb and actions, its heading the title. */
export interface TaskSlideOverProps extends Omit<
  TaskDetailProps,
  'layout' | 'header' | 'headingLevel'
> {
  open: boolean;
  onClose: () => void;
  closeLabel?: string;
  /** Receives focus on open instead of the panel itself. */
  initialFocusRef?: SlideOverProps['initialFocusRef'];
}

export interface TaskPropertyValueProps {
  children: ReactNode;
  /** A sentence under the value ("Given by the planner: …"). */
  note?: ReactNode;
  /** The value's colour (docs/architecture.md §8.2): a semantic tone for a
      value that needs attention (warning "Unassigned", danger an overdue
      date), muted = quiet. */
  tone?: UiTone;
  noteTone?: UiTone;
  /** Tabular figures for dates, durations and counts (Geist with
      tabular-nums: the name is older than the look). */
  mono?: boolean;
}
