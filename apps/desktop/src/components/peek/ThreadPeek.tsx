import { useEffect, useMemo } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import type { OverseerSession } from '../../hooks/useOverseerSession';
import { useThreadPaneProps } from '../../hooks/useThreadPaneProps';
import {
  useOpenGates,
  useThread,
  useThreadActions,
} from '../../hooks/useThreads';
import { overseerTurnLive } from '../../lib/agentPresence';
import { subjectOf } from '../../lib/conversationScope';
import type { RefAction } from '../../lib/threadSources';
import { replyRoute } from '../../lib/threadSources';
import { ThreadPane } from '../threads/ThreadPane';
import { PeekDrawer } from './PeekDrawer';
import { EmptyState } from '@/ui/chrome';
import { Spinner } from '@/ui/spinner';

export interface ThreadPeekProps {
  data: DispatchProjectData;
  overseer: OverseerSession;
  messageId: string;
  onOpenRef: (action: RefAction) => void;
  onShowOverseer: () => void;
  /** Opens the thread's home: its task, its room or the other person. */
  onOpenHome: (address: string) => void;
  onClose: () => void;
}

/** One thread in a drawer above the composer; it never changes the view underneath. */
export function ThreadPeek({
  data,
  overseer,
  messageId,
  onOpenRef,
  onShowOverseer,
  onOpenHome,
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

  const ready = open.thread !== null && open.messages.length > 0 && me !== null;
  const root = open.messages[0];
  const home = root === undefined || me === null ? null : subjectOf(root, me);
  return (
    <PeekDrawer
      label="Thread"
      testId="thread-peek"
      title="Thread"
      subtitle={home ?? undefined}
      onClose={onClose}
      actions={
        home !== null && (
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenHome(home);
            }}
            className="text-[12px] text-(--accent) hover:underline"
          >
            Open in its home →
          </button>
        )
      }
    >
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
            overseerVoice="agent"
          />
        ) : open.error !== null ? (
          <EmptyState className="h-full" heading={open.error.message} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Spinner className="text-muted-foreground size-4" />
          </div>
        )}
      </div>
    </PeekDrawer>
  );
}
