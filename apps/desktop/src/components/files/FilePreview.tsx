import type { ApiClient, WorkspaceFile } from '@dispatch/client';

import { Markdown } from '../runs/Markdown';
import styles from './FilePreview.module.css';

/**
 * What to show for a file the editor cannot hold as text — and the rendered
 * view of one it can.
 *
 * Markdown gets the same renderer the rest of the app uses (runs/Markdown,
 * whose images are links: a file a run wrote never loads an image on its
 * own, not even a loopback one), so a README reads as a document rather than
 * as source. Images, PDFs, audio and video are served straight from the
 * daemon's raw route; anything else binary says so plainly instead of
 * rendering as mojibake.
 */

interface FilePreviewProps {
  client: ApiClient;
  file: WorkspaceFile;
  runId: string | null;
}

// A size in the unit a person reads at a glance: bytes, KB or MB.
function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilePreview({ client, file, runId }: FilePreviewProps) {
  const src = client.workspaceFileUrl(file.path, { runId });

  if (file.kind === 'text') {
    return (
      <div className={styles.text}>
        <Markdown content={file.text ?? ''} variant="prose" />
      </div>
    );
  }

  if (file.preview === 'image') {
    return (
      <div className={styles.stage}>
        <img src={src} alt={file.path} className={styles.media} />
      </div>
    );
  }

  if (file.preview === 'pdf') {
    return <iframe src={src} title={file.path} className={styles.frame} />;
  }

  if (file.preview === 'video') {
    return (
      <div className={styles.stage}>
        {/* No caption track: these are arbitrary media files out of the
            user's own checkout, with no subtitle source to point at. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video src={src} controls className={styles.media} />
      </div>
    );
  }

  if (file.preview === 'audio') {
    return (
      <div className={styles.stage}>
        {/* Same as the video case above: nothing to caption from. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio src={src} controls />
      </div>
    );
  }

  return (
    <div className={styles.plain}>
      <p>
        {file.kind === 'too-large'
          ? `Too large to open in the editor (${formatBytes(file.size)}).`
          : `Binary file (${formatBytes(file.size)}, ${file.mime}).`}
      </p>
      <a href={src} download className={styles.download}>
        Download
      </a>
    </div>
  );
}
