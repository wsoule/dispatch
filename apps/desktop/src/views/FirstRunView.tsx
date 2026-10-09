import type { DraftRecord } from '@dispatch/client';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/ui/button';
import { Kbd } from '@/ui/kbd';
import { Spinner } from '@/ui/spinner';
import { Textarea } from '@/ui/textarea';

export interface FirstRunViewProps {
  projectName: string | null;
  /** The unwrapped draft start — rejects on failure, so the typed prompt can
   *  stay on screen with an inline error instead of being lost. */
  onStartDraft: (prompt: string) => Promise<DraftRecord>;
  /** Leaves the prompt behind for the ordinary board. The escape hatch
   *  matters: someone who opened the app to look around, not to describe
   *  work, must not be stuck behind a textarea. */
  onBrowseBoard: () => void;
  /** Two views: set the prompt aside for a conversation with the agent. */
  onTalkToAgent?: () => void;
}

/**
 * What an empty project opens on: one box asking what you want to change.
 *
 * A freshly initialized project used to land on the Control room — an empty
 * dashboard behind a full sidebar, with nothing on it and no obvious next
 * move. Nine nouns for "your work" is a lot to meet before you have any. This
 * is the same planner the AI composer drives, given the whole window while the
 * board has nothing on it.
 *
 * Deliberately narrower than the builder front door (epic e-16ef06), which
 * puts the proposed task graph inline and makes the preview the stage. This is
 * the empty state alone, and it ships without waiting for that.
 */
export function FirstRunView({
  projectName,
  onStartDraft,
  onBrowseBoard,
  onTalkToAgent,
}: FirstRunViewProps) {
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = prompt.trim() !== '' && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onStartDraft(prompt.trim());
      // The drafts tray picks the draft up from here, so the box empties and
      // stays available for the next thought rather than navigating away.
      setPrompt('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center px-6">
      <div className="flex w-full max-w-2xl flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-medium">
            What do you want to change
            {projectName === null ? '' : ` in ${projectName}`}?
          </h1>
          <p className="text-text-secondary text-sm">
            Describe it in a sentence. Dispatch drafts the task, you review it,
            then an agent picks it up.
          </p>
        </div>

        <Textarea
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // Enter submits, Shift+Enter breaks the line: the box is one
            // sentence far more often than it is a paragraph.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Add a dark mode toggle to the settings page…"
          rows={4}
          className="text-[15px]"
          aria-label="What do you want to change?"
        />

        {error !== null && (
          <p className="text-sm text-(--state-error-fg)" role="alert">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {submitting ? (
              <Spinner className="size-4" />
            ) : (
              <Sparkles aria-hidden />
            )}
            {submitting ? 'Drafting…' : 'Draft task'}
          </Button>
          <span className="text-text-secondary text-xs">
            <Kbd>Enter</Kbd> to draft
          </span>
          <div className="ml-auto flex items-center gap-1">
            {onTalkToAgent !== undefined && (
              <Button variant="ghost" onClick={onTalkToAgent}>
                Talk to the agent
              </Button>
            )}
            <Button variant="ghost" onClick={onBrowseBoard}>
              Browse the board
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
