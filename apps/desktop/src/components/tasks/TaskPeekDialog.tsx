import { Maximize2 } from 'lucide-react';
import { useEffect } from 'react';

import { ErrorBoundary } from '../shell/ErrorBoundary';
import type { TaskDetailPanelProps } from './detail';
import { TaskDetailPanel } from './detail';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';

/**
 * The task peek: `TaskDetailPanel` in a centered `Dialog`, opened from the board/list without
 * leaving the current view. Adds only what a peek needs beyond the panel itself — the dialog
 * shell, Escape-to-close, and an expand affordance (button + ⌘/Ctrl+Enter) that hands off to
 * the full task view via `onExpand`.
 */
export function TaskPeekDialog({
  onClose,
  onExpand,
  ...panelProps
}: TaskDetailPanelProps & { onClose: () => void; onExpand: () => void }) {
  // Cmd/Ctrl+Enter grows the peek into the full task view.
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        onExpand();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onExpand]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex h-[85vh] max-h-[760px] w-[min(960px,94vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[960px]"
        aria-describedby={undefined}
        // Radix's default open-autofocus lands on the first tabbable descendant — which is
        // the (pre-filled) title field — and browsers select a text input's full value when
        // it's focused this way, not just place a caret. Left alone, opening this dialog and
        // pressing any key (even Space) would silently wipe the task's title. Focus the
        // content root itself instead (Radix gives it `tabIndex={-1}` for exactly this) —
        // Tab still reaches the title field normally, just without the drive-by select-all.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
      >
        <DialogTitle className="sr-only">
          {panelProps.doc.meta.title || 'Task detail'}
        </DialogTitle>
        <ErrorBoundary label="this dialog">
          <TaskDetailPanel
            {...panelProps}
            headerTrailing={
              <Button
                variant="ghost"
                size="xs"
                onClick={onExpand}
                aria-label="Expand to full view"
                title="Expand (⌘↵)"
              >
                <Maximize2 className="size-3.5" />
              </Button>
            }
          />
        </ErrorBoundary>
      </DialogContent>
    </Dialog>
  );
}
