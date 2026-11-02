import type { StatusModel, TaskListItem } from '@dispatch-foo/core/browser';
import { isDoneStatus } from '@dispatch-foo/core/browser';
import type { RunMeta } from '@dispatch/client';
import { Button, ListItem, PriorityGlyph, ProgressPie } from '@dispatch/ui';
import { ChevronDown, Plus } from 'lucide-react';
import { useState } from 'react';

import { toTaskPriority } from '../../../adapters/rows';
import { isTerminalRunState } from '../../../lib/runState';
import { formatShortDate } from '../../../lib/taskDates';
import { priorityLabel } from '../../../lib/taskDisplay';
import { RunStatePill } from '../../runs/RunStatePill';
import { useShellActions } from '../../shell/ShellActionsContext';
import { AssigneeAvatar } from '../AssigneeAvatar';
import { LabelChip, useLabelColors } from '../LabelChip';
import { StatusIcon } from '../StatusIcon';
import styles from './pageBlocks.module.css';

// The `▾ Sub-tasks ◔ 1/3` block under the description: a header row whose one fold button
// holds the chevron, the title, the progress pie and the count (a press anywhere on them
// folds the list), and a `+` that opens the task creator with this milestone preset; then
// one list row per child (priority, title, status and id, label chips, a live run mark,
// the assignee, the day it last moved). The header is a button, not a heading: its hosts
// already head it (the rail's "Sub-issues" section, the drawer's "Work"). Also used,
// titled `Blocks`, for a task whose completion unblocks others.
export function SubtasksBlock({
  title = 'Sub-tasks',
  parent,
  tasks,
  latestRunByTaskId,
  onOpenTask,
  createPreset,
  model,
}: {
  title?: string;
  parent: TaskListItem;
  /** The child rows, in the order to draw them. */
  tasks: readonly TaskListItem[];
  /** The project's statuses: a landed or dropped child counts toward the `◔ n/m` glyph. */
  model: StatusModel;
  latestRunByTaskId: Map<string, RunMeta>;
  onOpenTask?: (taskId: string) => void;
  /** What the `+` pre-fills; omitted hides the button (a `Blocks` list has no creator). */
  createPreset?: { milestone: string };
}) {
  const shell = useShellActions();
  const colors = useLabelColors();
  const [collapsed, setCollapsed] = useState(false);
  const done = tasks.filter((doc) =>
    isDoneStatus(doc.meta.status, model)
  ).length;
  return (
    <section data-slot="subtasks-block" className={styles.subtasks}>
      <div className={styles.subtasksHead}>
        <button
          type="button"
          className={styles.subtasksToggle}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          <ChevronDown
            className={styles.subtasksChevron}
            size={14}
            strokeWidth={1.8}
            aria-hidden
          />
          {title}
          {/* The pie says the count for assistive tech; the digits after it are visual. */}
          <ProgressPie
            done={done}
            total={tasks.length}
            size={14}
            label={`${done} of ${tasks.length} done`}
          />
          <span className={styles.subtasksCount} aria-hidden="true">
            {done}/{tasks.length}
          </span>
        </button>
        {createPreset !== undefined && (
          <Button
            variant="quiet"
            size="sm"
            className={styles.subtasksAdd}
            aria-label={`Add sub-task to ${parent.meta.title}`}
            title={`Add sub-task to ${parent.meta.title}`}
            icon={<Plus size={14} strokeWidth={1.8} aria-hidden />}
            onClick={() =>
              shell.openCreateTask({ milestone: createPreset.milestone })
            }
          />
        )}
      </div>
      {!collapsed && (
        <div className={styles.subtaskRows}>
          {tasks.map((child) => {
            const run = latestRunByTaskId.get(child.meta.id);
            const live = run !== undefined && !isTerminalRunState(run.state);
            return (
              <ListItem
                key={child.meta.id}
                data-row-id={child.meta.id}
                leading={
                  <>
                    <PriorityGlyph
                      priority={toTaskPriority(child.meta.priority)}
                    />
                    {/* The glyph is aria-hidden; the words say the priority. */}
                    <span className="srOnly">
                      {priorityLabel(child.meta.priority)}
                    </span>
                  </>
                }
                title={child.meta.title}
                crumb={
                  <span className={styles.subtaskKey}>
                    <StatusIcon status={child.meta.status} />
                    <span className="mono">{child.meta.id}</span>
                  </span>
                }
                trailing={
                  <span className={styles.subtaskTrailing}>
                    {child.meta.labels.map((label) => (
                      <LabelChip
                        key={label}
                        label={label}
                        hex={colors.hex(label)}
                      />
                    ))}
                    {live && run !== undefined && (
                      <RunStatePill meta={run} compact />
                    )}
                    <AssigneeAvatar assignee={child.meta.assignee} />
                  </span>
                }
                date={formatShortDate(child.meta.updated)}
                onClick={
                  onOpenTask !== undefined
                    ? () => onOpenTask(child.meta.id)
                    : undefined
                }
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
