import { Sparkles } from 'lucide-react';

import { Button } from '@/ui/button';
import { ButtonGroup } from '@/ui/button-group';
import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
import { Spinner } from '@/ui/spinner';
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

/** The bottom bar: commit message, Generate (AI commit-message), and Commit/Amend. The
 * keymap lives behind `?` (see GitKeymapDialog), not as a permanent footer of copy. */
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
    <div className="shadow-hairline-top flex flex-col gap-1.5 pt-2">
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
          <ButtonGroup orientation="vertical">
            <Button
              variant="outline"
              size="sm"
              disabled={stagedCount === 0 || generating}
              onClick={onGenerate}
              title="Generate a commit message from the staged diff"
            >
              {generating ? (
                <Spinner className="size-3.5" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              Generate
            </Button>
            <Button size="sm" disabled={!canCommit} onClick={onCommit}>
              {amend ? 'Amend' : 'Commit'}
            </Button>
          </ButtonGroup>
          <Label className="text-muted-foreground flex items-center gap-1.5 px-1 text-[11px] font-normal">
            <Checkbox
              className="size-3.5"
              checked={amend}
              onCheckedChange={(checked) => onAmendChange(checked === true)}
            />
            Amend
          </Label>
        </div>
      </div>
    </div>
  );
}
