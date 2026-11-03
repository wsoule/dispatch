import type { ApiClient, WorkspaceFile } from '@dispatch/client';
import { Notice, SkeletonBlock } from '@dispatch/ui';
import { type MouseEvent, useState } from 'react';

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
 * plainly instead of rendering as mojibake, with a Download link that reads
 * the bytes the same way.
 */

type ClientForPreview = Pick<
  ApiClient,
  'fetchWorkspaceBlob' | 'workspaceFileUrl'
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
 * loopback page, the desktop app) a click reads the bytes through the client,
 * since the raw route 401s a bare navigation there, and saves them; the whole
 * file is held in memory meanwhile, and the sentence beside the link gives its
 * size. On a team-local page the session cookie authenticates a navigation, so
 * the link's own `href` (the raw route) is left to the browser, which streams
 * the file to disk at any size. One read at a time: a second click while one
 * is in flight does nothing.
 */
function DownloadLink({ client, file, runId }: FilePreviewProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (isTeamLocalPage()) return;
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    client.fetchWorkspaceBlob(file.path, { runId }).then(
      (blob) => {
        saveBlob(blob, baseName(file.path));
        setBusy(false);
      },
      (err: unknown) => {
        setError(
          err instanceof Error && err.message !== ''
            ? err.message
            : 'The daemon did not send the file.'
        );
        setBusy(false);
      }
    );
  };

  return (
    <>
      <a
        href={client.workspaceFileUrl(file.path, { runId })}
        download={baseName(file.path)}
        className={styles.download}
        aria-busy={busy || undefined}
        onClick={download}
      >
        {busy ? 'Downloading…' : 'Download'}
      </a>
      {error === null ? null : (
        <p className="toneText" data-tone="danger" role="alert">
          {`Download failed: ${error}`}
        </p>
      )}
    </>
  );
}
