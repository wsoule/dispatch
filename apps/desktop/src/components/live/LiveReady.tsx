import { Waypoints, Workflow, Zap } from 'lucide-react';

import { ContainerIcon } from '../tasks/page/ContainerIcon';
import type { ReadyContainer } from './liveGraph';
import { IconButton } from '@/ui/ai/icon-button';
import { PillButton } from '@/ui/ai/pill';
import { EmptyState, ProgressGlyph } from '@/ui/chrome';

interface LiveReadyProps {
  containers: readonly ReadyContainer[];
  refFor: (id: string) => string;
  onSendAgents: (containerId: string) => void;
  onOpenPlan: (containerId: string) => void;
}

/**
 * The Live view with nothing in flight: what could be, as the milestones and parent
 * issues with the most work a fan-out would start now, each with Send agents….
 */
export function LiveReady({
  containers,
  refFor,
  onSendAgents,
  onOpenPlan,
}: LiveReadyProps) {
  return (
    <div
      data-slot="live-empty"
      className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pt-12 pb-8"
    >
      <EmptyState
        icon={Workflow}
        heading="Nothing in flight"
        description={
          containers.length === 0
            ? 'No agent is running and nothing is ready to start. Plan work, and its waves show here as agents pick it up.'
            : 'Send agents at a milestone and its waves show here, live — blocked work starts on its own as its blockers land.'
        }
        className="py-4"
      />
      {containers.length > 0 && (
        <ul
          aria-label="Ready to start"
          className="flex w-full max-w-[640px] flex-col gap-1"
        >
          {containers.map(({ container, ready, total }) => {
            const id = container.meta.id;
            return (
              <li
                key={id}
                data-slot="live-ready-row"
                data-container={id}
                className="bg-surface-quaternary rounded-card flex h-11 items-center gap-2 px-3"
              >
                <ContainerIcon
                  kind={container.meta.kind}
                  icon={container.meta.icon}
                  color={container.meta.color}
                  className="size-3.5 shrink-0"
                />
                <span className="text-foreground min-w-0 truncate text-[13px] font-medium">
                  {container.meta.title}
                </span>
                <span className="font-book shrink-0 text-[12px] tracking-(--id-tracking) text-(--text-muted)">
                  {refFor(id)}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[12px] text-(--text-secondary) tabular-nums">
                  <ProgressGlyph fraction={total === 0 ? 0 : ready / total} />
                  {ready} ready of {total}
                </span>
                <PillButton onClick={() => onSendAgents(id)}>
                  <Zap className="size-3" />
                  Send agents…
                </PillButton>
                <IconButton
                  label={`Open the Flight Plan for ${container.meta.title}`}
                  onClick={() => onOpenPlan(id)}
                >
                  <Waypoints aria-hidden />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
