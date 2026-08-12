import { Sparkles } from 'lucide-react';

import { Button } from '@/ui/button';
import { ButtonGroup } from '@/ui/button-group';
import { Checkbox } from '@/ui/checkbox';
import { Kbd } from '@/ui/kbd';
import { Label } from '@/ui/label';
import { Spinner } from '@/ui/spinner';
import { Textarea } from '@/ui/textarea';

// Each entry is one keycap + its meaning, rendered as `Kbd key label · Kbd key label · …` so
// the shortcuts stay legible without the reader having to parse a run-on sentence of symbols.
const LEGEND: Array<{ key: string; label: string }> = [
  { key: '1-5', label: 'focus panel' },
  { key: 'j/k', label: 'move' },
  { key: 'space', label: 'stage' },
  { key: 'a', label: 'stage all' },
  { key: 'c', label: 'commit' },
  { key: 'A', label: 'amend' },
  { key: 'd', label: 'discard' },
  { key: 'b', label: 'branch' },
  { key: 'enter', label: 'checkout' },
  { key: 's/S', label: 'stash/pop' },
  { key: 'f/p/P', label: 'fetch/pull/push' },
  { key: '/', label: 'filter' },
  { key: '?', label: 'help' },
];

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
      <p className="text-muted-foreground/70 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10.5px]">
        {LEGEND.map(({ key, label }, index) => (
          <span key={key} className="inline-flex items-center gap-1">
            <Kbd className="h-auto min-w-0 px-1 py-0 font-mono text-[9.5px]">
              {key}
            </Kbd>
            <span>{label}</span>
            {index < LEGEND.length - 1 && <span aria-hidden="true">·</span>}
          </span>
        ))}
      </p>
    </div>
  );
}
