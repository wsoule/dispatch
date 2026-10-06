import { X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import type { OverseerSession } from '../../hooks/useOverseerSession';
import { useThreadPaneProps } from '../../hooks/useThreadPaneProps';
import {
  useOpenGates,
  useThread,
  useThreadActions,
} from '../../hooks/useThreads';
import { overseerTurnLive } from '../../lib/agentPresence';
import type { RefAction } from '../../lib/threadSources';
import { replyRoute } from '../../lib/threadSources';
import { ThreadPane } from '../threads/ThreadPane';
import { IconButton } from '@/ui/ai/icon-button';
import { EmptyState } from '@/ui/chrome';
import { Spinner } from '@/ui/spinner';

export interface ThreadPeekProps {
  data: DispatchProjectData;
  overseer: OverseerSession;
  messageId: string;
  onOpenRef: (action: RefAction) => void;
  onShowOverseer: () => void;
  onClose: () => void;
}

/** One thread in a drawer above the composer; it never changes the view underneath. */
export function ThreadPeek({
  data,
  overseer,
  messageId,
  onOpenRef,
  onShowOverseer,
  onClose,
}: ThreadPeekProps) {
  const { client, port, me, messageAccess: access } = data;
  const open = useThread(client, port, messageId, access);
  const gates = useOpenGates(client, port, access);
  const pane = useThreadPaneProps(data, onOpenRef);
  const actions = useThreadActions(client, port, me, access, data);
  const openIds = useMemo(
    () => new Set((gates.data?.items ?? []).map((m) => m.id)),
    [gates.data]
  );
  const { markRead } = actions;
  useEffect(() => {
    markRead(open.deliveries);
  }, [markRead, open.deliveries]);

  // Focus moves into the drawer and back to whatever opened it.
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeRef.current?.focus();
    return () => opener?.focus();
  }, []);

  const ready = open.thread !== null && open.messages.length > 0 && me !== null;
  return (
    <aside
      role="dialog"
      aria-label="Thread"
      data-testid="thread-peek"
      className="bg-background border-border-strong rounded-popover shadow-raised absolute top-3 right-3 bottom-[96px] z-20 flex w-[420px] max-w-[calc(100%-24px)] flex-col overflow-hidden border-[0.5px]"
    >
      <div className="border-border flex items-center gap-2 border-b-[0.5px] px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
          Thread
        </span>
        <IconButton ref={closeRef} label="Close" onClick={onClose}>
          <X aria-hidden />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1">
        {!access.canMessage ? (
          <EmptyState
            className="h-full"
            heading="Threads are not available in this window."
            description={access.explanation}
          />
        ) : ready && me !== null ? (
          <ThreadPane
            key={open.thread}
            messages={open.messages}
            focus={messageId}
            deliveries={open.deliveries}
            remote={open.remote}
            settlements={open.settlements}
            observer={open.observer}
            me={me}
            openIds={openIds}
            access={access}
            lookups={pane.lookups}
            availability={pane.availability}
            onRestartDaemon={pane.onRestartDaemon}
            onAnswer={actions.answer}
            onOpen={pane.onOpen}
            loadApprovalInput={pane.loadApprovalInput}
            client={client}
            port={port}
            route={replyRoute(
              open.messages,
              open.thread,
              overseer.record?.thread ?? null,
              pane.lookups
            )}
            onReply={actions.reply}
            onOverseerReply={overseer.reply}
            overseerBusy={overseer.sending || overseerTurnLive(overseer)}
            onOpenOverseer={onShowOverseer}
          />
        ) : open.error !== null ? (
          <EmptyState className="h-full" heading={open.error.message} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Spinner className="text-muted-foreground size-4" />
          </div>
        )}
      </div>
    </aside>
  );
}
