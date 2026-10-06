import { useState } from 'react';

import type { OverseerSession } from '../../hooks/useOverseerSession';
import { overseerTurnLive } from '../../lib/agentPresence';
import { PromptBar } from '@/ui/ai/prompt-bar';

export interface TasksComposerProps {
  overseer: OverseerSession;
  /** The task you have open or selected, offered as a context pill. */
  about: { taskId: string; title: string } | null;
  onOpenOverseer: () => void;
  disabled: boolean;
}

/** "say something" in Tasks: always your agent. Its reply shows in a tray; you stay put. */
export function TasksComposer({
  overseer,
  about,
  onOpenOverseer,
  disabled,
}: TasksComposerProps) {
  const [draft, setDraft] = useState('');
  // Collapsed to one line until used, so Tasks keeps its height for work.
  const [expanded, setExpanded] = useState(false);
  // The task whose pill you removed; another task brings the pill back.
  const [dismissed, setDismissed] = useState<string | null>(null);
  // How many messages the conversation held when this composer last sent.
  const [sentAt, setSentAt] = useState<number | null>(null);
  const pill = about !== null && about.taskId !== dismissed ? about : null;
  const messages = overseer.record?.messages ?? [];
  const reply =
    sentAt === null
      ? undefined
      : messages
          .slice(sentAt)
          .filter((m) => m.role === 'assistant')
          .at(-1);
  const working = sentAt !== null && overseerTurnLive(overseer);

  const submit = () => {
    const text = draft.trim();
    if (text === '' || overseer.sending) return;
    const prompt =
      pill === null ? text : `About ${pill.taskId} ("${pill.title}"): ${text}`;
    setSentAt(messages.length);
    setDraft('');
    void overseer.submit(prompt);
  };

  return (
    <div className="border-border flex shrink-0 flex-col items-center gap-2 border-t-[0.5px] px-4 pt-2 pb-2">
      {sentAt !== null && (
        <div
          data-testid="tasks-composer-tray"
          role="status"
          className="bg-background border-border rounded-card flex w-full max-w-[760px] items-start gap-3 border-[0.5px] px-3 py-2 text-[13px]"
        >
          <p className="line-clamp-3 min-w-0 flex-1 text-(--text-secondary)">
            {overseer.sendError ??
              (working
                ? 'Your agent is working…'
                : (reply?.text ?? 'Sent to your agent.'))}
          </p>
          <button
            type="button"
            onClick={onOpenOverseer}
            className="text-[12px] whitespace-nowrap text-(--accent) hover:underline"
          >
            Open in Overseer →
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setSentAt(null)}
            className="text-muted-foreground text-[12px]"
          >
            ×
          </button>
        </div>
      )}
      {!expanded && draft === '' ? (
        <button
          type="button"
          data-testid="tasks-composer-collapsed"
          disabled={disabled}
          onClick={() => setExpanded(true)}
          onFocus={() => setExpanded(true)}
          className="bg-surface-quaternary border-border rounded-control text-muted-foreground hover:text-foreground flex h-9 w-full max-w-[760px] items-center gap-2 border-[0.5px] px-3 text-left text-[13px]"
        >
          {pill !== null && (
            <span className="rounded-pill bg-surface-inset text-foreground shrink-0 px-2 py-0.5 text-[12px]">
              about {pill.taskId}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate">say something</span>
        </button>
      ) : (
        <div
          className="w-full max-w-[760px]"
          // Leaving an empty composer folds it back to one line.
          onBlur={(event) => {
            if (
              draft === '' &&
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
              setExpanded(false);
            }
          }}
        >
          <PromptBar
            focusOnMount
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            disabled={disabled || overseer.sending}
            placeholder="say something"
            ariaLabel="Say something to your agent"
            references={
              pill === null
                ? undefined
                : [{ id: 'about', label: `about ${pill.taskId}` }]
            }
            onRemoveReference={() => setDismissed(about?.taskId ?? null)}
          />
        </div>
      )}
    </div>
  );
}
