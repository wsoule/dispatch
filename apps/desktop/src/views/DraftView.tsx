import type { DraftRecord } from '@dispatch/client';
import type { CreateInput, Priority } from '@dispatch/core/browser';
import { Plus, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { PlanQuestionsForm } from '../components/plans/PlanQuestionsForm';
import {
  EpicControl,
  PriorityControl,
  StatusControl,
} from '../components/tasks/PropertyControls';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { EditableTaskDraft } from '../lib/taskDraft';
import {
  editableDraftFrom,
  editableDraftToCreateInput,
  isDraftSaveable,
} from '../lib/taskDraft';
import { IconButton } from '@/ui/ai/icon-button';
import { PageHeader } from '@/ui/ai/page-header';
import { PillButton } from '@/ui/ai/pill';
import {
  defaultSelectionActions,
  selectionActionLabel,
  SelectionActionsMenu,
  useTextSelection,
} from '@/ui/ai/selection-actions';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Spinner } from '@/ui/spinner';
import { Textarea } from '@/ui/textarea';

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
}

/** A settled AI task draft's review page on the issue-page grammar (§8): the task title is the
 * 24px page heading, the description is 15px prose with the acceptance criteria as a checklist
 * under it, and status/priority/epic live in a `Properties` rail. Every field is editable and
 * nothing is written until "Create task". Reviews only the proposal's first task. */
export function DraftView({
  data,
  projectName,
  onCreate,
  draft,
  onDone,
}: DraftViewProps) {
  const proposal = draft.proposal;
  const task = proposal?.tasks[0];
  const statuses = data.config?.statuses ?? [];
  // The status a fresh draft opens in. Pulled out as a string because the
  // hydration effect below depends on it: `statuses` is a new array identity on
  // every render whenever the config hasn't loaded, so depending on the array
  // would re-run that effect each render.
  const defaultStatus = statuses[0] ?? 'backlog';

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

  // Selection actions over the original prompt (the one piece of text on this page that
  // is plain rendered prose rather than an `<input>`/`<textarea>` — the Selection API this
  // primitive is built on cannot see a selection made inside a form control at all, so the
  // title/description fields below are out of reach for it regardless of this page's own
  // editable-vs-read-only distinction).
  const promptRef = useRef<HTMLDivElement>(null);
  const { text: selectedPromptText, rect: selectionRect } =
    useTextSelection(promptRef);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);

  // Explain/Improve are the only actions with somewhere real to go: the same
  // draft-message path `PlanQuestionsForm` above already uses to talk to the
  // planner about this draft. Shorten/Tone/Grammar have no text-transform
  // endpoint yet, so picking one surfaces an honest "not yet" notice instead
  // of silently no-op'ing or faking a rewrite.
  function handleSelectionAction(actionId: string) {
    if (actionId === 'explain' || actionId === 'improve') {
      setSelectionNotice(null);
      const verb = actionId === 'explain' ? 'Explain' : 'Improve';
      void data.handleSendDraftMessage(
        draft.id,
        `${verb} this: "${selectedPromptText}"`
      );
      return;
    }
    setSelectionNotice(
      `${selectionActionLabel(actionId)} isn't wired up yet — coming soon.`
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

  const crumb =
    projectName !== undefined
      ? [projectName, 'Drafts', 'Draft']
      : ['Drafts', 'Draft'];
  const canCreate =
    !saving && !discarding && task !== undefined && isDraftSaveable(editable);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        crumb={crumb}
        actions={
          <span className="font-book text-muted-foreground px-2 text-[12px]">
            {draft.state === 'running'
              ? 'The planner is working on this draft…'
              : 'Nothing is written until you create the task.'}
          </span>
        }
      />

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto px-10 py-6">
          <div className="mx-auto flex w-full max-w-[800px] flex-col gap-4">
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
              <p className="font-book text-muted-foreground text-[13px]">
                {draft.questions.length > 0
                  ? 'Answer the question above to get a proposed task.'
                  : 'No proposed task yet.'}
              </p>
            ) : (
              <>
                <div
                  ref={promptRef}
                  className="font-book text-muted-foreground flex items-start gap-2 text-[12px]"
                >
                  <Sparkles className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">{draft.prompt}</span>
                </div>
                {selectionRect !== null && (
                  <SelectionActionsMenu
                    actions={defaultSelectionActions}
                    onAction={handleSelectionAction}
                    position={selectionRect}
                  />
                )}
                {selectionNotice !== null && (
                  <p
                    role="status"
                    className="font-book text-muted-foreground text-[12px]"
                  >
                    {selectionNotice}
                  </p>
                )}

                <Input
                  variant="borderless"
                  value={editable.title}
                  onChange={(e) => editDraft({ title: e.target.value })}
                  aria-label="Task title"
                  placeholder="Task title"
                  className="text-[24px] leading-8 font-semibold tracking-[-0.16px]"
                />
                <Textarea
                  variant="borderless"
                  value={editable.description}
                  onChange={(e) => editDraft({ description: e.target.value })}
                  aria-label="Task description"
                  placeholder="Add description…"
                  className="min-h-[96px] text-[15px] leading-6"
                />

                <section
                  aria-label="Acceptance criteria"
                  className="flex flex-col gap-1"
                >
                  <h3 className="text-muted-foreground text-[12px] font-medium">
                    Acceptance criteria
                  </h3>
                  {editable.acceptanceCriteria.map((criterion, i) => (
                    <div
                      key={criterionKeys[i] ?? i}
                      className="group/criterion hover:bg-surface-hover rounded-control -mx-2 flex h-8 items-center gap-2 px-2"
                    >
                      {/* Decorative: a criterion is unchecked until a run proves it. */}
                      <span
                        aria-hidden
                        data-slot="criterion-box"
                        className="border-border-chip bg-surface-quaternary size-3.5 shrink-0 rounded-[4px] border-[0.5px]"
                      />
                      <Input
                        variant="borderless"
                        value={criterion}
                        onChange={(e) => editCriterion(i, e.target.value)}
                        aria-label={`Acceptance criterion ${i + 1}`}
                        className="flex-1 text-[15px] leading-6"
                      />
                      <IconButton
                        label={`Remove acceptance criterion ${i + 1}`}
                        onClick={() => removeCriterion(i)}
                        className="opacity-0 group-hover/criterion:opacity-100 focus-visible:opacity-100"
                      >
                        <X />
                      </IconButton>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={addCriterion}
                    className="self-start"
                  >
                    <Plus />
                    Add criterion
                  </Button>
                </section>

                {proposal !== null && proposal.tasks.length > 1 && (
                  <div className="font-book text-muted-foreground text-[12px]">
                    <p>
                      Only the first of {proposal.tasks.length} proposed tasks
                      is reviewed here; discarding also drops these:
                    </p>
                    <ul className="mt-1 list-disc pl-4">
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
          <aside
            aria-label="Properties"
            className="border-border-subtle flex w-[280px] shrink-0 flex-col gap-1 overflow-y-auto border-l-[0.5px] px-4 py-6"
          >
            <h2 className="text-muted-foreground mb-1 px-2 text-[13px] font-medium">
              Properties
            </h2>
            <StatusControl
              value={editable.status}
              statuses={statuses}
              onChange={(status) => editDraft({ status })}
              variant="row"
            />
            <PriorityControl
              value={editable.priority}
              onChange={(priority: Priority) => editDraft({ priority })}
              variant="row"
            />
            <EpicControl
              value={editable.parent}
              epics={data.epics}
              onChange={(parent) => editDraft({ parent })}
              variant="row"
            />
          </aside>
        )}
      </div>

      <div className="shadow-hairline-top flex h-12 shrink-0 items-center justify-end gap-2 px-6">
        {saveError !== null && (
          <p role="alert" className="text-red mr-auto text-[13px]">
            {saveError}
          </p>
        )}
        <PillButton
          onClick={() => void discard()}
          disabled={saving || discarding}
        >
          {discarding && <Spinner className="size-3.5" />}
          Discard
        </PillButton>
        <Button disabled={!canCreate} onClick={() => void save()}>
          {saving ? (
            <>
              <Spinner className="size-3.5" /> Creating…
            </>
          ) : (
            'Create task'
          )}
        </Button>
      </div>
    </div>
  );
}
