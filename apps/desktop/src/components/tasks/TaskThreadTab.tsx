import { useEffect, useMemo, useRef, useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { useThreadPaneProps } from '../../hooks/useThreadPaneProps';
import type { OpenThread } from '../../hooks/useThreads';
import {
  useTaskThreads,
  useThread,
  useThreadActions,
} from '../../hooks/useThreads';
import type { RefAction, ThreadLookups } from '../../lib/threadSources';
import { participantLabel, replyRoute } from '../../lib/threadSources';
import { Composer } from '../threads/Composer';
import { ThreadList } from '../threads/ThreadList';
import { ThreadPane } from '../threads/ThreadPane';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';

export interface TaskThreadTabProps {
  data: DispatchProjectData;
  taskId: string;
  onOpenRef: (action: RefAction) => void;
  onOpenOverseer: () => void;
}

// Never called: without the live Assistant thread, an Assistant thread here is read-only.
const noOverseerReply = (): Promise<void> => Promise.resolve();
const NOT_LISTED =
  "Listing a task's threads needs the decide tier. Ask the project owner for a decide token. You can still write to the task below.";
const NOTE = 'text-muted-foreground p-2 text-[12px]';

/** Everything to or from a task and its runs, with a composer addressed to the task. */
export function TaskThreadTab({
  data,
  taskId,
  onOpenRef,
  onOpenOverseer,
}: TaskThreadTabProps) {
  const { client, port, me, messageAccess: access } = data;
  const list = useTaskThreads(client, port, me, access, taskId);
  const [focus, setFocus] = useState<string | null>(null);
  const open = useThread(client, port, focus, access);
  const actions = useThreadActions(client, port, me, access, data);
  const pane = useThreadPaneProps(data, onOpenRef);
  const locked = useMemo(() => [`task:${taskId}`], [taskId]);
  // With a thread open, a new message waits behind a button so a reply is not
  // typed into it by mistake; closing it returns focus to that button.
  const [composing, setComposing] = useState(false);
  const newMessageRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const { markRead } = actions;
  useEffect(() => {
    markRead(open.deliveries);
  }, [markRead, open.deliveries]);
  useEffect(() => {
    if (composing || !returnFocus.current) return;
    returnFocus.current = false;
    newMessageRef.current?.focus();
  }, [composing]);

  if (!access.canMessage) {
    return (
      <EmptyState
        className="h-full"
        heading="Threads are not available in this window."
        description={access.explanation}
      />
    );
  }
  const threadOpen =
    open.thread !== null && open.messages.length > 0 && me !== null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside
        aria-label="Thread list"
        className="border-border w-72 shrink-0 overflow-y-auto border-r-[0.5px] p-2"
      >
        <TaskThreads
          list={list}
          canDecide={access.canDecide}
          me={me}
          selected={open.thread}
          onSelect={(thread) => {
            setComposing(false);
            setFocus(thread);
          }}
          lookups={pane.lookups}
        />
      </aside>
      <section aria-label="Thread" className="flex min-w-0 flex-1 flex-col">
        {threadOpen && me !== null ? (
          <ThreadPane
            // A fresh reply draft per thread.
            key={open.thread}
            messages={open.messages}
            focus={focus}
            deliveries={open.deliveries}
            me={me}
            openIds={list.openIds}
            access={access}
            lookups={pane.lookups}
            availability={pane.availability}
            onRestartDaemon={pane.onRestartDaemon}
            onAnswer={actions.answer}
            onOpen={pane.onOpen}
            loadApprovalInput={pane.loadApprovalInput}
            client={client}
            port={port}
            route={replyRoute(open.messages, open.thread, null, pane.lookups)}
            onReply={actions.reply}
            onOverseerReply={noOverseerReply}
            overseerBusy={false}
            onOpenOverseer={onOpenOverseer}
          />
        ) : (
          <NoThread focus={focus} open={open} />
        )}
        <div className="border-border border-t-[0.5px] p-2">
          {threadOpen && !composing ? (
            <Button
              ref={newMessageRef}
              size="sm"
              variant="ghost"
              onClick={() => setComposing(true)}
            >
              New message
            </Button>
          ) : (
            <Composer
              known={pane.known}
              initialTo={locked}
              locked={locked}
              label={(address) => participantLabel(address, pane.lookups)}
              onSend={actions.send}
              onSent={(result) => {
                setComposing(false);
                setFocus(result.message.thread);
              }}
              onCancel={
                threadOpen
                  ? () => {
                      returnFocus.current = true;
                      setComposing(false);
                    }
                  : undefined
              }
              focusOnMount={composing}
            />
          )}
        </div>
      </section>
    </div>
  );
}

// The task's thread rows, or why there are none to show.
function TaskThreads({
  list,
  canDecide,
  me,
  selected,
  onSelect,
  lookups,
}: {
  list: ReturnType<typeof useTaskThreads>;
  canDecide: boolean;
  me: string | null;
  selected: string | null;
  onSelect: (thread: string) => void;
  lookups: ThreadLookups;
}) {
  if (!canDecide) return <p className={NOTE}>{NOT_LISTED}</p>;
  // The list waits for the daemon to say who I am.
  if (me === null || list.loading) {
    return (
      <p aria-busy="true" className={NOTE}>
        Loading threads…
      </p>
    );
  }
  const error =
    list.error === null ? null : (
      <p role="alert" className="text-destructive p-2 text-[12px]">
        {list.error.message}
      </p>
    );
  if (list.summaries.length === 0) {
    return error ?? <p className={NOTE}>No messages yet.</p>;
  }
  // A failed refetch keeps the rows it already had, with why under them.
  return (
    <>
      <ThreadList
        label="Threads"
        sections={[{ key: 'task', summaries: list.summaries }]}
        selected={selected}
        onSelect={onSelect}
        lookups={lookups}
      />
      {error}
    </>
  );
}

// The pane with no thread on screen: blank while one loads or none is picked,
// or why the picked one failed.
function NoThread({ focus, open }: { focus: string | null; open: OpenThread }) {
  if (open.error !== null) {
    return (
      <EmptyState
        className="flex-1"
        heading="This thread did not load"
        description={open.error.message}
      />
    );
  }
  return (
    <div
      aria-busy={focus !== null && open.loading ? true : undefined}
      className="flex-1"
    />
  );
}
