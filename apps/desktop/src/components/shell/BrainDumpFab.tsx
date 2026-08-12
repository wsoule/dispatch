import { Brain, Inbox } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { splitCaptureLines } from '../../lib/inboxCapture';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

interface BrainDumpFabProps {
  /** The RAW capture handler (`rawData.handleCaptureInbox`), not the `withActionFeedback`
   * wrapper: the wrapper swallows rejections, and this panel must keep the draft and show
   * the error inline when a capture fails rather than clearing it as if it landed. */
  onCapture: (text: string) => Promise<void>;
  /** Navigates to the full Brain dump view — the panel's escape hatch for when one quick
   * line turns out to need the real composer. */
  onOpenBrainDump: () => void;
}

/**
 * The always-there capture button: a small brain in the bottom-right corner that opens a
 * one-shot version of Brain dump's composer, so a passing thought can be dropped into the
 * inbox from any screen without leaving it. Same contract as the full view — one item per
 * line, ⌘⏎ commits — and a successful capture closes the panel; the confirmation is the
 * thought being gone.
 *
 * Same "lightweight popover" pattern as InboxPanel: a plain fixed-position panel with
 * outside-click/Escape dismissal, not a Radix dialog.
 */
export function BrainDumpFab({
  onCapture,
  onOpenBrainDump,
}: BrainDumpFabProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Wraps both the trigger and the panel, so a click on the trigger while open counts as
  // "inside" — otherwise mousedown would close the panel and the click would reopen it.
  const rootRef = useRef<HTMLDivElement>(null);

  const pendingLines = splitCaptureLines(draft).length;

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (
        rootRef.current !== null &&
        !rootRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  function capture(): void {
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await onCapture(draft);
        // The draft is only dropped once it has landed; on failure it stays put above the
        // error so nothing typed is ever lost.
        setDraft('');
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <div ref={rootRef}>
      {open && (
        <div
          role="dialog"
          aria-label="Add to Brain dump"
          className="bg-popover rounded-card shadow-overlay fixed right-4 bottom-16 z-50 flex w-80 flex-col gap-2 p-3"
        >
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
            className="text-foreground field-sizing-fixed min-h-[72px] resize-none border-0 bg-transparent p-0 text-[13.5px] leading-relaxed shadow-none focus-visible:ring-0 md:text-[13.5px] dark:bg-transparent"
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
                setOpen(false);
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
        </div>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            onClick={() => setOpen((v) => !v)}
            aria-label="Add to Brain dump"
            aria-expanded={open}
            className="bg-accent text-accent-foreground hover:bg-accent/80 fixed right-4 bottom-4 z-50 size-9 rounded-full shadow-lg"
          >
            <Brain className="size-4.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">Add to Brain dump</TooltipContent>
      </Tooltip>
    </div>
  );
}
