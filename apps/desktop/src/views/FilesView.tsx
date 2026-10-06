import type { WorkspaceFile } from '@dispatch/client';
import { Eye, FileCode2, Save, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { FilePreview } from '../components/files/FilePreview';
import { FileTree } from '../components/files/FileTree';
import { QuickOpenDialog } from '../components/files/QuickOpenDialog';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { BackToTasks } from '../components/tasks/BackToTasks';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { EditorBuffer } from '../lib/editorBuffer';
import {
  AUTOSAVE_DEBOUNCE_MS,
  beginSave,
  editBuffer,
  openBuffer,
  saveFailed,
  saveSucceeded,
  shouldSave,
} from '../lib/editorBuffer';
import { Button } from '@/ui/button';

/**
 * Browse a checkout, edit a file, preview what cannot be edited.
 *
 * Scoped to the project or to one run's worktree, which is the point of having
 * it inside Dispatch at all: reviewing what an agent did often means opening a
 * file it changed, in the worktree it changed it in, rather than the merged
 * result.
 */

interface FilesViewProps {
  data: DispatchProjectData;
  /** The run whose worktree to browse, or null for the project checkout. */
  runId?: string | null;
  /** Two views: starts the header with "‹ tasks"; Classic leaves it out. */
  onBack?: () => void;
}

function statusLabel(buffer: EditorBuffer | null): string {
  if (buffer === null) return '';
  if (buffer.status === 'saving') return 'Saving…';
  if (buffer.status === 'dirty') return 'Unsaved';
  if (buffer.status === 'error') return buffer.error ?? 'Save failed';
  return 'Saved';
}

export function FilesView({ data, runId = null, onBack }: FilesViewProps) {
  const { client } = data;
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [buffer, setBuffer] = useState<EditorBuffer | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The save loop reads the latest buffer without re-arming its timer on every
  // keystroke, which is what makes the debounce a debounce.
  const bufferRef = useRef<EditorBuffer | null>(null);
  bufferRef.current = buffer;

  const open = useCallback(
    async (path: string) => {
      if (client === null) return;
      setSelected(path);
      try {
        const loaded = await client.fetchWorkspaceFile(path, { runId });
        setFile(loaded);
        setBuffer(
          loaded.kind === 'text' ? openBuffer(path, loaded.text ?? '') : null
        );
        // A file with no text has nothing to edit, so it opens in the preview.
        setPreviewing(loaded.kind !== 'text');
        setLoadError(null);
      } catch (err) {
        setFile(null);
        setBuffer(null);
        setLoadError(
          err instanceof Error ? err.message : 'could not open the file'
        );
      }
    },
    [client, runId]
  );

  // Autosave: one timer, re-armed on every edit, that saves whatever the
  // buffer holds when it fires.
  useEffect(() => {
    if (client === null || buffer === null || !shouldSave(buffer)) return;
    const timer = setTimeout(() => {
      const current = bufferRef.current;
      if (current === null || !shouldSave(current)) return;
      const sending = beginSave(current);
      setBuffer(sending);
      void client
        .saveWorkspaceFile(sending.path, sending.inFlightText ?? sending.text, {
          runId,
        })
        .then(() => {
          setBuffer((prev) =>
            // Guard against the file having been switched mid-save: the reply
            // belongs to the buffer that sent it, not to whatever is open now.
            prev === null || prev.path !== sending.path
              ? prev
              : saveSucceeded(prev)
          );
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'save failed';
          setBuffer((prev) =>
            prev === null || prev.path !== sending.path
              ? prev
              : saveFailed(prev, message)
          );
        });
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [client, buffer, runId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  const canPreview =
    file !== null && (file.kind !== 'text' || file.preview !== 'none');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
        {onBack && <BackToTasks onBack={onBack} />}
        <FileCode2 className="size-4" />
        <h1 className="text-sm font-medium">Files</h1>
        {runId !== null && (
          <span className="rounded bg-[var(--color-muted)] px-1.5 py-0.5 text-[10px]">
            run {runId.slice(0, 8)}
          </span>
        )}
        <span className="truncate text-xs text-[var(--color-muted-foreground)]">
          {selected ?? 'no file open'}
        </span>
        <div className="flex-1" />
        {buffer !== null && (
          <span
            className={`text-xs ${
              buffer.status === 'error'
                ? 'text-[var(--color-destructive)]'
                : 'text-[var(--color-muted-foreground)]'
            }`}
          >
            {statusLabel(buffer)}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setQuickOpen(true)}
          title="⌘P"
        >
          <Search className="size-3" />
        </Button>
        {canPreview && (
          <Button
            size="sm"
            variant={previewing ? 'default' : 'ghost'}
            onClick={() => setPreviewing((value) => !value)}
            title="Toggle preview"
          >
            <Eye className="size-3" />
          </Button>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 border-r border-[var(--color-border)]">
          <FileTree
            client={client}
            runId={runId}
            selectedPath={selected}
            onSelect={(path) => void open(path)}
          />
        </aside>

        <main className="min-w-0 flex-1">
          {loadError !== null && (
            <p className="p-3 text-xs text-[var(--color-destructive)]">
              {loadError}
            </p>
          )}
          {file === null && loadError === null && (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-[var(--color-muted-foreground)]">
              <Save className="size-4 opacity-50" />
              <p>Pick a file, or press ⌘P.</p>
            </div>
          )}
          {file !== null &&
            (previewing || buffer === null ? (
              <FilePreview client={client} file={file} runId={runId} />
            ) : (
              /* A textarea rather than a code editor component: it is the one
                 control that gets native undo, IME input, spellcheck-off and
                 accessibility for free, and the surrounding autosave is where
                 the actual behaviour lives. */
              <textarea
                value={buffer.text}
                spellCheck={false}
                onChange={(event) =>
                  setBuffer((prev) =>
                    prev === null ? prev : editBuffer(prev, event.target.value)
                  )
                }
                className="h-full w-full resize-none border-0 bg-[var(--color-card)] p-3 font-mono text-xs leading-relaxed outline-none"
                aria-label={`Editing ${file.path}`}
              />
            ))}
        </main>
      </div>

      <QuickOpenDialog
        client={client}
        runId={runId}
        open={quickOpen}
        onOpenChange={setQuickOpen}
        onPick={(path) => void open(path)}
      />
    </div>
  );
}
