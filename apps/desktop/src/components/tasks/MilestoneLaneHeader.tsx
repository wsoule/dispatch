import type { StatusModel, TaskListItem } from '@dispatch-foo/core/browser';
import { isCompletedStatus, isDoneStatus } from '@dispatch-foo/core/browser';
import type { MilestoneProgress } from '@dispatch/client';
import { Milestone, Waypoints } from 'lucide-react';
import { useState } from 'react';

import {
  clampConcurrencyInput,
  concurrencyChoices,
  concurrencyLabel,
} from '../../lib/milestoneConcurrency';
import { rollupMilestoneStatus } from '../../lib/milestoneRollup';
import type { WorkMilestoneOptions } from '../../lib/milestoneSession';
import { FanoutControls, sessionIdle } from '../milestones/FanoutControls';
import { useShellActions } from '../shell/ShellActionsContext';
import { statusColor, StatusIcon } from './StatusIcon';
import { GroupHeader } from '@/ui/ai/group-header';
import { IconButton } from '@/ui/ai/icon-button';
import { LabelPill, PillButton, SelectPill } from '@/ui/ai/pill';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

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
   * server-side). Optional so a header rendered without land wiring stays valid; the Land
   * button only renders once every child is done/cancelled, replacing the then-useless
   * Send agents… button. */
  onLand?: (milestoneId: string) => Promise<void>;
  /** A `+` on the right that presets the milestone in the task creator. */
  onAdd?: () => void;
}

/**
 * One milestone's lane header on the board: a 36px `GroupHeader` tinted by the milestone's rolled-up
 * status (the same glyph vocabulary its cards use), the title as the collapse target, the
 * card count, then `FanoutControls` — the same `◔ done/total`, phase chips, spend pill and
 * verbs the milestones page shows — with the id chip, the flight-plan button and the
 * concurrency picker slotted in.
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
  const active = progress?.active ?? false;
  const paused = session?.state === 'paused';

  const doneCount =
    progress?.children.filter((c) => isDoneStatus(c.status, model)).length ?? 0;
  const totalCount = progress?.children.length ?? 0;
  const liveCount = progress?.liveRuns.length ?? 0;
  // Same "finished" rule the server's land validation applies (every child done or
  // cancelled) — the button still only *requests*; the server is the authority and 409s
  // with its reason into the error pill.
  const landable =
    onLand !== undefined &&
    milestone !== null &&
    !active &&
    !paused &&
    totalCount > 0 &&
    doneCount === totalCount &&
    !isCompletedStatus(milestone.meta.status, model);
  const rollup =
    milestone !== null ? rollupMilestoneStatus(childTasks, model) : null;

  return (
    <>
      <GroupHeader
        tint={rollup !== null ? statusColor(rollup, model) : undefined}
        icon={
          rollup !== null ? (
            <StatusIcon status={rollup} />
          ) : (
            <Milestone className="text-muted-foreground" />
          )
        }
        name={
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="focus-visible:ring-ring inline-flex max-w-full cursor-pointer items-center rounded-[4px] text-left outline-none focus-visible:ring-2"
          >
            <span className="truncate">{title}</span>
          </button>
        }
        count={total}
        collapsed={!expanded}
        onToggle={onToggle}
        onAdd={onAdd}
        addLabel={`New task in ${title}`}
        className="mb-2"
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
              landable={landable}
              concurrencyPicker={
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <SelectPill
                        aria-label={`Milestone dispatch concurrency for ${milestone.meta.id}`}
                      />
                    }
                  >
                    {concurrencyLabel(concurrency)}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[96px]">
                    <DropdownMenuRadioGroup
                      value={String(concurrency)}
                      onValueChange={(value) =>
                        setConcurrency(clampConcurrencyInput(String(value)))
                      }
                    >
                      {concurrencyChoices(concurrencyDefault).map((choice) => (
                        <DropdownMenuRadioItem
                          key={choice}
                          value={String(choice)}
                        >
                          {concurrencyLabel(choice)}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
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
                <LabelPill color="var(--state-working-fg)">
                  {liveCount} running
                </LabelPill>
              )}
              <Tooltip>
                <TooltipTrigger
                  render={
                    // The milestone id as a 24px pill that opens the milestone — a `Pill`'s look on a
                    // real button.
                    <PillButton
                      aria-label={`Open ${milestone.meta.id}`}
                      onClick={() => onOpenTask(milestone.meta.id)}
                      className="bg-surface-quaternary h-6 px-2"
                    />
                  }
                >
                  {milestone.meta.id}
                </TooltipTrigger>
                <TooltipContent>Open milestone</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <IconButton
                      label={`Open the flight plan for ${milestone.meta.id}`}
                      onClick={() => shell.openTask(milestone.meta.id, 'plan')}
                    />
                  }
                >
                  <Waypoints aria-hidden />
                </TooltipTrigger>
                <TooltipContent>Open flight plan</TooltipContent>
              </Tooltip>
            </FanoutControls>
          )
        }
      />
    </>
  );
}
