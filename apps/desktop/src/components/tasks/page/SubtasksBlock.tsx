import type { StatusModel, TaskListItem } from '@dispatch-foo/core/browser';
import { isDoneStatus } from '@dispatch-foo/core/browser';
import type { RunMeta } from '@dispatch/client';
import {
  Button,
  cx,
  ListItem,
  PriorityGlyph,
  ProgressPie,
  TaskDetailSection,
} from '@dispatch/ui';
import { ChevronDown, Plus, Tag } from 'lucide-react';
import { type ReactNode, useState } from 'react';

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
// the assignee, the day it last moved). Inside a host that already heads it (the drawer's
// "Work") the header is a plain button row. Given `section`, the block is a section of
// its own (the task page rail's "Sub-issues"): the fold button sits inside the section's
// one heading, so the title and its count/progress are said once, and `lead` (the rail's
// mini Flight Plan) folds away with the rows. Also used, titled `Blocks`, for a task
// whose completion unblocks others.
export function SubtasksBlock({
  title = 'Sub-tasks',
  parent,
  tasks,
  latestRunByTaskId,
  onOpenTask,
  createPreset,
  model,
  section = false,
  lead,
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
  /** Render as a TaskDetailSection whose heading holds the fold button. */
  section?: boolean;
  /** Shown above the rows (and folded with them), in `section` mode. */
  lead?: ReactNode;
}) {
  const shell = useShellActions();
  const colors = useLabelColors();
  const [collapsed, setCollapsed] = useState(false);
  const done = tasks.filter((doc) =>
    isDoneStatus(doc.meta.status, model)
  ).length;
  const fold = (
    <button
      type="button"
      className={cx(
        styles.subtasksToggle,
        section ? styles.subtasksToggleHeading : undefined
      )}
      aria-expanded={!collapsed}
      onClick={() => setCollapsed((c) => !c)}
    >
      <ChevronDown
        className={styles.subtasksChevron}
        size={14}
        strokeWidth={1.8}
        aria-hidden
      />
      <span>{title}</span>
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
  );
  const add =
    createPreset === undefined ? null : (
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
    );
  const rows = (
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
                <PriorityGlyph priority={toTaskPriority(child.meta.priority)} />
                {/* The glyph is aria-hidden; the words say the priority. */}
                <span className="srOnly">
                  {priorityLabel(child.meta.priority)}
                </span>
              </>
            }
            // The title and its crumb (status glyph and id) on one line: the title
            // gives way and ends in an ellipsis (its whole text in its tooltip), the
            // crumb never does, so in the narrow rail a long title cannot push the id
            // out of sight. (ListItem's own crumb truncates with the title, so it is
            // not used here.)
            title={
              <span className={styles.subtaskLine}>
                <span className={styles.subtaskTitle} title={child.meta.title}>
                  {child.meta.title}
                </span>
                <span className={styles.subtaskKey} data-slot="subtask-key">
                  <span aria-hidden="true">›</span>
                  <StatusIcon status={child.meta.status} />
                  <span className="mono">{child.meta.id}</span>
                </span>
              </span>
            }
            trailing={
              <span className={styles.subtaskTrailing}>
                {child.meta.labels.length > 0 && (
                  <>
                    <span className={styles.subtaskLabels}>
                      {child.meta.labels.map((label) => (
                        <LabelChip
                          key={label}
                          label={label}
                          hex={colors.hex(label)}
                        />
                      ))}
                    </span>
                    {/* Where a narrow host drops the chips: a tag and their count, every
                        name in its hover title and in words for assistive tech. */}
                    <span
                      className={styles.subtaskLabelCount}
                      data-slot="subtask-label-count"
                      title={child.meta.labels.join(', ')}
                    >
                      <Tag size={14} strokeWidth={1.8} aria-hidden />
                      <span aria-hidden="true">{child.meta.labels.length}</span>
                      <span className="srOnly">
                        {`Labels: ${child.meta.labels.join(', ')}`}
                      </span>
                    </span>
                  </>
                )}
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
  );

  // `subtasks-block` names the whole block in both modes, header included and folded or
  // not, so a hook on it reads the count either way; `subtasks-rows` is the body alone.
  if (section) {
    return (
      <div data-slot="subtasks-block" className={styles.subtasksFrame}>
        <TaskDetailSection title={fold} meta={add}>
          {!collapsed && (
            <div data-slot="subtasks-rows" className={styles.subtasksSection}>
              {lead}
              {rows}
            </div>
          )}
        </TaskDetailSection>
      </div>
    );
  }
  return (
    <section data-slot="subtasks-block" className={styles.subtasks}>
      <div className={styles.subtasksHead}>
        {fold}
        {add}
      </div>
      {!collapsed && rows}
    </section>
  );
}
