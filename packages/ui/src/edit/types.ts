import type { ReactNode } from 'react';

import type { TaskPriority, TaskStateKind } from '../tasks/types';
import type { UiStatus, UiTone } from '../types';

// Prop vocabulary of the "edit" family: the controls a host puts into the
// task view (and anywhere else) to change a task's properties. Every control
// is controlled by its host and saves through one contract: the host's
// callback returns a promise, the control shows the new value as pending
// while it runs, keeps it once it resolves, and on rejection rolls back to
// the host's value and prints the error beside the control. Plain data and
// callbacks only, so the planner (Next) and Dispatch (Vite + Tauri) map
// their own models onto these shapes in a thin adapter.

/**
 * What a save callback returns: a promise the control waits on (resolve
 * once the change is stored, reject with an Error whose message the control
 * prints), or nothing for a change that is stored synchronously.
 *
 * After it resolves, the control keeps showing the saved value until the
 * host's `value` prop changes, so a host that refreshes its data a moment
 * later (a server round trip) does not flicker back to the old value.
 */
export type SaveResult = Promise<unknown> | void;

/** Turns a rejection into the sentence printed beside the control. */
export type ErrorFormatter = (error: unknown) => string;

/**
 * The leading mark of a picker option (and of the trigger showing it). The
 * marks are the system's own glyphs; `swatch` is the one place a colour
 * from data is drawn (a label's colour, as a small rounded square; the
 * label's chip itself stays neutral), and only a hex colour is accepted —
 * anything else draws a hollow square.
 */
export type PickerMark =
  | { kind: 'state'; state: TaskStateKind }
  | { kind: 'priority'; priority: TaskPriority }
  /** A round avatar with initials ("Ana Moreno" → AM) on a pastel tint of
      a hue picked from the name; a blank name draws the dashed empty
      avatar (nobody). */
  | { kind: 'avatar'; name: string }
  | { kind: 'status'; status: UiStatus; label: string; muted?: boolean }
  /** `#rgb`, `#rrggbb` or `#rrggbbaa`. */
  | { kind: 'swatch'; color: string }
  | { kind: 'node'; node: ReactNode };

/** One choice in a picker. */
export interface PickerOption {
  /** Stable id, handed back through onChange. */
  value: string;
  /** Printed, and matched by the search box. */
  label: string;
  /** Quiet text after the label (a handle, a date, a key); matched too. */
  hint?: string;
  /** Extra words the search matches but never prints (an email, an alias). */
  keywords?: readonly string[];
  mark?: PickerMark;
  /** Heading of the group the option is listed under. Groups keep the
      order in which they first appear; ungrouped options come first. */
  group?: string;
  /** Listed but not choosable (skipped by the arrow keys). */
  disabled?: boolean;
  /** The trigger face's text colour while this option is the value shown
      (pending included), from the data-tone hook: a status tone such as
      danger for "Urgent" in a list cell. Default: the trigger's own. */
  tone?: UiTone;
}

/**
 * How the trigger is drawn. value = the property sheet's voice (the value
 * as text, a --surface-2 pill on hover and while open, Gr8r's .pillbtn);
 * mono = the status line's bordered pill (the name is historical: it is
 * no longer mono); quiet = a small ghost button ("+ Add"); cell = a list
 * cell's value in the cell's own voice, the pill on hover; bar = a ghost
 * button on the inverted bulk bar, in --text-inv.
 */
export type PickerAppearance = 'value' | 'mono' | 'quiet' | 'cell' | 'bar';

/** Wording of every built-in label in the edit family. */
export interface EditLabels {
  /** Pending note ("Saving"). */
  saving: string;
  /** Lead-in of the inline save error ("Not saved"). */
  notSaved: string;
  /** Message when a rejection carries none. */
  saveFailed: string;
  /** Default placeholder of a picker's search box. */
  search: string;
  noMatch: string;
  /** Picker row while options load. */
  loading: string;
  /** Lead-in of a picker's options error. */
  error: string;
  retry: string;
  /** Accessible name of the popover's close button. */
  close: string;
  /** The close button's face on a phone sheet. */
  done: string;
  /** Spoken result count; {count} is replaced. */
  results: string;
  /** Keyboard hints in the popover's foot. */
  move: string;
  select: string;
  toggle: string;
  /** Description of a text field's view button ("Edit"). */
  edit: string;
  save: string;
  cancel: string;
  clear: string;
  /** A required text field left empty. */
  required: string;
  /** First Esc on a changed draft: the second one discards it. */
  unsaved: string;
  /** After the ⌘/Ctrl + Enter key caps. */
  saveShortcut: string;
}

interface PickerBaseProps {
  /** The property's name ("Assignee"): the trigger's accessible name is
      "Assignee: Ana Moreno", and it names the popover and its list. */
  label: string;
  options: readonly PickerOption[];
  /** Trigger face when nothing is chosen ("Unassigned"). */
  placeholder?: string;
  /** The empty face's tone: warning when the empty value needs action
      ("Unassigned" on an open issue), muted (default) = quiet, default =
      plain text (docs/architecture.md §8.2). */
  placeholderTone?: UiTone;
  /** The search box's placeholder ("Assign to…"). */
  searchPlaceholder?: string;
  /** Offers a leading option that clears the value ("No project"); single
      mode picks null, multiple mode picks []. Omit when a value is
      required. */
  noneLabel?: string;
  noneMark?: PickerMark;
  /** Printed when the search matches nothing. Default "No match". */
  emptyLabel?: string;
  /** Options are being fetched: a loading row under the list. */
  loading?: boolean;
  /** Options failed to load: an error row, with a Retry option when
      onRetry is given. */
  error?: string | null;
  onRetry?: () => void;
  /** Controlled search text (a host searching on the server). */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** Filter `options` by the search text here. Default true; false when
      the host already filtered them (server search). */
  filter?: boolean;
  /** Draw the search row. Default true; false for a short menu (Filter,
      Sort, a row's "…"): the list itself takes focus and the arrow keys,
      Enter and Space work on it. */
  searchable?: boolean;
  appearance?: PickerAppearance;
  /** Which trigger edge the popover lines up with. Default 'start'; 'end'
      for a trigger at the right of its row (a section's "+ Add"). */
  align?: 'start' | 'end';
  /** Opens at this viewport point instead of under the trigger (a row's
      context menu at the pointer); the trigger still takes focus back
      when it closes. A phone keeps its bottom sheet. */
  anchorPoint?: { x: number; y: number } | null;
  /** Where focus goes when the picker closes from inside (Esc, a choice,
      a close button) instead of the trigger: e.g. the row title a host's
      single-key shortcut opened it from. Null (or no element) keeps the
      trigger. Tab and an outside click are unchanged. */
  returnFocus?: () => HTMLElement | null;
  /** Replaces the trigger's face (an "Add" action, a host's own glyph). */
  trigger?: ReactNode;
  /** Replaces the trigger's accessible name (with a custom face). */
  triggerLabel?: string;
  disabled?: boolean;
  /** Controlled open state, e.g. for a host's single-key shortcuts. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  formatError?: ErrorFormatter;
  labels?: Partial<EditLabels>;
  /** id of the trigger button (for a <label htmlFor>). */
  id?: string;
  className?: string;
}

export interface SinglePickerProps extends PickerBaseProps {
  multiple?: false;
  /** The chosen option's value, or null. */
  value: string | null;
  /** Printed when `value` is not among the options (a deactivated person,
      an option list still loading). */
  valueLabel?: string;
  onChange: (value: string | null) => SaveResult;
  /** Each pick is an action (link this task) rather than a value: no row
      is shown as chosen, and every pick saves, the same one included. */
  action?: boolean;
}

export interface MultiPickerProps extends PickerBaseProps {
  multiple: true;
  value: readonly string[];
  /** Receives the complete new list after each toggle. The popover stays
      open, so several options toggle in one visit. */
  onChange: (value: string[]) => SaveResult;
  /** Computes the list after a toggle; default adds or removes `toggled`.
      (LabelPicker uses it for groups that allow one label.) */
  resolveToggle?: (current: readonly string[], toggled: string) => string[];
  /** How chosen options are marked: 'box' (default) a checkbox square on
      every row; 'tick' the single picker's trailing check and no
      squares, for a menu whose groups each hold one choice (a Sort or
      Group menu whose resolveToggle keeps one per group). */
  marks?: 'box' | 'tick';
}

export type PickerPopoverProps = SinglePickerProps | MultiPickerProps;

/** The props the property presets share with PickerPopover. */
export type PickerPresetBaseProps = Omit<
  PickerBaseProps,
  'options' | 'label' | 'filter' | 'query' | 'onQueryChange'
> & {
  /** Default per preset ("Status", "Assignee", …). */
  label?: string;
};

/** A workflow state for StatePicker. */
export interface StateChoice {
  id: string;
  name: string;
  kind: TaskStateKind;
}

export interface StatePickerProps extends PickerPresetBaseProps {
  /** The team's states, in the tracker's order. */
  states: readonly StateChoice[];
  /** The current state's id. */
  value: string | null;
  onChange: (stateId: string) => SaveResult;
}

/** A person for AssigneePicker. */
export interface PersonChoice {
  id: string;
  name: string;
  /** Muted note after the name (a handle); matched by the search. */
  hint?: string;
  /** Matched but not shown (an email). */
  keywords?: readonly string[];
  /** Heading of the group the person is listed under ("Agents", "Team");
      none by default. Groups keep first-seen order, ungrouped first. */
  group?: string;
  /** The row's mark; the round initials avatar by default. A host draws
      an agent with its own glyph (`{ kind: 'node', node }`). */
  mark?: PickerMark;
}

export interface AssigneePickerProps extends PickerPresetBaseProps {
  people: readonly PersonChoice[];
  value: string | null;
  /** The name to print when `value` is not in `people` (deactivated). */
  valueLabel?: string;
  /** The signed-in person: their row says "You". */
  meId?: string;
  /** Wording of the "you" note. Default "You". */
  meLabel?: string;
  onChange: (personId: string | null) => SaveResult;
}

export interface PriorityPickerProps extends PickerPresetBaseProps {
  value: TaskPriority;
  onChange: (priority: TaskPriority) => SaveResult;
  /** Names of the five levels (Linear's by default). */
  priorityLabels?: Partial<Record<TaskPriority, string>>;
  /** A level's face colour while it is the value shown (the list cell's
      danger "Urgent", architecture §8.2 "priority"); none by default. */
  priorityTones?: Partial<Record<TaskPriority, UiTone>>;
}

/** A label for LabelPicker. */
export interface LabelChoice {
  id: string;
  name: string;
  /** The tracker's colour (hex), drawn only as the small square of the
      option and of the label's (neutral) chip. */
  color?: string;
  /** The label's group: its heading, and singleSelect groups allow one
      label at a time (picking another replaces it). */
  group?: { id: string; name: string; singleSelect?: boolean };
}

export interface LabelPickerProps extends PickerPresetBaseProps {
  labelOptions: readonly LabelChoice[];
  value: readonly string[];
  onChange: (labelIds: string[]) => SaveResult;
  /** Draw each label's colour square (default true). */
  showColor?: boolean;
}

/** A project (or milestone) for ProjectPicker and MilestonePicker. */
export interface PlanChoice {
  id: string;
  name: string;
  /** Muted note (a status name, a due date). */
  hint?: string;
  status?: { status: UiStatus; label: string; muted?: boolean };
  group?: string;
  disabled?: boolean;
}

export interface ProjectPickerProps extends PickerPresetBaseProps {
  projects: readonly PlanChoice[];
  value: string | null;
  valueLabel?: string;
  onChange: (projectId: string | null) => SaveResult;
}

export interface MilestonePickerProps extends PickerPresetBaseProps {
  milestones: readonly PlanChoice[];
  value: string | null;
  valueLabel?: string;
  onChange: (milestoneId: string | null) => SaveResult;
}

/** One value of an estimate scale ("5", or "L" on a T-shirt scale). */
export interface EstimateChoice {
  value: number;
  label: string;
}

export interface EstimatePickerProps extends PickerPresetBaseProps {
  /** The scale, in order. A current value outside it is listed too. */
  estimates: readonly EstimateChoice[];
  value: number | null;
  onChange: (estimate: number | null) => SaveResult;
}

/** A task found by TaskRelationPicker's search. */
export interface TaskSearchResult {
  id: string;
  taskKey: string;
  title: string;
  state?: { kind: TaskStateKind; label: string };
  /** Group heading for the result ("Beacon search"). */
  group?: string;
}

export interface TaskRelationPickerProps {
  /** Names the trigger and the popover ("Add blocked by"). */
  label: string;
  /**
   * Finds tasks by key or title. Called with '' when the popover opens
   * (when minQueryLength is 0), then with each search after a short pause;
   * the signal aborts when a newer search or closing makes it stale.
   */
  search: (
    query: string,
    signal: AbortSignal
  ) => Promise<readonly TaskSearchResult[]>;
  /** Links the chosen task; the popover closes and the trigger shows the
      pending state until it settles. */
  onSelect: (task: TaskSearchResult) => SaveResult;
  /** Task ids not to offer (the task itself, tasks already linked). */
  exclude?: readonly string[];
  /** Characters typed before the first search. Default 0. */
  minQueryLength?: number;
  /** Pause after typing before searching, in ms. Default 200. */
  debounceMs?: number;
  /** The trigger's face. Default "+ Add". */
  trigger?: ReactNode;
  searchPlaceholder?: string;
  /** Said when the query is shorter than minQueryLength. */
  hintLabel?: string;
  appearance?: PickerAppearance;
  /** Default 'end': the trigger sits at the right of a section heading. */
  align?: 'start' | 'end';
  disabled?: boolean;
  formatError?: ErrorFormatter;
  labels?: Partial<EditLabels>;
  className?: string;
}

export interface InlineTextFieldProps {
  /** The field's name ("Title"): the editor's accessible name. */
  label: string;
  value: string;
  onSave: (next: string) => SaveResult;
  /** Shown (muted) when the value is empty. */
  placeholder?: string;
  /** Refuse an empty value (default true). */
  required?: boolean;
  maxLength?: number;
  formatError?: ErrorFormatter;
  labels?: Partial<EditLabels>;
  disabled?: boolean;
  className?: string;
}

export interface TextAreaEditorProps {
  /** The text's name ("Description", "Comment"): the editor's accessible
      name. */
  label: string;
  /** The saved text ('' when there is none). In compose mode, ignored. */
  value?: string;
  onSave: (next: string) => SaveResult;
  /**
   * edit (default): shows the text with an Edit button; editing swaps in
   * the editor with Save and Cancel. compose: the editor is always there
   * (a comment box); a save clears it.
   */
  mode?: 'edit' | 'compose';
  /**
   * What edit mode shows while not editing: a node, or a function of the
   * text (so a host's markdown renderer also draws a just-saved text before
   * the host's own value catches up). Default: the text as typed (line
   * breaks kept, nothing parsed), or `emptyLabel` when blank.
   */
  view?: ReactNode | ((text: string) => ReactNode);
  emptyLabel?: string;
  placeholder?: string;
  maxLength?: number;
  /** Characters at which the count appears. Default 80% of maxLength. */
  countFrom?: number;
  /** Visible lines of the editor. Default 6 (edit) or 3 (compose). */
  rows?: number;
  /** Controlled editing (edit mode), e.g. an Edit button elsewhere. */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  /** The Save button's label. Default "Save" (edit) or "Comment"
      (compose). */
  saveLabel?: string;
  /** The Edit button's label. Default "Edit". */
  editLabel?: string;
  formatError?: ErrorFormatter;
  labels?: Partial<EditLabels>;
  disabled?: boolean;
  className?: string;
}

export interface DateFieldProps {
  /** The field's name ("Due date"). */
  label: string;
  /** YYYY-MM-DD, or null. */
  value: string | null;
  onChange: (next: string | null) => SaveResult;
  /** Offer Clear (default true). */
  clearable?: boolean;
  min?: string;
  max?: string;
  /**
   * Pause after the last change before saving, in ms (default 600), so
   * typing a year digit by digit never saves year 0002. Leaving the field
   * or pressing Enter saves at once.
   */
  commitDelay?: number;
  formatError?: ErrorFormatter;
  labels?: Partial<EditLabels>;
  disabled?: boolean;
  id?: string;
  className?: string;
}
