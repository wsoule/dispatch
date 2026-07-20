import type { Priority, TaskDoc, UpdatePatch } from '@dispatch/core';
import { useEffect, useState } from 'react';

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
  onClose: () => void;
  onUpdate: (id: string, patch: UpdatePatch) => void;
}

/** Task detail: frontmatter, the two fields that change through direct controls (status,
 * priority), an editable title (blur to save), and the body split into its three plain
 * sections plus an activity append box. Mirrors
 * packages/web/src/components/TaskDetail.tsx's feature set, restyled native to Relay's
 * tokens.css/Modal rather than web's drawer + theme.css. */
export function TaskDetailModal({
  doc,
  statuses,
  onClose,
  onUpdate,
}: TaskDetailModalProps) {
  const [title, setTitle] = useState(doc.meta.title);
  const [activityDraft, setActivityDraft] = useState('');

  // A newly selected task (different id) resets the editable fields to its own values —
  // otherwise switching cards mid-edit would carry over the previous task's draft title.
  useEffect(() => {
    setTitle(doc.meta.title);
    setActivityDraft('');
  }, [doc.meta.id, doc.meta.title]);

  function saveTitleIfChanged() {
    if (title.trim() !== '' && title !== doc.meta.title) {
      onUpdate(doc.meta.id, { title });
    }
  }

  function submitActivity() {
    if (activityDraft.trim() !== '') {
      onUpdate(doc.meta.id, { appendActivity: activityDraft.trim() });
      setActivityDraft('');
    }
  }

  const sections = parseTaskSections(doc.body);

  return (
    <Modal isOpen onClose={onClose} title={doc.meta.id}>
      <div className="task-detail-modal">
        <TextInput
          className="task-detail-modal-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitleIfChanged}
          aria-label="Task title"
        />

        <div className="task-detail-modal-fields">
          <label className="task-detail-modal-field">
            <span className="task-detail-modal-field-label">Status</span>
            <Select
              value={doc.meta.status}
              onChange={(e) =>
                onUpdate(doc.meta.id, { status: e.target.value })
              }
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
                onUpdate(doc.meta.id, {
                  priority: e.target.value as Priority,
                })
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
