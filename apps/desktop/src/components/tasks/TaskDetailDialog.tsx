import type { RunMeta } from '@dispatch/client';
import type { Priority, TaskDoc, UpdatePatch } from '@dispatch/core';
import { ArrowUpRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { isFakeExecutorDevToolEnabled } from '../../lib/devTools';
import { isTerminalRunState } from '../../lib/runState';
import { parseTaskSections, sectionOrDash } from '../../lib/taskDisplay';
import { AssigneeAvatar } from './AssigneeAvatar';
import { PriorityIcon } from './PriorityIcon';
import { StatusIcon } from './StatusIcon';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

// `Assignee` is a fixed three-value enum ('agent'/'human'/'none') — a plain capitalize reads
// fine for all three ("Agent"/"Human"/"None") without needing a dedicated label map here on
// top of `AssigneeAvatar`'s own internal one.
function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

interface TaskDetailDialogProps {
  doc: TaskDoc;
  statuses: string[];
  ready: boolean;
  run: RunMeta | undefined;
  onClose: () => void;
  onUpdate: (id: string, patch: UpdatePatch) => Promise<void>;
  /** Optimistic status change (see `useDispatchProject.moveTaskStatus`) — the same one the
   * board's drag-and-drop uses, so moving a task's status from this dialog's select feels as
   * immediate as dragging its card, rather than waiting on a round-trip like every other field
   * here (`onUpdate`) does. */
  onMoveStatus: (id: string, status: string) => Promise<void>;
  onDispatch: (id: string, executor?: 'fake' | 'claude') => Promise<void>;
  onOpenRun: (runId: string) => void;
}

/**
 * Task detail as a centered shadcn `Dialog` — Linear itself opens task detail as a modal, not
 * a side panel, so this replaces the old `TaskPeekPanel` overlay with the same treatment
 * `CreateTaskModal` already uses. Same fields/behavior as the panel it replaces (editable
 * title, status/priority selects, read-only frontmatter, body sections, an activity feed +
 * composer, and the dispatch/view-run row), plus an assignee field the panel never surfaced.
 * Dialog owns its own focus trap and Escape handling (Radix), so the panel's hand-rolled
 * `useFocusTrap` + backdrop-click-to-close are gone; closing routes through `onClose` the same
 * way either way — the caller (`App.tsx`) unmounts this on close, same as `CreateTaskModal`.
 */
export function TaskDetailDialog({
  doc,
  statuses,
  ready,
  run,
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
      await onDispatch(doc.meta.id, executor);
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

  const sections = parseTaskSections(doc.body);
  // The Activity section body is append-only free text, one line per entry (see
  // core/store.ts's template) — split it into a feed of entries rather than one flat block,
  // matching the redesign brief's "Activity timeline styled as a feed".
  const activityFeed = sectionOrDash(sections, 'Activity');
  const activityEntries =
    activityFeed === '—'
      ? []
      : activityFeed.split('\n').filter((line) => line.trim() !== '');

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] w-[min(640px,90vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]"
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
        <div className="border-border flex shrink-0 items-center gap-2 border-b px-5 py-3.5">
          <span className="text-muted-foreground font-mono text-[11px]">
            {doc.meta.id}
          </span>
          <span className="text-muted-foreground/50">·</span>
          <StatusIcon status={doc.meta.status} />
          <span className="text-muted-foreground text-[12px]">
            {doc.meta.status}
          </span>
          {/* Visually hidden — Radix requires an accessible dialog title; the visible header
              above (id + status) is the actual title bar people see, so this only exists for
              screen readers. */}
          <DialogTitle className="sr-only">
            {doc.meta.title || 'Task detail'}
          </DialogTitle>
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          {error !== null && (
            <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-[13px]">
              {error}
            </div>
          )}

          <Input
            className="text-foreground hover:border-border -mx-1 h-auto w-[calc(100%+0.5rem)] border-transparent px-1 py-1 text-[17px] font-medium shadow-none transition-colors duration-150"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitleIfChanged}
            aria-label="Task title"
          />

          {(ready || hasOpenRun) && (
            <div className="flex items-center gap-2">
              {ready && (
                <Button
                  size="sm"
                  disabled={dispatching}
                  onClick={() => void dispatch()}
                >
                  Dispatch
                </Button>
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
                  {doc.meta.status === 'in-review' ? 'Review run' : 'View run'}
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

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="text-muted-foreground text-[11px]">Status</span>
              <Select
                value={doc.meta.status}
                onValueChange={(value) => void changeStatus(value)}
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statuses.map((s) => (
                    <SelectItem key={s} value={s}>
                      <StatusIcon status={s} />
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="text-muted-foreground text-[11px]">
                Priority
              </span>
              <Select
                value={doc.meta.priority}
                onValueChange={(value) =>
                  void runUpdate({ priority: value as Priority })
                }
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      <PriorityIcon priority={p} />
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <div className="flex flex-col gap-1 text-[13px]">
              <span className="text-muted-foreground text-[11px]">Kind</span>
              <span className="text-foreground font-mono text-[13px]">
                {doc.meta.kind}
              </span>
            </div>
            <div className="flex flex-col gap-1 text-[13px]">
              <span className="text-muted-foreground text-[11px]">Epic</span>
              <span className="text-foreground font-mono text-[13px]">
                {doc.meta.parent ?? '—'}
              </span>
            </div>
            <div className="flex flex-col gap-1 text-[13px]">
              <span className="text-muted-foreground text-[11px]">
                Blocked by
              </span>
              <span className="text-foreground font-mono text-[13px]">
                {doc.meta.blockedBy.length > 0
                  ? doc.meta.blockedBy.join(', ')
                  : '—'}
              </span>
            </div>
            <div className="flex flex-col gap-1 text-[13px]">
              <span className="text-muted-foreground text-[11px]">
                Assignee
              </span>
              <span className="text-foreground flex items-center gap-1.5 text-[13px]">
                <AssigneeAvatar assignee={doc.meta.assignee} />
                {capitalize(doc.meta.assignee)}
              </span>
            </div>
            {doc.meta.labels.length > 0 && (
              <div className="col-span-2 flex flex-col gap-1 text-[13px]">
                <span className="text-muted-foreground text-[11px]">
                  Labels
                </span>
                <div className="flex flex-wrap gap-1">
                  {doc.meta.labels.map((label) => (
                    <Badge
                      key={label}
                      variant="secondary"
                      className="text-[11px]"
                    >
                      {label}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="border-border flex flex-col gap-2 border-t pt-3">
            <div className="text-foreground text-[13px] font-medium">
              Description
            </div>
            <div className="text-muted-foreground text-[13px] whitespace-pre-wrap">
              {sectionOrDash(sections, 'Description')}
            </div>
          </div>

          <div className="border-border flex flex-col gap-2 border-t pt-3">
            <div className="text-foreground text-[13px] font-medium">
              Acceptance Criteria
            </div>
            <div className="text-muted-foreground text-[13px] whitespace-pre-wrap">
              {sectionOrDash(sections, 'Acceptance Criteria')}
            </div>
          </div>

          <div className="border-border flex flex-col gap-2 border-t pt-3">
            <div className="text-foreground text-[13px] font-medium">
              Activity
            </div>
            {activityEntries.length === 0 ? (
              <p className="text-muted-foreground text-[13px]">—</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {activityEntries.map((entry, i) => (
                  <li
                    key={i}
                    className="bg-muted text-muted-foreground border-primary/40 rounded-md border-l-2 px-3 py-2 text-[13px] whitespace-pre-wrap"
                  >
                    {entry}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <Input
                className="h-8 flex-1 text-[13px]"
                placeholder="Add an activity note…"
                value={activityDraft}
                onChange={(e) => setActivityDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitActivity();
                }}
              />
              <Button variant="secondary" size="sm" onClick={submitActivity}>
                Add
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
