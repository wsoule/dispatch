import type {
  Priority,
  StatusModel,
  TaskListItem,
  UpdatePatch,
} from '@dispatch-foo/core/browser';
import { PRIORITY_ORDER, statusType } from '@dispatch-foo/core/browser';
import {
  AssigneePicker,
  MilestonePicker,
  type PersonChoice,
  type PickerOption,
  PickerPopover,
  type PlanChoice,
  PriorityPicker,
  type StateChoice,
  StatePicker,
  type TaskColumnId,
  type TaskGroupData,
  type TaskPriority,
  type TaskRowData,
} from '@dispatch/ui';
import { Bot, Ellipsis, Zap } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  AGENTS_GROUP,
  type AssigneeChoice,
  buildPersonChoices,
  type PersonChoicesInput,
} from '../adapters/people';
import { fromTaskPriority, toTaskPriority } from '../adapters/rows';
import { FANOUT_VERB_LABEL, type FanoutVerb } from '../lib/fanoutVerbs';
import { assigneeRef, priorityLabel, statusLabel } from '../lib/taskDisplay';

// The Issues list's edit controls, every one @dispatch/ui's PickerPopover
// (architecture §8.4 "Issues", moving): the cell pickers (status, priority,
// assignee, milestone: one task, through the window's handleUpdate and
// moveTaskStatus), a row's "…" menu (also opened by a right-click and the row
// keys s / p / a / m, which jump straight to a field's picker), a group's "…"
// menu (New task here, the fan-out verbs) and the bulk bar's pickers for the
// selection. One control is open at a time, held outside React state so that
// opening one redraws one row (the planner's RowMenuSlot pattern).

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

/** The property pickers a row offers: each table cell, and each a stage of
 * the row's menu, so `s` still opens the status picker when the Status column
 * is hidden. */
export type RowPickerKind = 'state' | 'priority' | 'assignee' | 'milestone';

/** The picker a table column is, or undefined for a plain column. */
export function pickerForColumn(
  column: TaskColumnId
): RowPickerKind | undefined {
  switch (column) {
    case 'state':
    case 'priority':
    case 'assignee':
    case 'milestone':
      return column;
    default:
      return undefined;
  }
}

/** Which row's control is open: its "…" menu (`kind: 'menu'`), one of its
 * pickers in its own cell (`slot: 'cell'`) or in the menu's place (`slot:
 * 'menu'`, a row key on a hidden column), and where: under its trigger
 * (`point` null) or at the pointer of a right-click. */
interface OpenControl {
  rowId: string;
  kind: 'menu' | RowPickerKind;
  slot: 'cell' | 'menu';
  point: { x: number; y: number } | null;
  /** A row key opened it: Esc or a choice puts focus back on the row's
   * title, not on the trigger. */
  fromKey: boolean;
}

type ControlUpdate =
  | OpenControl
  | null
  | ((current: OpenControl | null) => OpenControl | null);

/** The open control, outside React state: each row's slots read only their
 * own row's entry, so opening one redraws that row, not the list. */
export interface ControlStore {
  get: () => OpenControl | null;
  set: (next: ControlUpdate) => void;
  subscribe: (listener: () => void) => () => void;
}

/** One ControlStore for the life of the list. */
export function useControlStore(): ControlStore {
  const [store] = useState<ControlStore>(() => {
    let control: OpenControl | null = null;
    const listeners = new Set<() => void>();
    return {
      get: () => control,
      set(next) {
        const value = typeof next === 'function' ? next(control) : next;
        if (value === control) return;
        control = value;
        for (const listener of listeners) listener();
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  });
  return store;
}

/** This row's open control in `slot`, or null: a cell picker reads its own
 * kind, the "…" slot reads the menu and every stage opened in its place. */
function useOpenControl(
  store: ControlStore,
  rowId: string,
  slot: 'cell' | 'menu',
  kind?: RowPickerKind
): OpenControl | null {
  return useSyncExternalStore<OpenControl | null>(
    store.subscribe,
    () => {
      const current = store.get();
      if (current === null || current.rowId !== rowId) return null;
      if (current.slot !== slot) return null;
      if (kind !== undefined && current.kind !== kind) return null;
      return current;
    },
    () => null
  );
}

/**
 * A function that keeps one identity for the life of the component and always
 * runs the latest render's `fn`: for the callbacks the table's rows call on an
 * event (a menu choice, a drop), so that passing them never redraws a row.
 */
export function useEventCallback<A extends unknown[], R>(
  fn: (...args: A) => R
): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

/** A row's title (its link, or its button without an href): where a row key
 * was pressed, and where focus returns after the picker it opened. */
export function rowTitleElement(rowId: string): HTMLElement | null {
  const row = `[data-nav-item="row"][data-row-id="${CSS.escape(rowId)}"]`;
  return document.querySelector<HTMLElement>(
    `${row} [data-nav-target] > a, ${row} [data-nav-target] > button`
  );
}

// ---- the choices every picker lists ------------------------------------

/** The project's statuses as StatePicker choices (id = the status name as
 * the config spells it, which is what `moveTaskStatus` takes; its workflow
 * type from the model). Without a config, the model's own definitions. */
export function stateChoices(
  statuses: readonly string[] | undefined,
  model: StatusModel
): StateChoice[] {
  const names =
    statuses === undefined || statuses.length === 0
      ? model.definitions.map((definition) => definition.name)
      : statuses;
  return names.map((name) => ({
    id: name,
    name: statusLabel(name),
    kind: statusType(name, model),
  }));
}

/** The assignee choices with the agents' glyph attached (people.ts leaves an
 * agent's mark to the view, a React node being no business of a pure
 * adapter). */
export function assigneeChoices(input: PersonChoicesInput): PersonChoice[] {
  return buildPersonChoices(input).map((choice: AssigneeChoice) =>
    choice.kind === 'agent' || choice.group === AGENTS_GROUP
      ? { ...choice, mark: { kind: 'node', node: <Bot {...ICON} /> } }
      : choice
  );
}

/** The containers a task can sit under, as MilestonePicker choices. */
export function milestoneChoices(
  containers: readonly TaskListItem[]
): PlanChoice[] {
  return containers.map((container) => ({
    id: container.meta.id,
    name: container.meta.title,
    hint: container.meta.kind,
  }));
}

const PRIORITIES = Object.keys(PRIORITY_ORDER) as Priority[];

/** The priority cell's Urgent face in red, as the plain Urgent cell draws it
 * (architecture §8.2 "priority"). */
const URGENT_TONE: Partial<Record<TaskPriority, 'danger'>> = { 1: 'danger' };

/** What every picker needs beyond the row: the choices and the writes. */
export interface PickerContext {
  states: readonly StateChoice[];
  people: readonly PersonChoice[];
  meId: string | null;
  milestones: readonly PlanChoice[];
  onUpdate: (id: string, patch: UpdatePatch) => Promise<void>;
  onMoveStatus: (id: string, status: string) => Promise<void>;
}

// ---- cell pickers -------------------------------------------------------

interface CellProps {
  row: TaskRowData;
  doc: TaskListItem;
  store: ControlStore;
  ctx: PickerContext;
}

/** Controlled open state for a picker that is one row's control. */
function useControlledOpen(
  store: ControlStore,
  rowId: string,
  slot: 'cell' | 'menu',
  kind: RowPickerKind
) {
  const control = useOpenControl(store, rowId, slot, kind);
  const onOpenChange = (open: boolean) =>
    store.set((current) => {
      if (open) return { rowId, kind, slot, point: null, fromKey: false };
      return current !== null && current.rowId === rowId ? null : current;
    });
  return { control, onOpenChange };
}

/** The picker for one kind: the cell's control, or a stage of the "…" menu
 * (trigger, anchor point and focus return supplied by the slot). */
function RowPicker({
  kind,
  row,
  doc,
  ctx,
  open,
  onOpenChange,
  appearance,
  trigger,
  triggerLabel,
  anchorPoint,
  returnFocus,
  align,
}: {
  kind: RowPickerKind;
  row: TaskRowData;
  doc: TaskListItem;
  ctx: PickerContext;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appearance: 'cell' | 'quiet';
  trigger?: ReactNode;
  triggerLabel?: string;
  anchorPoint?: { x: number; y: number } | null;
  returnFocus?: () => HTMLElement | null;
  align?: 'start' | 'end';
}): ReactNode {
  const id = doc.meta.id;
  const common = {
    appearance,
    trigger,
    triggerLabel,
    anchorPoint,
    returnFocus,
    align,
    open,
    onOpenChange,
  };
  switch (kind) {
    case 'state':
      return (
        <StatePicker
          {...common}
          label={`${row.key} status`}
          states={ctx.states}
          value={doc.meta.status}
          onChange={(status) => ctx.onMoveStatus(id, status)}
        />
      );
    case 'priority':
      return (
        <PriorityPicker
          {...common}
          label={`${row.key} priority`}
          priorityTones={URGENT_TONE}
          value={toTaskPriority(doc.meta.priority)}
          onChange={(priority) =>
            ctx.onUpdate(id, { priority: fromTaskPriority(priority) })
          }
        />
      );
    case 'assignee':
      return (
        <AssigneePicker
          {...common}
          label={`${row.key} assignee`}
          people={ctx.people}
          value={
            assigneeRef(doc.meta.assignee) === null ? null : doc.meta.assignee
          }
          valueLabel={row.assignee ?? undefined}
          meId={ctx.meId ?? undefined}
          placeholder={row.unassignedLabel}
          placeholderTone={row.assigneeTone === 'warning' ? 'warning' : 'muted'}
          onChange={(assignee) =>
            ctx.onUpdate(id, { assignee: assignee ?? 'none' })
          }
        />
      );
    case 'milestone':
      return (
        <MilestonePicker
          {...common}
          label={`${row.key} milestone`}
          milestones={ctx.milestones}
          value={doc.meta.parent}
          valueLabel={row.milestone ?? undefined}
          onChange={(parent) => ctx.onUpdate(id, { parent })}
        />
      );
  }
}

/** A meta cell as its picker (TaskGroupTable's renderCell): the status,
 * priority, assignee and milestone columns; undefined keeps a plain cell. */
export function IssueCell({
  kind,
  row,
  doc,
  store,
  ctx,
}: CellProps & { kind: RowPickerKind }): ReactNode {
  const { control, onOpenChange } = useControlledOpen(
    store,
    row.id,
    'cell',
    kind
  );
  return (
    <RowPicker
      kind={kind}
      row={row}
      doc={doc}
      ctx={ctx}
      open={control !== null}
      onOpenChange={onOpenChange}
      appearance="cell"
      returnFocus={
        control?.fromKey === true ? () => rowTitleElement(row.id) : undefined
      }
    />
  );
}

// ---- the row's "…" menu -------------------------------------------------

/** A menu item that is not a field change. */
export type RowAction =
  | 'open'
  | 'peek'
  | 'dispatch'
  | 'copy-id'
  | 'copy-link'
  | 'archive'
  | 'drop';

export interface RowMenuInput {
  /** The row may be edited (not archived, not a read-only tier). */
  editable: boolean;
  /** The task is ready to dispatch (`readyIds`). */
  ready: boolean;
  /** A deep-link provider is there to copy a link with. */
  canCopyLink: boolean;
}

/** The "…" menu's options, in order: the field pickers as stages (the old
 * context menu's Status / Priority / Assignee / Milestone submenus), the
 * opens, Dispatch…, the copies, then Archive and Drop. */
function rowMenuOptions(input: RowMenuInput): PickerOption[] {
  const options: PickerOption[] = [];
  if (input.editable) {
    options.push(
      { value: 'state', label: 'Status…', group: 'Change' },
      { value: 'priority', label: 'Priority…', group: 'Change' },
      { value: 'assignee', label: 'Assignee…', group: 'Change' },
      { value: 'milestone', label: 'Milestone…', group: 'Change' }
    );
  }
  options.push(
    { value: 'open', label: 'Open', hint: 'O', group: 'Row' },
    { value: 'peek', label: 'Quick look', hint: 'Space', group: 'Row' }
  );
  if (input.editable) {
    options.push({
      value: 'dispatch',
      label: 'Dispatch…',
      hint: 'D',
      group: 'Row',
      disabled: !input.ready,
    });
  }
  options.push({
    value: 'copy-id',
    label: 'Copy id',
    hint: '⌘C',
    group: 'Row',
  });
  if (input.canCopyLink) {
    options.push({ value: 'copy-link', label: 'Copy link', group: 'Row' });
  }
  if (input.editable) {
    options.push(
      { value: 'archive', label: 'Archive', group: 'Remove' },
      { value: 'drop', label: 'Drop', group: 'Remove', tone: 'danger' }
    );
  }
  return options;
}

function isPickerKind(value: string): value is RowPickerKind {
  return (
    value === 'state' ||
    value === 'priority' ||
    value === 'assignee' ||
    value === 'milestone'
  );
}

/**
 * A row's "…" cell (TaskGroupTable's rowActions): the actions menu, or in its
 * place the stage a choice (or a row key on a hidden column) picked. Each
 * stage is its own popover on the "…" button: the button stays as the closed
 * trigger, and a stage a row key opened returns focus to the row's title. The
 * slot follows the open control through the store, so only the row whose menu
 * opens, moves stage or closes redraws.
 */
export function RowMenuSlot({
  row,
  doc,
  store,
  ctx,
  menu,
  onAction,
}: CellProps & {
  menu: RowMenuInput;
  onAction: (action: RowAction, row: TaskRowData) => void;
}): ReactNode {
  const rowId = row.id;
  const control = useOpenControl(store, rowId, 'menu');
  const trigger = <Ellipsis {...ICON} />;
  const triggerLabel = `Actions for ${row.key}`;
  const anchorPoint = control?.point ?? null;
  const returnFocus =
    control?.fromKey === true ? () => rowTitleElement(rowId) : undefined;
  const close = () =>
    store.set((current) =>
      current !== null && current.rowId === rowId ? null : current
    );
  const stage = control?.kind ?? 'menu';
  if (stage !== 'menu') {
    return (
      <RowPicker
        key={stage}
        kind={stage}
        row={row}
        doc={doc}
        ctx={ctx}
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
        appearance="quiet"
        trigger={trigger}
        triggerLabel={triggerLabel}
        anchorPoint={anchorPoint}
        returnFocus={returnFocus}
        align={anchorPoint === null ? 'end' : 'start'}
      />
    );
  }
  return (
    <PickerPopover
      key="menu"
      label={triggerLabel}
      searchable={false}
      action
      appearance="quiet"
      align={anchorPoint === null ? 'end' : 'start'}
      anchorPoint={anchorPoint}
      returnFocus={returnFocus}
      value={null}
      options={rowMenuOptions(menu)}
      trigger={trigger}
      triggerLabel={triggerLabel}
      open={control !== null}
      onOpenChange={(open) => {
        if (open) {
          store.set({
            rowId,
            kind: 'menu',
            slot: 'menu',
            point: null,
            fromKey: false,
          });
        } else {
          close();
        }
      }}
      onChange={(value) => {
        if (value === null) return;
        if (isPickerKind(value)) {
          store.set((current) => ({
            rowId,
            kind: value,
            slot: 'menu',
            point: current?.rowId === rowId ? current.point : null,
            fromKey: current?.rowId === rowId ? current.fromKey : false,
          }));
        } else {
          onAction(value as RowAction, row);
        }
      }}
    />
  );
}

// ---- the group's "…" menu -----------------------------------------------

/** A group menu item: a fan-out verb, the task creator, or the flight plan. */
export type GroupAction = FanoutVerb | 'new-task' | 'open-plan';

/**
 * A group header's "…" menu: New task here (pre-filled with the group's
 * status or container), and for a container its flight plan and the fan-out
 * verbs that apply right now (`fanoutVerbs`).
 */
export function GroupMenu({
  group,
  verbs,
  container,
  onAction,
}: {
  group: TaskGroupData;
  verbs: readonly FanoutVerb[];
  /** The group stands for a container (an epic or a milestone). */
  container: boolean;
  onAction: (action: GroupAction, group: TaskGroupData) => void;
}): ReactNode {
  const options: PickerOption[] = [
    { value: 'new-task', label: 'New task here' },
  ];
  if (container)
    options.push({ value: 'open-plan', label: 'Open flight plan' });
  for (const verb of verbs) {
    options.push({
      value: verb,
      label: FANOUT_VERB_LABEL[verb],
      group: 'Agents',
      mark:
        verb === 'send' ? { kind: 'node', node: <Zap {...ICON} /> } : undefined,
    });
  }
  const label = `Actions for ${group.title}`;
  return (
    <PickerPopover
      label={label}
      searchable={false}
      action
      appearance="quiet"
      align="end"
      value={null}
      options={options}
      trigger={<Ellipsis {...ICON} />}
      triggerLabel={label}
      onChange={(value) => {
        if (value !== null) onAction(value as GroupAction, group);
      }}
    />
  );
}

// ---- the bulk bar's actions ---------------------------------------------

/** A change the bulk bar applies to every selected task. */
export type BulkChange =
  | { kind: 'status'; status: string }
  | { kind: 'priority'; priority: Priority }
  | { kind: 'assignee'; assignee: string }
  | { kind: 'archive' };

/** The words for a bulk change, for the confirmation sentence. */
export function bulkChangeLabel(change: BulkChange): string {
  switch (change.kind) {
    case 'status':
      return `Set status to ${statusLabel(change.status)}`;
    case 'priority':
      return `Set priority to ${priorityLabel(change.priority)}`;
    case 'assignee':
      return `Assign to ${change.assignee}`;
    case 'archive':
      return 'Archive';
  }
}

/**
 * The bulk bar's triggers (appearance 'bar'): Actions (Dispatch… for the
 * ready ones, Archive), then Status, Priority and Assignee as pickers for the
 * selection. Every pick is an action: nothing is shown as chosen, since the
 * selected tasks need not agree.
 */
export function BulkActions({
  ready,
  states,
  people,
  onDispatch,
  onChange,
}: {
  /** How many of the selected tasks are ready to dispatch. */
  ready: number;
  states: readonly StateChoice[];
  people: readonly PersonChoice[];
  onDispatch: () => void;
  onChange: (change: BulkChange) => void;
}): ReactNode {
  const face = (text: string) => <span data-bulk-label="">{text}</span>;
  const stateOptions: PickerOption[] = states.map((state) => ({
    value: state.id,
    label: state.name,
    mark: { kind: 'state', state: state.kind },
  }));
  const priorityOptions: PickerOption[] = PRIORITIES.map((priority) => ({
    value: priority,
    label: priorityLabel(priority),
    mark: { kind: 'priority', priority: toTaskPriority(priority) },
  }));
  const peopleOptions: PickerOption[] = [
    { value: 'none', label: 'Unassigned', mark: { kind: 'avatar', name: '' } },
    ...people.map((person) => ({
      value: person.id,
      label: person.name,
      hint: person.hint,
      keywords: person.keywords,
      group: person.group,
      mark: person.mark ?? { kind: 'avatar' as const, name: person.name },
    })),
  ];
  return (
    <>
      <PickerPopover
        label="Actions for the selection"
        searchable={false}
        action
        appearance="bar"
        align="start"
        value={null}
        options={[
          {
            value: 'dispatch',
            label: ready === 0 ? 'Dispatch…' : `Dispatch ${ready} ready…`,
            disabled: ready === 0,
            mark: { kind: 'node', node: <Zap {...ICON} /> },
          },
          { value: 'archive', label: 'Archive' },
        ]}
        trigger={face('Actions')}
        triggerLabel="Actions"
        onChange={(value) => {
          if (value === 'dispatch') onDispatch();
          else if (value === 'archive') onChange({ kind: 'archive' });
        }}
      />
      <PickerPopover
        label="Set the status of the selection"
        action
        appearance="bar"
        align="start"
        value={null}
        options={stateOptions}
        searchPlaceholder="Change status…"
        trigger={face('Status')}
        triggerLabel="Status"
        onChange={(value) => {
          if (value !== null) onChange({ kind: 'status', status: value });
        }}
      />
      <PickerPopover
        label="Set the priority of the selection"
        searchable={false}
        action
        appearance="bar"
        align="start"
        value={null}
        options={priorityOptions}
        trigger={face('Priority')}
        triggerLabel="Priority"
        onChange={(value) => {
          if (value !== null) {
            onChange({ kind: 'priority', priority: value as Priority });
          }
        }}
      />
      <PickerPopover
        label="Assign the selection"
        action
        appearance="bar"
        align="end"
        value={null}
        options={peopleOptions}
        searchPlaceholder="Assign to…"
        trigger={face('Assignee')}
        triggerLabel="Assignee"
        onChange={(value) => {
          if (value !== null) onChange({ kind: 'assignee', assignee: value });
        }}
      />
    </>
  );
}
