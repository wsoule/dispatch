import { Loader2, Sparkles } from 'lucide-react';

import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';

interface CommitComposerProps {
  message: string;
  onMessageChange: (message: string) => void;
  stagedCount: number;
  amend: boolean;
  onAmendChange: (amend: boolean) => void;
  busy: boolean;
  generating: boolean;
  onGenerate: () => void;
  onCommit: () => void;
}

/** The bottom bar: commit message, Generate (AI commit-message), Commit/Amend, and a one-line
 * keymap reminder so the shortcuts are documented on screen, not just behind `?`. */
export function CommitComposer({
  message,
  onMessageChange,
  stagedCount,
  amend,
  onAmendChange,
  busy,
  generating,
  onGenerate,
  onCommit,
}: CommitComposerProps) {
  const canCommit =
    message.trim() !== '' && (stagedCount > 0 || amend) && !busy;

  return (
    <div className="border-border flex flex-col gap-1.5 border-t pt-2">
      <div className="flex items-end gap-2">
        <Textarea
          id="git-commit-message"
          rows={2}
          placeholder={
            stagedCount > 0
              ? `Commit message for ${stagedCount} staged file${stagedCount === 1 ? '' : 's'}…`
              : 'Commit message…'
          }
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          className="min-h-0 flex-1 text-[12px]"
        />
        <div className="flex flex-col gap-1.5">
          <Button
            variant="outline"
            size="sm"
            disabled={stagedCount === 0 || generating}
            onClick={onGenerate}
            title="Generate a commit message from the staged diff"
          >
            {generating ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            Generate
          </Button>
          <label className="text-muted-foreground flex items-center gap-1.5 px-1 text-[11px]">
            <input
              type="checkbox"
              checked={amend}
              onChange={(e) => onAmendChange(e.target.checked)}
            />
            Amend
          </label>
          <Button size="sm" disabled={!canCommit} onClick={onCommit}>
            {amend ? 'Amend' : 'Commit'}
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground/70 text-[10.5px]">
        1-5 focus panel · j/k move · space stage · a stage all · c commit · A
        amend · d discard · b branch · enter checkout · s/S stash/pop · f/p/P
        fetch/pull/push · / filter · ? help
      </p>
    </div>
  );
}
