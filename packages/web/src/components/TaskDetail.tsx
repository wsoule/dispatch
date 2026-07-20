import type { Priority, TaskDoc, UpdatePatch } from '@dispatch/core';
import { useEffect, useState } from 'react';

// Mirrors core/types.ts's PRIORITIES — a fixed, non-config-driven enum
// (unlike statuses), reimplemented here rather than imported at runtime per
// this package's types-only import rule for @dispatch/core.
const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

// A task body is `## Description\n\n...\n\n## Acceptance Criteria\n\n## Activity\n`
// (see core/store.ts's create template). This splits it into a heading ->
// content map so each section can render as its own plain block — no
// markdown parser, just `white-space: pre-wrap` per the design direction.
function parseSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = body.split(/^## /m).slice(1);
  for (const part of parts) {
    const newlineIndex = part.indexOf('\n');
    const heading = (
      newlineIndex === -1 ? part : part.slice(0, newlineIndex)
    ).trim();
    const content =
      newlineIndex === -1 ? '' : part.slice(newlineIndex + 1).trim();
    sections.set(heading, content);
  }
  return sections;
}

// Empty sections (e.g. an unfilled Acceptance Criteria) should read the same
// as a missing one — both just mean "nothing here yet."
function sectionOrDash(sections: Map<string, string>, heading: string): string {
  const content = sections.get(heading);
  return content !== undefined && content !== '' ? content : '—';
}

export interface TaskDetailProps {
  doc: TaskDoc | null;
  statuses: string[];
  onClose: () => void;
  onUpdate: (id: string, patch: UpdatePatch) => Promise<void>;
}

// Right-side drawer: full frontmatter, the two fields that change through
// direct controls (status, priority), an editable title (blur to save), and
// the body split into its three plain sections plus an activity append box.
export function TaskDetail({
  doc,
  statuses,
  onClose,
  onUpdate,
}: TaskDetailProps) {
  // Retain the last opened doc while the drawer slides shut so the close
  // transition doesn't blank the content mid-animation.
  const [lastDoc, setLastDoc] = useState<TaskDoc | null>(null);
  const [title, setTitle] = useState('');
  const [activityDraft, setActivityDraft] = useState('');

  useEffect(() => {
    if (doc !== null) {
      setLastDoc(doc);
      setTitle(doc.meta.title);
      setActivityDraft('');
    }
  }, [doc]);

  const shown = doc ?? lastDoc;
  const isOpen = doc !== null;

  function saveTitleIfChanged() {
    if (shown !== null && title.trim() !== '' && title !== shown.meta.title) {
      void onUpdate(shown.meta.id, { title });
    }
  }

  function submitActivity() {
    if (shown !== null && activityDraft.trim() !== '') {
      void onUpdate(shown.meta.id, { appendActivity: activityDraft.trim() });
      setActivityDraft('');
    }
  }

  const sections =
    shown !== null ? parseSections(shown.body) : new Map<string, string>();

  return (
    <>
      <div
        className="scrim"
        data-open={isOpen}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className="drawer"
        data-open={isOpen}
        aria-hidden={!isOpen}
        aria-label="Task detail"
      >
        {shown !== null && (
          <>
            <div className="drawer__header">
              <input
                className="drawer__title-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={saveTitleIfChanged}
                aria-label="Task title"
              />
              <button
                type="button"
                className="btn btn--ghost btn--icon"
                onClick={onClose}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="drawer__body">
              <div className="drawer__meta-grid">
                <div className="drawer__meta-row">
                  <span className="field__label">Id</span>
                  <span className="drawer__meta-value mono">
                    {shown.meta.id}
                  </span>
                </div>
                <div className="drawer__meta-row">
                  <span className="field__label">Kind</span>
                  <span className="drawer__meta-value">{shown.meta.kind}</span>
                </div>
                <div className="drawer__meta-row">
                  <span className="field__label">Status</span>
                  <select
                    className="control"
                    value={shown.meta.status}
                    onChange={(e) =>
                      void onUpdate(shown.meta.id, { status: e.target.value })
                    }
                  >
                    {statuses.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="drawer__meta-row">
                  <span className="field__label">Priority</span>
                  <select
                    className="control"
                    value={shown.meta.priority}
                    onChange={(e) =>
                      void onUpdate(shown.meta.id, {
                        priority: e.target.value as Priority,
                      })
                    }
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="drawer__meta-row">
                  <span className="field__label">Epic</span>
                  <span className="drawer__meta-value mono">
                    {shown.meta.parent ?? '—'}
                  </span>
                </div>
                <div className="drawer__meta-row">
                  <span className="field__label">Assignee</span>
                  <span className="drawer__meta-value">
                    {shown.meta.assignee}
                  </span>
                </div>
                <div className="drawer__meta-row">
                  <span className="field__label">Blocked by</span>
                  <span className="drawer__meta-value mono">
                    {shown.meta.blockedBy.length > 0
                      ? shown.meta.blockedBy.join(', ')
                      : '—'}
                  </span>
                </div>
                <div className="drawer__meta-row">
                  <span className="field__label">Labels</span>
                  <span className="drawer__meta-value">
                    {shown.meta.labels.length > 0
                      ? shown.meta.labels.join(', ')
                      : '—'}
                  </span>
                </div>
                <div className="drawer__meta-row">
                  <span className="field__label">Created</span>
                  <span className="drawer__meta-value">
                    {shown.meta.created}
                  </span>
                </div>
                <div className="drawer__meta-row">
                  <span className="field__label">Updated</span>
                  <span className="drawer__meta-value">
                    {shown.meta.updated}
                  </span>
                </div>
              </div>

              <div className="drawer__section">
                <div className="drawer__section-title">Description</div>
                <div className="drawer__section-body">
                  {sectionOrDash(sections, 'Description')}
                </div>
              </div>

              <div className="drawer__section">
                <div className="drawer__section-title">Acceptance Criteria</div>
                <div className="drawer__section-body">
                  {sectionOrDash(sections, 'Acceptance Criteria')}
                </div>
              </div>

              <div className="drawer__section">
                <div className="drawer__section-title">Activity</div>
                <div className="drawer__section-body">
                  {sectionOrDash(sections, 'Activity')}
                </div>
                <div className="drawer__activity-row">
                  <input
                    className="control"
                    placeholder="Add an activity note…"
                    value={activityDraft}
                    onChange={(e) => setActivityDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitActivity();
                    }}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={submitActivity}
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </aside>
    </>
  );
}
