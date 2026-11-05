import { Button, cx, EmptyState, SkeletonRows } from '@dispatch/ui';
import { useEffect, useRef, useState } from 'react';

import { DocsLinkingList } from '../components/docs/DocsLinkingList';
import { PageHead } from '../components/shell/PageHead';
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
import styles from './ThreadsView.module.css';

export interface ThreadsViewProps {
  /** The back chip to the Tasks list the page leads with; omitted, no chip. */
  onBack?: () => void;
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
  onBack,
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
    <div className={styles.head}>
      <PageHead
        onBack={onBack}
        crumbs={
          onBack === undefined
            ? [projectName ?? 'Project', 'Threads']
            : ['Threads']
        }
        actions={
          <Button
            ref={newThreadRef}
            size="sm"
            variant="secondary"
            disabled={!access.canMessage || me === null}
            onClick={startComposing}
          >
            New thread
          </Button>
        }
      />
    </div>
  );
  if (!access.canMessage) {
    return (
      <div className={styles.view}>
        {header}
        <div className={styles.empty}>
          <EmptyState label="Threads are not available in this window.">
            {access.explanation}
          </EmptyState>
        </div>
      </div>
    );
  }
  if (me === null && data.whoamiError !== null) {
    return (
      <div className={styles.view}>
        {header}
        <div className={styles.empty}>
          <EmptyState
            label="The daemon did not say who you are"
            action={
              <Button size="sm" variant="secondary" onClick={data.retryWhoami}>
                Retry
              </Button>
            }
          >
            {data.whoamiError.message}
          </EmptyState>
        </div>
      </div>
    );
  }
  // Still waiting on whoami: the rail's skeleton, as while the rail loads.
  if (me === null) {
    return (
      <div className={styles.view}>
        {header}
        <div className={styles.body}>
          <aside aria-label="Thread list" aria-busy className={styles.rail}>
            <SkeletonRows
              rows={5}
              label="Waiting for the daemon to say who you are."
            />
          </aside>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.view}>
      {header}
      <div className={styles.body}>
        <aside
          aria-label="Thread list"
          aria-busy={rail.loading || undefined}
          className={styles.rail}
        >
          {rail.loading ? (
            <SkeletonRows rows={5} label="Loading threads…" />
          ) : railEmpty ? (
            <EmptyState
              label="No threads yet"
              action={
                <Button size="sm" variant="primary" onClick={startComposing}>
                  New thread
                </Button>
              }
            >
              Questions, handoffs and messages to or from you land here.
            </EmptyState>
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
            <p
              role="alert"
              className={cx('toneText', styles.error)}
              data-tone="danger"
            >
              {rail.error.message}
            </p>
          )}
        </aside>
        <section aria-label="Thread" className={styles.thread}>
          {composing ? (
            <div className={styles.composer}>
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
            <div className={styles.open}>
              <DocsLinkingList
                client={client}
                port={port}
                target={`thread:${open.thread}`}
                onOpenDoc={(docId) =>
                  onOpen({ kind: 'doc', docId, anchor: null })
                }
              />
              <div className={styles.paneSlot}>
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
                  client={client}
                  port={port}
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
              </div>
            </div>
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
      <div className={styles.empty}>
        <EmptyState label="This thread did not load">
          {open.error.message}
        </EmptyState>
      </div>
    );
  }
  if ((focus !== null && open.loading) || railLoading) {
    return <div aria-busy="true" className={styles.empty} />;
  }
  if (railEmpty) {
    return (
      <div className={styles.empty}>
        <EmptyState label="Nothing to read yet">
          A thread opens here once someone writes to you, or once you start one.
        </EmptyState>
      </div>
    );
  }
  return (
    <div className={styles.empty}>
      <EmptyState label="Pick a thread">
        Questions and handoffs waiting on you are at the top.
      </EmptyState>
    </div>
  );
}
