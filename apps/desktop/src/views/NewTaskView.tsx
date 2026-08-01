import type { Priority } from '@dispatch/core';
import {
  Check,
  CircleAlert,
  Loader2,
  PanelTopOpen,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
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
import { Skeleton } from '@/ui/skeleton';
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

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]">
      <CircleAlert className="size-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

interface NewTaskViewProps {
  data: DispatchProjectData;
  /** Pre-selects the draft's Status — a board column's or list group's hover "+" passes its
   * own status through, exactly as it already does for `CreateTaskModal`; omitted when opened
   * from the plain "New task" button, which falls back to the first configured status. */
  initialStatus?: string;
  /** Opens `CreateTaskModal` instead — the structured quick-add fallback for when you already
   * know the exact fields and don't want to spend an agent round-trip describing them. */
  onQuickAdd: () => void;
  /** Leaves the creator (Cancel, or after a task is created). */
  onClose: () => void;
}

/**
 * The full-page, describe-what-you-want task creator: Plans' single-task sibling. You type a
 * plain description, the natural-language draft endpoint (`handleDraftTask`) turns it into one
 * structured task, and you edit every field in place before it's saved through the same
 * `handleCreate`/`POST /api/tasks` path `CreateTaskModal` uses — so how a task is persisted
 * never depends on which creator produced it.
 *
 * Deliberately mirrors `PlansView`'s shape (centered column, composer card, a draft that
 * replaces the composer once it resolves, the same `DaemonUnavailable` guard) since the two
 * are the same gesture at different scales: describe a body of work, review what the agent
 * proposes, commit it.
 */
export function NewTaskView({
  data,
  initialStatus,
  onQuickAdd,
  onClose,
}: NewTaskViewProps) {
  // The text as typed. Kept (not cleared) once a draft comes back, so "Start over" returns to
  // the composer with the original description still there to refine rather than retyped.
  const [prompt, setPrompt] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditableTaskDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Stable per-row identity for the acceptance-criteria inputs, kept in lockstep with
  // `draft.acceptanceCriteria` (same length, same order) — the same problem, and the same fix,
  // `PlansView` documents for its task rows: index keys would make React reuse a row's DOM
  // node and focus for whichever criterion slides into that index after a removal, which reads
  // as your cursor jumping to a different line mid-edit.
  const [criterionKeys, setCriterionKeys] = useState<string[]>([]);
  const nextCriterionKey = useRef(0);

  function mintCriterionKeys(count: number): string[] {
    return Array.from(
      { length: count },
      () => `criterion-${nextCriterionKey.current++}`
    );
  }

  // Guards state updates from a poll that resolves after this view unmounts
  // — the draft itself keeps running server-side regardless.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const POLL_INTERVAL_MS = 1500;
  // ~5 minutes of polling, well past any real planner turn — bounds a draft
  // that somehow never settles instead of polling forever.
  const MAX_POLL_ATTEMPTS = 200;

  async function pollDraftUntilSettled(draftId: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      if (data.client === null) throw new Error('dispatchd client not ready');
      const record = await data.client.fetchDraft(draftId);
      if (!mountedRef.current) return;
      if (record.state === 'running') {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }
      if (record.state === 'failed') {
        throw new Error(record.error ?? 'draft failed');
      }
      const task = record.proposal?.tasks[0];
      if (task === undefined) {
        throw new Error('planner produced no task for this description');
      }
      const status = initialStatus ?? data.config?.statuses[0] ?? 'backlog';
      setDraft(
        editableDraftFrom(
          {
            title: task.title,
            description: task.description,
            acceptanceCriteria: task.acceptanceCriteria,
            priority: task.priority,
          },
          status
        )
      );
      setCriterionKeys(mintCriterionKeys(task.acceptanceCriteria.length));
      return;
    }
    throw new Error('draft is taking too long — please try again');
  }

  async function submitPrompt() {
    if (prompt.trim() === '' || drafting) return;
    setDrafting(true);
    setDraftError(null);
    try {
      const started = await data.handleDraftTask(prompt.trim());
      await pollDraftUntilSettled(started.id);
    } catch (err) {
      if (mountedRef.current) {
        setDraftError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mountedRef.current) setDrafting(false);
    }
  }

  function editDraft(patch: Partial<EditableTaskDraft>) {
    setDraft((prev) => (prev === null ? prev : { ...prev, ...patch }));
  }

  function editCriterion(index: number, text: string) {
    setDraft((prev) =>
      prev === null
        ? prev
        : {
            ...prev,
            acceptanceCriteria: prev.acceptanceCriteria.map((c, i) =>
              i === index ? text : c
            ),
          }
    );
  }

  function addCriterion() {
    setDraft((prev) =>
      prev === null
        ? prev
        : { ...prev, acceptanceCriteria: [...prev.acceptanceCriteria, ''] }
    );
    setCriterionKeys((prev) => [...prev, ...mintCriterionKeys(1)]);
  }

  function removeCriterion(index: number) {
    setDraft((prev) =>
      prev === null
        ? prev
        : {
            ...prev,
            acceptanceCriteria: prev.acceptanceCriteria.filter(
              (_, i) => i !== index
            ),
          }
    );
    setCriterionKeys((prev) => prev.filter((_, i) => i !== index));
  }

  function startOver() {
    setDraft(null);
    setCriterionKeys([]);
    setSaveError(null);
  }

  async function saveDraft() {
    if (draft === null || !isDraftSaveable(draft)) return;
    setSaving(true);
    setSaveError(null);
    try {
      await data.handleCreate(editableDraftToCreateInput(draft));
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  // Same guard every other primary view uses: a composer pointed at a dead daemon would only
  // fail *after* you'd typed a description and clicked draft (`handleDraftTask` throws once
  // `client` is null), so show the shared starting/failed/retry state instead.
  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  // The status/epic pickers are driven by the project's configured statuses, so the form can't
  // render honestly until config resolves.
  if (data.config === null) {
    return (
      <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-6">
        <h1 className="view-topbar-title">New task</h1>
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }

  const statuses = data.config.statuses;

  return (
    <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="view-topbar-title">New task</h1>
        <Button variant="ghost" size="sm" onClick={onQuickAdd}>
          <PanelTopOpen className="size-3.5" />
          Quick add…
        </Button>
      </div>

      {draft === null ? (
        <div className="border-border bg-card animate-in fade-in-0 flex flex-col gap-3 rounded-lg border p-4 duration-150">
          {draftError !== null && <ErrorBanner message={draftError} />}
          <Textarea
            rows={5}
            autoFocus
            placeholder="Describe the task — what should change, and how you'll know it's done…"
            aria-label="Describe the task"
            value={prompt}
            disabled={drafting}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter submits from inside the field, the same chord every other
              // multi-line composer in this app uses — a bare Enter has to stay a newline in a
              // description this long.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submitPrompt();
              }
            }}
            className="resize-y text-[13px]"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground text-[11px]">
              <kbd className="border-border bg-secondary rounded border px-1 py-0.5 font-mono text-[10px]">
                ⌘↵
              </kbd>{' '}
              to draft — nothing is created until you review it.
            </span>
            <Button
              disabled={drafting || prompt.trim() === ''}
              onClick={() => void submitPrompt()}
            >
              {drafting ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Drafting…
                </>
              ) : (
                <>
                  <Sparkles className="size-4" /> Draft task
                </>
              )}
            </Button>
          </div>
        </div>
      ) : (
        <div className="animate-in fade-in-0 flex flex-col gap-4 duration-150">
          {saveError !== null && <ErrorBanner message={saveError} />}

          <div className="text-muted-foreground flex items-start gap-2 text-[12px]">
            <Sparkles className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 italic">{prompt.trim()}</span>
          </div>

          <div className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4">
            <Input
              value={draft.title}
              onChange={(e) => editDraft({ title: e.target.value })}
              aria-label="Task title"
              placeholder="Task title"
              className="focus-visible:ring-ring/40 h-auto border-none bg-transparent px-0 py-0.5 text-[14px] font-medium shadow-none focus-visible:ring-1"
            />
            <Textarea
              rows={4}
              value={draft.description}
              onChange={(e) => editDraft({ description: e.target.value })}
              aria-label="Task description"
              placeholder="Description"
              className="text-muted-foreground focus-visible:ring-ring/40 min-h-0 resize-y border-none bg-transparent px-0 py-0.5 text-[13px] shadow-none focus-visible:ring-1"
            />

            <div className="border-border flex flex-col gap-1.5 border-t pt-3">
              <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                Acceptance criteria
              </span>
              {draft.acceptanceCriteria.map((criterion, i) => (
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
                value={draft.status}
                statuses={statuses}
                onChange={(status) => editDraft({ status })}
                variant="row"
              />
            </PropertyField>
            <PropertyField label="Priority">
              <PriorityControl
                value={draft.priority}
                onChange={(priority: Priority) => editDraft({ priority })}
                variant="row"
              />
            </PropertyField>
            <PropertyField label="Epic">
              <EpicControl
                value={draft.parent}
                epics={data.epics}
                onChange={(parent) => editDraft({ parent })}
                variant="row"
              />
            </PropertyField>
          </div>

          <div className="border-border flex items-center justify-end gap-2 border-t pt-3">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button variant="ghost" onClick={startOver} disabled={saving}>
              <RotateCcw className="size-4" />
              Start over
            </Button>
            <Button
              disabled={saving || !isDraftSaveable(draft)}
              onClick={() => void saveDraft()}
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
          </div>
        </div>
      )}

      {drafting && (
        <div className="border-border bg-card animate-in fade-in-0 flex flex-col gap-3 rounded-lg border p-4 duration-150">
          <div className="text-muted-foreground flex items-center gap-2 text-[13px]">
            <Loader2 className="text-primary size-4 animate-spin" />
            <span>
              Drafting — the agent is reading the codebase and turning your
              description into a task. This can take a minute.
            </span>
          </div>
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}
    </div>
  );
}
