import type { Delivery, Message } from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';

import { useStickToBottom } from '../../hooks/useStickToBottom';
import { useDraftKey } from '../../hooks/useThreads';
import type { ComposeProblem } from '../../lib/composer';
import { problemText, sendProblem } from '../../lib/composer';
import type { DecideAvailability, MessageAccess } from '../../lib/daemonAuth';
import type {
  RefAction,
  ReplyPlan,
  ReplyRoute,
  ThreadLookups,
} from '../../lib/threadSources';
import {
  hasAnswerButtons,
  replyPlan,
  replyTarget,
  threadOpenIds,
} from '../../lib/threadSources';
import type { MessageRowProps } from './MessageRow';
import { MessageRow } from './MessageRow';
import { PromptBar } from '@/ui/ai/prompt-bar';
import { Button } from '@/ui/button';

// How long a message a link opened the thread at stays marked.
const LINKED_MARK_MS = 2000;

export interface ThreadPaneProps {
  messages: Message[];
  /** The message id the thread was opened at; a later one is scrolled to and briefly marked. */
  focus: string | null;
  /** The thread's deliveries: a teammate may reply only to what reached them. */
  deliveries: readonly Delivery[];
  me: string;
  openIds: ReadonlySet<string>;
  access: MessageAccess;
  lookups: ThreadLookups;
  availability: DecideAvailability;
  onRestartDaemon: () => Promise<void>;
  onAnswer: MessageRowProps['onAnswer'];
  onOpen: (action: RefAction) => void;
  loadApprovalInput: MessageRowProps['loadApprovalInput'];
  route: ReplyRoute;
  /** Sends under the reply draft's idempotency key, kept until a send or an edit. */
  onReply: (
    plan: ReplyPlan,
    body: string,
    idempotencyKey: string
  ) => Promise<unknown>;
  onOverseerReply: (body: string) => Promise<void>;
  /** The Assistant is mid-turn or taking a message, so it would refuse another. */
  overseerBusy: boolean;
  onOpenOverseer: () => void;
}

/** An open thread, following its newest message: its messages, then a reply
 *  box addressed by `replyPlan`. */
export function ThreadPane(props: ThreadPaneProps) {
  const { messages, me, focus } = props;
  const openIds = useMemo(
    () => threadOpenIds(messages, me, props.openIds),
    [messages, me, props.openIds]
  );
  const thread = messages[0]?.thread ?? '';
  const { scrollRef, contentRef, unpin } = useStickToBottom(thread);
  const linked =
    focus !== null && focus !== thread && messages.some((m) => m.id === focus)
      ? focus
      : null;
  const [faded, setFaded] = useState<string | null>(null);
  // Runs after the hook's jump to the bottom, so the linked message wins.
  useLayoutEffect(() => {
    if (linked === null) return;
    const rows = scrollRef.current?.querySelectorAll('[data-message-id]');
    const row = Array.from(rows ?? []).find(
      (el) => el.getAttribute('data-message-id') === linked
    );
    if (row === undefined) return;
    unpin();
    row.scrollIntoView({ block: 'center' });
  }, [linked, scrollRef, unpin]);
  useEffect(() => {
    if (linked === null) return;
    const timer = setTimeout(() => setFaded(linked), LINKED_MARK_MS);
    // A later link back to the same message marks it again.
    return () => {
      clearTimeout(timer);
      setFaded(null);
    };
  }, [linked]);
  const marked = linked !== faded ? linked : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        role="log"
        aria-label="Messages"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div ref={contentRef} className="flex flex-col gap-3 p-3">
          {messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              me={me}
              linked={message.id === marked}
              open={openIds.has(message.id)}
              access={props.access}
              lookups={props.lookups}
              availability={props.availability}
              onRestartDaemon={props.onRestartDaemon}
              onAnswer={props.onAnswer}
              onOpen={props.onOpen}
              loadApprovalInput={props.loadApprovalInput}
            />
          ))}
        </div>
      </div>
      <div className="border-border border-t-[0.5px] p-2">
        <ReplyBox
          {...props}
          openIds={openIds}
          plan={replyPlan(messages, me, openIds, {
            canDecide: props.access.canDecide,
            deliveries: props.deliveries,
          })}
        />
      </div>
    </div>
  );
}

// The typed reply under a thread, or why there is none.
function ReplyBox({
  messages,
  me,
  openIds,
  access,
  lookups,
  route,
  plan,
  onReply,
  onOverseerReply,
  overseerBusy,
  onOpenOverseer,
}: ThreadPaneProps & { plan: ReplyPlan | null }) {
  const [body, setBody] = useState('');
  const [problem, setProblem] = useState<ComposeProblem | null>(null);
  const [sending, setSending] = useState(false);
  const [draftKey, renewKey] = useDraftKey();
  // A send whose response was lost may have landed, so resending the unedited
  // draft repeats its plan and key even if the thread moved on.
  const [lost, setLost] = useState<{ plan: ReplyPlan; key: string } | null>(
    null
  );
  if (!access.canMessage) {
    return (
      <p className="text-muted-foreground text-[12px]">{access.explanation}</p>
    );
  }
  if (route === 'overseer-elsewhere') {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-[12px]">
        This Assistant conversation takes no replies here.
        <Button size="sm" variant="ghost" onClick={onOpenOverseer}>
          Open Assistant
        </Button>
      </p>
    );
  }
  if (route === 'bus' && plan === null && lost === null) {
    return (
      <p className="text-muted-foreground text-[12px]">
        {hasAnswerButtons(messages, { me, openIds, access })
          ? 'Answer with the buttons above.'
          : 'Nothing in this thread takes a reply.'}
      </p>
    );
  }
  const waiting = route === 'overseer' && overseerBusy;
  const next = lost !== null && lost.key === draftKey ? lost.plan : plan;
  const submit = async () => {
    if (waiting || (route === 'bus' && next === null)) return;
    const text = body.trim();
    setSending(true);
    setProblem(null);
    try {
      if (route === 'overseer') await onOverseerReply(text);
      else if (next !== null) await onReply(next, text, draftKey);
      setBody('');
      setLost(null);
      renewKey();
    } catch (err) {
      setProblem(sendProblem(err));
      // The daemon answering with an error means nothing landed.
      const mayHaveLanded = route === 'bus' && !(err instanceof ApiError);
      setLost(
        mayHaveLanded && next !== null ? { plan: next, key: draftKey } : null
      );
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground truncate text-[12px]">
        {route === 'overseer'
          ? 'To the Assistant'
          : next === null
            ? null
            : replyTarget(next, lookups)}
      </p>
      <PromptBar
        value={body}
        onChange={(value) => {
          setBody(value);
          setProblem(null);
          renewKey();
        }}
        onSubmit={() => void submit()}
        disabled={sending || waiting}
        placeholder={
          waiting
            ? 'The Assistant is answering…'
            : route === 'overseer'
              ? 'Reply to the Assistant…'
              : 'Reply…'
        }
        ariaLabel="Reply"
      />
      {problem !== null && (
        <p role="alert" className="text-destructive text-[12px]">
          {problemText(problem)}
        </p>
      )}
    </div>
  );
}
