import type { Message } from '@dispatch/client';
import { useState } from 'react';

import type { ComposeProblem } from '../../lib/composer';
import { problemText, sendProblem } from '../../lib/composer';
import type { DecideAvailability, MessageAccess } from '../../lib/daemonAuth';
import type {
  RefAction,
  ReplyPlan,
  ReplyRoute,
  ThreadLookups,
} from '../../lib/threadSources';
import { replyPlan } from '../../lib/threadSources';
import type { MessageRowProps } from './MessageRow';
import { MessageRow } from './MessageRow';
import { PromptBar } from '@/ui/ai/prompt-bar';
import { Button } from '@/ui/button';

export interface ThreadPaneProps {
  messages: Message[];
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
  onReply: (plan: ReplyPlan, body: string) => Promise<unknown>;
  onOverseerReply: (body: string) => Promise<void>;
  onOpenOverseer: () => void;
}

/** An open thread: its messages, then a reply box addressed by `replyPlan`. */
export function ThreadPane(props: ThreadPaneProps) {
  const { messages, me, openIds } = props;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            me={me}
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
      <div className="border-border border-t-[0.5px] p-2">
        <ReplyBox {...props} plan={replyPlan(messages, me, openIds)} />
      </div>
    </div>
  );
}

// The typed reply under a thread, or why there is none.
function ReplyBox({
  messages,
  openIds,
  access,
  route,
  plan,
  onReply,
  onOverseerReply,
  onOpenOverseer,
}: ThreadPaneProps & { plan: ReplyPlan | null }) {
  const [body, setBody] = useState('');
  const [problem, setProblem] = useState<ComposeProblem | null>(null);
  const [sending, setSending] = useState(false);
  if (!access.canMessage) {
    return (
      <p className="text-muted-foreground text-[12px]">{access.explanation}</p>
    );
  }
  if (route === 'overseer-elsewhere') {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-[12px]">
        This is an earlier Assistant conversation.
        <Button size="sm" variant="ghost" onClick={onOpenOverseer}>
          Open Assistant
        </Button>
      </p>
    );
  }
  if (route === 'bus' && plan === null) {
    return (
      <p className="text-muted-foreground text-[12px]">
        {messages.some((m) => openIds.has(m.id))
          ? 'Answer with the buttons above.'
          : 'Nothing in this thread takes a reply.'}
      </p>
    );
  }
  const submit = async () => {
    setSending(true);
    setProblem(null);
    try {
      if (route === 'overseer') await onOverseerReply(body.trim());
      else if (plan !== null) await onReply(plan, body.trim());
      setBody('');
    } catch (err) {
      setProblem(sendProblem(err));
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <PromptBar
        value={body}
        onChange={(value) => {
          setBody(value);
          setProblem(null);
        }}
        onSubmit={() => void submit()}
        disabled={sending}
        placeholder={
          route === 'overseer' ? 'Reply to the Assistant…' : 'Reply…'
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
