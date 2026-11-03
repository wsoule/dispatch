import type { WorkspaceFile } from '@dispatch/client';
import {
  Button,
  Chip,
  EmptyState,
  KbdKeys,
  Notice,
  useModKeyLabel,
} from '@dispatch/ui';
import { Eye, FileCode2, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { FilePreview } from '../components/files/FilePreview';
import { FileTree } from '../components/files/FileTree';
import { QuickOpenDialog } from '../components/files/QuickOpenDialog';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { PageHead } from '../components/shell/PageHead';
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
import styles from './FilesView.module.css';

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
  /** Starts the header with the back chip to the Tasks list. */
  onBack?: () => void;
  /** Opens with this file selected, e.g. from a file link in a thread. */
  initialPath?: string;
  /** Whether quick open (Go to file) shows, when the host controls it: App's
   * project Files page and the Tasks page's run Files tab, where ⌘P is a
   * global command (`quickOpen` in lib/appNav.ts). Read only together with
   * `onQuickOpenChange`. */
  quickOpen?: boolean;
  /** Called with the quick open's new state (the Go to file button opens
   * it; a pick, Escape or the scrim closes it). Given, the host controls
   * quick open; omitted (the run's Files embedded in the Overseer's column),
   * the view keeps it in local state. */
  onQuickOpenChange?: (open: boolean) => void;
}

// The head's save state in words: nothing before a text file is open.
function statusLabel(buffer: EditorBuffer | null): string {
  if (buffer === null) return '';
  if (buffer.status === 'saving') return 'Saving…';
  if (buffer.status === 'dirty') return 'Unsaved';
  if (buffer.status === 'error') return buffer.error ?? 'Save failed';
  return 'Saved';
}

// A shortcut as one string for a title attribute: "⌘P" on a Mac, "Ctrl+P"
// elsewhere (the modifier label comes from useModKeyLabel).
function shortcutTitle(mod: string, key: string): string {
  return mod === '⌘' ? `${mod}${key}` : `${mod}+${key}`;
}

export function FilesView({
  data,
  runId = null,
  onBack,
  initialPath,
  quickOpen,
  onQuickOpenChange,
}: FilesViewProps) {
  const { client } = data;
  const mod = useModKeyLabel();
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [buffer, setBuffer] = useState<EditorBuffer | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [localQuickOpen, setLocalQuickOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The save loop reads the latest buffer without re-arming its timer on every
  // keystroke, which is what makes the debounce a debounce.
  const bufferRef = useRef<EditorBuffer | null>(null);
  bufferRef.current = buffer;
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Controlled by the host when it passes onQuickOpenChange, local otherwise.
  const quickOpenShown =
    onQuickOpenChange === undefined ? localQuickOpen : quickOpen === true;
  const setQuickOpen = (open: boolean): void => {
    if (onQuickOpenChange === undefined) setLocalQuickOpen(open);
    else onQuickOpenChange(open);
  };

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

  // Opens `initialPath` once a client is up; a later reconnect never yanks the
  // selection back from wherever the user has moved on to.
  const openedInitial = useRef(false);
  useEffect(() => {
    if (initialPath === undefined || client === null || openedInitial.current) {
      return;
    }
    openedInitial.current = true;
    void open(initialPath);
  }, [initialPath, client, open]);

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

  // Quick open cannot show while the daemon is down (the page is
  // DaemonUnavailable then), so an open state is dropped rather than left
  // unseen, taking the next Escape and popping up when the client is back.
  useEffect(() => {
    if (client !== null || !quickOpenShown) return;
    if (onQuickOpenChange === undefined) setLocalQuickOpen(false);
    else onQuickOpenChange(false);
  }, [client, quickOpenShown, onQuickOpenChange]);

  // When quick open closes with focus nowhere (⌘P from another page unmounted
  // whatever had it, so the dialog's own focus return found nothing), focus
  // lands on the page: the editor when a text file is open, else Go to file.
  const wasQuickOpen = useRef(false);
  useEffect(() => {
    const closed = wasQuickOpen.current && !quickOpenShown;
    wasQuickOpen.current = quickOpenShown;
    if (!closed) return;
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body) return;
    const target =
      textRef.current ??
      rootRef.current?.querySelector<HTMLElement>('[data-files-go-to-file]');
    target?.focus();
  }, [quickOpenShown]);

  if (client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  // The Preview toggle is for a text file that also renders as something
  // else: Markdown (the daemon marks every text file's `preview` "none", so
  // the mime decides). A file with no text always shows its preview, so a
  // toggle there would only report a state it cannot change.
  const canPreview =
    file !== null &&
    file.kind === 'text' &&
    (file.preview !== 'none' || file.mime === 'text/markdown');

  return (
    <div ref={rootRef} className={styles.view}>
      <div className={styles.head}>
        <PageHead
          onBack={onBack}
          title="Files"
          // Inside the task page the task's title is the h1.
          titleLevel={runId === null ? 1 : 2}
          meta={
            <>
              {runId === null ? null : (
                <Chip>
                  run <span className={styles.mono}>{runId.slice(0, 8)}</span>
                </Chip>
              )}{' '}
              {selected === null ? (
                'No file open'
              ) : (
                <span className={styles.mono}>{selected}</span>
              )}
            </>
          }
          receipts={
            buffer === null ? undefined : buffer.status === 'error' ? (
              <span className="toneText" data-tone="danger" role="alert">
                {statusLabel(buffer)}
              </span>
            ) : (
              statusLabel(buffer)
            )
          }
          actions={
            <>
              <Button
                variant="quiet"
                size="sm"
                aria-label="Go to file"
                data-files-go-to-file=""
                title={`Go to file (${shortcutTitle(mod, 'P')})`}
                icon={<Search size={14} strokeWidth={1.8} aria-hidden />}
                onClick={() => setQuickOpen(true)}
              />
              {canPreview ? (
                <Button
                  variant="quiet"
                  size="sm"
                  aria-label="Preview"
                  aria-pressed={previewing}
                  icon={<Eye size={14} strokeWidth={1.8} aria-hidden />}
                  onClick={() => setPreviewing((value) => !value)}
                />
              ) : null}
            </>
          }
        />
      </div>

      <div className={styles.body}>
        <aside className={styles.aside} aria-label="File tree">
          <FileTree
            client={client}
            runId={runId}
            selectedPath={selected}
            onSelect={(path) => void open(path)}
          />
        </aside>

        <div className={styles.editor}>
          {loadError !== null && (
            <div className={styles.notice}>
              <Notice tone="danger" role="alert" label="Could not open">
                {loadError}
              </Notice>
            </div>
          )}
          {file === null && loadError === null && (
            <div className={styles.empty}>
              <EmptyState
                label="Pick a file"
                icon={<FileCode2 size={22} strokeWidth={1.8} />}
              >
                or press <KbdKeys keys={[mod, 'P']} />
              </EmptyState>
            </div>
          )}
          {file !== null &&
            (previewing || buffer === null ? (
              <div className={styles.preview}>
                <FilePreview client={client} file={file} runId={runId} />
              </div>
            ) : (
              /* A textarea rather than a code editor component: it is the one
                 control that gets native undo, IME input, spellcheck-off and
                 accessibility for free, and the surrounding autosave is where
                 the actual behaviour lives. */
              <textarea
                ref={textRef}
                value={buffer.text}
                spellCheck={false}
                onChange={(event) =>
                  setBuffer((prev) =>
                    prev === null ? prev : editBuffer(prev, event.target.value)
                  )
                }
                className={styles.text}
                aria-label={`Editing ${file.path}`}
              />
            ))}
        </div>
      </div>

      {quickOpenShown ? (
        <QuickOpenDialog
          client={client}
          runId={runId}
          onClose={() => setQuickOpen(false)}
          onPick={(path) => void open(path)}
        />
      ) : null}
    </div>
  );
}
