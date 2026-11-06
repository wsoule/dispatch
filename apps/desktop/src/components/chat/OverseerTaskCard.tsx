import type { RunMeta } from '@dispatch/client';
import { TaskListCard, type TaskListCardItem } from '@dispatch/ui';

import { useRunStep } from '../../hooks/useRunStep';
import { deriveFeedState } from '../../lib/feedState';
import {
  taskCardHeading,
  type TaskCardModel,
  taskCardNote,
} from '../../lib/overseerTaskCard';
import {
  closedOutMark,
  isTerminalRunState,
  runStateLabel,
} from '../../lib/runState';
import { runStepFromRecord } from '../../lib/runStep';
import { StateMark } from '../status/StateMark';

/** A run's status line: the step it is on right now, else what the record last said, else its
 * state in words, so a started row never leans on its dot's colour alone. */
function RunStatusLine({ run }: { run: RunMeta }) {
  const live = useRunStep(run.id);
  const step = isTerminalRunState(run.state)
    ? null
    : (live ?? runStepFromRecord(run));
  return <>{step ?? runStateLabel(run.state)}</>;
}

/** A run's dot: the feed state's tone, the closed-out disc once a person closed it; live work pulses. */
function RunDot({ run }: { run: RunMeta }) {
  return (
    <StateMark
      variant="dot"
      state={deriveFeedState(run) ?? closedOutMark(run)}
      label={runStateLabel(run.state)}
      pulse
    />
  );
}

/**
 * The tasks an Overseer action proposes or sent out, as one card: "3 suggested tasks" with how
 * many have started, a row per task with its run's step under the title, its state dot, and a
 * chevron that opens the task once it exists.
 */
export function OverseerTaskCard({
  card,
  onOpenTask,
  className,
}: {
  card: TaskCardModel;
  /** Opens a task in the Overseer's middle; without it no row opens. */
  onOpenTask?: (taskId: string) => void;
  className?: string;
}) {
  const items: TaskListCardItem[] = card.entries.map((entry, index) => {
    const { taskId, run } = entry;
    return {
      id: taskId ?? `proposed-${index}`,
      'data-testid': 'overseer-task-row',
      'data-task-id': taskId,
      'data-run-state': run?.state,
      title: entry.title,
      live: run !== undefined,
      ...(run === undefined
        ? {}
        : { status: <RunStatusLine run={run} />, mark: <RunDot run={run} /> }),
      ...(taskId === undefined || onOpenTask === undefined
        ? {}
        : { onOpen: () => onOpenTask(taskId) }),
    };
  });
  return (
    <TaskListCard
      data-testid="overseer-task-card"
      className={className}
      heading={taskCardHeading(card.proposed)}
      note={taskCardNote(card.started)}
      items={items}
    />
  );
}
