import type {
  Assignee,
  CreateInput,
  Priority,
  TaskKind,
  TaskListItem,
} from '@dispatch-foo/core/browser';
import { isContainerKind, isValidParentKind } from '@dispatch-foo/core/browser';
import {
  Box,
  Check,
  ChevronDown,
  CircleDot,
  Diamond,
  Layers,
  type LucideIcon,
  Paperclip,
  SquareCheck,
  Tag,
  Target,
  X,
} from 'lucide-react';
import type {
  ClipboardEvent,
  DragEvent,
  KeyboardEvent,
  ReactNode,
} from 'react';
import { useRef, useState } from 'react';

import { usePersistedDraft } from '../../hooks/usePersistedDraft';
import { filesFromDataTransfer, splitOversized } from '../../lib/attachments';
import { colorForLabel } from '../../lib/labelColor';
import {
  assigneeLabel,
  kindLabel,
  priorityLabel,
  statusLabel,
} from '../../lib/taskDisplay';
import { useShellActions } from '../shell/ShellActionsContext';
import { useToasts } from '../shell/Toasts';
import { AssigneeAvatar } from './AssigneeAvatar';
import { type PickerItem, PickerPopover } from './detail/PickerPopover';
import { PriorityIcon } from './PriorityIcon';
import { StatusIcon } from './StatusIcon';
import { cn } from '@/lib/utils';
import { IconButton } from '@/ui/ai/icon-button';
import { Pill, PILL_BUTTON_CLASS, SelectPill } from '@/ui/ai/pill';
import { Switch } from '@/ui/ai/switch';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogBody,
  DialogChrome,
  DialogContent,
  DialogFooter,
} from '@/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';

// Fixed, non-config-driven enums — see TaskDetailModal.tsx for why these
// mirror core/types.ts's constants instead of importing them at runtime.
const KINDS: TaskKind[] = ['task', 'milestone', 'project', 'initiative'];
const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];
const ASSIGNEES: Assignee[] = ['agent', 'human', 'none'];

// Picker values can't be the empty string, so this stands in for the "no parent" choice and
// is mapped back to `null` at the onSelect boundary.
const NO_PARENT = '__none__';

// The glyph each kind wears in the parent picker, as in the task rail's hierarchy.
const KIND_ICON: Record<string, LucideIcon> = {
  initiative: Target,
  project: Box,
  milestone: Diamond,
  task: CircleDot,
};

export const CREATE_TASK_TITLE_KEY = 'dispatch:create-task-title';
export const CREATE_TASK_DESCRIPTION_KEY = 'dispatch:create-task-description';

interface CreateTaskModalProps {
  statuses: string[];
  /** Every container (a container kind, or an issue with sub-issues) — where a new task
   * can be filed. */
  epics: TaskListItem[];
  /** The crumb's project chip (`[project] › New task`); the app name until a project is open. */
  projectName?: string;
  /** Pre-selects the status — kept for callers that pass it directly; the shell's
   * `createPreset` (a `+` on a status group or board column) fills the same slot. */
  initialStatus?: string;
  /** Every label used anywhere in the project — the Labels chip's picker candidates. */
  labels?: readonly string[];
  /** Resolves with the created doc so pending files can be attached to it; `undefined`
   * (what `withActionFeedback` yields on a failure it already toasted) or `null` leaves
   * the dialog open with its draft and files intact. */
  onCreate: (input: CreateInput) => Promise<TaskListItem | null | undefined>;
  /** Given, the footer paperclip and paste/drop on the body collect files that are
   * uploaded once the task exists. */
  onUploadAttachments?: (taskId: string, files: File[]) => Promise<void>;
  onClose: () => void;
}

// The `Labels` chip: a `SelectPill` face over the same colour-dotted multi-select the rail's
// `LabelsControl` opens, so a label picked here reads exactly as it will on the task.
function LabelsChip({
  value,
  candidates,
  onChange,
}: {
  value: string[];
  candidates: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const unset = value.length === 0;
  const items = [...new Set([...candidates, ...value])].sort().map((label) => ({
    value: label,
    label,
    glyph: (
      <span
        aria-hidden
        data-slot="label-dot"
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: colorForLabel(label) }}
      />
    ),
    selected: value.includes(label),
  }));
  function toggle(label: string) {
    onChange(
      value.includes(label)
        ? value.filter((l) => l !== label)
        : [...value, label]
    );
  }
  function create(text: string) {
    const label = text.trim();
    if (label === '' || value.includes(label)) return;
    onChange([...value, label]);
  }
  return (
    <PickerPopover
      triggerLabel="Labels"
      triggerClassName={cn(PILL_BUTTON_CLASS, unset && 'text-muted-foreground')}
      placeholder="Label…"
      items={items}
      onSelect={toggle}
      onCreate={create}
      emptyLabel="Type a new label."
      closeOnSelect={false}
    >
      <Tag />
      <span className="min-w-0 truncate">
        {unset ? 'Labels' : value.join(', ')}
      </span>
      <ChevronDown
        aria-hidden
        className="text-muted-foreground size-3"
        strokeWidth={2}
      />
    </PickerPopover>
  );
}

interface ChipOption {
  value: string;
  label: string;
  glyph: ReactNode;
}

// One 28px property chip: a `SelectPill` whose menu lists the options with their 14px glyph
// and a 12px check on the current one. `unset` chips read as the property's name in muted
// text (`Priority`, `Assignee`), the way Linear's new-issue chips do before a value is picked.
function PropertyChip({
  value,
  options,
  onChange,
  label,
  menuTitle,
  unset = false,
}: {
  value: string;
  options: ChipOption[];
  onChange: (value: string) => void;
  /** The chip's accessible name and its text while `unset`. */
  label: string;
  menuTitle: string;
  unset?: boolean;
}) {
  const selected = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        data-slot="property-chip"
        data-unset={unset || undefined}
        render={
          <SelectPill
            icon={selected?.glyph}
            className={unset ? 'text-muted-foreground' : undefined}
          />
        }
      >
        {unset ? label : (selected?.label ?? value)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 min-w-[184px]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{menuTitle}</DropdownMenuLabel>
          {options.map((o) => (
            <DropdownMenuItem
              key={o.value}
              onClick={() => onChange(o.value)}
              data-selected={o.value === value || undefined}
            >
              {o.glyph}
              <span className="truncate">{o.label}</span>
              {o.value === value && (
                <Check className="ml-auto size-3" aria-label="Selected" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Where a new task of `kind` may be filed: containers broad enough to hold it, then issues
// that already have sub-issues, archived ones left out — the rail's "Move to" rule.
function parentOptions(
  kind: TaskKind,
  epics: readonly TaskListItem[]
): TaskListItem[] {
  const containers: TaskListItem[] = [];
  const parents: TaskListItem[] = [];
  for (const epic of epics) {
    if (epic.meta.archivedAt !== undefined) continue;
    if (!isValidParentKind(kind, epic.meta.kind)) continue;
    if (isContainerKind(epic.meta.kind)) containers.push(epic);
    else parents.push(epic);
  }
  return [...containers, ...parents];
}

// The `Parent` chip: the container the task is filed under, picked from a searchable list
// so a project with hundreds of milestones and parent issues stays one keystroke away.
function ParentChip({
  value,
  kind,
  epics,
  onChange,
}: {
  value: string | null;
  kind: TaskKind;
  epics: readonly TaskListItem[];
  onChange: (parent: string | null) => void;
}) {
  const selected =
    value === null ? undefined : epics.find((e) => e.meta.id === value);
  const Icon =
    selected === undefined
      ? Layers
      : (KIND_ICON[selected.meta.kind] ?? CircleDot);
  const items = (): PickerItem[] => [
    ...(value === null
      ? []
      : [
          {
            value: NO_PARENT,
            label: 'No parent',
            glyph: <X className="size-3.5" />,
          },
        ]),
    ...parentOptions(kind, epics).map((epic) => {
      const Glyph = KIND_ICON[epic.meta.kind] ?? CircleDot;
      return {
        value: epic.meta.id,
        label: epic.meta.title,
        hint: kindLabel(epic.meta.kind),
        glyph: <Glyph className="size-3.5" />,
        selected: epic.meta.id === value,
      };
    }),
  ];
  return (
    <PickerPopover
      triggerLabel="Parent"
      triggerClassName={cn(
        PILL_BUTTON_CLASS,
        value === null && 'text-muted-foreground'
      )}
      placeholder="Project, milestone or issue…"
      items={items}
      limit={50}
      onSelect={(next) => onChange(next === NO_PARENT ? null : next)}
    >
      <Icon />
      <span className="min-w-0 truncate">
        {value === null ? 'Parent' : (selected?.meta.title ?? value)}
      </span>
      <ChevronDown
        aria-hidden
        className="text-muted-foreground size-3"
        strokeWidth={2}
      />
    </PickerPopover>
  );
}

/**
 * Linear's new-issue dialog (§9): a ~1024px sheet near the top of the window with a crumb
 * header, a borderless 18px title over a 15px description, a row of 28px property chips,
 * and a footer with `Create more` + the indigo `Create task`. Title is the only required
 * field; `⌘⏎` creates, `Save as draft` files it under `draft`, and `Create more` keeps the
 * dialog open with the properties intact for the next one.
 */
export function CreateTaskModal({
  statuses,
  epics,
  projectName = 'Dispatch',
  initialStatus,
  labels: labelCatalogue = [],
  onCreate,
  onUploadAttachments,
  onClose,
}: CreateTaskModalProps) {
  const { createPreset } = useShellActions();
  const toasts = useToasts();
  // Title and description survive an accidental close (Escape, outside click) — the two
  // fields with real typing in them. The chips cost one click to redo and stay ephemeral.
  const [title, setTitle] = usePersistedDraft(CREATE_TASK_TITLE_KEY);
  const [description, setDescription] = usePersistedDraft(
    CREATE_TASK_DESCRIPTION_KEY
  );
  const [kind, setKind] = useState<TaskKind>(createPreset?.kind ?? 'task');
  const [priority, setPriority] = useState<Priority>('none');
  const [assignee, setAssignee] = useState<Assignee>('none');
  const [status, setStatus] = useState(
    initialStatus ?? createPreset?.status ?? statuses[0] ?? 'backlog'
  );
  const [parent, setParent] = useState<string | null>(
    createPreset?.epic ?? null
  );
  const [labels, setLabels] = useState<string[]>([]);
  // Files chosen before the task exists; uploaded against its id once created.
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [createMore, setCreateMore] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = title.trim() !== '' && !submitting;
  const canAttach = onUploadAttachments !== undefined;

  // Queues files for the upload after create; the ones over the daemon's cap get one
  // toast now rather than a 413 later.
  function addFiles(files: File[]) {
    if (!canAttach || files.length === 0) return;
    const { accepted, rejected } = splitOversized(files);
    if (rejected.length > 0) {
      toasts.push({
        tone: 'error',
        title: 'File too large',
        description: `${rejected.map((f) => f.name).join(', ')} — the limit is 25 MB`,
      });
    }
    if (accepted.length > 0) setPendingFiles((prev) => [...prev, ...accepted]);
  }

  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    const files = filesFromDataTransfer(e.clipboardData);
    if (!canAttach || files.length === 0) return;
    e.preventDefault();
    addFiles(files);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    const files = filesFromDataTransfer(e.dataTransfer);
    if (!canAttach || files.length === 0) return;
    e.preventDefault();
    addFiles(files);
  }

  // `asStatus` overrides the chip for `Save as draft`. Only a landed create clears the
  // persisted title/description; with `Create more` the dialog stays open for the next one.
  // The task exists before its files are sent, so a failed upload is a toast per file
  // rather than a failed create.
  async function submit(asStatus: string = status) {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const created = await onCreate({
        title: title.trim(),
        kind,
        priority,
        assignee,
        status: asStatus,
        parent,
        labels,
        description,
      });
      // No doc means the create did not happen (`withActionFeedback` toasted
      // and swallowed it, or there is no client yet): keep the draft and the
      // chosen files in place for another try.
      if (created === undefined || created === null) return;
      if (onUploadAttachments !== undefined) {
        for (const file of pendingFiles) {
          try {
            await onUploadAttachments(created.meta.id, [file]);
          } catch (err) {
            toasts.push({
              tone: 'error',
              title: `Could not attach ${file.name}`,
              description: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      setTitle('');
      setDescription('');
      setPendingFiles([]);
      if (!createMore) onClose();
    } catch (err) {
      toasts.push({
        tone: 'error',
        title: 'Could not create task',
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  }

  // A broader kind can outgrow its parent (a project cannot sit in a milestone), so a
  // parent the new kind cannot live under is dropped rather than sent to be refused.
  function changeKind(next: TaskKind) {
    setKind(next);
    const current = epics.find((e) => e.meta.id === parent);
    if (current !== undefined && !isValidParentKind(next, current.meta.kind)) {
      setParent(null);
    }
  }

  // `⌘⏎` from any field creates; a chip input that already consumed its Enter is skipped.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  }

  const statusOptions: ChipOption[] = statuses.map((s) => ({
    value: s,
    label: statusLabel(s),
    glyph: <StatusIcon status={s} />,
  }));
  const priorityOptions: ChipOption[] = PRIORITIES.map((p) => ({
    value: p,
    label: priorityLabel(p),
    glyph: <PriorityIcon priority={p} />,
  }));
  const assigneeOptions: ChipOption[] = ASSIGNEES.map((a) => ({
    value: a,
    label: assigneeLabel(a),
    glyph: <AssigneeAvatar assignee={a} size={16} />,
  }));
  const kindOptions: ChipOption[] = KINDS.map((k) => ({
    value: k,
    label: kindLabel(k),
    glyph: k === 'task' ? <SquareCheck /> : <Layers />,
  }));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-label="New task"
        showCloseButton={false}
        onKeyDown={onKeyDown}
        className={
          expanded
            ? 'top-[4%] w-[min(1400px,96vw)] max-w-none translate-y-0 sm:max-w-none'
            : 'top-[12%] w-[min(1024px,92vw)] max-w-none translate-y-0 sm:max-w-none'
        }
      >
        <DialogChrome
          expanded={expanded}
          onExpand={() => setExpanded((v) => !v)}
        >
          <Pill>{projectName}</Pill>
          <span aria-hidden>›</span>
          <span className="text-(--text-secondary)">New task</span>
        </DialogChrome>

        <DialogBody
          className="gap-2 pt-1 pb-4"
          onPaste={onPaste}
          onDrop={onDrop}
          onDragOver={(e) => {
            if (canAttach) e.preventDefault();
          }}
        >
          <Input
            variant="borderless"
            aria-label="Task title"
            placeholder="Task title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            className="text-[18px] leading-7 font-medium"
          />
          <Textarea
            variant="borderless"
            aria-label="Description"
            placeholder="Add description…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={
              expanded
                ? 'min-h-[240px] text-[15px] leading-6'
                : 'min-h-[72px] text-[15px] leading-6'
            }
          />
          {pendingFiles.length > 0 && (
            <div
              data-slot="pending-attachments"
              className="flex flex-wrap items-center gap-1.5"
            >
              {pendingFiles.map((file, index) => (
                <Pill key={`${file.name}-${index}`}>
                  <Paperclip />
                  <span className="max-w-[240px] truncate">{file.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() =>
                      setPendingFiles((prev) =>
                        prev.filter((_, i) => i !== index)
                      )
                    }
                    className="text-muted-foreground hover:text-foreground -mr-1 flex size-3.5 items-center justify-center"
                  >
                    <X className="size-2.5" />
                  </button>
                </Pill>
              ))}
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <PropertyChip
              value={status}
              options={statusOptions}
              onChange={setStatus}
              label="Status"
              menuTitle="Change status"
            />
            <PropertyChip
              value={priority}
              options={priorityOptions}
              onChange={(v) => setPriority(v as Priority)}
              label="Priority"
              menuTitle="Change priority"
              unset={priority === 'none'}
            />
            <PropertyChip
              value={assignee}
              options={assigneeOptions}
              onChange={(v) => setAssignee(v)}
              label="Assignee"
              menuTitle="Assign to"
              unset={assignee === 'none'}
            />
            <LabelsChip
              value={labels}
              candidates={labelCatalogue}
              onChange={setLabels}
            />
            <ParentChip
              value={parent}
              kind={kind}
              epics={epics}
              onChange={setParent}
            />
            <PropertyChip
              value={kind}
              options={kindOptions}
              onChange={(v) => changeKind(v as TaskKind)}
              label="Kind"
              menuTitle="Kind"
            />
          </div>
        </DialogBody>

        <DialogFooter
          className="shadow-hairline-top"
          leading={
            <>
              <IconButton
                label="Attach"
                disabled={!canAttach}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip />
              </IconButton>
              {canAttach && (
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  aria-hidden
                  tabIndex={-1}
                  onChange={(e) => {
                    const files = Array.from(e.currentTarget.files ?? []);
                    e.currentTarget.value = '';
                    addFiles(files);
                  }}
                />
              )}
            </>
          }
        >
          <Switch
            label="Create more"
            checked={createMore}
            onCheckedChange={(next) => setCreateMore(next)}
          />
          {title.trim() !== '' && (
            <Button
              variant="ghost"
              disabled={submitting}
              onClick={() => void submit('draft')}
            >
              Save as draft
            </Button>
          )}
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            Create task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
