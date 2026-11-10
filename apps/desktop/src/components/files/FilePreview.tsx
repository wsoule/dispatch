import { type ApiClient, ApiError, type WorkspaceFile } from '@dispatch/client';
import { Button, Notice, SkeletonBlock } from '@dispatch/ui';
import { FolderOpen } from 'lucide-react';
import { type MouseEvent, useState, useSyncExternalStore } from 'react';

import { revealActionLabel } from '../../lib/savedFile';
import {
  downloadWorkspaceFile,
  isTauri,
  revealInFinder,
} from '../../lib/tauri';
import { isTeamLocalPage } from '../../lib/teamLocal';
import { Markdown } from '../runs/Markdown';
import styles from './FilePreview.module.css';
import { type BlobRequest, useWorkspaceBlobUrl } from './useWorkspaceBlobUrl';

/**
 * What to show for a file the editor cannot hold as text — and the rendered
 * view of one it can.
 *
 * Markdown gets the same renderer the rest of the app uses (runs/Markdown,
 * whose images are links: a file a run wrote never loads an image on its
 * own, not even a loopback one), so a README reads as a document rather than
 * as source. Images, PDFs, audio and video are read from the daemon's raw
 * route through the client, with its credential, and shown from a `blob:`
 * URL; an SVG, which is a document that can script, gets a `data:` URL
 * instead (useWorkspaceBlobUrl says why). Anything else binary says so
 * plainly instead of rendering as mojibake, with a Download link (below) that
 * leaves the bytes to the browser wherever it can.
 */

type ClientForPreview = Pick<
  ApiClient,
  'fetchWorkspaceBlob' | 'workspaceDownloadUrl' | 'workspaceFileUrl'
>;

interface FilePreviewProps {
  client: ClientForPreview;
  file: WorkspaceFile;
  runId: string | null;
}

/** Above this a media file is offered as a download instead of a preview:
 *  the preview holds the whole file in memory as a blob, and a multi-gigabyte
 *  video in the webview's memory is worse than one click to download it. */
export const PREVIEW_MAX_BYTES = 64 * 1024 * 1024;

type MediaKind = 'image' | 'pdf' | 'video' | 'audio';

/** How the pane shows a file: a media element fed by a blob of `type`, the
 *  Markdown renderer, or the plain sentence with a Download link. */
export type PreviewPlan =
  | { as: MediaKind; type: string }
  | { as: 'markdown' }
  | { as: 'plain'; reason: 'binary' | 'too-large' | 'too-large-to-preview' };

/**
 * Decides how the pane shows `file`. The daemon's `preview` wins over `kind`,
 * because an SVG is text (kind "text") that previews as an image. The blob
 * type is fixed per kind and never taken from an unexpected mime, so a frame
 * only ever holds a PDF and an element only ever the media it was made for.
 */
export function previewPlan(file: WorkspaceFile): PreviewPlan {
  if (file.preview !== 'none') {
    if (file.size > PREVIEW_MAX_BYTES) {
      return { as: 'plain', reason: 'too-large-to-preview' };
    }
    if (file.preview === 'pdf') return { as: 'pdf', type: 'application/pdf' };
    if (file.mime.startsWith(`${file.preview}/`)) {
      return { as: file.preview, type: file.mime };
    }
  }
  if (file.kind === 'text') return { as: 'markdown' };
  return {
    as: 'plain',
    reason: file.kind === 'too-large' ? 'too-large' : 'binary',
  };
}

// A size in the unit a person reads at a glance: bytes, KB or MB.
function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// The last path segment, as the saved file's name.
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

// Saves a blob under `name` through a throwaway link. The bytes are re-typed
// application/octet-stream first: the URL lives in the app's origin for a
// minute (so the browser has read it before it is revoked), and a webview
// that opens it instead of saving it must never render a downloaded .svg or
// .html as a document there.
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(
    new Blob([blob], { type: 'application/octet-stream' })
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Hands `url` to the browser's own download through a throwaway link. The
// daemon serves a ticket URL as an attachment, so the browser streams the file
// to disk and the page never holds it; `download` names it on the daemon's own
// origin, and Content-Disposition names it anywhere else.
function startDownload(url: string, name: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
}

// What a failed call has to say: an Error's message, or `fallback` when it
// carries none.
function failureReason(err: unknown, fallback: string): string {
  return err instanceof Error && err.message !== '' ? err.message : fallback;
}

// Whether a ticket call failed because the daemon has no ticket route at all:
// a daemon from before tickets answers its catch-all 404 ("not found: /api/…")
// or a 405. Every other refusal is about this file or this moment (404 "no such
// file", 400 outside the project, 401 or 403, a 5xx, a network error), and
// reading the whole file into the page would either fail the same way or hold
// a file of any size in the tab, which is what tickets exist to avoid.
function ticketRouteMissing(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.status === 405 ||
      (err.status === 404 && err.message !== 'no such file'))
  );
}

/** Where a desktop save of one file stands: going, saved at `path`, or
 *  refused for `reason`. */
type NativeSave =
  | { state: 'saving' }
  | { state: 'saved'; path: string }
  | { state: 'failed'; reason: string };

// The desktop app's saves, by [runId, path], kept outside the Download link.
// The backend goes on writing a file after its link unmounts (another file
// opened mid-download), so the outcome lives here: back on the file, the link
// says "Downloading…" or where it was saved instead of offering a second copy.
// One small entry per file saved this session, replaced by the next save.
const nativeSaves = new Map<string, NativeSave>();
const nativeSaveListeners = new Set<() => void>();

function setNativeSave(key: string, save: NativeSave): void {
  nativeSaves.set(key, save);
  for (const listener of nativeSaveListeners) listener();
}

function subscribeNativeSaves(listener: () => void): () => void {
  nativeSaveListeners.add(listener);
  return () => {
    nativeSaveListeners.delete(listener);
  };
}

// The save `key` names, re-rendering when it changes. Each entry is replaced,
// never mutated, so the snapshot is stable between changes.
function useNativeSave(key: string): NativeSave | undefined {
  return useSyncExternalStore(subscribeNativeSaves, () => nativeSaves.get(key));
}

// The desktop app's save: the backend reads the raw route with the daemon's
// own credential and writes the bytes to disk as they arrive, so the page
// never holds the file. It rejects with its reason as a plain string.
function startNativeSave(key: string, rawUrl: string): void {
  setNativeSave(key, { state: 'saving' });
  downloadWorkspaceFile(rawUrl).then(
    (path) => setNativeSave(key, { state: 'saved', path }),
    (err: unknown) =>
      setNativeSave(key, {
        state: 'failed',
        reason:
          typeof err === 'string' && err !== ''
            ? err
            : 'The file could not be saved.',
      })
  );
}

export function FilePreview({ client, file, runId }: FilePreviewProps) {
  const plan = previewPlan(file);
  const request: BlobRequest | null =
    plan.as === 'markdown' || plan.as === 'plain'
      ? null
      : {
          path: file.path,
          runId,
          version: `${file.modifiedAt}/${file.size}`,
          type: plan.type,
        };
  const { state, fail, anchor } = useWorkspaceBlobUrl(client, request);

  if (plan.as === 'markdown') {
    return (
      <div className={styles.text}>
        <Markdown content={file.text ?? ''} variant="prose" />
      </div>
    );
  }

  if (plan.as === 'plain') {
    return (
      <div className={styles.plain}>
        <p>
          {plan.reason === 'too-large'
            ? `Too large to open in the editor (${formatBytes(file.size)}).`
            : plan.reason === 'too-large-to-preview'
              ? `Too large to preview (${formatBytes(file.size)}).`
              : `Binary file (${formatBytes(file.size)}, ${file.mime}).`}
        </p>
        {/* One link per file: a busy read or a failure belongs to the
            file it was for, never to the next one opened. */}
        <DownloadLink
          key={JSON.stringify([runId, file.path])}
          client={client}
          file={file}
          runId={runId}
        />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div ref={anchor} className={styles.notice}>
        <Notice tone="danger" role="alert" label="Could not load the preview">
          {state.message}
        </Notice>
      </div>
    );
  }

  if (state.status !== 'ready') {
    return (
      <div ref={anchor} className={styles.loading}>
        <SkeletonBlock height={240} label={`Loading ${file.path}`} />
      </div>
    );
  }

  const src = state.url;
  if (plan.as === 'pdf') {
    return (
      <iframe
        ref={anchor}
        src={src}
        title={file.path}
        className={styles.frame}
      />
    );
  }

  return (
    <div ref={anchor} className={styles.stage}>
      {plan.as === 'image' ? (
        <img
          src={src}
          alt={file.path}
          className={styles.media}
          onError={() => fail('The image could not be decoded.')}
        />
      ) : plan.as === 'video' ? (
        /* No caption track: these are arbitrary media files out of the
           user's own checkout, with no subtitle source to point at. */
        /* eslint-disable-next-line jsx-a11y/media-has-caption */
        <video
          src={src}
          controls
          className={styles.media}
          onError={() => fail('This video format cannot play here.')}
        />
      ) : (
        /* Same as the video case above: nothing to caption from. */
        /* eslint-disable-next-line jsx-a11y/media-has-caption */
        <audio
          src={src}
          controls
          onError={() => fail('This audio format cannot play here.')}
        />
      )}
    </div>
  );
}

/**
 * The Download link for a file the pane cannot show. On a bearer page (the
 * loopback page in a browser) the raw route 401s a bare navigation, so a click
 * asks the daemon for a single-use ticket URL (`workspaceDownloadUrl`, minted
 * then, since a ticket dies after one use or a minute) and points a throwaway
 * `<a download>` at it: the browser streams the file to disk at any size. Only
 * a daemon from before tickets (no ticket route: `ticketRouteMissing`) gets
 * the old way, the bytes read through the client and saved from memory, and
 * when that fails too the error line gives both reasons; any other refusal is
 * shown as it is. On a team-local page the session cookie authenticates a
 * navigation, so the link's own `href` (the raw route) is left to the browser.
 * In the desktop app, where wry cancels an `<a download>`, the backend streams
 * the file into Downloads itself (`startNativeSave`), and a status line that
 * stays mounted says where it was saved, with an action that shows it in the
 * file manager (`revealActionLabel`: "Reveal in Finder" on macOS, "Show in
 * folder" elsewhere); that outcome outlives the link (`nativeSaves`). The app
 * only ever talks to the daemon it started or attached to on this computer
 * (http://127.0.0.1:<port>), the one address the backend's save accepts. One
 * download at a time: a second click while one is being set up does nothing.
 */
function DownloadLink({ client, file, runId }: FilePreviewProps) {
  const inApp = isTauri();
  const saveKey = JSON.stringify([runId, file.path]);
  const native = useNativeSave(saveKey);
  // The browser's save: its own state, since the browser's download UI takes
  // over once the link is clicked.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nativeSave = inApp ? native : undefined;
  const shownBusy = inApp ? nativeSave?.state === 'saving' : busy;
  const shownError = inApp
    ? nativeSave?.state === 'failed'
      ? nativeSave.reason
      : null
    : error;
  const savedTo = nativeSave?.state === 'saved' ? nativeSave.path : null;

  // The browser's save: a ticket URL the browser downloads natively, or, for
  // a daemon with no ticket route, the bytes read into the page and saved
  // from a blob.
  const saveInBrowser = (): void => {
    const name = baseName(file.path);
    client.workspaceDownloadUrl(file.path, { runId }).then(
      (url) => {
        startDownload(url, name);
        setBusy(false);
      },
      (ticketError: unknown) => {
        const ticket = failureReason(
          ticketError,
          'the daemon issued no download link'
        );
        if (!ticketRouteMissing(ticketError)) {
          setError(ticket);
          setBusy(false);
          return;
        }
        client.fetchWorkspaceBlob(file.path, { runId }).then(
          (blob) => {
            saveBlob(blob, name);
            setBusy(false);
          },
          (readError: unknown) => {
            const read = failureReason(
              readError,
              'the daemon did not send the file'
            );
            setError(
              `${ticket} (reading it into the page failed too: ${read})`
            );
            setBusy(false);
          }
        );
      }
    );
  };

  const download = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (isTeamLocalPage()) return;
    event.preventDefault();
    if (shownBusy) return;
    if (inApp) {
      startNativeSave(saveKey, client.workspaceFileUrl(file.path, { runId }));
      return;
    }
    setBusy(true);
    setError(null);
    saveInBrowser();
  };

  return (
    <>
      <a
        href={client.workspaceFileUrl(file.path, { runId })}
        download={baseName(file.path)}
        className={styles.download}
        aria-busy={shownBusy || undefined}
        onClick={download}
      >
        {shownBusy ? 'Downloading…' : 'Download'}
      </a>
      {shownError === null ? null : (
        <p className="toneText" data-tone="danger" role="alert">
          {`Download failed: ${shownError}`}
        </p>
      )}
      {/* Mounted, empty, before any save, so a screen reader announces the
          line when a save fills it (a live region inserted already filled
          is often not read out). */}
      {inApp ? (
        <p role="status" className={styles.saved}>
          {savedTo === null ? '' : `Saved to ${savedTo}`}
        </p>
      ) : null}
      {savedTo === null ? null : (
        <Button
          variant="quiet"
          size="sm"
          icon={<FolderOpen size={14} strokeWidth={1.8} aria-hidden />}
          onClick={() => {
            revealInFinder(savedTo).catch((err: unknown) => {
              console.error(`Failed to reveal ${savedTo}:`, err);
            });
          }}
        >
          {revealActionLabel()}
        </Button>
      )}
    </>
  );
}
