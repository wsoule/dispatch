import type { DraftRecord } from '@dispatch/client';
import { CircleAlert, PanelTopOpen, Sparkles } from 'lucide-react';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { DaemonUnavailable } from '../shell/DaemonUnavailable';
import { Alert } from '@/ui/alert';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Kbd } from '@/ui/kbd';
import { Spinner } from '@/ui/spinner';
import { Textarea } from '@/ui/textarea';

interface AiTaskComposerProps {
  data: DispatchProjectData;
  /** The unwrapped start call — rejects on failure (unlike `data.handleStartDraft`) so the
   * composer can keep the typed prompt on screen with an inline error instead of losing it. */
  onStartDraft: (prompt: string) => Promise<DraftRecord>;
  /** Opens `CreateTaskModal` instead — the structured quick-add fallback for when you already
   * know the exact fields and don't want to spend an agent round-trip describing them. */
  onQuickAdd: () => void;
  onClose: () => void;
}

/** Describe-what-you-want task starter: submitting starts a background draft and closes right
 * away — the drafts tray picks up its progress, and review/save happens later from there. */
export function AiTaskComposer({
  data,
  onStartDraft,
  onQuickAdd,
  onClose,
}: AiTaskComposerProps) {
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (prompt.trim() === '' || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onStartDraft(prompt.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
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

        {data.portLoading || data.portError || data.client === null ? (
          <DaemonUnavailable
            starting={data.portLoading}
            errorDetail={data.portErrorDetail}
            onRetry={data.retryEnsureDispatchd}
          />
        ) : (
          <>
            <div className="flex flex-col gap-3">
              {error !== null && (
                <Alert
                  variant="destructive"
                  className="border-destructive/30 bg-destructive/10 flex items-center gap-2 rounded-md px-3 py-2 text-[13px] has-[>svg]:gap-x-2 [&>svg]:translate-y-0"
                >
                  <CircleAlert className="size-4 shrink-0" />
                  <span>{error}</span>
                </Alert>
              )}
              <Textarea
                rows={5}
                autoFocus
                placeholder="Describe the task — what should change, and how you'll know it's done…"
                aria-label="Describe the task"
                value={prompt}
                disabled={submitting}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  // Cmd/Ctrl+Enter submits — a bare Enter has to stay a newline here.
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
                  <Kbd className="border-border bg-secondary h-auto rounded border py-0.5 font-mono text-[10px]">
                    ⌘↵
                  </Kbd>{' '}
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
                    <Spinner className="size-4" /> Starting…
                  </>
                ) : (
                  <>
                    <Sparkles className="size-4" /> Draft task
                  </>
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
