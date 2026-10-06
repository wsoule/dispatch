import type { ReactNode } from 'react';

import { OverseerChat } from '../components/chat/OverseerChat';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { OverseerSession } from '../hooks/useOverseerSession';
import type { OverseerDoor } from '../lib/overseerThread';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';

export interface TwoViewOverseerProps {
  data: DispatchProjectData;
  overseer: OverseerSession;
  /** Asks waiting on you; the stream shows a door to them, never a copy. */
  asks: number;
  revoked: boolean;
  onShowAsks: () => void;
  onOpenConnectedAgents: () => void;
  /** "For you" posts, between the conversation and its composer. */
  posts?: ReactNode;
  /** Opens one of the agent's "Show in tasks" doors. */
  onOpenDoor: (door: OverseerDoor) => void;
}

/** Overseer in Two views: one conversation with your agent, a door to the asks. */
export function TwoViewOverseer({
  data,
  overseer,
  asks,
  revoked,
  onShowAsks,
  onOpenConnectedAgents,
  posts,
  onOpenDoor,
}: TwoViewOverseerProps) {
  const daemonDown = data.portLoading || data.portError || data.client === null;

  if (daemonDown) {
    return (
      <div className="px-6 py-4">
        <DaemonUnavailable
          starting={data.portLoading}
          errorDetail={data.portErrorDetail}
          onRetry={data.retryEnsureDispatchd}
        />
      </div>
    );
  }

  const door =
    revoked || asks === 0 ? null : (
      <button
        type="button"
        onClick={onShowAsks}
        data-testid="overseer-asks-door"
        className="rounded-pill self-center bg-(--state-waiting-surface) px-3.5 py-1 text-[12px] text-(--state-waiting-fg) hover:underline"
      >
        ● {asks} {asks === 1 ? 'ask waits' : 'asks wait'} on you · Show in tasks
        →
      </button>
    );

  return (
    <div
      data-testid="overseer-view"
      className="flex h-full min-h-0 flex-col px-6 pt-3 pb-4"
    >
      {/* Before the first message the composer sits at the bottom, as it will after. */}
      <div
        className={cn(
          'mx-auto flex h-full min-h-0 w-full max-w-[760px] flex-col gap-3',
          overseer.conversationId === null && 'justify-end'
        )}
      >
        {revoked && (
          <div
            role="alert"
            data-testid="overseer-off"
            className="rounded-card border-border text-muted-foreground flex items-center gap-3 border-[0.5px] border-dashed px-3 py-2 text-[13px]"
          >
            <span className="flex-1">The agent is off.</span>
            <Button size="sm" variant="outline" onClick={onOpenConnectedAgents}>
              Approve it again in Settings › Connected agents
            </Button>
          </div>
        )}
        <OverseerChat
          overseer={overseer}
          placeholder="say something"
          aboveComposer={
            <>
              {posts}
              {door}
            </>
          }
          disabled={revoked}
          durable
          onOpenDoor={onOpenDoor}
        />
      </div>
    </div>
  );
}
