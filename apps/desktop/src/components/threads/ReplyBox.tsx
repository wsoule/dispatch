import { ApiError } from '@dispatch/client';
import { Button, cx } from '@dispatch/ui';
import { useState } from 'react';

import { useDraftKey } from '../../hooks/useThreads';
import type { ComposeProblem } from '../../lib/composer';
import { problemText, sendProblem } from '../../lib/composer';
import type { ReplyPlan } from '../../lib/threadSources';
import { hasAnswerButtons, replyTarget } from '../../lib/threadSources';
import { PromptBar } from '../chat/PromptBar';
import styles from './ReplyBox.module.css';
import type { ThreadPaneProps } from './ThreadPane';

export type ReplyBoxProps = Pick<
  ThreadPaneProps,
  | 'messages'
  | 'me'
  | 'openIds'
  | 'access'
  | 'lookups'
  | 'route'
  | 'onReply'
  | 'onOverseerReply'
  | 'overseerBusy'
  | 'onOpenOverseer'
  | 'overseerVoice'
> & {
  /** Where a typed reply goes, from `replyPlan`; null when nothing takes one. */
  plan: ReplyPlan | null;
};

export type OverseerVoice = 'assistant' | 'agent';

// The Overseer's name in each place: the Threads page says Overseer, the thread peek says
// your agent (ThreadPane's `overseerVoice`).
const VOICE: Record<
  OverseerVoice,
  { elsewhere: string; open: string; to: string; busy: string; reply: string }
> = {
  assistant: {
    elsewhere: 'This Overseer conversation takes no replies here.',
    open: 'Open Overseer',
    to: 'To the Overseer',
    busy: 'The Overseer is answering…',
    reply: 'Reply to the Overseer…',
  },
  agent: {
    elsewhere: 'This conversation with your agent takes no replies here.',
    open: 'Open Overseer',
    to: 'To your agent',
    busy: 'Your agent is answering…',
    reply: 'Reply to your agent…',
  },
};

/** The typed reply under a thread, or why there is none. */
export function ReplyBox({
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
  overseerVoice = 'assistant',
}: ReplyBoxProps) {
  const voice = VOICE[overseerVoice];
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
    return <p className={styles.note}>{access.explanation}</p>;
  }
  if (route === 'overseer-elsewhere') {
    return (
      <p className={cx(styles.note, styles.elsewhere)}>
        {voice.elsewhere}
        <Button size="sm" variant="quiet" onClick={onOpenOverseer}>
          {voice.open}
        </Button>
      </p>
    );
  }
  if (route === 'bus' && plan === null && lost === null) {
    return (
      <p className={styles.note}>
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
    <div className={styles.reply}>
      <p className={styles.target}>
        {route === 'overseer'
          ? voice.to
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
          waiting ? voice.busy : route === 'overseer' ? voice.reply : 'Reply…'
        }
        ariaLabel="Reply"
      />
      {problem !== null && (
        <p
          role="alert"
          className={cx('toneText', styles.note)}
          data-tone="danger"
        >
          {problemText(problem)}
        </p>
      )}
    </div>
  );
}
