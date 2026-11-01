import { Button, EmptyState, Spinner } from '@dispatch/ui';
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
import { PeekSlideOver } from './PeekSlideOver';
import styles from './ThreadPeek.module.css';

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

/** One thread in the shell's slide-over; it never changes the view underneath. */
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
    <PeekSlideOver
      testId="thread-peek"
      contentKey={messageId}
      title="Thread"
      subtitle={home ?? undefined}
      onClose={onClose}
      actions={
        home !== null && (
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              onClose();
              onOpenHome(home);
            }}
          >
            Open in its home →
          </Button>
        )
      }
    >
      <div className={styles.body}>
        {!access.canMessage ? (
          <div className={styles.centred}>
            <EmptyState label="Threads are not available in this window.">
              {access.explanation}
            </EmptyState>
          </div>
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
          <div className={styles.centred}>
            <EmptyState>{open.error.message}</EmptyState>
          </div>
        ) : (
          <div className={styles.centred}>
            <Spinner size="md" label="Loading the thread" />
          </div>
        )}
      </div>
    </PeekSlideOver>
  );
}
