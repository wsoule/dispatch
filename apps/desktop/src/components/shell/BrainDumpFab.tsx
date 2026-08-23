import { Brain, Inbox } from 'lucide-react';
import { useState } from 'react';

import {
  BRAIN_DUMP_DRAFT_KEY,
  usePersistedDraft,
} from '../../hooks/usePersistedDraft';
import { splitCaptureLines } from '../../lib/inboxCapture';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Textarea } from '@/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

interface BrainDumpFabProps {
  /** Owned by App so the ⌘B global shortcut opens the same modal the button does. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The RAW capture handler (`rawData.handleCaptureInbox`), not the `withActionFeedback`
   * wrapper: the wrapper swallows rejections, and this modal must keep the draft and show
   * the error inline when a capture fails rather than clearing it as if it landed. */
  onCapture: (text: string) => Promise<void>;
  /** Navigates to the full Brain dump view — the modal's escape hatch for when one quick
   * line turns out to need the real composer. */
  onOpenBrainDump: () => void;
}

/**
 * The always-there capture affordance: a small brain in the bottom-right corner (and ⌘B)
 * that opens a centered one-shot version of Brain dump's composer, so a passing thought can
 * be dropped into the inbox from any screen without leaving it. Same contract as the full
 * view — one item per line, ⌘⏎ commits — and a successful capture closes the modal; the
 * confirmation is the thought being gone.
 */
export function BrainDumpFab({
  open,
  onOpenChange,
  onCapture,
  onOpenBrainDump,
}: BrainDumpFabProps) {
  // The same persisted draft as the full Brain dump view — closing the modal, navigating,
  // or relaunching never costs a half-typed thought, and the two surfaces stay one box.
  const [draft, setDraft] = usePersistedDraft(BRAIN_DUMP_DRAFT_KEY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pendingLines = splitCaptureLines(draft).length;

  function capture(): void {
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await onCapture(draft);
        // The draft is only dropped once it has landed; on failure it stays put above the
        // error so nothing typed is ever lost.
        setDraft('');
        onOpenChange(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="top-[30%] w-[32rem] max-w-[calc(100vw-2rem)] gap-2 p-4">
          <DialogHeader className="gap-0.5">
            <DialogTitle className="text-[13px] font-medium">
              Add to Brain dump
            </DialogTitle>
            <DialogDescription className="sr-only">
              Capture quick thoughts, one per line, into the Brain dump inbox.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // ⌘⏎ commits, same as the full Brain dump composer; plain Enter stays a
              // newline so several thoughts can go down in one dump.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                // `!busy` mirrors the button's own disabled state — without it a rapid
                // double ⌘⏎ would capture the same draft twice.
                if (draft.trim() !== '' && !busy) capture();
              }
            }}
            placeholder="Dump it here…"
            autoFocus
            className="text-foreground field-sizing-fixed min-h-[88px] resize-none border-0 bg-transparent p-0 text-[13.5px] leading-relaxed shadow-none focus-visible:ring-0 md:text-[13.5px] dark:bg-transparent"
          />
          {error !== null && (
            <p className="text-state-failed text-[12px]">{error}</p>
          )}
          <div className="flex items-center gap-2">
            <span className="dense-meta flex-1">
              {pendingLines > 1
                ? `${pendingLines} lines, one item each`
                : 'One per line. ⌘⏎ to drop it.'}
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                onOpenChange(false);
                onOpenBrainDump();
              }}
              className="text-muted-foreground hover:text-foreground h-auto px-1.5 py-1 text-[12px] font-normal hover:bg-transparent"
            >
              Open Brain dump
            </Button>
            <Button
              size="xs"
              disabled={draft.trim() === '' || busy}
              onClick={capture}
              className="text-accent-foreground bg-accent hover:bg-accent/80 h-auto gap-1.5 px-2.5 py-1 text-[12px] font-normal has-[>svg]:px-2.5"
            >
              <Inbox className="size-3.5" />
              Drop it
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            onClick={() => onOpenChange(!open)}
            aria-label="Add to Brain dump"
            aria-expanded={open}
            className="bg-accent text-accent-foreground hover:bg-accent/80 fixed right-4 bottom-4 z-50 size-9 rounded-full shadow-lg"
          >
            <Brain className="size-4.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">Add to Brain dump (⌘B)</TooltipContent>
      </Tooltip>
    </>
  );
}
