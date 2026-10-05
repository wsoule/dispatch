import { useEffect, useRef, useState } from 'react';

import { Composer } from '../components/threads/Composer';
import { ThreadPane } from '../components/threads/ThreadPane';
import { ThreadRail } from '../components/threads/ThreadRail';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { useThreadPaneProps } from '../hooks/useThreadPaneProps';
import type { OpenThread } from '../hooks/useThreads';
import {
  useThread,
  useThreadActions,
  useThreadRail,
} from '../hooks/useThreads';
import type { RefAction } from '../lib/threadSources';
import { participantLabel, replyRoute } from '../lib/threadSources';
import { PageHeader } from '@/ui/ai/page-header';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';

export interface ThreadsViewProps {
  data: DispatchProjectData;
  projectName: string | null;
  /** A message id whose thread is open, from navigation; null for none. */
  focus: string | null;
  onFocus: (messageId: string | null) => void;
  onOpenRef: (action: RefAction) => void;
  /** The live Assistant conversation, which takes replies through its own route. */
  overseer: {
    thread: string | null;
    /** Mid-turn or sending: the daemon would refuse another message. */
    busy: boolean;
    /** Rejects on failure, so the reply box keeps its draft and says why. */
    submit: (text: string) => Promise<void>;
    open: () => void;
  };
}

/** Every conversation I am part of: Needs you, Channels and Direct, one open at a time. */
export function ThreadsView({
  data,
  projectName,
  focus,
  onFocus,
  onOpenRef,
  overseer,
}: ThreadsViewProps) {
  const { client, port, me, messageAccess: access } = data;
  const rail = useThreadRail(client, port, me, access);
  const open = useThread(client, port, focus, access);
  const actions = useThreadActions(client, port, me, access, data);
  const {
    lookups,
    availability,
    known,
    onRestartDaemon,
    onOpen,
    loadApprovalInput,
  } = useThreadPaneProps(data, onOpenRef);
  const [composing, setComposing] = useState(false);
  const newThreadRef = useRef<HTMLButtonElement>(null);
  const { markRead } = actions;
  useEffect(() => {
    markRead(open.deliveries);
  }, [markRead, open.deliveries]);
  const startComposing = () => {
    setComposing(true);
    onFocus(null);
  };
  // Nothing to list once the rail has loaded without error.
  const railEmpty =
    !rail.loading && rail.error === null && rail.summaries.length === 0;

  const header = (
    <PageHeader
      crumb={[projectName ?? 'Project', 'Threads']}
      actions={
        <Button
          ref={newThreadRef}
          size="sm"
          variant="ghost"
          disabled={!access.canMessage || me === null}
          onClick={startComposing}
        >
          New thread
        </Button>
      }
    />
  );
  if (!access.canMessage) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <EmptyState
          className="flex-1"
          heading="Threads are not available in this window."
          description={access.explanation}
        />
      </div>
    );
  }
  if (me === null && data.whoamiError !== null) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <EmptyState
          className="flex-1"
          heading="The daemon did not say who you are"
          description={data.whoamiError.message}
          secondary={{ label: 'Retry', onClick: data.retryWhoami }}
        />
      </div>
    );
  }
  if (me === null) {
    return (
      <div aria-busy="true" className="flex h-full flex-col">
        {header}
        <EmptyState
          className="flex-1"
          heading="Loading threads"
          description="Waiting for the daemon to say who you are."
        />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Thread list"
          aria-busy={rail.loading || undefined}
          className="border-border w-80 shrink-0 overflow-y-auto border-r-[0.5px] p-2"
        >
          {rail.loading ? (
            <p className="text-muted-foreground p-2 text-[12px]">
              Loading threads…
            </p>
          ) : railEmpty ? (
            <EmptyState
              heading="No threads yet"
              description="Questions, handoffs and messages to or from you land here."
              primary={{ label: 'New thread', onClick: startComposing }}
            />
          ) : (
            <ThreadRail
              groups={rail.groups}
              selected={open.thread}
              onSelect={(thread) => {
                setComposing(false);
                onFocus(thread);
              }}
              lookups={lookups}
            />
          )}
          {rail.error !== null && (
            <p role="alert" className="text-destructive p-2 text-[12px]">
              {rail.error.message}
            </p>
          )}
        </aside>
        <section aria-label="Thread" className="flex min-w-0 flex-1 flex-col">
          {composing ? (
            <div className="p-3">
              <Composer
                known={known}
                label={(address) => participantLabel(address, lookups)}
                onSend={actions.send}
                onSent={(result) => {
                  setComposing(false);
                  onFocus(result.message.thread);
                }}
                onCancel={() => {
                  setComposing(false);
                  newThreadRef.current?.focus();
                }}
                focusOnMount
              />
            </div>
          ) : open.thread !== null && open.messages.length > 0 ? (
            <ThreadPane
              // A fresh reply draft per thread.
              key={open.thread}
              messages={open.messages}
              focus={focus}
              deliveries={open.deliveries}
              remote={open.remote}
              settlements={open.settlements}
              observer={open.observer}
              me={me}
              openIds={rail.openIds}
              access={access}
              lookups={lookups}
              availability={availability}
              onRestartDaemon={onRestartDaemon}
              onAnswer={actions.answer}
              onOpen={onOpen}
              loadApprovalInput={loadApprovalInput}
              route={replyRoute(
                open.messages,
                open.thread,
                overseer.thread,
                lookups
              )}
              onReply={actions.reply}
              onOverseerReply={overseer.submit}
              overseerBusy={overseer.busy}
              onOpenOverseer={overseer.open}
            />
          ) : (
            <EmptyPane
              focus={focus}
              open={open}
              railLoading={rail.loading}
              railEmpty={railEmpty}
            />
          )}
        </section>
      </div>
    </div>
  );
}

// What the pane shows with no thread on screen: nothing while one or the rail
// loads, why one failed, or where to start.
function EmptyPane({
  focus,
  open,
  railLoading,
  railEmpty,
}: {
  focus: string | null;
  open: OpenThread;
  railLoading: boolean;
  railEmpty: boolean;
}) {
  if (open.error !== null) {
    return (
      <EmptyState
        className="flex-1"
        heading="This thread did not load"
        description={open.error.message}
      />
    );
  }
  if ((focus !== null && open.loading) || railLoading) {
    return <div aria-busy="true" className="flex-1" />;
  }
  if (railEmpty) {
    return (
      <EmptyState
        className="flex-1"
        heading="Nothing to read yet"
        description="A thread opens here once someone writes to you, or once you start one."
      />
    );
  }
  return (
    <EmptyState
      className="flex-1"
      heading="Pick a thread"
      description="Questions and handoffs waiting on you are at the top."
    />
  );
}
