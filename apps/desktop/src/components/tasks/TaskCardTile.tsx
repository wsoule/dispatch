import type {
  StatusModel,
  TaskListItem,
  UpdatePatch,
} from '@dispatch-foo/core/browser';
import { statusType } from '@dispatch-foo/core/browser';
import type {
  MergeQueueEntryState,
  ReadinessReading,
  RunMeta,
  RunState,
} from '@dispatch/client';
import {
  AssigneePicker,
  Button,
  Chip,
  cx,
  type LabelChoice,
  LabelPicker,
  type PersonChoice,
  PriorityGlyph,
  PriorityPicker,
  Spinner,
  type StateChoice,
  StatePicker,
} from '@dispatch/ui';
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from '@dnd-kit/core';
import { ArrowRight, Bot } from 'lucide-react';
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { AGENTS_GROUP, buildPersonChoices } from '../../adapters/people';
import { fromTaskPriority, toTaskPriority } from '../../adapters/rows';
import { labelChoices } from '../../adapters/taskDetail';
import { readinessBadges } from '../../lib/judgmentBadges';
import {
  type LabelColors,
  labelColors,
  subscribeLabelColors,
} from '../../lib/labelColor';
import { useActiveStatusModel } from '../../lib/statusModel';
import { formatCreated } from '../../lib/taskDates';
import { assigneeLabel, assigneeRef, statusLabel } from '../../lib/taskDisplay';
import { TASK_PROPERTIES, type TaskProperty } from '../../lib/tasksPrefs';
import { type PeopleDirectory, usePeople } from '../people/PeopleContext';
import { MergeLadderPill } from '../runs/MergeLadderDot';
import { RunStatePill } from '../runs/RunStatePill';
import { AssigneeAvatar } from './AssigneeAvatar';
import { LabelChip } from './LabelChip';
import { LandingBadge } from './LandingBadge';
import { StatusIcon } from './StatusIcon';
import styles from './TaskCardTile.module.css';

// Drag wiring handed down from `TaskBoard`'s `@dnd-kit` draggable card — grouped into one
// optional prop rather than several loose ones so a card rendered outside the board (the drag
// overlay, a test) can simply omit it and render as a plain, non-draggable card.
interface CardDragProps {
  setNodeRef: (node: HTMLElement | null) => void;
  style: React.CSSProperties | undefined;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  isDragging: boolean;
}

interface TaskCardTileProps {
  doc: TaskListItem;
  ready: boolean;
  blocked: boolean;
  /** State of this task's live (non-terminal) run, if it has one. */
  liveRunState: RunState | undefined;
  /** This task's latest run, if any — feeds the run-state mark and the merge-ladder pill. */
  run?: RunMeta;
  /** Title of this task's parent milestone, resolved by the caller — the ` › Milestone` crumb on row 1.
   * Omitted on a board grouped by milestone, where the lane header already names it. */
  milestoneTitle?: string;
  /** The project's configured status list, for the card's inline status picker. */
  statuses: string[];
  // Callbacks take the task id so a board can hand every card the same stable functions.
  /** Changes this task's status inline from the card (optimistic, same path as drag-and-drop). */
  onStatusChange: (id: string, status: string) => void;
  /** Edits this task's priority/assignee/labels inline from the card. */
  onEditTask: (id: string, patch: UpdatePatch) => void;
  onClick: (id: string) => void;
  /** Dispatches this task directly from the card. Omitted (no action rendered) for cards that
   * aren't ready to start. */
  onDispatch?: (id: string) => Promise<void>;
  /** True when the Board's own j/k roving-focus cursor (see `BoardPane`) is on this card —
   * moves real DOM focus onto the card so `:focus-visible` and screen readers agree with
   * what j/k just did. */
  focused?: boolean;
  /** Called whenever real DOM focus lands on this card (click, Tab, or the `focused` effect
   * above) — lets `BoardPane` sync its `focusedTaskId` cursor to wherever focus actually is. */
  onFocus?: (id: string) => void;
  /** See `CardDragProps` — omitted for a card that isn't draggable. */
  drag?: CardDragProps;
  /** True for an archived task shown via Display › Show archived — dims the card and drops the
   * pickers; `TaskBoard` also disables the drag itself. */
  archived?: boolean;
  /** True when this task's latest run needs a human (see `deriveTaskAttentionById`) — a
   * `Needs you` pill on row 3, never a tinted card. */
  needsAttention?: boolean;
  /** Where the task's run stands in the merge queue, while it is landing — a `Landing` pill
   * on row 3. */
  landing?: MergeQueueEntryState;
  /** Which properties the card shows (Display › Display properties). Defaults to all. */
  properties?: ReadonlySet<TaskProperty>;
  /** The daemon's readiness reading for this task, when judged — a thin spec
   * or a likely split shows as a pill beside the labels. */
  readiness?: ReadinessReading;
  /** Every label the project uses — the vocabulary the label pills' picker offers. */
  labelCatalogue?: readonly string[];
}

// Only shows the first few label pills before collapsing the rest into a "+N" — Linear's own
// row/card treatment never lets an unbounded label list crowd out the title.
const MAX_VISIBLE_LABELS = 2;

const ALL_PROPERTIES: ReadonlySet<TaskProperty> = new Set(TASK_PROPERTIES);
const NO_LABELS: readonly string[] = [];

const AGENT_MARK = {
  kind: 'node',
  node: <Bot size={14} strokeWidth={1.8} aria-hidden />,
} as const;

/** The StatePicker's choices: the board's configured statuses, each with its label and
 * workflow type, plus the card's own status when the list lacks it (a renamed status), so
 * the picker still shows it as chosen. Each row draws the card's own StatusIcon (hidden:
 * the row's name says the status), so the menu's glyphs match the trigger's face rather
 * than the library's workflow glyphs (review a green pie, done the neutral disk). */
function cardStateChoices(
  statuses: readonly string[],
  current: string,
  model: StatusModel
): StateChoice[] {
  const names = statuses.includes(current) ? statuses : [...statuses, current];
  return names.map((name) => ({
    id: name,
    name: statusLabel(name),
    kind: statusType(name, model),
    mark: {
      kind: 'node',
      node: (
        <span aria-hidden className={styles.optionGlyph}>
          <StatusIcon status={name} />
        </span>
      ),
    },
  }));
}

/** The AssigneePicker's choices from the people directory: the people (you first), the agent
 * pool and nobody (the picker's none row), the agents drawn with the bot glyph as on the
 * Issues list. */
function cardPersonChoices(directory: PeopleDirectory): PersonChoice[] {
  return buildPersonChoices({
    people: directory.people,
    executors: [],
    me: directory.me,
  }).map((choice) =>
    choice.kind === 'agent' || choice.group === AGENTS_GROUP
      ? { ...choice, mark: AGENT_MARK }
      : choice
  );
}

/** The LabelPicker's choices: the project's vocabulary and the card's own labels, one per
 * label (case aside, the card's spelling first so its labels show as chosen), in name
 * order, each with its registry colour when the registry has one. */
function cardLabelChoices(
  doc: TaskListItem,
  catalogue: readonly string[],
  colors: LabelColors
): LabelChoice[] {
  const byKey = new Map<string, string>();
  for (const label of [...doc.meta.labels, ...catalogue]) {
    const key = label.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, label);
  }
  const vocabulary = [...byKey.values()].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
  return labelChoices([], doc, vocabulary).map((choice) => {
    const hex = colors.hex(choice.id);
    return hex === undefined ? choice : { ...choice, color: hex };
  });
}

/** The card's labels with a label typed into the picker's create row appended, or null
 * when there is nothing to add: a blank name, or a case-variant of a label the card already
 * has (`UI` and `ui` are one label). The picker itself never offers a name an option
 * already carries. */
function withCreatedLabel(
  labels: readonly string[],
  query: string
): string[] | null {
  const label = query.trim();
  const folded = label.toLowerCase();
  if (label === '' || labels.some((l) => l.toLowerCase() === folded)) {
    return null;
  }
  return [...labels, label];
}

/**
 * A Board card on Linear's four-row anatomy: row 1 the id and ` › Milestone` crumb with the
 * assignee picker pushed right; row 2 the status picker and a two-line title; row 3 the
 * priority picker and the pills (blocked, `Needs you`, labels, readiness, `Landing`, live run
 * mark, merge ladder); row 4 `Created Sep 13` with the Dispatch action on the right. Every
 * card is the same 322px tile on `--surface` with a soft border and no shadow; the keyboard
 * cursor and hover are neutral. The pickers are the library's glyph-only (`mark`) pickers.
 * Draggable via the optional `drag` prop.
 */
export const TaskCardTile = memo(function TaskCardTile({
  doc,
  ready,
  blocked,
  liveRunState,
  run,
  milestoneTitle,
  statuses,
  onStatusChange,
  onEditTask,
  onClick,
  onDispatch,
  focused = false,
  onFocus,
  drag,
  archived = false,
  needsAttention = false,
  landing,
  properties = ALL_PROPERTIES,
  readiness,
  labelCatalogue = NO_LABELS,
}: TaskCardTileProps) {
  const id = doc.meta.id;
  const [dispatching, setDispatching] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const has = (p: TaskProperty) => properties.has(p);
  const model = useActiveStatusModel();
  const directory = usePeople();
  // Re-render when the label registry loads, so the label swatches repaint on a memoized card.
  const colors = useSyncExternalStore(
    subscribeLabelColors,
    labelColors,
    labelColors
  );

  useEffect(() => {
    if (focused) openRef.current?.focus();
  }, [focused]);

  const states = useMemo(
    () => cardStateChoices(statuses, doc.meta.status, model),
    [statuses, doc.meta.status, model]
  );
  const people = useMemo(() => cardPersonChoices(directory), [directory]);
  // The picker's value: the registry ref for the card's assignee (the legacy bare `human` is
  // you), or null for nobody.
  const assignee =
    assigneeRef(doc.meta.assignee) === null
      ? null
      : (directory.personFor(doc.meta.assignee)?.ref ??
        (doc.meta.assignee === 'human' && directory.me !== null
          ? directory.me
          : doc.meta.assignee));

  async function dispatchNow(e: React.MouseEvent) {
    e.stopPropagation();
    if (onDispatch === undefined) return;
    setDispatching(true);
    try {
      await onDispatch(id);
    } finally {
      setDispatching(false);
    }
  }

  const visibleLabels = has('labels')
    ? doc.meta.labels.slice(0, MAX_VISIBLE_LABELS)
    : [];
  const hiddenLabelCount = has('labels')
    ? doc.meta.labels.length - visibleLabels.length
    : 0;
  const showCrumb = has('milestone') && milestoneTitle !== undefined;
  const labelsEditable = visibleLabels.length > 0 && !archived;
  // Built only for a card that shows the labels picker, and again when the registry's
  // colours (the options' swatches) change.
  const labelOptions = useMemo(
    () => (labelsEditable ? cardLabelChoices(doc, labelCatalogue, colors) : []),
    [labelsEditable, doc, labelCatalogue, colors]
  );
  const labelFace = visibleLabels.map((label) => (
    <LabelChip key={label} label={label} hex={colors.hex(label)} />
  ));

  return (
    // The card is a container, not a button: its title is the real `<button>` that opens the
    // task, stretched over the whole tile (and carrying the drag handle), while the pickers and
    // Dispatch sit above that hit area as controls of their own. No button nests in another.
    <div
      ref={drag?.setNodeRef}
      style={drag?.style}
      data-slot="task-card"
      data-focused={focused}
      data-dragging={drag?.isDragging === true ? 'true' : undefined}
      data-archived={archived ? 'true' : undefined}
      className={styles.card}
      onFocus={onFocus === undefined ? undefined : () => onFocus(id)}
      onPointerDown={(e) => {
        // A press on a picker (its trigger or its open popover) is the picker's own: it
        // never reaches the board behind the card. The drag handle is the open button,
        // whose own listener has already run.
        if (e.target instanceof Element && e.target.closest('[data-picker]')) {
          e.stopPropagation();
        }
      }}
      onKeyDown={(e) => {
        // A keydown from a nested control (a picker, the Dispatch button) owns its own keys;
        // stop it before it reaches the Board's roving-focus track. The open button's keys
        // travel on, so j/k and Enter keep driving the board from the card.
        if (e.target !== openRef.current) e.stopPropagation();
      }}
    >
      <div data-slot="task-card-meta" className={styles.meta}>
        {has('id') && <span className={styles.id}>{doc.meta.id}</span>}
        {showCrumb && (
          <>
            <span aria-hidden className={styles.separator}>
              ›
            </span>
            <span
              data-slot="task-card-crumb"
              className={styles.crumb}
              title={milestoneTitle}
            >
              {milestoneTitle}
            </span>
          </>
        )}
        {has('assignee') && (
          // Each picker's own root is the control (no wrapper of the card's): it rides
          // above the stretched open button.
          <AssigneePicker
            className={cx(styles.control, styles.assignee)}
            appearance="mark"
            people={people}
            meId={directory.me ?? undefined}
            value={assignee}
            valueLabel={assigneeLabel(doc.meta.assignee)}
            noneLabel="No assignee"
            trigger={<AssigneeAvatar assignee={doc.meta.assignee} size={16} />}
            triggerLabel="Change assignee"
            disabled={archived}
            onChange={(next) => onEditTask(id, { assignee: next ?? 'none' })}
          />
        )}
      </div>

      <div data-slot="task-card-title" className={styles.titleRow}>
        {has('status') && (
          <StatePicker
            className={styles.control}
            appearance="mark"
            states={states}
            value={doc.meta.status}
            trigger={<StatusIcon status={doc.meta.status} />}
            triggerLabel="Change status"
            disabled={archived}
            onChange={(status) => onStatusChange(id, status)}
          />
        )}
        <button
          ref={openRef}
          type="button"
          data-task-card-open=""
          className={styles.open}
          {...drag?.attributes}
          {...drag?.listeners}
          onClick={() => onClick(id)}
          onKeyDown={(e) => {
            if (drag !== undefined && e.key === ' ') {
              // Space belongs to @dnd-kit's keyboard sensor (pick up / move / drop) when the
              // card is draggable; Enter still opens. The sensor's own `onKeyDown`, spread
              // above, also starts on Enter, so only Space is forwarded to it (left un-prevented:
              // the sensor ignores a handled event, and prevents the button's own click itself).
              drag.listeners?.onKeyDown?.(e);
            }
          }}
        >
          <span className={styles.title}>{doc.meta.title}</span>
        </button>
      </div>

      <div data-slot="task-card-pills" className={styles.pills}>
        {has('priority') && (
          <PriorityPicker
            className={styles.control}
            appearance="mark"
            value={toTaskPriority(doc.meta.priority)}
            trigger={
              <PriorityGlyph priority={toTaskPriority(doc.meta.priority)} />
            }
            triggerLabel="Change priority"
            disabled={archived}
            onChange={(p) => onEditTask(id, { priority: fromTaskPriority(p) })}
          />
        )}
        {blocked && (
          <Chip data-slot="label-pill" tone="warning" filled>
            Blocked
          </Chip>
        )}
        {needsAttention && !archived && (
          <Chip data-slot="label-pill" tone="warning" filled>
            Needs you
          </Chip>
        )}
        {/* The label pills are the face of the labels picker (click a pill to change the
            labels); the `+N` overflow stays outside it. An archived card shows plain pills. */}
        {visibleLabels.length > 0 &&
          (archived ? (
            labelFace
          ) : (
            // The chips are the trigger's face as they are (the face lays them out:
            // .labels in the card's module), with no wrapper of their own.
            <LabelPicker
              className={cx(styles.control, styles.labels)}
              appearance="mark"
              labelOptions={labelOptions}
              value={doc.meta.labels}
              trigger={labelFace}
              triggerLabel="Change labels"
              onChange={(labels) => onEditTask(id, { labels })}
              onCreate={(query) => {
                const labels = withCreatedLabel(doc.meta.labels, query);
                if (labels !== null) onEditTask(id, { labels });
              }}
            />
          ))}
        {hiddenLabelCount > 0 && <Chip tone="muted">+{hiddenLabelCount}</Chip>}
        {readinessBadges(readiness).map((badge) => (
          <Chip key={badge} data-slot="label-pill" tone="warning">
            {badge}
          </Chip>
        ))}
        {has('run') && landing !== undefined && !archived && (
          <LandingBadge state={landing} />
        )}
        {has('run') && liveRunState !== undefined && run !== undefined && (
          <RunStatePill meta={run} compact />
        )}
        {has('run') && <MergeLadderPill meta={run} />}
        {archived && <Chip tone="muted">Archived</Chip>}
      </div>

      {/* The footer is the card's fixed `Created` line (Linear's row 4); the Created/Updated
          property chips govern the list's date column, not this. */}
      <div data-slot="task-card-footer" className={styles.footer}>
        <span className={styles.created}>
          {formatCreated(doc.meta.created)}
        </span>
        {ready && onDispatch !== undefined && (
          <Button
            variant="quiet"
            size="sm"
            busy={dispatching}
            busyLabel="Dispatching"
            icon={dispatching ? <Spinner label="" /> : undefined}
            iconAfter={
              dispatching ? undefined : (
                <ArrowRight size={14} strokeWidth={1.8} aria-hidden />
              )
            }
            className={styles.dispatch}
            onClick={(e) => void dispatchNow(e)}
          >
            Dispatch
          </Button>
        )}
      </div>
    </div>
  );
});
