import type { RunMeta } from '@dispatch/client';
import type { Priority, TaskDoc, UpdatePatch } from '@dispatch/core';
import { useEffect, useState } from 'react';

import { isFakeExecutorDevToolEnabled } from '../../lib/devTools';
import { parseTaskSections, sectionOrDash } from '../../lib/taskDisplay';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { TextInput } from '../ui/TextInput';
import './TaskDetailModal.css';

// Fixed, non-config-driven enum (unlike statuses, which come from the
// project's tracker config) — reimplemented here rather than imported at
// runtime, matching @dispatch/web's own TaskDetail.tsx convention of not
// depending on @dispatch/core beyond types.
const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

interface TaskDetailModalProps {
  doc: TaskDoc;
  statuses: string[];
  /** Whether the task graph considers this task safe to start right now — gates the
   * Dispatch button independently of any past run (a task can cycle back to `ready` after a
   * discarded run). */
  ready: boolean;
  /** The most recent orchestrator run for this task, if any — used only to open its RunModal;
   * see TasksPanel's `latestRunByTaskId` for why "most recent" is safe here (task.status
   * gates whether that run is still relevant, not the run's own state). */
  run: RunMeta | undefined;
  onClose: () => void;
  onUpdate: (id: string, patch: UpdatePatch) => Promise<void>;
  onDispatch: (id: string, executor?: 'fake' | 'claude') => Promise<void>;
  onOpenRun: (runId: string) => void;
}

/** Task detail: frontmatter, the two fields that change through direct controls (status,
 * priority), an editable title (blur to save), and the body split into its three plain
 * sections plus an activity append box. Mirrors
 * packages/web/src/components/TaskDetail.tsx's feature set, restyled native to Relay's
 * tokens.css/Modal rather than web's drawer + theme.css. */
export function TaskDetailModal({
  doc,
  statuses,
  ready,
  run,
  onClose,
  onUpdate,
  onDispatch,
  onOpenRun,
}: TaskDetailModalProps) {
  const [title, setTitle] = useState(doc.meta.title);
  const [activityDraft, setActivityDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);

  const hasOpenRun =
    run !== undefined &&
    (doc.meta.status === 'in-progress' || doc.meta.status === 'in-review');

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

  // A newly selected task (different id) resets the editable fields to its own values —
  // otherwise switching cards mid-edit would carry over the previous task's draft title.
  useEffect(() => {
    setTitle(doc.meta.title);
    setActivityDraft('');
    setError(null);
  }, [doc.meta.id, doc.meta.title]);

  // Every control below (status/priority selects, title blur, activity submit) routes
  // through this instead of calling `onUpdate` directly, so a PATCH rejection surfaces
  // inline the same way CreateTaskModal's `submit()` does, rather than silently vanishing
  // — the WS-driven refetch that follows a failed PATCH would otherwise be the only
  // visible effect, quietly reverting whatever the control optimistically showed.
  async function runUpdate(patch: UpdatePatch) {
    try {
      setError(null);
      await onUpdate(doc.meta.id, patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function saveTitleIfChanged() {
    if (title.trim() !== '' && title !== doc.meta.title) {
      void runUpdate({ title });
    }
  }

  function submitActivity() {
    if (activityDraft.trim() !== '') {
      void runUpdate({ appendActivity: activityDraft.trim() });
      setActivityDraft('');
    }
  }

  const sections = parseTaskSections(doc.body);

  return (
    <Modal isOpen onClose={onClose} title={doc.meta.id}>
      <div className="task-detail-modal">
        {error !== null && (
          <div className="task-detail-modal-error">{error}</div>
        )}

        <TextInput
          className="task-detail-modal-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitleIfChanged}
          aria-label="Task title"
        />

        {(ready || hasOpenRun) && (
          <div className="task-detail-modal-run-row">
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
                className="task-detail-modal-pr-chip"
                href={run.prUrl}
                target="_blank"
                rel="noreferrer"
              >
                PR ↗
              </a>
            )}
          </div>
        )}

        <div className="task-detail-modal-fields">
          <label className="task-detail-modal-field">
            <span className="task-detail-modal-field-label">Status</span>
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
          <label className="task-detail-modal-field">
            <span className="task-detail-modal-field-label">Priority</span>
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
          <div className="task-detail-modal-field">
            <span className="task-detail-modal-field-label">Kind</span>
            <span className="task-detail-modal-field-value">
              {doc.meta.kind}
            </span>
          </div>
          <div className="task-detail-modal-field">
            <span className="task-detail-modal-field-label">Epic</span>
            <span className="task-detail-modal-field-value">
              {doc.meta.parent ?? '—'}
            </span>
          </div>
          <div className="task-detail-modal-field">
            <span className="task-detail-modal-field-label">Blocked by</span>
            <span className="task-detail-modal-field-value">
              {doc.meta.blockedBy.length > 0
                ? doc.meta.blockedBy.join(', ')
                : '—'}
            </span>
          </div>
        </div>

        <div className="task-detail-modal-section">
          <div className="task-detail-modal-section-title">Description</div>
          <div className="task-detail-modal-section-body">
            {sectionOrDash(sections, 'Description')}
          </div>
        </div>

        <div className="task-detail-modal-section">
          <div className="task-detail-modal-section-title">
            Acceptance Criteria
          </div>
          <div className="task-detail-modal-section-body">
            {sectionOrDash(sections, 'Acceptance Criteria')}
          </div>
        </div>

        <div className="task-detail-modal-section">
          <div className="task-detail-modal-section-title">Activity</div>
          <div className="task-detail-modal-section-body">
            {sectionOrDash(sections, 'Activity')}
          </div>
          <div className="task-detail-modal-activity-row">
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
    </Modal>
  );
}
