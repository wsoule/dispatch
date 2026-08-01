import type { DraftRecord } from '@dispatch/client';
import type { Priority } from '@dispatch/core';
import {
  Check,
  CircleAlert,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useRef, useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import type { EditableTaskDraft } from '../../lib/taskDraft';
import {
  editableDraftFrom,
  editableDraftToCreateInput,
  isDraftSaveable,
} from '../../lib/taskDraft';
import {
  EpicControl,
  PriorityControl,
  StatusControl,
} from './PropertyControls';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Input } from '@/ui/input';
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

interface DraftReviewDialogProps {
  data: DispatchProjectData;
  /** A `ready` draft — the drafts tray only ever opens this dialog for one, since a
   * `running`/`failed` draft has no settled proposal to review. */
  draft: DraftRecord;
  onClose: () => void;
}

/**
 * Reviews one settled AI task draft before it becomes a real task: every field is editable in
 * place, and nothing is written until "Create task" — the same `handleCreate`/`POST /api/tasks`
 * path `CreateTaskModal` uses, so how a task is persisted never depends on which creator
 * produced it.
 *
 * A draft's proposal can carry more than one planned task (`PlanProposal` is shared with the
 * multi-task Plans flow), but `POST /api/tasks/draft` is documented as the single-task
 * creator — this dialog only ever reviews the first task and says so when the planner proposed
 * more, rather than silently dropping the rest or growing a second copy of Plans' multi-task
 * editor for a surface meant to stay "one thing, fast".
 */
export function DraftReviewDialog({
  data,
  draft,
  onClose,
}: DraftReviewDialogProps) {
  const proposal = draft.proposal;
  const task = proposal?.tasks[0];
  const statuses = data.config?.statuses ?? [];

  const [editable, setEditable] = useState<EditableTaskDraft>(() =>
    editableDraftFrom(
      {
        title: task?.title ?? '',
        description: task?.description ?? '',
        acceptanceCriteria: task?.acceptanceCriteria ?? [],
        priority: task?.priority ?? 'none',
      },
      statuses[0] ?? 'backlog'
    )
  );
  // Stable per-row identity for the acceptance-criteria inputs: index keys would make React
  // reuse a row's DOM node/focus for whichever criterion slides into that index after a
  // removal, which reads as your cursor jumping to a different line mid-edit.
  const [criterionKeys, setCriterionKeys] = useState<string[]>(() =>
    editable.acceptanceCriteria.map((_, i) => `criterion-${i}`)
  );
  const nextCriterionKey = useRef(editable.acceptanceCriteria.length);
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);

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

  // Saves the edited draft as a real task, then dismisses the draft — once it is a task it has
  // no further reason to sit in the tray as something still awaiting review.
  async function save() {
    if (!isDraftSaveable(editable)) return;
    setSaving(true);
    await data.handleCreate(editableDraftToCreateInput(editable));
    await data.handleDismissDraft(draft.id);
    onClose();
  }

  async function discard() {
    setDiscarding(true);
    await data.handleDismissDraft(draft.id);
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review draft</DialogTitle>
        </DialogHeader>

        {task === undefined ? (
          <div className="text-muted-foreground flex items-center gap-2 text-[13px]">
            <CircleAlert className="size-4 shrink-0" />
            <span>This draft has no proposed task to review.</span>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="text-muted-foreground flex items-start gap-2 text-[12px]">
              <Sparkles className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 italic">{draft.prompt}</span>
            </div>

            {proposal !== undefined &&
              proposal !== null &&
              proposal.tasks.length > 1 && (
                <div className="border-border bg-secondary/40 text-muted-foreground rounded-md border px-3 py-2 text-[12px]">
                  The planner proposed {proposal.tasks.length} tasks — only the
                  first is reviewed here; use Plans for a multi-task body of
                  work.
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

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => void discard()}
            disabled={saving || discarding}
          >
            {discarding ? (
              <Loader2 className="size-4 animate-spin" />
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
                <Loader2 className="size-4 animate-spin" /> Creating…
              </>
            ) : (
              <>
                <Check className="size-4" /> Create task
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
