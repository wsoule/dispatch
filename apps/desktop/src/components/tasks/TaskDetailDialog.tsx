import type { RunMeta } from '@dispatch/client';
import type { TaskDoc, UpdatePatch } from '@dispatch/core';
import {
  ArrowUpRight,
  Ban,
  Check,
  ChevronDown,
  Layers,
  Plus,
  Tag,
  Target,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';

import { isFakeExecutorDevToolEnabled } from '../../lib/devTools';
import { formatRelativeTimeFromIso } from '../../lib/format';
import { modelLabel, MODELS, readDefaultModel } from '../../lib/models';
import { isTerminalRunState } from '../../lib/runState';
import { parseTaskSections } from '../../lib/taskDisplay';
import { RunStatePill } from '../runs/RunStatePill';
import {
  AssigneeControl,
  EpicControl,
  PriorityControl,
  StatusControl,
} from './PropertyControls';
import { StatusIcon } from './StatusIcon';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/ui/select';
import { Textarea } from '@/ui/textarea';

// A titled group of rows in the rail (Properties, Labels, Blocked by) — the
// small muted header that lets Linear stack several property groups down the
// sidebar without any dividers doing the separating.
function RailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-muted-foreground/70 px-2 pb-1 text-[11px] font-medium tracking-wide">
        {title}
      </div>
      {children}
    </div>
  );
}

// A titled block in the main column (Description, Acceptance Criteria,
// Sessions, Activity) — a quiet header plus its content, separated from
// neighbors by whitespace rather than the heavy top-borders the old
// single-column layout stacked on every section.
function MainSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

// An inline-editable body section (Description, Acceptance Criteria): renders
// as borderless prose until focused, auto-grows to its content, and commits on
// blur only when the text actually changed — so reading the task costs nothing
// and editing is one click into the text. `value` is the section's current
// persisted text; the local draft resets whenever it (or the task) changes.
function EditableBodySection({
  title,
  value,
  placeholder,
  onSave,
}: {
  title: string;
  value: string;
  placeholder: string;
  onSave: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <MainSection title={title}>
      <Textarea
        className="text-foreground/90 hover:bg-muted/30 focus-visible:bg-muted/40 -mx-2 min-h-[2.25rem] resize-none rounded-md border-transparent bg-transparent px-2 py-1.5 text-[13.5px] leading-relaxed shadow-none transition-colors duration-150 focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) onSave(draft);
        }}
      />
    </MainSection>
  );
}

// The milestone editor in the rail: a pick-or-type field (native datalist) over the
// project's existing milestone names, so assigning a task to a milestone reuses a name with
// one keystroke or coins a new one — no per-project milestone setup, matching the free-form
// model. Commits on blur; clearing it unsets the milestone.
function MilestoneRow({
  value,
  milestones,
  onChange,
}: {
  value: string | null;
  milestones: string[];
  onChange: (milestone: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  return (
    <div className="hover:bg-muted/60 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]">
      <Target className="text-muted-foreground size-3.5 shrink-0" />
      <input
        list="dispatch-milestones"
        className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent outline-none"
        placeholder="No milestone"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next !== (value ?? '')) onChange(next === '' ? null : next);
        }}
      />
      <datalist id="dispatch-milestones">
        {milestones.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  );
}

// The labels editor in the rail: existing labels as removable chips plus an
// input that adds a label on Enter. Labels are freeform strings, so this is a
// plain add/remove rather than a pick-from-list — deduped and trimmed before it
// calls back with the whole new list (matching UpdatePatch.labels' shape).
function LabelEditor({
  labels,
  onChange,
}: {
  labels: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  function add() {
    const label = draft.trim();
    if (label !== '' && !labels.includes(label)) onChange([...labels, label]);
    setDraft('');
  }
  return (
    <div className="flex flex-col gap-1.5 px-2 pt-0.5">
      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {labels.map((label) => (
            <Badge
              key={label}
              variant="secondary"
              className="gap-1 pr-1 text-[11px]"
            >
              {label}
              <button
                type="button"
                aria-label={`Remove label ${label}`}
                className="hover:text-foreground text-muted-foreground"
                onClick={() => onChange(labels.filter((l) => l !== label))}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Input
        className="h-7 text-[12px]"
        placeholder="Add label…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add();
        }}
        onBlur={add}
      />
    </div>
  );
}

// The blocked-by editor in the rail: current blockers as removable chips (each
// showing the blocking task's id) plus a Select of the other tasks in the
// project to add one. Unlike labels this IS a pick-from-list — a blocker has to
// be a real task id — so the add control is a dropdown of candidates (self and
// already-listed blockers filtered out) rather than a free-text input.
function BlockedByEditor({
  blockedBy,
  candidates,
  onChange,
}: {
  blockedBy: string[];
  candidates: TaskDoc[];
  onChange: (next: string[]) => void;
}) {
  const addable = candidates.filter((t) => !blockedBy.includes(t.meta.id));
  return (
    <div className="flex flex-col gap-1.5 px-2 pt-0.5">
      {blockedBy.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {blockedBy.map((id) => (
            <Badge
              key={id}
              variant="secondary"
              className="gap-1 pr-1 text-[11px]"
            >
              <span className="font-mono">{id}</span>
              <button
                type="button"
                aria-label={`Remove blocker ${id}`}
                className="hover:text-foreground text-muted-foreground"
                onClick={() => onChange(blockedBy.filter((b) => b !== id))}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      {addable.length > 0 && (
        // `key` on the Select resets it to the placeholder after each add, so it
        // never shows a stale "selected" blocker and can add several in a row.
        <Select
          key={blockedBy.join(',')}
          value=""
          onValueChange={(id) => onChange([...blockedBy, id])}
        >
          <SelectTrigger
            size="sm"
            className="text-muted-foreground h-7 w-full justify-start gap-1.5 text-[12px] [&>svg]:hidden"
          >
            <Plus className="size-3.5" />
            <span>Add blocker</span>
          </SelectTrigger>
          <SelectContent>
            {addable.map((t) => (
              <SelectItem key={t.meta.id} value={t.meta.id}>
                <span className="text-muted-foreground font-mono text-[11px]">
                  {t.meta.id}
                </span>
                <span className="truncate">{t.meta.title}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

interface TaskDetailDialogProps {
  doc: TaskDoc;
  statuses: string[];
  ready: boolean;
  run: RunMeta | undefined;
  /** Every run (agent session) this task has had — newest first — so the detail modal can
   * list them and let you jump into any session's log/review, not just the latest one. */
  runs: RunMeta[];
  /** All epics in the project, for the editable Epic (parent) picker. */
  epics: TaskDoc[];
  /** All tasks in the project, for the editable Blocked-by picker (self is filtered out). */
  tasks: TaskDoc[];
  onClose: () => void;
  onUpdate: (id: string, patch: UpdatePatch) => Promise<void>;
  /** Optimistic status change (see `useDispatchProject.moveTaskStatus`) — the same one the
   * board's drag-and-drop uses, so moving a task's status from this dialog's select feels as
   * immediate as dragging its card, rather than waiting on a round-trip like every other field
   * here (`onUpdate`) does. */
  onMoveStatus: (id: string, status: string) => Promise<void>;
  onDispatch: (
    id: string,
    executor?: 'fake' | 'claude',
    model?: string
  ) => Promise<void>;
  onOpenRun: (runId: string) => void;
}

/**
 * Task detail as a wide, two-column shadcn `Dialog`, built to Linear's issue-detail anatomy: a
 * roomy main column (the title as the one loud element, then inline-editable Description /
 * Acceptance Criteria, Sessions, and Activity) beside a narrow right-hand *properties rail*
 * where status, priority, assignee, epic, blockers, and labels are all editable as compact
 * icon+value rows instead of boxed form fields. Every field on the task is editable in place:
 * frontmatter fields go through `onUpdate`/`onMoveStatus`, and the free-text body sections go
 * through `onUpdate`'s `description`/`acceptanceCriteria` (whole-section replacements — see
 * core's setSection). Linear opens issues as a modal (not a side panel), so this stays a
 * centered `Dialog` and owns its own focus trap and Escape handling via Radix.
 */
export function TaskDetailDialog({
  doc,
  statuses,
  ready,
  run,
  runs,
  epics,
  tasks,
  onClose,
  onUpdate,
  onMoveStatus,
  onDispatch,
  onOpenRun,
}: TaskDetailDialogProps) {
  const [title, setTitle] = useState(doc.meta.title);
  const [activityDraft, setActivityDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  // The model this dispatch will use — seeded from the saved default, overridable per-dispatch
  // via the picker beside the Dispatch button.
  const [model, setModel] = useState(readDefaultModel);

  // Derived from the run's own state, not the task's status string: the old check compared
  // `doc.meta.status` against the literal built-in strings `'in-progress'`/`'in-review'`,
  // which silently stopped working for any project whose `.dispatch/config.yml` names its
  // in-flight statuses something else. A run that isn't in a terminal state *is* an "open
  // run" regardless of what the task's own status happens to be called.
  const hasOpenRun = run !== undefined && !isTerminalRunState(run.state);

  async function dispatch(executor?: 'fake' | 'claude') {
    setDispatching(true);
    setError(null);
    try {
      await onDispatch(
        doc.meta.id,
        executor,
        executor === 'fake' ? undefined : model
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDispatching(false);
    }
  }

  useEffect(() => {
    setTitle(doc.meta.title);
    setActivityDraft('');
    setError(null);
  }, [doc.meta.id, doc.meta.title]);

  const runUpdate = useCallback(
    async (patch: UpdatePatch) => {
      try {
        setError(null);
        await onUpdate(doc.meta.id, patch);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [doc.meta.id, onUpdate]
  );

  const changeStatus = useCallback(
    async (status: string) => {
      try {
        setError(null);
        await onMoveStatus(doc.meta.id, status);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [doc.meta.id, onMoveStatus]
  );

  const saveTitleIfChanged = useCallback(() => {
    if (title.trim() !== '' && title !== doc.meta.title) {
      void runUpdate({ title });
    }
  }, [title, doc.meta.title, runUpdate]);

  // Escape closes the dialog via Radix's own handling (which unmounts this component through
  // `onClose`/`onOpenChange`) — a plain `onBlur` on the title input can't be relied on to fire
  // before that unmount (removing a focused node's blur behavior is inconsistent enough across
  // browsers/webviews to not build a save on), so this listens for Escape itself and commits
  // the in-progress title edit explicitly. The choice here is to commit, not discard, on
  // Escape-while-editing — matching every other control on this dialog (status/priority
  // selects, activity notes), which all save immediately rather than needing a separate "save"
  // step.
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') saveTitleIfChanged();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [saveTitleIfChanged]);

  function submitActivity() {
    if (activityDraft.trim() !== '') {
      void runUpdate({ appendActivity: activityDraft.trim() });
      setActivityDraft('');
    }
  }

  // Existing milestone names across the project, for the rail's pick-or-type field.
  const milestones = [
    ...new Set(
      tasks
        .map((t) => t.meta.milestone)
        .filter((m): m is string => m !== null && m !== '')
    ),
  ].sort();

  const sections = parseTaskSections(doc.body);
  const description = sections.get('Description') ?? '';
  const acceptance = sections.get('Acceptance Criteria') ?? '';
  // The Activity section body is append-only free text, one line per entry (see
  // core/store.ts's template) — split it into a feed of entries rather than one flat block.
  const activityEntries = (sections.get('Activity') ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '');

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex h-[85vh] max-h-[760px] w-[min(960px,94vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[960px]"
        aria-describedby={undefined}
        // Radix's default open-autofocus lands on the first tabbable descendant — which is
        // the (pre-filled) title field — and browsers select a text input's full value when
        // it's focused this way, not just place a caret. Left alone, opening this dialog and
        // pressing any key (even Space) would silently wipe the task's title. Focus the
        // content root itself instead (Radix gives it `tabIndex={-1}` for exactly this) —
        // Tab still reaches the title field normally, just without the drive-by select-all.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
      >
        {/* Breadcrumb-style header, matching Linear's `Team › Issues › ID`: just the id and
            live status, quiet, above the two-column body. */}
        <div className="border-border flex shrink-0 items-center gap-2 border-b px-6 py-3">
          <span className="text-muted-foreground font-mono text-[11px]">
            {doc.meta.id}
          </span>
          <span className="text-muted-foreground/40">›</span>
          <StatusIcon status={doc.meta.status} />
          <span className="text-muted-foreground text-[12px]">
            {doc.meta.status}
          </span>
          <DialogTitle className="sr-only">
            {doc.meta.title || 'Task detail'}
          </DialogTitle>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Main column: the title leads, then dispatch actions, editable prose sections,
              sessions, and the activity feed + composer — all left-aligned in a roomy flow. */}
          <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-8 py-6">
            {error !== null && (
              <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-[13px]">
                {error}
              </div>
            )}

            <Input
              className="text-foreground hover:bg-muted/40 dark:hover:bg-muted/40 -mx-2 h-auto w-[calc(100%+1rem)] border-transparent bg-transparent px-2 py-1 text-[22px] leading-tight font-semibold shadow-none transition-colors duration-150 dark:bg-transparent"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={saveTitleIfChanged}
              aria-label="Task title"
            />

            {(ready || hasOpenRun) && (
              <div className="-mt-2 flex items-center gap-2">
                {ready && (
                  <>
                    <Button
                      size="sm"
                      disabled={dispatching}
                      onClick={() => void dispatch()}
                    >
                      Dispatch
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="text-muted-foreground hover:bg-muted/60 hover:text-foreground inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-1 text-[12px] transition-colors duration-150"
                        >
                          {modelLabel(model)}
                          <ChevronDown className="size-3" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        {MODELS.map((m) => (
                          <DropdownMenuItem
                            key={m.id}
                            onSelect={() => setModel(m.id)}
                            className="gap-2 pr-8 text-[13px]"
                          >
                            <span className="flex-1">{m.label}</span>
                            {m.id === model && (
                              <Check className="ml-auto size-3.5" />
                            )}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
                {ready && isFakeExecutorDevToolEnabled() && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={dispatching}
                    onClick={() => void dispatch('fake')}
                  >
                    Dispatch (fake)
                  </Button>
                )}
                {hasOpenRun && run !== undefined && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onOpenRun(run.id)}
                  >
                    {doc.meta.status === 'in-review'
                      ? 'Review run'
                      : 'View run'}
                  </Button>
                )}
                {run?.prUrl !== undefined && (
                  <a
                    className="text-primary hover:bg-accent border-border inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition-colors duration-150"
                    href={run.prUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    PR
                    <ArrowUpRight className="size-3" />
                  </a>
                )}
              </div>
            )}

            <EditableBodySection
              title="Description"
              value={description}
              placeholder="Add a description…"
              onSave={(next) => void runUpdate({ description: next })}
            />

            <EditableBodySection
              title="Acceptance Criteria"
              value={acceptance}
              placeholder="Add acceptance criteria…"
              onSave={(next) => void runUpdate({ acceptanceCriteria: next })}
            />

            <MainSection
              title={`Sessions${runs.length > 0 ? ` · ${runs.length}` : ''}`}
            >
              {runs.length === 0 ? (
                <p className="text-muted-foreground text-[13px]">
                  No agent has worked this task yet.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {runs.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => onOpenRun(r.id)}
                        className="hover:bg-muted/60 border-border/60 flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors duration-150"
                      >
                        <RunStatePill state={r.state} />
                        <span className="text-muted-foreground font-mono text-[11px]">
                          {r.id}
                        </span>
                        <span className="text-muted-foreground/70 ml-auto text-[11px] whitespace-nowrap">
                          {r.costUsd !== undefined &&
                            `$${r.costUsd.toFixed(2)} · `}
                          {formatRelativeTimeFromIso(r.updatedAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </MainSection>

            <MainSection title="Activity">
              {activityEntries.length === 0 ? (
                <p className="text-muted-foreground text-[13px]">
                  No activity yet.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {activityEntries.map((entry, i) => (
                    <li
                      key={i}
                      className="text-muted-foreground text-[13px] whitespace-pre-wrap"
                    >
                      {entry}
                    </li>
                  ))}
                </ul>
              )}
              {/* Linear-style comment composer: one bordered, rounded box that focuses as a
                  unit, with the send affordance tucked inside on the right. */}
              <div className="border-border focus-within:border-ring/60 mt-1 flex items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors duration-150">
                <Input
                  className="h-7 flex-1 border-transparent bg-transparent px-1 text-[13px] shadow-none focus-visible:ring-0"
                  placeholder="Leave a note…"
                  value={activityDraft}
                  onChange={(e) => setActivityDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitActivity();
                  }}
                />
                <Button
                  size="sm"
                  disabled={activityDraft.trim() === ''}
                  onClick={submitActivity}
                >
                  Add
                </Button>
              </div>
            </MainSection>
          </div>

          {/* Properties rail: the signature Linear element — every property editable in place
              as a compact icon+value row (ghost selects) or chip editor, grouped under quiet
              headers, instead of a grid of boxed form fields. */}
          <aside className="border-border bg-muted/20 w-[248px] shrink-0 overflow-y-auto border-l px-4 py-6">
            <div className="flex flex-col gap-5">
              <RailSection title="Properties">
                <StatusControl
                  value={doc.meta.status}
                  statuses={statuses}
                  onChange={(s) => void changeStatus(s)}
                  variant="row"
                />
                <PriorityControl
                  value={doc.meta.priority}
                  onChange={(p) => void runUpdate({ priority: p })}
                  variant="row"
                />
                <AssigneeControl
                  value={doc.meta.assignee}
                  onChange={(a) => void runUpdate({ assignee: a })}
                  variant="row"
                />
                <EpicControl
                  value={doc.meta.parent}
                  epics={epics}
                  onChange={(parent) => void runUpdate({ parent })}
                  variant="row"
                />

                <MilestoneRow
                  value={doc.meta.milestone}
                  milestones={milestones}
                  onChange={(milestone) => void runUpdate({ milestone })}
                />

                {/* Kind is fixed at creation (task vs epic) — the one property that stays
                    read-only, shown for context alongside the editable rows. */}
                <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]">
                  <Layers className="text-muted-foreground size-3.5" />
                  <span>{doc.meta.kind}</span>
                </div>
              </RailSection>

              <RailSection title="Blocked by">
                {doc.meta.blockedBy.length === 0 && (
                  <div className="text-muted-foreground flex items-center gap-2 px-2 py-1.5 text-[13px]">
                    <Ban className="size-3.5" />
                    No blockers
                  </div>
                )}
                <BlockedByEditor
                  blockedBy={doc.meta.blockedBy}
                  candidates={tasks.filter((t) => t.meta.id !== doc.meta.id)}
                  onChange={(next) => void runUpdate({ blockedBy: next })}
                />
              </RailSection>

              <RailSection title="Labels">
                {doc.meta.labels.length === 0 && (
                  <div className="text-muted-foreground flex items-center gap-2 px-2 pb-0.5 text-[13px]">
                    <Tag className="size-3.5" />
                    No labels
                  </div>
                )}
                <LabelEditor
                  labels={doc.meta.labels}
                  onChange={(next) => void runUpdate({ labels: next })}
                />
              </RailSection>
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
