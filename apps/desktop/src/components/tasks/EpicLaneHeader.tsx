import type { EpicProgress } from '@dispatch/client';
import type { StatusModel, TaskListItem } from '@dispatch/core/browser';
import { isCompletedStatus, isDoneStatus } from '@dispatch/core/browser';
import { Milestone, Waypoints } from 'lucide-react';
import { useState } from 'react';

import {
  clampConcurrencyInput,
  concurrencyChoices,
  concurrencyLabel,
} from '../../lib/epicConcurrency';
import type { WorkEpicOptions } from '../../lib/epicSession';
import { rollupMilestoneStatus } from '../../lib/milestoneRollup';
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

interface EpicLaneHeaderProps {
  /** The epic this lane belongs to, or `null` for the catch-all "No epic" lane — which still
   * collapses and still shows its count, it just has nothing to dispatch or graph. */
  epic: TaskListItem | null;
  /** Lane title: the epic's own, `No epic`, or a bare parent id that resolves to no known epic. */
  title: string;
  /** How many cards the lane holds, collapsed or not — the one count that never moves, so
   * folding a lane away can't look like its work disappeared. */
  total: number;
  expanded: boolean;
  onToggle: () => void;
  /** `undefined` until this epic's progress fetch resolves — the controls still render, just
   * without the `◔ n/m` glyph. */
  progress: EpicProgress | undefined;
  /** `orchestrator.epicConcurrency` from the project config, the picker's starting value. */
  concurrencyDefault: number;
  /** This epic's children — the rolled-up status. */
  childTasks: TaskListItem[];
  /** The project's statuses, which roll the children up and say the epic is landable. */
  model: StatusModel;
  /** Opens the epic itself (its id chip) in the peek/detail dialog. */
  onOpenTask: (taskId: string) => void;
  /** The direct path: starts a session at the picker's concurrency with no ceilings. */
  onWork: (epicId: string, opts: WorkEpicOptions) => Promise<void>;
  /** When given, Send agents… opens the fan-out dialog instead of dispatching straight away. */
  onRequestWork?: (epicId: string) => void;
  onPause?: (epicId: string) => Promise<void>;
  onResume?: (epicId: string) => Promise<void>;
  /** Reopens the dialog pre-filled from the paused session. */
  onRaiseCeiling?: (epicId: string) => void;
  onStop: (epicId: string) => Promise<void>;
  /** Lands the finished epic branch on the default base (one PR or one local merge, decided
   * server-side). Optional so a header rendered without land wiring stays valid; the Land
   * button only renders once every child is done/cancelled, replacing the then-useless
   * Send agents… button. */
  onLand?: (epicId: string) => Promise<void>;
  /** A `+` on the right that presets the epic in the task creator. */
  onAdd?: () => void;
}

/**
 * One epic's lane header on the board: a 36px `GroupHeader` tinted by the epic's rolled-up
 * status (the same glyph vocabulary its cards use), the title as the collapse target, the
 * card count, then `FanoutControls` — the same `◔ done/total`, phase chips, spend pill and
 * verbs the milestones page shows — with the id chip, the flight-plan button and the
 * concurrency picker slotted in.
 *
 * Epics are containers here, not objects on the board: they are never dragged and never
 * occupy a status column. Only the chevron and the title toggle the lane; the controls in
 * the actions slot never do.
 */
export function EpicLaneHeader({
  epic,
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
}: EpicLaneHeaderProps) {
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
    epic !== null &&
    !active &&
    !paused &&
    totalCount > 0 &&
    doneCount === totalCount &&
    !isCompletedStatus(epic.meta.status, model);
  const rollup =
    epic !== null ? rollupMilestoneStatus(childTasks, model) : null;

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
          epic !== null && (
            <FanoutControls
              epic={epic}
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
                        aria-label={`Epic dispatch concurrency for ${epic.meta.id}`}
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
              onSendAgents={(epicId) =>
                onRequestWork !== undefined
                  ? onRequestWork(epicId)
                  : onWork(epicId, { concurrency })
              }
              onPause={onPause}
              onResume={onResume}
              onRaiseCeiling={onRaiseCeiling}
              onStop={onStop}
              onLand={onLand}
              onOpenEpic={onOpenTask}
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
                    // The epic id as a 24px pill that opens the epic — a `Pill`'s look on a
                    // real button.
                    <PillButton
                      aria-label={`Open ${epic.meta.id}`}
                      onClick={() => onOpenTask(epic.meta.id)}
                      className="bg-surface-quaternary h-6 px-2"
                    />
                  }
                >
                  {epic.meta.id}
                </TooltipTrigger>
                <TooltipContent>Open epic</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <IconButton
                      label={`Open the flight plan for ${epic.meta.id}`}
                      onClick={() => shell.openTask(epic.meta.id, 'plan')}
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
