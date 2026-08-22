import { Plus } from 'lucide-react';

import { WardenChat } from '../components/chat/WardenChat';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { WardenSession } from '../hooks/useWardenSession';
import { Button } from '@/ui/button';

interface WardenViewProps {
  data: DispatchProjectData;
  warden: WardenSession;
  projectName: string | null;
}

/**
 * The Warden tab — a chat with the project assistant. The conversation itself
 * (transcript, composer, confirm cards) is WardenChat, shared with the
 * LiveRail's Warden tab; this page adds the header chrome and the daemon
 * gate. The session lives in `useWardenSession` (mounted by App), so
 * switching tabs and coming back lands on the same transcript.
 */
export function WardenView({ data, warden, projectName }: WardenViewProps) {
  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[60rem] flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h1 className="view-topbar-title">Warden</h1>
          {projectName !== null && (
            <span className="text-muted-foreground text-[13px]">
              {projectName}
            </span>
          )}
        </div>
        {warden.conversationId !== null && (
          // Same gate as WardenChat's compact reset: reset() drops the only UI
          // handle on the conversation, so a queued mutation must be decided
          // before this can discard the confirm card that decides it.
          <Button
            variant="outline"
            size="sm"
            disabled={(warden.record?.pendingActions.length ?? 0) > 0}
            title={
              (warden.record?.pendingActions.length ?? 0) > 0
                ? 'Decide the pending action first'
                : undefined
            }
            onClick={() => warden.reset()}
          >
            <Plus className="size-3.5" /> New conversation
          </Button>
        )}
      </div>

      <WardenChat warden={warden} />
    </div>
  );
}
