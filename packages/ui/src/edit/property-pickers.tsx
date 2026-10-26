'use client';

import type { ReactNode } from 'react';

import type { TaskPriority } from '../tasks/types';
import { PickerPopover } from './picker-popover';
import { toggleValue } from './shared';
import type {
  AssigneePickerProps,
  EstimatePickerProps,
  LabelPickerProps,
  MilestonePickerProps,
  PickerOption,
  PlanChoice,
  PriorityPickerProps,
  ProjectPickerProps,
  StatePickerProps,
} from './types';

// Thin presets over PickerPopover for a task's properties: each maps the
// host's plain choices onto options with the right mark, wording and none
// option, and hands every other prop through. Values in, ids out.

/** Linear's priority names, in its picker order. */
export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

const PRIORITY_ORDER: readonly TaskPriority[] = [0, 1, 2, 3, 4];

function isPriority(value: string | null): value is `${TaskPriority}` {
  return (
    value === '0' ||
    value === '1' ||
    value === '2' ||
    value === '3' ||
    value === '4'
  );
}

/** The workflow state, drawn with the state glyph. Required: no none
    option. A bordered pill by default, for the task view's status line. */
export function StatePicker({
  states,
  value,
  onChange,
  label = 'Status',
  appearance = 'mono',
  searchPlaceholder = 'Change status…',
  ...rest
}: StatePickerProps): ReactNode {
  const options: PickerOption[] = states.map((state) => ({
    value: state.id,
    label: state.name,
    mark: { kind: 'state', state: state.kind },
  }));
  return (
    <PickerPopover
      {...rest}
      label={label}
      appearance={appearance}
      searchPlaceholder={searchPlaceholder}
      options={options}
      value={value}
      onChange={(next) => (next === null ? undefined : onChange(next))}
    />
  );
}

/** Who the task is assigned to: round avatars (or a person's own mark),
    a "You" note on the signed-in person, optional groups ("Agents"), and
    "Unassigned" (a dashed empty avatar, amber: an open task needs a
    person) as the none option and the empty face. */
export function AssigneePicker({
  people,
  value,
  valueLabel,
  meId,
  meLabel = 'You',
  onChange,
  label = 'Assignee',
  noneLabel = 'Unassigned',
  noneMark = { kind: 'avatar', name: '' },
  placeholder = 'Unassigned',
  placeholderTone = 'warning',
  searchPlaceholder = 'Assign to…',
  ...rest
}: AssigneePickerProps): ReactNode {
  const options: PickerOption[] = people.map((person) => ({
    value: person.id,
    label: person.name,
    hint: person.id === meId ? (person.hint ?? meLabel) : person.hint,
    keywords:
      person.id === meId
        ? [...(person.keywords ?? []), meLabel]
        : person.keywords,
    group: person.group,
    mark: person.mark ?? { kind: 'avatar', name: person.name },
  }));
  if (
    value !== null &&
    valueLabel !== undefined &&
    !options.some((option) => option.value === value)
  ) {
    options.unshift({
      value,
      label: valueLabel,
      mark: { kind: 'avatar', name: valueLabel },
    });
  }
  return (
    <PickerPopover
      {...rest}
      label={label}
      noneLabel={noneLabel}
      noneMark={noneMark}
      placeholder={placeholder}
      placeholderTone={placeholderTone}
      searchPlaceholder={searchPlaceholder}
      options={options}
      value={value}
      valueLabel={valueLabel}
      onChange={onChange}
    />
  );
}

/** Linear's five priorities with the bar glyph ("No priority" is a level,
    not an empty value). */
export function PriorityPicker({
  value,
  onChange,
  priorityLabels,
  priorityTones,
  label = 'Priority',
  searchPlaceholder = 'Set priority…',
  ...rest
}: PriorityPickerProps): ReactNode {
  const names = { ...PRIORITY_LABELS, ...priorityLabels };
  const options: PickerOption[] = PRIORITY_ORDER.map((priority) => ({
    value: String(priority),
    label: names[priority],
    mark: { kind: 'priority', priority },
    tone: priorityTones?.[priority],
  }));
  return (
    <PickerPopover
      {...rest}
      label={label}
      searchPlaceholder={searchPlaceholder}
      options={options}
      value={String(value)}
      onChange={(next) =>
        isPriority(next) ? onChange(Number(next) as TaskPriority) : undefined
      }
    />
  );
}

/**
 * The task's labels, several at a time: grouped under their label group,
 * each with its colour as a small square (the chosen ones are neutral
 * label chips carrying the same square), and a group marked singleSelect
 * keeps one label (picking another replaces it, as in Linear).
 */
export function LabelPicker({
  labelOptions,
  value,
  onChange,
  showColor = true,
  label = 'Labels',
  placeholder = 'Add label',
  searchPlaceholder = 'Add labels…',
  ...rest
}: LabelPickerProps): ReactNode {
  const byId = new Map(labelOptions.map((choice) => [choice.id, choice]));
  const options: PickerOption[] = labelOptions.map((choice) => ({
    value: choice.id,
    label: choice.name,
    keywords: choice.group !== undefined ? [choice.group.name] : undefined,
    group: choice.group?.name,
    mark:
      showColor && choice.color !== undefined
        ? { kind: 'swatch', color: choice.color }
        : undefined,
  }));
  // Picking a label of a one-label group drops its siblings first.
  const resolveToggle = (
    current: readonly string[],
    toggled: string
  ): string[] => {
    const group = byId.get(toggled)?.group;
    if (current.includes(toggled) || group?.singleSelect !== true) {
      return toggleValue(current, toggled);
    }
    return [
      ...current.filter((id) => byId.get(id)?.group?.id !== group.id),
      toggled,
    ];
  };
  return (
    <PickerPopover
      {...rest}
      multiple
      label={label}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      options={options}
      value={value}
      onChange={onChange}
      resolveToggle={resolveToggle}
    />
  );
}

/** Maps projects and milestones onto options (status mark, note). */
function planOptions(choices: readonly PlanChoice[]): PickerOption[] {
  return choices.map((choice) => ({
    value: choice.id,
    label: choice.name,
    hint: choice.hint,
    group: choice.group,
    disabled: choice.disabled,
    mark:
      choice.status !== undefined
        ? {
            kind: 'status',
            status: choice.status.status,
            label: choice.status.label,
            muted: choice.status.muted,
          }
        : undefined,
  }));
}

/** The project the task belongs to, with "No project". */
export function ProjectPicker({
  projects,
  value,
  valueLabel,
  onChange,
  label = 'Project',
  noneLabel = 'No project',
  placeholder = 'No project',
  searchPlaceholder = 'Move to project…',
  ...rest
}: ProjectPickerProps): ReactNode {
  return (
    <PickerPopover
      {...rest}
      label={label}
      noneLabel={noneLabel}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      options={planOptions(projects)}
      value={value}
      valueLabel={valueLabel}
      onChange={onChange}
    />
  );
}

/** The project milestone, with "No milestone"; the host passes the
    milestones of the task's project. */
export function MilestonePicker({
  milestones,
  value,
  valueLabel,
  onChange,
  label = 'Milestone',
  noneLabel = 'No milestone',
  placeholder = 'No milestone',
  searchPlaceholder = 'Move to milestone…',
  ...rest
}: MilestonePickerProps): ReactNode {
  return (
    <PickerPopover
      {...rest}
      label={label}
      noneLabel={noneLabel}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      options={planOptions(milestones)}
      value={value}
      valueLabel={valueLabel}
      onChange={onChange}
    />
  );
}

/** The estimate on the host's scale, with "No estimate". A current value
    outside the scale (set elsewhere) is listed first. */
export function EstimatePicker({
  estimates,
  value,
  onChange,
  label = 'Estimate',
  noneLabel = 'No estimate',
  placeholder = 'No estimate',
  searchPlaceholder = 'Set estimate…',
  ...rest
}: EstimatePickerProps): ReactNode {
  const options: PickerOption[] = estimates.map((choice) => ({
    value: String(choice.value),
    label: choice.label,
  }));
  if (value !== null && !estimates.some((choice) => choice.value === value)) {
    options.unshift({ value: String(value), label: String(value) });
  }
  return (
    <PickerPopover
      {...rest}
      label={label}
      noneLabel={noneLabel}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      options={options}
      value={value === null ? null : String(value)}
      onChange={(next) => {
        if (next === null) return onChange(null);
        const number = Number(next);
        return Number.isFinite(number) ? onChange(number) : undefined;
      }}
    />
  );
}
