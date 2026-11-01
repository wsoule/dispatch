import {
  type CreateInput,
  isValidParentKind,
  providerById,
  type StatusModel,
  type TaskListItem,
} from '@dispatch-foo/core/browser';
import type { DraftRecord } from '@dispatch/client';
import {
  Button,
  type PickerOption,
  PickerPopover,
  PriorityPicker,
  PropertyList,
  type StateChoice,
  StatePicker,
} from '@dispatch/ui';
import {
  ChevronLeft,
  type LucideIcon,
  MessageCircleQuestion,
  Plus,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  SpellCheck,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { fromTaskPriority, toTaskPriority } from '../adapters/rows';
import { stateChoices } from '../adapters/taskDetail';
import { FailureNotice } from '../components/failure/FailureNotice';
import {
  type SendChoice,
  SendToAgent,
  type SendToAgentOptions,
} from '../components/guide/SendToAgent';
import { PlanQuestionsForm } from '../components/plans/PlanQuestionsForm';
import { PageHead } from '../components/shell/PageHead';
import { ContainerIcon } from '../components/tasks/page/ContainerIcon';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import {
  selectionWithin,
  type TextSelection,
  useTextSelection,
} from '../hooks/useTextSelection';
import { useActiveStatusModel } from '../lib/statusModel';
import { kindLabel } from '../lib/taskDisplay';
import type { EditableTaskDraft } from '../lib/taskDraft';
import {
  editableDraftFrom,
  editableDraftToCreateInput,
  isDraftSaveable,
} from '../lib/taskDraft';
import styles from './DraftView.module.css';

interface DraftViewProps {
  data: DispatchProjectData;
  /** The active project's display name — the header's `Project › Drafts › Draft` crumb. */
  projectName?: string;
  /** The unwrapped create call — rejects on failure (unlike `data.handleCreate`) so a failed
   * save keeps this page open with the draft intact instead of discarding it. The result is
   * ignored, so a caller returning the created doc fits too. */
  onCreate: (input: CreateInput) => Promise<unknown>;
  /** The draft being reviewed — may be `running` or `failed`, not just `ready`, since
   * notifications, history restore, and the tray can all land here mid-turn. */
  draft: DraftRecord;
  onDone: () => void;
  /** A failed draft's Try again: a fresh draft from the same sentence. */
  onRetry?: () => Promise<void>;
  /** The first-task guide's draft: Send to agent replaces Create task, which moves into More options. */
  send?: {
    options: SendToAgentOptions;
    onSend: (input: CreateInput, choice: SendChoice) => Promise<void>;
  };
}

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

// A lucide glyph as a picker option's leading mark.
function iconMark(Icon: LucideIcon): PickerOption['mark'] {
  return { kind: 'node', node: <Icon {...ICON} /> };
}

// The prompt menu's first step. Tone is a step (keepOpen) into its three
// voices; the rest act on the frozen text at once.
const PROMPT_ACTIONS: readonly PickerOption[] = [
  { value: 'explain', label: 'Explain', mark: iconMark(MessageCircleQuestion) },
  { value: 'improve', label: 'Improve', mark: iconMark(Sparkles) },
  { value: 'shorten', label: 'Shorten', mark: iconMark(Scissors) },
  {
    value: 'tone',
    label: 'Tone',
    mark: iconMark(SlidersHorizontal),
    keepOpen: true,
  },
  { value: 'grammar', label: 'Grammar', mark: iconMark(SpellCheck) },
];

// Tone's step: back to the actions, then the three voices.
const TONE_ACTIONS: readonly PickerOption[] = [
  {
    value: 'back',
    label: 'Back to actions',
    mark: iconMark(ChevronLeft),
    keepOpen: true,
  },
  { value: 'tone-professional', label: 'Professional' },
  { value: 'tone-friendly', label: 'Friendly' },
  { value: 'tone-direct', label: 'Direct' },
];

/** The words of a prompt action (or one of Tone's voices) by its id, for the
 * "isn't wired up yet" notice; the id itself when it is unknown. */
function promptActionLabel(actionId: string): string {
  const option = [...PROMPT_ACTIONS, ...TONE_ACTIONS].find(
    (o) => o.value === actionId
  );
  return option?.label ?? actionId;
}

// Two reads of the same selection: a selectionchange that repeats it (focus
// moving, a click that leaves it) must not reopen a menu just closed.
function sameSelection(a: TextSelection | null, b: TextSelection): boolean {
  return (
    a !== null &&
    a.text === b.text &&
    a.rect.left === b.rect.left &&
    a.rect.top === b.rect.top
  );
}

/** The project's statuses as StatePicker choices: the status model's
 * choices kept to the config's list (all of them before config loads), with
 * the draft's own status listed even when it is not among them. */
function draftStateChoices(
  model: StatusModel,
  statuses: readonly string[],
  current: string
): StateChoice[] {
  const all = stateChoices(model, current);
  if (statuses.length === 0) return all;
  return all.filter(
    (choice) => choice.id === current || statuses.includes(choice.id)
  );
}

/** Where a new task may be filed: containers broad enough to hold a task
 * (core's `isValidParentKind`), archived ones left out, each with its own
 * glyph and its kind as the hint. */
function parentOptions(epics: readonly TaskListItem[]): PickerOption[] {
  const options: PickerOption[] = [];
  for (const epic of epics) {
    if (epic.meta.archivedAt !== undefined) continue;
    if (!isValidParentKind('task', epic.meta.kind)) continue;
    options.push({
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
            className={styles.containerMark}
          />
        ),
      },
    });
  }
  return options;
}

/** The prompt menu while open: the text it acts on, frozen when it opened,
 * and the viewport point it opened at (null = under its trigger). */
type PromptMenu = { text: string; point: { x: number; y: number } | null };

/** A settled AI task draft's review page on the issue-page grammar (§8): the task title is the
 * page heading, the description is prose with the acceptance criteria as a checklist under it,
 * and status/priority/parent live in a `Properties` rail of pickers. Every field is editable and
 * nothing is written until "Create task". Reviews only the proposal's first task. */
export function DraftView({
  data,
  projectName,
  onCreate,
  draft,
  onDone,
  onRetry,
  send,
}: DraftViewProps) {
  const proposal = draft.proposal;
  const task = proposal?.tasks[0];
  const statuses = data.config?.statuses ?? [];
  // The status a fresh draft opens in. Pulled out as a string because the
  // hydration effect below depends on it: `statuses` is a new array identity on
  // every render whenever the config hasn't loaded, so depending on the array
  // would re-run that effect each render.
  const defaultStatus = statuses[0] ?? 'backlog';
  const statusModel = useActiveStatusModel();

  const [editable, setEditable] = useState<EditableTaskDraft>(() =>
    editableDraftFrom(
      {
        title: task?.title ?? '',
        description: task?.description ?? '',
        acceptanceCriteria: task?.acceptanceCriteria ?? [],
        priority: task?.priority ?? 'none',
      },
      defaultStatus,
      draft.parent ?? null
    )
  );
  // Stable per-row identity for the acceptance-criteria inputs, so editing one row never
  // shifts focus to a different one after a removal.
  const [criterionKeys, setCriterionKeys] = useState<string[]>(() =>
    editable.acceptanceCriteria.map((_, i) => `criterion-${i}`)
  );
  const nextCriterionKey = useRef(editable.acceptanceCriteria.length);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [sendingToAgent, setSendingToAgent] = useState(false);

  // The prompt menu over the original prompt (the one piece of plain rendered prose on this
  // page: the Selection API cannot see a selection inside the title and description fields).
  // A pointer drag that selects text in the prompt opens it at the selection; its trigger
  // opens it on the selected text, or the whole prompt when none is selected. A keyboard
  // selection never opens it by itself (the menu takes focus, so the next Shift+Arrow would
  // move in the menu instead of extending the selection): the trigger is the keyboard's way
  // in. The text and point are frozen when it opens, so focus moving into the menu (which
  // may clear the selection) does not close it.
  const promptRef = useRef<HTMLDivElement>(null);
  const liveSelection = useTextSelection(promptRef);
  const [promptMenu, setPromptMenu] = useState<PromptMenu | null>(null);
  const [toneStep, setToneStep] = useState(false);
  const [promptNotice, setPromptNotice] = useState<string | null>(null);
  // The selection the menu last opened over, and whether a pointer drag is still selecting.
  const handledSelection = useRef<TextSelection | null>(null);
  const pointerSelecting = useRef(false);

  function openPromptMenu(selection: TextSelection) {
    handledSelection.current = selection;
    setToneStep(false);
    setPromptMenu({
      text: selection.text,
      point: { x: selection.rect.left, y: selection.rect.bottom + 4 },
    });
  }

  // A selection that is gone (collapsed, or moved out of the prompt) is forgotten, so selecting
  // the same words again later opens the menu again.
  useEffect(() => {
    if (liveSelection === null) handledSelection.current = null;
  }, [liveSelection]);

  // A pointer drag that started in the prompt ends anywhere on the page: open the menu over
  // the settled selection, if it is a new one. Only here, after the drag, so the menu never
  // takes focus mid-drag.
  useEffect(() => {
    const onPointerUp = (): void => {
      if (!pointerSelecting.current) return;
      pointerSelecting.current = false;
      const selection = selectionWithin(promptRef.current);
      if (selection === null) return;
      if (sameSelection(handledSelection.current, selection)) return;
      openPromptMenu(selection);
    };
    document.addEventListener('pointerup', onPointerUp);
    return () => document.removeEventListener('pointerup', onPointerUp);
  }, []);

  // Explain/Improve are the only actions with somewhere real to go: the same
  // draft-message path `PlanQuestionsForm` above already uses to talk to the
  // planner about this draft. Shorten/Tone/Grammar have no text-transform
  // endpoint yet, so picking one surfaces an honest "not yet" notice instead
  // of silently no-op'ing or faking a rewrite.
  function handlePromptAction(actionId: string, text: string) {
    if (actionId === 'explain' || actionId === 'improve') {
      setPromptNotice(null);
      const verb = actionId === 'explain' ? 'Explain' : 'Improve';
      void data.handleSendDraftMessage(draft.id, `${verb} this: "${text}"`);
      return;
    }
    setPromptNotice(
      `${promptActionLabel(actionId)} isn't wired up yet — coming soon.`
    );
  }

  // Hydrates `editable` from `task` the first time it appears — needed when a draft opens
  // still asking questions, so a proposal that lands later populates the form once.
  const [hydrated, setHydrated] = useState(task !== undefined);
  useEffect(() => {
    if (hydrated || task === undefined) return;
    setEditable(
      editableDraftFrom(
        {
          title: task.title,
          description: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
          priority: task.priority,
        },
        defaultStatus,
        draft.parent ?? null
      )
    );
    setCriterionKeys(task.acceptanceCriteria.map((_, i) => `criterion-${i}`));
    nextCriterionKey.current = task.acceptanceCriteria.length;
    setHydrated(true);
  }, [hydrated, task, defaultStatus, draft.parent]);

  const states = draftStateChoices(statusModel, statuses, editable.status);
  const parents = useMemo(() => parentOptions(data.epics), [data.epics]);

  function editDraft(patch: Partial<EditableTaskDraft>) {
    setEditable((prev) => ({ ...prev, ...patch }));
  }

  function editCriterion(index: number, text: string) {
    setEditable((prev) => ({
      ...prev,
      acceptanceCriteria: prev.acceptanceCriteria.map((c, i) =>
        i === index ? text : c
      ),
    }));
  }

  function addCriterion() {
    setEditable((prev) => ({
      ...prev,
      acceptanceCriteria: [...prev.acceptanceCriteria, ''],
    }));
    setCriterionKeys((prev) => [
      ...prev,
      `criterion-${nextCriterionKey.current++}`,
    ]);
  }

  function removeCriterion(index: number) {
    setEditable((prev) => ({
      ...prev,
      acceptanceCriteria: prev.acceptanceCriteria.filter((_, i) => i !== index),
    }));
    setCriterionKeys((prev) => prev.filter((_, i) => i !== index));
  }

  // Only dismisses the draft once the task actually exists — a failed create leaves it intact
  // in the tray, with the error shown inline, rather than discarding drafted work.
  async function save() {
    if (!isDraftSaveable(editable)) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onCreate(editableDraftToCreateInput(editable));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaving(false);
      return;
    }
    await data.handleDismissDraft(draft.id);
    onDone();
  }

  async function discard() {
    setDiscarding(true);
    await data.handleDismissDraft(draft.id);
    onDone();
  }

  const crumbs =
    projectName !== undefined
      ? [projectName, 'Drafts', 'Draft']
      : ['Drafts', 'Draft'];
  const canCreate =
    !saving &&
    !discarding &&
    !sendingToAgent &&
    task !== undefined &&
    isDraftSaveable(editable);

  return (
    <div className={styles.root}>
      <div className={styles.bar}>
        <PageHead
          crumbs={crumbs}
          meta={
            draft.state === 'running'
              ? 'The planner is working on this draft…'
              : send !== undefined
                ? 'This is what the agent will do. Edit anything, then send it.'
                : 'Nothing is written until you create the task.'
          }
        />
      </div>

      <div className={styles.body}>
        <div className={styles.main}>
          <div className={styles.column}>
            {draft.state === 'failed' && (
              <FailureNotice
                error={draft.error ?? 'Drafting the task failed.'}
                providerId={providerById(draft.plannerName)?.id}
                onRetry={onRetry}
              />
            )}

            {draft.questions.length > 0 && (
              <PlanQuestionsForm
                questions={draft.questions}
                disabled={draft.state === 'running'}
                onSend={async (text) => {
                  await data.handleSendDraftMessage(draft.id, text);
                }}
              />
            )}

            {task === undefined ? (
              // A failed draft's notice says it all; no empty line under it.
              (draft.questions.length > 0 || draft.state !== 'failed') && (
                <p className={styles.quiet}>
                  {draft.questions.length > 0
                    ? 'Answer the question above to get a proposed task.'
                    : 'No proposed task yet.'}
                </p>
              )
            ) : (
              <>
                <div className={styles.prompt}>
                  <PickerPopover
                    label={toneStep ? 'Tone' : 'Prompt actions'}
                    triggerLabel="Prompt actions"
                    trigger={<Sparkles {...ICON} />}
                    appearance="quiet"
                    searchable={false}
                    action
                    value={null}
                    options={toneStep ? TONE_ACTIONS : PROMPT_ACTIONS}
                    anchorPoint={promptMenu?.point ?? null}
                    open={promptMenu !== null}
                    onOpenChange={(open) => {
                      setToneStep(false);
                      // The trigger (a click, or Enter after a keyboard selection) acts on
                      // the text selected in the prompt, else on the whole prompt.
                      const selected = open
                        ? selectionWithin(promptRef.current)
                        : null;
                      setPromptMenu(
                        open
                          ? {
                              text: selected?.text ?? draft.prompt,
                              point: null,
                            }
                          : null
                      );
                    }}
                    onChange={(value) => {
                      if (value === 'tone' || value === 'back') {
                        setToneStep(value === 'tone');
                        return;
                      }
                      if (value === null || promptMenu === null) return;
                      handlePromptAction(value, promptMenu.text);
                    }}
                  />
                  <div
                    ref={promptRef}
                    className={styles.promptText}
                    onPointerDown={() => {
                      pointerSelecting.current = true;
                    }}
                  >
                    {draft.prompt}
                  </div>
                </div>
                {promptNotice !== null && (
                  <p role="status" className={styles.quiet}>
                    {promptNotice}
                  </p>
                )}

                <input
                  className={styles.titleInput}
                  value={editable.title}
                  onChange={(e) => editDraft({ title: e.target.value })}
                  aria-label="Task title"
                  placeholder="Task title"
                />
                <textarea
                  className={styles.description}
                  value={editable.description}
                  onChange={(e) => editDraft({ description: e.target.value })}
                  aria-label="Task description"
                  placeholder="Add description…"
                />

                <section
                  aria-label="Acceptance criteria"
                  className={styles.criteria}
                >
                  <h3 className={styles.sectionTitle}>Acceptance criteria</h3>
                  {editable.acceptanceCriteria.map((criterion, i) => (
                    <div
                      key={criterionKeys[i] ?? i}
                      className={styles.criterion}
                    >
                      {/* Decorative: a criterion is unchecked until a run proves it. */}
                      <span
                        aria-hidden
                        data-slot="criterion-box"
                        className={styles.criterionBox}
                      />
                      <input
                        className={styles.criterionInput}
                        value={criterion}
                        onChange={(e) => editCriterion(i, e.target.value)}
                        aria-label={`Acceptance criterion ${i + 1}`}
                      />
                      <Button
                        variant="quiet"
                        size="sm"
                        className={styles.removeCriterion}
                        aria-label={`Remove acceptance criterion ${i + 1}`}
                        icon={<X {...ICON} />}
                        onClick={() => removeCriterion(i)}
                      />
                    </div>
                  ))}
                  <span className={styles.addCriterion}>
                    <Button
                      variant="quiet"
                      size="sm"
                      icon={<Plus {...ICON} />}
                      onClick={addCriterion}
                    >
                      Add criterion
                    </Button>
                  </span>
                </section>

                {proposal !== null && proposal.tasks.length > 1 && (
                  <div className={styles.quiet}>
                    <p className={styles.flush}>
                      Only the first of {proposal.tasks.length} proposed tasks
                      is reviewed here; discarding also drops these:
                    </p>
                    <ul className={styles.dropped}>
                      {proposal.tasks.slice(1).map((t, i) => (
                        <li key={i}>{t.title}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {task !== undefined && (
          <aside aria-label="Properties" className={styles.rail}>
            <h2 className={styles.railTitle}>Properties</h2>
            <PropertyList
              items={[
                {
                  id: 'status',
                  label: 'Status',
                  value: (
                    <StatePicker
                      label="Status"
                      states={states}
                      value={editable.status}
                      onChange={(status) => editDraft({ status })}
                    />
                  ),
                },
                {
                  id: 'priority',
                  label: 'Priority',
                  value: (
                    <PriorityPicker
                      label="Priority"
                      value={toTaskPriority(editable.priority)}
                      onChange={(priority) =>
                        editDraft({ priority: fromTaskPriority(priority) })
                      }
                    />
                  ),
                },
                {
                  id: 'parent',
                  label: 'Parent',
                  value: (
                    <PickerPopover
                      label="Parent"
                      options={parents}
                      value={editable.parent}
                      valueLabel="Unknown task"
                      noneLabel="No parent"
                      placeholder="No parent"
                      searchPlaceholder="Move to…"
                      onChange={(parent) => editDraft({ parent })}
                    />
                  ),
                },
              ]}
            />
          </aside>
        )}
      </div>

      <div className={styles.foot}>
        {saveError !== null && (
          <p role="alert" data-tone="danger" className={styles.error}>
            {saveError}
          </p>
        )}
        <Button
          variant="secondary"
          busy={discarding}
          busyLabel="Discarding…"
          disabled={saving || sendingToAgent}
          onClick={() => void discard()}
        >
          Discard
        </Button>
        {send !== undefined && task !== undefined ? (
          <SendToAgent
            options={send.options}
            disabled={!canCreate}
            onSend={async (choice) => {
              setSendingToAgent(true);
              try {
                await send.onSend(
                  {
                    ...editableDraftToCreateInput(editable),
                    ...(choice.writes.length > 0
                      ? { writes: choice.writes }
                      : {}),
                  },
                  choice
                );
              } finally {
                setSendingToAgent(false);
              }
            }}
            extra={
              <Button
                variant="quiet"
                size="sm"
                disabled={!canCreate}
                onClick={() => void save()}
              >
                Just create the task
              </Button>
            }
          />
        ) : (
          <Button
            variant="primary"
            busy={saving}
            busyLabel="Creating…"
            disabled={!canCreate}
            onClick={() => void save()}
          >
            Create task
          </Button>
        )}
      </div>
    </div>
  );
}
