import { ApiError } from '@dispatch/client';
import { useState } from 'react';

import { useDraftKey } from '../../hooks/useThreads';
import type { ComposeProblem } from '../../lib/composer';
import { problemText, sendProblem } from '../../lib/composer';
import type { ReplyPlan } from '../../lib/threadSources';
import { hasAnswerButtons, replyTarget } from '../../lib/threadSources';
import type { ThreadPaneProps } from './ThreadPane';
import { PromptBar } from '@/ui/ai/prompt-bar';
import { Button } from '@/ui/button';

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
> & {
  /** Where a typed reply goes, from `replyPlan`; null when nothing takes one. */
  plan: ReplyPlan | null;
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
}: ReplyBoxProps) {
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
