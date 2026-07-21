import type { RunMeta } from '@dispatch/client';
import type { Priority, TaskDoc, UpdatePatch } from '@dispatch/core';
import {
  ArrowUpRight,
  ChevronsUp,
  Minus,
  SignalHigh,
  SignalLow,
  SignalMedium,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useFocusTrap } from '../../hooks/useFocusTrap';
import { isFakeExecutorDevToolEnabled } from '../../lib/devTools';
import { isTerminalRunState } from '../../lib/runState';
import { parseTaskSections, sectionOrDash } from '../../lib/taskDisplay';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../ui/select';

const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

// Per-priority icon + color, matching the redesign brief's "priority is a small lucide icon,
// color-coded" direction. Unlike `priorityTone` (lib/taskDisplay.ts), which only colors
// urgent/high for the list/board's low-noise chip, the peek panel's own priority *control*
// shows every value distinctly (a select needs to represent whatever is currently chosen).
const PRIORITY_ICON: Record<Priority, typeof ChevronsUp> = {
  urgent: ChevronsUp,
  high: SignalHigh,
  medium: SignalMedium,
  low: SignalLow,
  none: Minus,
};

const PRIORITY_COLOR: Record<Priority, string> = {
  urgent: 'text-destructive',
  high: 'text-amber-500',
  medium: 'text-muted-foreground',
  low: 'text-muted-foreground',
  none: 'text-muted-foreground',
};

function PriorityGlyph({ priority }: { priority: Priority }) {
  const Icon = PRIORITY_ICON[priority];
  return <Icon className={`size-3.5 shrink-0 ${PRIORITY_COLOR[priority]}`} />;
}

interface TaskPeekPanelProps {
  doc: TaskDoc;
  statuses: string[];
  ready: boolean;
  run: RunMeta | undefined;
  onClose: () => void;
  onUpdate: (id: string, patch: UpdatePatch) => Promise<void>;
  onDispatch: (id: string, executor?: 'fake' | 'claude') => Promise<void>;
  onOpenRun: (runId: string) => void;
}

/**
 * Task detail as a Linear-style side peek: an overlay panel from the right rather than a
 * centered modal, so the board stays visible (and legible as "still the same screen, just
 * with detail open") behind it. Replaces the old `TaskDetailModal` — same fields/behavior
 * (editable title, status/priority selects, read-only frontmatter, body sections, an
 * activity feed + composer, and the dispatch/view-run row), just restyled as a peek and with
 * the Activity section reframed as a feed rather than a plain text block. Closing happens
 * via the caller's `onClose` — wired through the app-level `navReducer`'s `escape` action, a
 * click on the panel's own close button, or a click on the dimmed backdrop to its left.
 */
export function TaskPeekPanel({
  doc,
  statuses,
  ready,
  run,
  onClose,
  onUpdate,
  onDispatch,
  onOpenRun,
}: TaskPeekPanelProps) {
  const [title, setTitle] = useState(doc.meta.title);
  const [activityDraft, setActivityDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const panelRef = useRef<HTMLElement>(null);

  useFocusTrap(panelRef, true);

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

  const saveTitleIfChanged = useCallback(() => {
    if (title.trim() !== '' && title !== doc.meta.title) {
      void runUpdate({ title });
    }
  }, [title, doc.meta.title, runUpdate]);

  // Escape closes the peek via the app-root `navReducer` (a global `window` listener, not
  // this component) — which unmounts this panel entirely. A plain `onBlur` on the title
  // input can't be relied on to fire before that unmount (removing a focused node's blur
  // behavior is inconsistent enough across browsers/webviews to not build a save on), so
  // this listens for Escape itself and commits the in-progress title edit explicitly. The
  // choice here is to commit, not discard, on Escape-while-editing — matching every other
  // control on this panel (status/priority selects, activity notes), which all save
  // immediately rather than needing a separate "save" step.
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
    <div
      className="animate-in fade-in-0 fixed inset-0 z-40 bg-black/40 duration-150"
      onClick={onClose}
    >
      <aside
        ref={panelRef}
        className="border-border bg-card animate-in slide-in-from-right-4 fade-in-0 fixed top-0 right-0 bottom-0 z-50 flex w-[min(28rem,92vw)] flex-col border-l shadow-2xl duration-150"
        onClick={(e) => e.stopPropagation()}
        aria-label={`Task ${doc.meta.id} detail`}
      >
        <div className="border-border flex shrink-0 items-center justify-between border-b px-4 py-3">
          <span className="text-muted-foreground font-mono text-[11px]">
            {doc.meta.id}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
          {error !== null && (
            <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-[13px]">
              {error}
            </div>
          )}

          <Input
            className="text-foreground hover:border-border -mx-1 h-auto w-[calc(100%+0.5rem)] border-transparent px-1 py-1 text-[15px] font-medium shadow-none transition-colors duration-150"
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
                onValueChange={(value) => void runUpdate({ status: value })}
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statuses.map((s) => (
                    <SelectItem key={s} value={s}>
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
                      <PriorityGlyph priority={p} />
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
      </aside>
    </div>
  );
}
