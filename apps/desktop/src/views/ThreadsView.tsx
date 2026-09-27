import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Composer } from '../components/threads/Composer';
import { ThreadPane } from '../components/threads/ThreadPane';
import { ThreadRail } from '../components/threads/ThreadRail';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { OpenThread } from '../hooks/useThreads';
import {
  useAgentRoster,
  useChannels,
  useThread,
  useThreadActions,
  useThreadRail,
} from '../hooks/useThreads';
import { availabilityKey } from '../lib/daemonAuth';
import type { ParkedCall, RefAction } from '../lib/threadSources';
import {
  knownAddresses,
  lookupsKey,
  participantLabel,
  replyRoute,
  threadLookups,
} from '../lib/threadSources';
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
  const agents = useAgentRoster(client, port);
  const channels = useChannels(client, port, access.canMessage);
  const lookups = useKeyed(lookupsKey(data.tasks, data.runs, agents), () =>
    threadLookups(data.tasks, data.runs, agents)
  );
  const availability = useKeyed(
    availabilityKey(data.scopeDecide),
    () => data.scopeDecide
  );
  const known = useMemo(
    () =>
      knownAddresses({
        tasks: data.tasks,
        channels,
        agents,
        presence: data.presence,
        me,
      }),
    [data.tasks, channels, agents, data.presence, me]
  );
  const [composing, setComposing] = useState(false);
  // App re-renders on every event; a ref keeps the restart callback stable for memoised rows.
  const latest = useRef(data);
  useEffect(() => {
    latest.current = data;
  }, [data]);
  const onRestartDaemon = useCallback(
    () => latest.current.handleRestartDaemon(),
    []
  );
  const openRef = useRef(onOpenRef);
  useEffect(() => {
    openRef.current = onOpenRef;
  }, [onOpenRef]);
  const onOpen = useCallback(
    (action: RefAction) => openRef.current(action),
    []
  );
  const loadApprovalInput = useCallback(
    (call: ParkedCall) =>
      'runId' in call
        ? latest.current.fetchApprovalInput(call.runId, call.requestId)
        : latest.current.fetchOverseerApprovalInput(
            call.conversation,
            call.requestId
          ),
    []
  );
  const { markRead } = actions;
  useEffect(() => {
    markRead(open.deliveries);
  }, [markRead, open.deliveries]);

  const header = (
    <PageHeader
      crumb={[projectName ?? 'Project', 'Threads']}
      actions={
        <Button
          size="sm"
          variant="ghost"
          disabled={!access.canMessage || me === null}
          onClick={() => {
            setComposing(true);
            onFocus(null);
          }}
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
        <aside className="border-border w-80 shrink-0 overflow-y-auto border-r-[0.5px] p-2">
          <ThreadRail
            groups={rail.groups}
            selected={open.thread}
            onSelect={(thread) => {
              setComposing(false);
              onFocus(thread);
            }}
            lookups={lookups}
          />
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
                disabledReason={null}
                label={(address) => participantLabel(address, lookups)}
                onSend={actions.send}
                onSent={(result) => {
                  setComposing(false);
                  onFocus(result.message.thread);
                }}
              />
            </div>
          ) : open.thread !== null && open.messages.length > 0 ? (
            <ThreadPane
              // A fresh reply draft per thread.
              key={open.thread}
              messages={open.messages}
              me={me}
              openIds={rail.openIds}
              access={access}
              lookups={lookups}
              availability={availability}
              onRestartDaemon={onRestartDaemon}
              onAnswer={actions.answer}
              onOpen={onOpen}
              loadApprovalInput={loadApprovalInput}
              route={replyRoute(open.messages, open.thread, overseer.thread)}
              onReply={actions.reply}
              onOverseerReply={overseer.submit}
              overseerBusy={overseer.busy}
              onOpenOverseer={overseer.open}
            />
          ) : (
            <EmptyPane focus={focus} open={open} />
          )}
        </section>
      </div>
    </div>
  );
}

// What `build` makes, kept as the same object until `key` changes, so memoised
// rows skip the run and board events that change nothing they show.
function useKeyed<T>(key: string, build: () => T): T {
  const [held, setHeld] = useState(() => ({ key, value: build() }));
  if (held.key === key) return held.value;
  const next = { key, value: build() };
  setHeld(next);
  return next.value;
}

// What the pane shows with no thread on screen: nothing while one loads, why
// one failed, or where to start.
function EmptyPane({
  focus,
  open,
}: {
  focus: string | null;
  open: OpenThread;
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
  if (focus !== null && open.loading) {
    return <div aria-busy="true" className="flex-1" />;
  }
  return (
    <EmptyState
      className="flex-1"
      heading="Pick a thread"
      description="Questions and handoffs waiting on you are at the top."
    />
  );
}
