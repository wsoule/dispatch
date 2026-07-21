import type { RunMeta } from '@dispatch/client';
import type { Priority, TaskDoc, UpdatePatch } from '@dispatch/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useFocusTrap } from '../../hooks/useFocusTrap';
import { isFakeExecutorDevToolEnabled } from '../../lib/devTools';
import { isTerminalRunState } from '../../lib/runState';
import { parseTaskSections, sectionOrDash } from '../../lib/taskDisplay';
import { Button } from '../ui/Button';
import { Pill } from '../ui/Pill';
import { Select } from '../ui/Select';
import { TextInput } from '../ui/TextInput';
import './TaskPeekPanel.css';

const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

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
    <div className="task-peek-backdrop" onClick={onClose}>
      <aside
        ref={panelRef}
        className="task-peek-panel"
        onClick={(e) => e.stopPropagation()}
        aria-label={`Task ${doc.meta.id} detail`}
      >
        <div className="task-peek-header">
          <span className="task-peek-id">{doc.meta.id}</span>
          <button
            className="task-peek-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="task-peek-body">
          {error !== null && <div className="task-peek-error">{error}</div>}

          <TextInput
            className="task-peek-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitleIfChanged}
            aria-label="Task title"
          />

          {(ready || hasOpenRun) && (
            <div className="task-peek-run-row">
              {ready && (
                <Button disabled={dispatching} onClick={() => void dispatch()}>
                  Dispatch
                </Button>
              )}
              {ready && isFakeExecutorDevToolEnabled() && (
                <Button
                  variant="secondary"
                  disabled={dispatching}
                  onClick={() => void dispatch('fake')}
                >
                  Dispatch (fake)
                </Button>
              )}
              {hasOpenRun && run !== undefined && (
                <Button variant="secondary" onClick={() => onOpenRun(run.id)}>
                  {doc.meta.status === 'in-review' ? 'Review run' : 'View run'}
                </Button>
              )}
              {run?.prUrl !== undefined && (
                <a
                  className="task-peek-pr-chip"
                  href={run.prUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  PR ↗
                </a>
              )}
            </div>
          )}

          <div className="task-peek-fields">
            <label className="task-peek-field">
              <span className="task-peek-field-label">Status</span>
              <Select
                value={doc.meta.status}
                onChange={(e) => void runUpdate({ status: e.target.value })}
              >
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </label>
            <label className="task-peek-field">
              <span className="task-peek-field-label">Priority</span>
              <Select
                value={doc.meta.priority}
                onChange={(e) =>
                  void runUpdate({ priority: e.target.value as Priority })
                }
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </label>
            <div className="task-peek-field">
              <span className="task-peek-field-label">Kind</span>
              <span className="task-peek-field-value">{doc.meta.kind}</span>
            </div>
            <div className="task-peek-field">
              <span className="task-peek-field-label">Epic</span>
              <span className="task-peek-field-value">
                {doc.meta.parent ?? '—'}
              </span>
            </div>
            <div className="task-peek-field">
              <span className="task-peek-field-label">Blocked by</span>
              <span className="task-peek-field-value">
                {doc.meta.blockedBy.length > 0
                  ? doc.meta.blockedBy.join(', ')
                  : '—'}
              </span>
            </div>
            {doc.meta.labels.length > 0 && (
              <div className="task-peek-field">
                <span className="task-peek-field-label">Labels</span>
                <div className="task-peek-field-labels">
                  {doc.meta.labels.map((label) => (
                    <Pill key={label} variant="tag" tone="gray">
                      {label}
                    </Pill>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="task-peek-section">
            <div className="task-peek-section-title">Description</div>
            <div className="task-peek-section-body">
              {sectionOrDash(sections, 'Description')}
            </div>
          </div>

          <div className="task-peek-section">
            <div className="task-peek-section-title">Acceptance Criteria</div>
            <div className="task-peek-section-body">
              {sectionOrDash(sections, 'Acceptance Criteria')}
            </div>
          </div>

          <div className="task-peek-section">
            <div className="task-peek-section-title">Activity</div>
            {activityEntries.length === 0 ? (
              <p className="task-peek-section-body">—</p>
            ) : (
              <ul className="task-peek-activity-feed">
                {activityEntries.map((entry, i) => (
                  <li key={i} className="task-peek-activity-entry">
                    {entry}
                  </li>
                ))}
              </ul>
            )}
            <div className="task-peek-activity-row">
              <TextInput
                placeholder="Add an activity note…"
                value={activityDraft}
                onChange={(e) => setActivityDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitActivity();
                }}
              />
              <Button variant="secondary" onClick={submitActivity}>
                Add
              </Button>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
