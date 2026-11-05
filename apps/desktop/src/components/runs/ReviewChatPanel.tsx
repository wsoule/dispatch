import type { ApiClient, ChatMessage, Snippet } from '@dispatch/client';
import { Button, Panel } from '@dispatch/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, MessageSquare } from 'lucide-react';
import type { Ref } from 'react';
import { useCallback, useImperativeHandle, useMemo, useState } from 'react';

import type { ChatTarget } from '../chat/SnippetComposer';
import { SnippetComposer } from '../chat/SnippetComposer';
import styles from './ReviewChatPanel.module.css';
import { snippetLabel } from '@/lib/conversation';
import { reviewTargetKey } from '@/lib/reviewTarget';

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

/** How the diff hands a selection to the dock. Imperative because the two sit side by side in
 * the review page and the pending attachments belong to the dock, not to the page. */
export interface ReviewChatHandle {
  attach(snippet: Snippet): void;
}

interface ReviewChatPanelProps {
  client: ApiClient;
  runId: string;
  /**
   * Whether this run's own agent could still be resumed on its branch. False — a run still
   * going, or one already reviewed — withholds the acting target entirely rather than offering
   * a recipient that cannot act, the same rule the pencil and the gutter "+" already follow.
   */
  canResumeAgent: boolean;
  ref?: Ref<ReviewChatHandle>;
}

/**
 * The review's chat dock: everything about *this run* that the composer, the selection bar and
 * the conversation store deliberately do not know.
 *
 * It is the only place that turns a run into a subject (`reviewTargetKey`) and into targets, which
 * is what lets the same composer and the same selection bar serve a Git-page diff or a GitHub PR
 * unchanged — they never learn what a run is.
 *
 * Sending stores the message against the subject and nothing more: no agent is resumed and no
 * reply is produced. That is stated in the dock rather than implied, because a message that
 * looks sent but was only filed is the worse failure.
 */
export function ReviewChatPanel({
  client,
  runId,
  canResumeAgent,
  ref,
}: ReviewChatPanelProps) {
  const queryClient = useQueryClient();
  const subject = reviewTargetKey({ kind: 'run', runId });
  // Keyed on the subject and the daemon it came from — never on the run id, so a subject that
  // is not a run reads from exactly the same cache entry shape.
  const queryKey = useMemo(
    () => ['dispatch-conversation', client.baseUrl, subject],
    [client, subject]
  );
  const { data: messages } = useQuery({
    queryKey,
    queryFn: () => client.fetchConversation(subject),
    retry: false,
  });

  // The pending attachments live here, not in `SnippetComposer`: that component is controlled
  // by contract, and the selection bar that pushes onto this list is in another subtree.
  const [attachments, setAttachments] = useState<Snippet[]>([]);
  const [open, setOpen] = useState(false);

  useImperativeHandle(ref, () => ({
    attach(snippet: Snippet) {
      setAttachments((prev) => [...prev, snippet]);
      // Attaching into a collapsed dock would drop the chip out of sight, which reads as the
      // action having done nothing.
      setOpen(true);
    },
  }));

  const targets = useMemo<ChatTarget[]>(
    () => [
      ...(canResumeAgent
        ? [
            {
              id: 'run-agent',
              label: "This run's agent",
              canAct: true,
              hint: 'Resumes the session. It can edit code.',
            },
          ]
        : []),
      {
        id: 'side',
        label: 'Side conversation',
        canAct: false,
        hint: 'A fresh agent with the diff as context. It explains; it does not edit.',
      },
    ],
    [canResumeAgent]
  );

  const handleSend = useCallback(
    async (body: string, snippets: Snippet[], targetId: string) => {
      const created = await client.addChatMessage({
        subject,
        role: 'human',
        body,
        snippets,
        target: targetId,
      });
      // A first fetch still in flight would resolve *after* this write and overwrite it with a
      // list that predates the message — sending into a dock opened a moment ago would then
      // look like a send that vanished.
      await queryClient.cancelQueries({ queryKey });
      // The POST returns the stored message, so it goes straight into the cache rather than
      // costing a refetch — same one-round-trip pattern as the PR review calls.
      queryClient.setQueryData<ChatMessage[]>(queryKey, (prev) => [
        ...(prev ?? []),
        created,
      ]);
      setAttachments([]);
    },
    [client, subject, queryClient, queryKey]
  );

  const handleRemoveAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const count = messages?.length ?? 0;

  if (!open) {
    // The collapsed dock: one full-width row that opens the composer. The
    // count trails it as decoration; the words carry it for assistive tech.
    return (
      <div className={styles.dock}>
        <Button
          block
          className={styles.openRow}
          onClick={() => setOpen(true)}
          icon={<MessageSquare {...ICON} />}
          iconAfter={
            count > 0 ? (
              <span className={styles.count}>{count}</span>
            ) : undefined
          }
        >
          Ask about this diff…
          {count > 0 && (
            <span className="srOnly">
              {`, ${count} message${count === 1 ? '' : 's'}`}
            </span>
          )}
        </Button>
      </div>
    );
  }

  return (
    <Panel
      heading="Chat about this diff"
      className={styles.panel}
      actions={
        <Button
          variant="quiet"
          size="sm"
          aria-label="Collapse the chat"
          icon={<ChevronDown {...ICON} />}
          onClick={() => setOpen(false)}
        />
      }
    >
      {count > 0 && (
        <div className={styles.messages}>
          {messages?.map((m) => (
            <Message key={m.id} message={m} />
          ))}
        </div>
      )}

      <SnippetComposer
        targets={targets}
        attachments={attachments}
        onRemoveAttachment={handleRemoveAttachment}
        onSend={handleSend}
      />

      <p className={styles.note}>
        Saved with this review — nothing is dispatched to an agent yet.
      </p>
    </Panel>
  );
}

/** One stored message: who wrote it, what it said, and which code it pointed at. */
function Message({ message }: { message: ChatMessage }) {
  return (
    <div className={styles.message}>
      <span className={styles.author}>
        {message.role === 'human' ? 'You' : 'Agent'}
        {message.target === undefined ? '' : ` → ${message.target}`}
      </span>
      {message.snippets.length > 0 && (
        <div className={styles.snippets}>
          {message.snippets.map((snippet, index) => (
            <span key={`${snippet.file}-${index}`}>
              {snippetLabel(snippet)}
            </span>
          ))}
        </div>
      )}
      <p className={styles.body}>{message.body}</p>
    </div>
  );
}
