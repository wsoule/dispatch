import type {
  Assignee,
  CreateInput,
  LabelDefinition,
  Priority,
  TaskKind,
  TaskListItem,
} from '@dispatch-foo/core/browser';
import {
  isContainerKind,
  isValidParentKind,
  labelRef,
} from '@dispatch-foo/core/browser';
import type { DraftRecord } from '@dispatch/client';
import {
  AssigneePicker,
  Button,
  Chip,
  cx,
  isHexColor,
  KbdKeys,
  type LabelChoice,
  LabelPicker,
  type PersonChoice,
  type PickerOption,
  PickerPopover,
  PriorityPicker,
  SegmentedControl,
  SlideOver,
  type StateChoice,
  StatePicker,
  Switch,
  useModKeyLabel,
} from '@dispatch/ui';
import { Bot, Inbox, Layers, Paperclip, Sparkles, X } from 'lucide-react';
import type {
  ClipboardEvent,
  DragEvent,
  KeyboardEvent,
  ReactNode,
  RefObject,
} from 'react';
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { AGENT_POOL_LABEL, AGENTS_GROUP } from '../../adapters/people';
import { fromTaskPriority, toTaskPriority } from '../../adapters/rows';
import { stateChoices } from '../../adapters/taskDetail';
import {
  BRAIN_DUMP_DRAFT_KEY,
  usePersistedDraft,
} from '../../hooks/usePersistedDraft';
import { filesFromDataTransfer, splitOversized } from '../../lib/attachments';
import { useActiveStatusModel } from '../../lib/statusModel';
import { assigneeLabel, kindLabel } from '../../lib/taskDisplay';
import { DaemonUnavailable } from '../shell/DaemonUnavailable';
import {
  type CreateTaskPreset,
  useShellActions,
} from '../shell/ShellActionsContext';
import { useToasts } from '../shell/Toasts';
import { ContainerIcon } from './page/ContainerIcon';
import styles from './TaskComposerSlideOver.module.css';

/** The persisted Quick add title and description: they survive an accidental close (Escape,
 * the scrim) and a relaunch — the two fields with real typing in them. */
export const CREATE_TASK_TITLE_KEY = 'dispatch:create-task-title';
export const CREATE_TASK_DESCRIPTION_KEY = 'dispatch:create-task-description';

/** Which form the composer shows: an agent-drafted task from a description, the structured
 * quick add, or a thought dropped into the Notes inbox. */
export type ComposerMode = 'describe' | 'quick' | 'capture';

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

// Fixed, non-config-driven enums — they mirror core/types.ts's constants rather than import
// them at runtime.
const KINDS: readonly TaskKind[] = [
  'task',
  'milestone',
  'project',
  'initiative',
];

/** The three assignee kinds the composer offers before a task exists: the agent pool, a
 * human, and nobody (the picker's none row). */
const ASSIGNEE_PEOPLE: readonly PersonChoice[] = [
  {
    id: 'agent',
    name: AGENT_POOL_LABEL,
    group: AGENTS_GROUP,
    mark: { kind: 'node', node: <Bot {...ICON} /> },
  },
  { id: 'human', name: assigneeLabel('human'), group: 'People' },
];

const KIND_OPTIONS: readonly PickerOption[] = KINDS.map((kind) => ({
  value: kind,
  label: kindLabel(kind),
  mark: {
    kind: 'node',
    node: <ContainerIcon kind={kind} icon={null} color={null} />,
  },
}));

const MODE_OPTIONS: readonly { id: ComposerMode; label: string }[] = [
  { id: 'describe', label: 'Describe' },
  { id: 'quick', label: 'Quick add' },
  { id: 'capture', label: 'Drop a thought' },
];

// One empty registry, so an absent `labelDefinitions` keeps the Labels choices memoised.
const NO_LABEL_DEFINITIONS: readonly LabelDefinition[] = [];

/** Whether focus has fallen out of the composer's controls: to nothing, to <body>, or to the
 * panel itself (where the slide-over parks focus a control dropped). A submit that ends
 * without closing moves focus back to its field only then, never away from a control the
 * person has since moved to. */
function focusLost(): boolean {
  const active = document.activeElement;
  return (
    active === null ||
    active === document.body ||
    (active instanceof HTMLElement && active.dataset.slot === 'task-composer')
  );
}

interface TaskComposerSlideOverProps {
  open: boolean;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  /** The project's configured statuses, in order: the Status picker's choices. */
  statuses: string[];
  /** Every container (a container kind, or an issue with sub-issues) — where a new task
   * can be filed. */
  epics: TaskListItem[];
  /** Every label in use across the project: the Labels picker's candidates. */
  labels: readonly string[];
  /** The project's label registry; only its hex colours are drawn (as swatches). */
  labelDefinitions?: readonly LabelDefinition[];
  /** The crumb's project (`<project> › New task`); the app name until a project is open. */
  projectName?: string;
  /** Pre-selects the status; the shell's `createPreset` fills the same slot. */
  initialStatus?: string;
  /** Resolves with the created doc so pending files can be attached to it; `undefined`
   * (what `withActionFeedback` yields on a failure it already toasted) or `null` keeps the
   * draft and the files for another try. */
  onCreate: (input: CreateInput) => Promise<TaskListItem | null | undefined>;
  /** The unwrapped draft start: rejects on failure so Describe keeps the prompt on screen
   * with an inline error. `parent` is the container the composer was opened in. */
  onDraft: (
    prompt: string,
    options?: { parent?: string | null }
  ) => Promise<DraftRecord>;
  /** The RAW capture handler (not the `withActionFeedback` wrapper, which swallows
   * rejections): a failed capture keeps the thought and shows the error inline. Omitted, the
   * "Drop a thought" mode is not offered. */
  onCapture?: (text: string) => Promise<void>;
  /** Given, Attach and paste/drop on the form collect files that are uploaded once the task
   * exists. */
  onUploadAttachments?: (taskId: string, files: File[]) => Promise<void>;
  /** Non-null while the daemon is down: Describe shows the starting/error/retry state. */
  daemon: {
    starting: boolean;
    errorDetail: unknown;
    onRetry: () => void;
  } | null;
  onClose: () => void;
}

/**
 * The one task composer (`c`, the palette's "New task", a group's "+", ⌘D): a modal
 * slide-over titled "New task" whose Mode control switches between Describe (an agent drafts
 * the task), Quick add (the structured form) and Drop a thought (the Notes inbox). Each open
 * starts a fresh session from the shell's `createPreset`; within it, every mode keeps its
 * state across mode switches. The persisted drafts survive a close either way.
 */
export function TaskComposerSlideOver(props: TaskComposerSlideOverProps) {
  // A new key per open, so a reopened composer reads the new createPreset and starts clean
  // (the old dialogs mounted per open); the same key while it slides out keeps its content.
  const [session, setSession] = useState(0);
  const [wasOpen, setWasOpen] = useState(props.open);
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    if (props.open) setSession((current) => current + 1);
  }
  return <ComposerPanel key={session} {...props} />;
}

function ComposerPanel({
  open,
  mode: requestedMode,
  onModeChange,
  statuses,
  epics,
  labels: labelsInUse,
  labelDefinitions = NO_LABEL_DEFINITIONS,
  projectName = 'Dispatch',
  initialStatus,
  onCreate,
  onDraft,
  onCapture,
  onUploadAttachments,
  daemon,
  onClose,
}: TaskComposerSlideOverProps) {
  const { createPreset } = useShellActions();
  const modKey = useModKeyLabel();
  // Without a capture handler the third mode is not offered, so it cannot be shown either.
  const mode: ComposerMode =
    requestedMode === 'capture' && onCapture === undefined
      ? 'describe'
      : requestedMode;
  // Only the shown mode's first field is mounted, so one ref names the field that takes
  // focus when the panel opens.
  const focusRef = useRef<HTMLElement | null>(null);
  const setFocusTarget = useCallback((el: HTMLElement | null) => {
    focusRef.current = el;
  }, []);
  // Back to the shown mode's field: after a landed "Create more", or (only when focus fell
  // out with a busy or removed control) after a submit that kept the panel open.
  const focusField = useCallback(() => {
    focusRef.current?.focus({ preventScroll: true });
  }, []);
  const refocusIfLost = useCallback(() => {
    if (focusLost()) focusField();
  }, [focusField]);
  // The container the task goes under, shared by Describe and Quick add: dropping it in one
  // drops it in the other.
  const [parent, setParent] = useState<string | null>(
    createPreset?.epic ?? null
  );

  const describe = useDescribe({
    parent,
    daemon,
    onDraft,
    onClose,
    onKept: refocusIfLost,
  });
  const quick = useQuickAdd({
    preset: createPreset,
    statuses,
    epics,
    initialStatus,
    parent,
    setParent,
    onCreate,
    onUploadAttachments,
    onClose,
    onCreatedMore: focusField,
    onKept: refocusIfLost,
  });
  const capture = useCapture({ onCapture, onClose, onKept: refocusIfLost });

  // ⌘/Ctrl+Enter submits the shown mode from any field or footer control (the body and the
  // footer each carry this handler); a key a field already consumed (a picker's Enter) is
  // skipped. Handled, it stops here, so a page listener behind the modal (a task drawer's own
  // ⌘⏎) never sees it, and a focused button (Create more) is not also pressed.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    event.stopPropagation();
    switch (mode) {
      case 'describe':
        describe.submit();
        break;
      case 'quick':
        quick.submit();
        break;
      case 'capture':
        capture.submit();
        break;
    }
  }

  function onPaste(event: ClipboardEvent<HTMLDivElement>) {
    if (mode !== 'quick') return;
    const files = filesFromDataTransfer(event.clipboardData);
    if (!quick.canAttach || files.length === 0) return;
    event.preventDefault();
    quick.addFiles(files);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (mode !== 'quick') return;
    const files = filesFromDataTransfer(event.dataTransfer);
    if (!quick.canAttach || files.length === 0) return;
    event.preventDefault();
    quick.addFiles(files);
  }

  const modeOptions = MODE_OPTIONS.filter(
    (option) => option.id !== 'capture' || onCapture !== undefined
  );
  const parentTitle =
    parent === null
      ? null
      : (epics.find((epic) => epic.meta.id === parent)?.meta.title ?? parent);
  // Drop a thought files nothing as a task: it keeps the old quick capture's own name and
  // its Notes crumb, so a screen reader hears what ⌘D opened.
  const heading = mode === 'capture' ? 'Quick capture' : 'New task';
  const crumbRoot = mode === 'capture' ? 'Notes' : projectName;

  let body: ReactNode;
  let footer: ReactNode;
  switch (mode) {
    case 'describe':
      body =
        daemon === null ? (
          <DescribeFields
            state={describe}
            parentTitle={parentTitle}
            onDropParent={() => {
              // The button goes with the chip: hand focus to the prompt first.
              focusField();
              setParent(null);
            }}
            modKey={modKey}
            fieldRef={setFocusTarget}
          />
        ) : (
          <DaemonUnavailable
            starting={daemon.starting}
            errorDetail={daemon.errorDetail}
            onRetry={daemon.onRetry}
          />
        );
      footer =
        daemon === null ? (
          <div className={styles.footerActions} onKeyDown={onKeyDown}>
            <Button
              variant="primary"
              icon={<Sparkles {...ICON} />}
              busy={describe.submitting}
              busyLabel="Starting…"
              disabled={describe.prompt.trim() === ''}
              onClick={() => describe.submit()}
            >
              Draft task
            </Button>
          </div>
        ) : null;
      break;
    case 'quick':
      body = (
        <QuickAddFields
          state={quick}
          epics={epics}
          labelsInUse={labelsInUse}
          labelDefinitions={labelDefinitions}
          fieldRef={setFocusTarget}
        />
      );
      footer = <QuickAddFooter state={quick} onKeyDown={onKeyDown} />;
      break;
    case 'capture':
      body = (
        <CaptureFields
          state={capture}
          modKey={modKey}
          fieldRef={setFocusTarget}
        />
      );
      footer = (
        <div className={styles.footerActions} onKeyDown={onKeyDown}>
          <Button
            variant="primary"
            icon={<Inbox {...ICON} />}
            disabled={capture.draft.trim() === '' || capture.busy}
            onClick={() => capture.submit()}
          >
            Drop it
          </Button>
        </div>
      );
      break;
  }

  return (
    <SlideOver
      open={open}
      onClose={onClose}
      modal
      title={heading}
      data-slot="task-composer"
      data-mode={mode}
      initialFocusRef={focusRef}
      breadcrumb={
        <span className={styles.crumb}>
          <span className={styles.crumbProject}>{crumbRoot}</span>
          <span aria-hidden="true">›</span>
          <span>{heading}</span>
        </span>
      }
      footer={footer}
    >
      {/* Paste and drop collect attachments in Quick add; ⌘⏎ submits any mode. */}
      <div
        className={styles.form}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={(event) => {
          if (mode === 'quick' && quick.canAttach) event.preventDefault();
        }}
      >
        <SegmentedControl
          label="Mode"
          size="sm"
          options={modeOptions.map(({ id, label }) => ({ id, label }))}
          value={mode}
          onChange={(id) => {
            const next = modeOptions.find((option) => option.id === id);
            if (next !== undefined) onModeChange(next.id);
          }}
        />
        {body}
      </div>
    </SlideOver>
  );
}

/* ---- Describe ------------------------------------------------------------ */

interface DescribeState {
  prompt: string;
  setPrompt: (next: string) => void;
  submitting: boolean;
  error: string | null;
  submit: () => void;
}

/** Describe's state: the prompt, the in-flight start and its inline error. Submitting starts
 * a background draft and closes at once (the drafts tray picks up its progress); a rejection
 * keeps the prompt and says why. */
function useDescribe({
  parent,
  daemon,
  onDraft,
  onClose,
  onKept,
}: {
  parent: string | null;
  daemon: TaskComposerSlideOverProps['daemon'];
  onDraft: TaskComposerSlideOverProps['onDraft'];
  onClose: () => void;
  /** A rejected draft keeps the panel open: focus goes back to the prompt if it fell out. */
  onKept: () => void;
}): DescribeState {
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards a second ⌘⏎ in the same tick, before `submitting` re-renders.
  const inFlight = useRef(false);

  function submit() {
    const text = prompt.trim();
    if (text === '' || daemon !== null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    void (async () => {
      try {
        await onDraft(text, parent === null ? undefined : { parent });
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        onKept();
      } finally {
        inFlight.current = false;
        setSubmitting(false);
      }
    })();
  }

  return { prompt, setPrompt, submitting, error, submit };
}

function DescribeFields({
  state,
  parentTitle,
  onDropParent,
  modKey,
  fieldRef,
}: {
  state: DescribeState;
  parentTitle: string | null;
  onDropParent: () => void;
  modKey: string;
  fieldRef: (el: HTMLElement | null) => void;
}) {
  return (
    <>
      <textarea
        ref={fieldRef}
        className={cx('textarea', styles.prompt)}
        aria-label="Describe the task"
        placeholder="What should change, and how you'll know it's done…"
        rows={6}
        value={state.prompt}
        // Read-only rather than disabled while the draft starts, so focus stays in the field
        // (a disabled field drops it to <body>) and a refusal leaves the caret where it was.
        readOnly={state.submitting}
        aria-busy={state.submitting ? 'true' : undefined}
        onChange={(event) => state.setPrompt(event.target.value)}
      />
      {parentTitle !== null && (
        <span data-slot="draft-parent" className={styles.draftParent}>
          <Chip>
            <span className={styles.chipBody}>
              <Layers {...ICON} />
              <span className={styles.chipText}>In {parentTitle}</span>
            </span>
          </Chip>
          <Button
            variant="quiet"
            size="sm"
            icon={<X {...ICON} />}
            aria-label={`Not in ${parentTitle}`}
            onClick={onDropParent}
          />
        </span>
      )}
      {state.error !== null && (
        <p role="alert" className={styles.error} data-tone="danger">
          {state.error}
        </p>
      )}
      <p className={styles.hint}>
        <KbdKeys keys={[modKey, '↵']} />
        <span>to draft — nothing is created until you review it.</span>
      </p>
    </>
  );
}

/* ---- Quick add ------------------------------------------------------------ */

interface QuickAddState {
  title: string;
  setTitle: (next: string) => void;
  description: string;
  setDescription: (next: string) => void;
  kind: TaskKind;
  changeKind: (next: TaskKind) => void;
  priority: Priority;
  setPriority: (next: Priority) => void;
  assignee: Assignee;
  setAssignee: (next: Assignee) => void;
  status: string;
  setStatus: (next: string) => void;
  states: readonly StateChoice[];
  parent: string | null;
  setParent: (next: string | null) => void;
  labels: readonly string[];
  setLabels: (next: string[]) => void;
  createdLabels: readonly string[];
  createLabel: (name: string) => void;
  pendingFiles: readonly File[];
  removeFile: (index: number) => void;
  addFiles: (files: File[]) => void;
  canAttach: boolean;
  /** The footer's Attach button: where focus goes when the last pending file is removed. */
  attachRef: RefObject<HTMLButtonElement | null>;
  createMore: boolean;
  setCreateMore: (next: boolean) => void;
  submitting: boolean;
  canSubmit: boolean;
  submit: (asStatus?: string) => void;
}

/** The Status picker's choices: the project's configured statuses in order, each with its
 * workflow type from the active status model (a status the model lacks still gets one). */
function composerStates(
  statuses: readonly string[],
  model: ReturnType<typeof useActiveStatusModel>
): StateChoice[] {
  const defined = new Map(
    stateChoices(model).map((choice) => [choice.id, choice])
  );
  return statuses.flatMap((status) => {
    const choice =
      defined.get(status) ??
      stateChoices(model, status).find((c) => c.id === status);
    return choice === undefined ? [] : [choice];
  });
}

/** Quick add's state: the persisted title and description, the properties, the files
 * queued for upload, and the create itself. */
function useQuickAdd({
  preset,
  statuses,
  epics,
  initialStatus,
  parent,
  setParent,
  onCreate,
  onUploadAttachments,
  onClose,
  onCreatedMore,
  onKept,
}: {
  preset: CreateTaskPreset | null;
  statuses: readonly string[];
  epics: readonly TaskListItem[];
  initialStatus: string | undefined;
  parent: string | null;
  setParent: (next: string | null) => void;
  onCreate: TaskComposerSlideOverProps['onCreate'];
  onUploadAttachments: TaskComposerSlideOverProps['onUploadAttachments'];
  onClose: () => void;
  /** A landed create with "Create more" on: focus goes to the cleared title. */
  onCreatedMore: () => void;
  /** A create that did not land keeps the panel: focus goes back to the title if it fell
   * out (the busy Create task button drops it). */
  onKept: () => void;
}): QuickAddState {
  const toasts = useToasts();
  const model = useActiveStatusModel();
  const [title, setTitle] = usePersistedDraft(CREATE_TASK_TITLE_KEY);
  const [description, setDescription] = usePersistedDraft(
    CREATE_TASK_DESCRIPTION_KEY
  );
  const [kind, setKind] = useState<TaskKind>(preset?.kind ?? 'task');
  const [priority, setPriority] = useState<Priority>('none');
  const [assignee, setAssignee] = useState<Assignee>('none');
  const [status, setStatus] = useState(
    initialStatus ?? preset?.status ?? statuses[0] ?? 'backlog'
  );
  const [labels, setLabels] = useState<string[]>([]);
  // Labels made from the picker's search box this session, so they are listed (and shown
  // chosen) before any task carries them.
  const [createdLabels, setCreatedLabels] = useState<string[]>([]);
  // Files chosen before the task exists; uploaded against its id once created.
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [createMore, setCreateMore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const attachRef = useRef<HTMLButtonElement | null>(null);
  const states = useMemo(
    () => composerStates(statuses, model),
    [statuses, model]
  );

  const canAttach = onUploadAttachments !== undefined;
  const canSubmit = title.trim() !== '' && !submitting;

  // Queues files for the upload after create; the ones over the daemon's cap get one toast
  // now rather than a 413 later.
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

  // A broader kind can outgrow its parent (a project cannot sit in a milestone), so a parent
  // the new kind cannot live under is dropped rather than sent to be refused.
  function changeKind(next: TaskKind) {
    setKind(next);
    const current = epics.find((epic) => epic.meta.id === parent);
    if (current !== undefined && !isValidParentKind(next, current.meta.kind)) {
      setParent(null);
    }
  }

  function createLabel(name: string) {
    setCreatedLabels((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setLabels((prev) => (prev.includes(name) ? prev : [...prev, name]));
  }

  // `asStatus` overrides the picker for "Save as draft". Only a landed create clears the
  // persisted title and description; with "Create more" the panel stays open with the
  // properties kept for the next one, and focus goes to the cleared title. The task exists
  // before its files are sent, so a failed upload is a toast per file rather than a failed
  // create. Resolves whether the panel stays open with the same draft.
  async function create(asStatus: string): Promise<boolean> {
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
      // No doc means the create did not happen (`withActionFeedback` toasted and swallowed
      // it, or there is no client yet): keep the draft and the files for another try.
      if (created === undefined || created === null) return true;
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
      if (createMore) onCreatedMore();
      else onClose();
      return false;
    } catch (err) {
      toasts.push({
        tone: 'error',
        title: 'Could not create task',
        description: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }

  function submit(asStatus: string = status) {
    if (title.trim() === '' || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    void create(asStatus).then((kept) => {
      inFlight.current = false;
      setSubmitting(false);
      if (kept) onKept();
    });
  }

  return {
    title,
    setTitle,
    description,
    setDescription,
    kind,
    changeKind,
    priority,
    setPriority,
    assignee,
    setAssignee,
    status,
    setStatus,
    states,
    parent,
    setParent,
    labels,
    setLabels,
    createdLabels,
    createLabel,
    pendingFiles,
    removeFile: (index) =>
      setPendingFiles((prev) => prev.filter((_, i) => i !== index)),
    addFiles,
    canAttach,
    attachRef,
    createMore,
    setCreateMore,
    submitting,
    canSubmit,
    submit,
  };
}

// Where a new task of `kind` may be filed: containers broad enough to hold it, then issues
// that already have sub-issues, archived ones left out — the rail's "Move to" rule.
function parentOptions(
  kind: TaskKind,
  epics: readonly TaskListItem[]
): PickerOption[] {
  const containers: TaskListItem[] = [];
  const parents: TaskListItem[] = [];
  for (const epic of epics) {
    if (epic.meta.archivedAt !== undefined) continue;
    if (!isValidParentKind(kind, epic.meta.kind)) continue;
    if (isContainerKind(epic.meta.kind)) containers.push(epic);
    else parents.push(epic);
  }
  return [...containers, ...parents].map((epic) => ({
    value: epic.meta.id,
    label: epic.meta.title,
    hint: kindLabel(epic.meta.kind),
    mark: {
      kind: 'node',
      node: (
        <ContainerIcon
          kind={epic.meta.kind}
          icon={epic.meta.icon}
          color={epic.meta.color}
        />
      ),
    },
  }));
}

/** The Labels picker's choices: every label in use, every registry label and every label
 * made this session, sorted, each with its registry colour as a swatch when that colour is a
 * hex value (no mark otherwise). */
function composerLabelChoices(
  inUse: readonly string[],
  definitions: readonly LabelDefinition[],
  extra: readonly string[]
): LabelChoice[] {
  const colors = new Map<string, string>();
  for (const definition of definitions) {
    if (definition.color !== null && isHexColor(definition.color)) {
      colors.set(labelRef(definition), definition.color);
    }
  }
  const names = new Set([
    ...inUse,
    ...definitions.map((definition) => labelRef(definition)),
    ...extra,
  ]);
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const color = colors.get(name);
      return color === undefined
        ? { id: name, name }
        : { id: name, name, color };
    });
}

function QuickAddFields({
  state,
  epics,
  labelsInUse,
  labelDefinitions,
  fieldRef,
}: {
  state: QuickAddState;
  epics: readonly TaskListItem[];
  labelsInUse: readonly string[];
  labelDefinitions: readonly LabelDefinition[];
  fieldRef: (el: HTMLElement | null) => void;
}) {
  const parentTitle =
    state.parent === null
      ? undefined
      : epics.find((epic) => epic.meta.id === state.parent)?.meta.title;
  // Built once per input change, not on every keystroke in the title: a project can hold
  // hundreds of containers and labels.
  const { kind, createdLabels, labels: chosenLabels } = state;
  const parentChoices = useMemo(
    () => parentOptions(kind, epics),
    [kind, epics]
  );
  const labelChoices = useMemo(
    () =>
      composerLabelChoices(labelsInUse, labelDefinitions, [
        ...createdLabels,
        ...chosenLabels,
      ]),
    [labelsInUse, labelDefinitions, createdLabels, chosenLabels]
  );

  // A removed file's chip takes its own remove button with it: focus moves to the next
  // file's (or the previous one's, or Attach once none is left) after the list re-renders.
  const attachmentsRef = useRef<HTMLDivElement | null>(null);
  const removedAt = useRef<number | null>(null);
  const { pendingFiles, attachRef } = state;
  useLayoutEffect(() => {
    const at = removedAt.current;
    if (at === null) return;
    removedAt.current = null;
    const buttons =
      attachmentsRef.current?.querySelectorAll<HTMLButtonElement>('button') ??
      [];
    const next =
      buttons.length === 0 ? null : buttons[Math.min(at, buttons.length - 1)];
    (next ?? attachRef.current)?.focus({ preventScroll: true });
  }, [pendingFiles, attachRef]);

  return (
    <>
      <input
        ref={fieldRef}
        className={cx('input', styles.title)}
        aria-label="Task title"
        placeholder="Task title"
        value={state.title}
        onChange={(event) => state.setTitle(event.target.value)}
      />
      <textarea
        className={cx('textarea', styles.description)}
        aria-label="Description"
        placeholder="Add description…"
        rows={4}
        value={state.description}
        onChange={(event) => state.setDescription(event.target.value)}
      />
      {state.pendingFiles.length > 0 && (
        <div
          ref={attachmentsRef}
          data-slot="pending-attachments"
          className={styles.attachments}
        >
          {state.pendingFiles.map((file, index) => (
            <span key={`${file.name}-${index}`} className={styles.attachment}>
              <Chip>
                <span className={styles.chipBody}>
                  <Paperclip {...ICON} />
                  <span className={styles.chipText}>{file.name}</span>
                </span>
              </Chip>
              <Button
                variant="quiet"
                size="sm"
                icon={<X {...ICON} />}
                aria-label={`Remove ${file.name}`}
                onClick={() => {
                  removedAt.current = index;
                  state.removeFile(index);
                }}
              />
            </span>
          ))}
        </div>
      )}
      <div className={styles.properties}>
        <StatePicker
          label="Status"
          states={state.states}
          value={state.status}
          onChange={(next) => state.setStatus(next)}
        />
        <PriorityPicker
          label="Priority"
          appearance="mono"
          value={toTaskPriority(state.priority)}
          onChange={(next) => state.setPriority(fromTaskPriority(next))}
        />
        <AssigneePicker
          label="Assignee"
          appearance="mono"
          people={ASSIGNEE_PEOPLE}
          placeholderTone="muted"
          value={state.assignee === 'none' ? null : state.assignee}
          onChange={(next) => state.setAssignee(next ?? 'none')}
        />
        <PickerPopover
          label="Kind"
          appearance="mono"
          searchable={false}
          options={KIND_OPTIONS}
          value={state.kind}
          onChange={(next) => {
            const kind = KINDS.find((candidate) => candidate === next);
            if (kind !== undefined) state.changeKind(kind);
          }}
        />
        <PickerPopover
          label="Parent"
          appearance="mono"
          noneLabel="No parent"
          placeholder="No parent"
          searchPlaceholder="Project, milestone or issue…"
          options={parentChoices}
          value={state.parent}
          valueLabel={parentTitle}
          onChange={(next) => state.setParent(next)}
        />
        <LabelPicker
          label="Labels"
          appearance="mono"
          labelOptions={labelChoices}
          value={state.labels}
          onChange={(next) => state.setLabels(next)}
          onCreate={(query) => state.createLabel(query)}
        />
      </div>
    </>
  );
}

function QuickAddFooter({
  state,
  onKeyDown,
}: {
  state: QuickAddState;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className={styles.footerRow} onKeyDown={onKeyDown}>
      <div className={styles.footerLead}>
        <Button
          ref={state.attachRef}
          variant="quiet"
          size="sm"
          icon={<Paperclip {...ICON} />}
          aria-label="Attach"
          disabled={!state.canAttach}
          onClick={() => fileInputRef.current?.click()}
        />
        {state.canAttach && (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = '';
              state.addFiles(files);
            }}
          />
        )}
      </div>
      <div className={styles.footerActions}>
        <Switch
          label="Create more"
          checked={state.createMore}
          onChange={(next) => state.setCreateMore(next)}
        />
        {state.title.trim() !== '' && (
          <Button
            variant="quiet"
            disabled={state.submitting}
            onClick={() => state.submit('draft')}
          >
            Save as draft
          </Button>
        )}
        <Button
          variant="primary"
          busy={state.submitting}
          busyLabel="Creating…"
          disabled={!state.canSubmit}
          onClick={() => state.submit()}
        >
          Create task
        </Button>
      </div>
    </div>
  );
}

/* ---- Drop a thought ------------------------------------------------------- */

interface CaptureState {
  draft: string;
  setDraft: (next: string) => void;
  busy: boolean;
  error: string | null;
  submit: () => void;
}

/** Drop a thought's state: the persisted brain-dump draft (shared with the full view), the
 * in-flight capture and its inline error. The draft is only dropped once it has landed. */
function useCapture({
  onCapture,
  onClose,
  onKept,
}: {
  onCapture: TaskComposerSlideOverProps['onCapture'];
  onClose: () => void;
  /** A failed capture keeps the panel: focus goes back to the box if the busy Drop it
   * button dropped it. */
  onKept: () => void;
}): CaptureState {
  const [draft, setDraft] = usePersistedDraft(BRAIN_DUMP_DRAFT_KEY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A rapid double ⌘⏎ must not capture the same draft twice.
  const inFlight = useRef(false);

  function submit() {
    if (onCapture === undefined || draft.trim() === '' || inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await onCapture(draft);
        setDraft('');
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        onKept();
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    })();
  }

  return { draft, setDraft, busy, error, submit };
}

function CaptureFields({
  state,
  modKey,
  fieldRef,
}: {
  state: CaptureState;
  modKey: string;
  fieldRef: (el: HTMLElement | null) => void;
}) {
  // The hint is the box's description: where a dropped thought goes.
  const hintId = useId();
  return (
    <>
      <textarea
        ref={fieldRef}
        className={cx('textarea', styles.prompt)}
        aria-label="Quick capture"
        aria-describedby={hintId}
        placeholder="Dump it here…"
        rows={5}
        value={state.draft}
        onChange={(event) => state.setDraft(event.target.value)}
      />
      {state.error !== null && (
        <p role="alert" className={styles.error} data-tone="danger">
          {state.error}
        </p>
      )}
      <p id={hintId} className={styles.hint}>
        <KbdKeys keys={[modKey, '↵']} />
        <span>to drop it into the Notes inbox, one thought per line.</span>
      </p>
    </>
  );
}
