import { Loader2, PanelTopOpen, Sparkles } from 'lucide-react';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Textarea } from '@/ui/textarea';

interface AiTaskComposerProps {
  data: DispatchProjectData;
  /** Opens `CreateTaskModal` instead — the structured quick-add fallback for when you already
   * know the exact fields and don't want to spend an agent round-trip describing them. */
  onQuickAdd: () => void;
  onClose: () => void;
}

/**
 * Describe-what-you-want task starter. Submitting starts a background draft
 * (`handleStartDraft`) and closes right away — the planner turn keeps running server-side and
 * the drafts tray picks up its progress, so nothing here blocks on it settling. Reviewing and
 * saving the result happens later, from the tray, via `DraftReviewDialog`.
 */
export function AiTaskComposer({
  data,
  onQuickAdd,
  onClose,
}: AiTaskComposerProps) {
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (prompt.trim() === '' || submitting) return;
    setSubmitting(true);
    await data.handleStartDraft(prompt.trim());
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Textarea
            rows={5}
            autoFocus
            placeholder="Describe the task — what should change, and how you'll know it's done…"
            aria-label="Describe the task"
            value={prompt}
            disabled={submitting}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter submits from inside the field, the same chord every other
              // multi-line composer in this app uses — a bare Enter has to stay a newline.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            className="resize-y text-[13px]"
          />
          <div className="flex items-center justify-between gap-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onQuickAdd}
              disabled={submitting}
            >
              <PanelTopOpen className="size-3.5" />
              Quick add…
            </Button>
            <span className="text-muted-foreground text-[11px]">
              <kbd className="border-border bg-secondary rounded border px-1 py-0.5 font-mono text-[10px]">
                ⌘↵
              </kbd>{' '}
              to draft — nothing is created until you review it.
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            disabled={submitting || prompt.trim() === ''}
            onClick={() => void submit()}
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Starting…
              </>
            ) : (
              <>
                <Sparkles className="size-4" /> Draft task
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
