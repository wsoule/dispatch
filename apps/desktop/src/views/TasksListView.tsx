import type { TaskDoc } from '@dispatch/core';
import { useEffect, useMemo, useRef, useState } from 'react';

import { RunStatePill } from '../components/runs/RunStatePill';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { Button } from '../components/ui/Button';
import { Pill } from '../components/ui/Pill';
import { TextInput } from '../components/ui/TextInput';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { resolveListKeyCommand } from '../lib/keyboard';
import { priorityTone, statusTone } from '../lib/taskDisplay';
import './TasksListView.css';

interface TasksListViewProps {
  data: DispatchProjectData;
  onSelectTask: (taskId: string) => void;
  onNewTask: () => void;
}

/** Case-insensitive substring match against a task's id and title — the list view's filter
 * is a plain narrowing search, not the palette's fuzzy ranking (a dense flat list benefits
 * more from a predictable "contains" filter than from fuzzy re-ordering). */
function matchesFilter(doc: TaskDoc, filter: string): boolean {
  if (filter.trim() === '') return true;
  const needle = filter.toLowerCase();
  return (
    doc.meta.id.toLowerCase().includes(needle) ||
    doc.meta.title.toLowerCase().includes(needle)
  );
}

/**
 * Flat, filterable list of every task in the active project — the "Tasks" primary nav item,
 * complementing the Board's column view when you want to scan or search rather than group by
 * status. Supports the redesign brief's j/k + Enter list navigation directly on the row
 * list (only while the filter input itself isn't focused, so "j"/"k" keep working as
 * ordinary filter-text characters while typing). The list container auto-focuses itself on
 * mount (view enter) so j/k work immediately without first requiring a click or Tab.
 */
export function TasksListView({
  data,
  onSelectTask,
  onNewTask,
}: TasksListViewProps) {
  const [filter, setFilter] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () => data.tasks.filter((doc) => matchesFilter(doc, filter)),
    [data.tasks, filter]
  );

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  // Keeps the highlighted row visible as j/k moves it — `listRef`'s direct children are the
  // row buttons in list order, so the highlighted index doubles as a DOM child index.
  useEffect(() => {
    const row = listRef.current?.children[highlighted];
    row?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  function handleListKeyDown(e: React.KeyboardEvent) {
    const command = resolveListKeyCommand(
      { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey },
      { isTyping: false }
    );
    if (command === 'list-down') {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
    } else if (command === 'list-up') {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (command === 'list-confirm') {
      e.preventDefault();
      const doc = filtered[highlighted];
      if (doc !== undefined) onSelectTask(doc.meta.id);
    }
  }

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  if (data.tasksLoading || data.config === null) {
    return <p className="tasks-list-view-status">Loading tasks…</p>;
  }

  return (
    <div className="tasks-list-view">
      <div className="tasks-list-view-toolbar">
        <h1 className="view-topbar-title">Tasks</h1>
        <Button onClick={onNewTask}>+ New Task</Button>
      </div>

      <TextInput
        className="tasks-list-view-filter"
        placeholder="Filter by id or title…"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          setHighlighted(0);
        }}
      />

      {filtered.length === 0 ? (
        <p className="tasks-list-view-status">
          {data.tasks.length === 0
            ? 'No tasks yet — create the first one from the Board.'
            : 'No tasks match this filter.'}
        </p>
      ) : (
        <div
          className="tasks-list-view-list"
          ref={listRef}
          tabIndex={0}
          onKeyDown={handleListKeyDown}
        >
          {filtered.map((doc, i) => {
            const tone = priorityTone(doc.meta.priority);
            const liveState = data.liveRunStateByTaskId.get(doc.meta.id);
            return (
              <button
                key={doc.meta.id}
                type="button"
                className={`tasks-list-view-row${
                  i === highlighted ? ' active' : ''
                }`}
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => onSelectTask(doc.meta.id)}
              >
                <span className="tasks-list-view-row-id">{doc.meta.id}</span>
                <span className="tasks-list-view-row-title">
                  {doc.meta.title}
                </span>
                <span className="tasks-list-view-row-badges">
                  {data.blockedIds.has(doc.meta.id) && (
                    <Pill variant="tag" tone="red">
                      blocked
                    </Pill>
                  )}
                  {tone !== null && (
                    <Pill variant="tag" tone={tone}>
                      {doc.meta.priority}
                    </Pill>
                  )}
                  {liveState !== undefined && (
                    <RunStatePill state={liveState} />
                  )}
                  <Pill variant="status" tone={statusTone(doc.meta.status)}>
                    {doc.meta.status}
                  </Pill>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
