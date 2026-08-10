import type { DraftRecord } from '@dispatch/client';
import type { CreateInput, Priority } from '@dispatch/core/browser';
import { Check, CircleAlert, Plus, Sparkles, Trash2 } from 'lucide-react';
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
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Spinner } from '@/ui/spinner';
import { Textarea } from '@/ui/textarea';

/** One labeled cell of the draft's property rail, so Status/Priority/Epic all read the same
 * way — a small uppercase caption over the shared `PropertyControls` row editor. */
function PropertyField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

interface DraftViewProps {
  data: DispatchProjectData;
  /** The unwrapped create call — rejects on failure (unlike `data.handleCreate`) so a failed
   * save keeps this page open with the draft intact instead of discarding it. */
  onCreate: (input: CreateInput) => Promise<void>;
  /** The draft being reviewed — may be `running` or `failed`, not just `ready`, since
   * notifications, history restore, and the tray can all land here mid-turn. */
  draft: DraftRecord;
  onDone: () => void;
}

/** A settled AI task draft's review page — every field editable, nothing written until
 * "Create task". Reviews only the proposal's first task. */
export function DraftView({ data, onCreate, draft, onDone }: DraftViewProps) {
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
      defaultStatus
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
        defaultStatus
      )
    );
    setCriterionKeys(task.acceptanceCriteria.map((_, i) => `criterion-${i}`));
    nextCriterionKey.current = task.acceptanceCriteria.length;
    setHydrated(true);
  }, [hydrated, task, defaultStatus]);

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

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-[18px] font-medium">Review draft</h1>
        <p className="text-muted-foreground text-[13px]">
          {draft.state === 'running'
            ? 'The planner is working on this draft…'
            : 'Nothing is written until you create the task.'}
        </p>
      </div>

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
        <div className="text-muted-foreground flex items-center gap-2 text-[13px]">
          <CircleAlert className="size-4 shrink-0" />
          <span>
            {draft.questions.length > 0
              ? 'Answer the question above to get a proposed task.'
              : 'This draft has no proposed task to review.'}
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {saveError !== null && (
            <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]">
              <CircleAlert className="size-4 shrink-0" />
              <span>{saveError}</span>
            </div>
          )}

          <div className="text-muted-foreground flex items-start gap-2 text-[12px]">
            <Sparkles className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 italic">{draft.prompt}</span>
          </div>

          {proposal !== null && proposal.tasks.length > 1 && (
            <div className="border-border bg-secondary/40 text-muted-foreground rounded-md border px-3 py-2 text-[12px]">
              <p>
                Only the first of {proposal.tasks.length} proposed tasks is
                reviewed here; discarding also drops these:
              </p>
              <ul className="mt-1 list-disc pl-4">
                {proposal.tasks.slice(1).map((t, i) => (
                  <li key={i}>{t.title}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4">
            <Input
              value={editable.title}
              onChange={(e) => editDraft({ title: e.target.value })}
              aria-label="Task title"
              placeholder="Task title"
              className="focus-visible:ring-ring/40 h-auto border-none bg-transparent px-0 py-0.5 text-[14px] font-medium shadow-none focus-visible:ring-1"
            />
            <Textarea
              rows={4}
              value={editable.description}
              onChange={(e) => editDraft({ description: e.target.value })}
              aria-label="Task description"
              placeholder="Description"
              className="text-muted-foreground focus-visible:ring-ring/40 min-h-0 resize-y border-none bg-transparent px-0 py-0.5 text-[13px] shadow-none focus-visible:ring-1"
            />

            <div className="border-border flex flex-col gap-1.5 border-t pt-3">
              <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                Acceptance criteria
              </span>
              {editable.acceptanceCriteria.map((criterion, i) => (
                <div
                  key={criterionKeys[i] ?? i}
                  className="flex items-center gap-2"
                >
                  <span className="text-muted-foreground/60 w-2 shrink-0 text-[13px]">
                    •
                  </span>
                  <Input
                    value={criterion}
                    onChange={(e) => editCriterion(i, e.target.value)}
                    aria-label={`Acceptance criterion ${i + 1}`}
                    className="focus-visible:ring-ring/40 h-auto flex-1 border-none bg-transparent px-0 py-0.5 text-[13px] shadow-none focus-visible:ring-1"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => removeCriterion(i)}
                    aria-label={`Remove acceptance criterion ${i + 1}`}
                    className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={addCriterion}
                className="text-muted-foreground self-start"
              >
                <Plus className="size-3.5" />
                Add criterion
              </Button>
            </div>
          </div>

          <div className="border-border bg-card grid grid-cols-3 gap-3 rounded-lg border p-3">
            <PropertyField label="Status">
              <StatusControl
                value={editable.status}
                statuses={statuses}
                onChange={(status) => editDraft({ status })}
                variant="row"
              />
            </PropertyField>
            <PropertyField label="Priority">
              <PriorityControl
                value={editable.priority}
                onChange={(priority: Priority) => editDraft({ priority })}
                variant="row"
              />
            </PropertyField>
            <PropertyField label="Epic">
              <EpicControl
                value={editable.parent}
                epics={data.epics}
                onChange={(parent) => editDraft({ parent })}
                variant="row"
              />
            </PropertyField>
          </div>
        </div>
      )}

      <div className="border-border flex justify-end gap-2 border-t pt-4">
        <Button
          variant="ghost"
          onClick={() => void discard()}
          disabled={saving || discarding}
        >
          {discarding ? (
            <Spinner className="size-4" />
          ) : (
            <Trash2 className="size-4" />
          )}
          Discard
        </Button>
        <Button
          disabled={
            saving ||
            discarding ||
            task === undefined ||
            !isDraftSaveable(editable)
          }
          onClick={() => void save()}
        >
          {saving ? (
            <>
              <Spinner className="size-4" /> Creating…
            </>
          ) : (
            <>
              <Check className="size-4" /> Create task
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
