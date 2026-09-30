import type { DraftRecord } from '@dispatch/client';
import { Layers, PanelTopOpen, Sparkles, X } from 'lucide-react';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { DaemonUnavailable } from '../shell/DaemonUnavailable';
import {
  type CreateTaskPreset,
  useShellActions,
} from '../shell/ShellActionsContext';
import { Pill } from '@/ui/ai/pill';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogBody,
  DialogChrome,
  DialogContent,
  DialogFooter,
} from '@/ui/dialog';
import { Kbd } from '@/ui/kbd';
import { Spinner } from '@/ui/spinner';
import { Textarea } from '@/ui/textarea';

interface AiTaskComposerProps {
  data: DispatchProjectData;
  /** The crumb's project chip (`[project] › New task`); the app name until a project is open. */
  projectName?: string;
  /** The unwrapped start call — rejects on failure (unlike `data.handleStartDraft`) so the
   * composer can keep the typed prompt on screen with an inline error instead of losing it.
   * `parent` is the container a group's "+" opened the composer in. */
  onStartDraft: (
    prompt: string,
    options?: { parent?: string | null }
  ) => Promise<DraftRecord>;
  /** Opens `CreateTaskModal` instead — the structured quick-add fallback for when you already
   * know the exact fields and don't want to spend an agent round-trip describing them.
   * `preset` is the creator's preset with the parent this dialog holds now. */
  onQuickAdd: (preset: CreateTaskPreset) => void;
  onClose: () => void;
}

/** Describe-what-you-want task starter on the new-issue dialog's grammar (§9): the same
 * ~1024px sheet near the top, a borderless 15px prompt, and a single primary `Draft task`.
 * Submitting starts a background draft and closes right away — the drafts tray picks up its
 * progress, and review/save happens later from there. */
export function AiTaskComposer({
  data,
  projectName = 'Dispatch',
  onStartDraft,
  onQuickAdd,
  onClose,
}: AiTaskComposerProps) {
  const { createPreset } = useShellActions();
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A milestone's (or any container's) "+" drafts the task inside it.
  const [parent, setParent] = useState<string | null>(
    createPreset?.epic ?? null
  );
  const parentTitle =
    parent === null
      ? null
      : (data.epics.find((e) => e.meta.id === parent)?.meta.title ?? parent);

  // The launch preset with this dialog's parent, so a dropped chip stays dropped.
  function quickAddPreset(): CreateTaskPreset {
    const next: CreateTaskPreset = { ...createPreset };
    if (parent === null) delete next.epic;
    else next.epic = parent;
    return next;
  }

  async function submit() {
    if (prompt.trim() === '' || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onStartDraft(
        prompt.trim(),
        parent === null ? undefined : { parent }
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const daemonDown = data.portLoading || data.portError || data.client === null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-label="New task"
        showCloseButton={false}
        className="top-[12%] w-[min(1024px,92vw)] max-w-none translate-y-0 sm:max-w-none"
      >
        <DialogChrome>
          <Pill>{projectName}</Pill>
          <span aria-hidden>›</span>
          <span className="text-(--text-secondary)">New task</span>
        </DialogChrome>

        {daemonDown ? (
          <DialogBody className="pb-4">
            <DaemonUnavailable
              starting={data.portLoading}
              errorDetail={data.portErrorDetail}
              onRetry={data.retryEnsureDispatchd}
            />
          </DialogBody>
        ) : (
          <>
            <DialogBody className="gap-3 pt-1 pb-4">
              <Textarea
                variant="borderless"
                autoFocus
                placeholder="What should change, and how you'll know it's done…"
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
                className="min-h-[120px] text-[15px] leading-6"
              />
              {parentTitle !== null && (
                <div className="flex items-center gap-1.5">
                  <Pill data-slot="draft-parent">
                    <Layers />
                    <span className="max-w-[320px] truncate">
                      In {parentTitle}
                    </span>
                    <button
                      type="button"
                      aria-label={`Not in ${parentTitle}`}
                      onClick={() => setParent(null)}
                      className="text-muted-foreground hover:text-foreground -mr-1 flex size-3.5 items-center justify-center"
                    >
                      <X className="size-2.5" />
                    </button>
                  </Pill>
                </div>
              )}
              {error !== null && (
                <p role="alert" className="text-red text-[12px]">
                  {error}
                </p>
              )}
              <p className="font-book text-muted-foreground flex items-center gap-1.5 text-[12px]">
                <Kbd>⌘⏎</Kbd>
                to draft — nothing is created until you review it.
              </p>
            </DialogBody>

            <DialogFooter
              className="shadow-hairline-top"
              leading={
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onQuickAdd(quickAddPreset())}
                  disabled={submitting}
                >
                  <PanelTopOpen />
                  Quick add…
                </Button>
              }
            >
              <Button
                disabled={submitting || prompt.trim() === ''}
                onClick={() => void submit()}
              >
                {submitting ? (
                  <>
                    <Spinner className="size-3.5" /> Starting…
                  </>
                ) : (
                  <>
                    <Sparkles /> Draft task
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
