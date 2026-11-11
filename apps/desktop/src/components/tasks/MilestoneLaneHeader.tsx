import type { StatusModel, TaskListItem } from '@dispatch-foo/core/browser';
import { isDoneStatus } from '@dispatch-foo/core/browser';
import type { MilestoneProgress } from '@dispatch/client';
import {
  Button,
  Chip,
  Menu,
  type MenuEntry,
  SectionHeader,
  Tooltip,
} from '@dispatch/ui';
import { ChevronDown, Milestone, Waypoints } from 'lucide-react';
import { useState } from 'react';

import {
  concurrencyChoices,
  concurrencyLabel,
} from '../../lib/milestoneConcurrency';
import { rollupMilestoneStatus } from '../../lib/milestoneRollup';
import type { WorkMilestoneOptions } from '../../lib/milestoneSession';
import { FanoutControls, sessionIdle } from '../milestones/FanoutControls';
import { useShellActions } from '../shell/ShellActionsContext';
import { LaneTitleButton } from './LaneHeader';
import laneStyles from './LaneHeader.module.css';
import styles from './MilestoneLaneHeader.module.css';
import { StatusIcon } from './StatusIcon';

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

interface MilestoneLaneHeaderProps {
  /** The milestone this lane belongs to, or `null` for the catch-all "No milestone" lane — which still
   * collapses and still shows its count, it just has nothing to dispatch or graph. */
  milestone: TaskListItem | null;
  /** Lane title: the milestone's own, `No milestone`, or a bare parent id that resolves to no known milestone. */
  title: string;
  /** How many cards the lane holds, collapsed or not — the one count that never moves, so
   * folding a lane away can't look like its work disappeared. */
  total: number;
  expanded: boolean;
  onToggle: () => void;
  /** `undefined` until this milestone's progress fetch resolves — the controls still render, just
   * without the `◔ n/m` glyph. */
  progress: MilestoneProgress | undefined;
  /** `orchestrator.milestoneConcurrency` from the project config, the picker's starting value. */
  concurrencyDefault: number;
  /** This milestone's children — the rolled-up status. */
  childTasks: TaskListItem[];
  /** The project's statuses, which roll the children up and say the milestone is landable. */
  model: StatusModel;
  /** Opens the milestone itself (its id chip) in the peek/detail dialog. */
  onOpenTask: (taskId: string) => void;
  /** The direct path: starts a session at the picker's concurrency with no ceilings. */
  onWork: (milestoneId: string, opts: WorkMilestoneOptions) => Promise<void>;
  /** When given, Send agents… opens the fan-out dialog instead of dispatching straight away. */
  onRequestWork?: (milestoneId: string) => void;
  onPause?: (milestoneId: string) => Promise<void>;
  onResume?: (milestoneId: string) => Promise<void>;
  /** Reopens the dialog pre-filled from the paused session. */
  onRaiseCeiling?: (milestoneId: string) => void;
  onStop: (milestoneId: string) => Promise<void>;
  /** Lands the finished milestone branch on the default base (one PR or one local merge, decided
   * server-side). Optional so a header rendered without land wiring stays valid; when Land
   * is offered (`fanoutVerbs`: every child done or cancelled, the milestone not landed, no
   * session running) it replaces the then-useless Send agents… button. The server stays
   * the authority and answers a stale offer with its reason in the error pill. */
  onLand?: (milestoneId: string) => Promise<void>;
  /** A `+` on the right that presets the milestone in the task creator. */
  onAdd?: () => void;
}

/**
 * One milestone's lane header on the board: a `SectionHeader` whose icon is the milestone's
 * rolled-up status glyph (the same vocabulary its cards use; no SectionHeader `tone`, which
 * would draw a second status mark), the title as the collapse target, the card count, then
 * `FanoutControls` (the same progress pie, phase chips, spend pill and verbs the milestones
 * page shows) with the id button, the flight-plan button and the concurrency menu slotted
 * in.
 *
 * Milestones are containers here, not objects on the board: they are never dragged and never
 * occupy a status column. Only the chevron and the title toggle the lane; the controls in
 * the actions slot never do.
 */
export function MilestoneLaneHeader({
  milestone,
  title,
  total,
  expanded,
  onToggle,
  progress,
  concurrencyDefault,
  childTasks,
  model,
  onOpenTask,
  onWork,
  onRequestWork,
  onPause,
  onResume,
  onRaiseCeiling,
  onStop,
  onLand,
  onAdd,
}: MilestoneLaneHeaderProps) {
  const shell = useShellActions();
  const [concurrency, setConcurrency] = useState(concurrencyDefault);
  const session = progress?.session ?? null;

  const doneCount =
    progress?.children.filter((c) => isDoneStatus(c.status, model)).length ?? 0;
  const totalCount = progress?.children.length ?? 0;
  const liveCount = progress?.liveRuns.length ?? 0;
  const rollup =
    milestone !== null ? rollupMilestoneStatus(childTasks, model) : null;

  const concurrencyItems: MenuEntry[] = concurrencyChoices(
    concurrencyDefault
  ).map((choice) => ({
    kind: 'radio',
    id: String(choice),
    label: concurrencyLabel(choice),
    checked: choice === concurrency,
    onSelect: () => setConcurrency(choice),
  }));

  return (
    <SectionHeader
      data-slot="group-header"
      className={laneStyles.header}
      icon={
        <span data-slot="group-header-icon" className={laneStyles.icon}>
          {rollup !== null ? (
            <StatusIcon status={rollup} />
          ) : (
            <Milestone {...ICON} className={styles.noRollup} />
          )}
        </span>
      }
      name={
        <LaneTitleButton
          title={title}
          expanded={expanded}
          onToggle={onToggle}
        />
      }
      count={total}
      collapsed={!expanded}
      onToggle={onToggle}
      onAdd={onAdd}
      addLabel={`New issue in ${title}`}
      actions={
        milestone !== null && (
          <FanoutControls
            milestone={milestone}
            model={model}
            progress={progress}
            count={
              progress === undefined
                ? undefined
                : { done: doneCount, total: totalCount }
            }
            concurrencyPicker={
              <Menu
                label={`Concurrency for ${milestone.meta.id}`}
                items={concurrencyItems}
                align="end"
                trigger={(props) => (
                  <Button
                    {...props}
                    variant="secondary"
                    size="sm"
                    aria-label={`Milestone dispatch concurrency for ${milestone.meta.id}`}
                    iconAfter={<ChevronDown {...ICON} size={12} />}
                  >
                    {concurrencyLabel(concurrency)}
                  </Button>
                )}
              />
            }
            onSendAgents={(milestoneId) =>
              onRequestWork !== undefined
                ? onRequestWork(milestoneId)
                : onWork(milestoneId, { concurrency })
            }
            onPause={onPause}
            onResume={onResume}
            onRaiseCeiling={onRaiseCeiling}
            onStop={onStop}
            onLand={onLand}
            onOpenMilestone={onOpenTask}
            showOpen={false}
          >
            {/* Outside a session the live count is the only thing to say; inside one the
                phase chips carry it. */}
            {sessionIdle(session) && liveCount > 0 && (
              <Chip tone="info">{liveCount} running</Chip>
            )}
            <Tooltip content="Open milestone">
              {/* The milestone id, in mono (a machine-read string), as a quiet button that
                  opens the milestone. */}
              <Button
                variant="quiet"
                size="sm"
                className={styles.idButton}
                aria-label={`Open ${milestone.meta.id}`}
                onClick={() => onOpenTask(milestone.meta.id)}
              >
                {milestone.meta.id}
              </Button>
            </Tooltip>
            <Tooltip content="Open flight plan">
              <Button
                variant="quiet"
                size="sm"
                aria-label={`Open the flight plan for ${milestone.meta.id}`}
                onClick={() => shell.openTask(milestone.meta.id, 'plan')}
                icon={<Waypoints {...ICON} />}
              />
            </Tooltip>
          </FanoutControls>
        )
      }
    />
  );
}
