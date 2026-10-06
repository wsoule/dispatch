import type { ApiClient, WorkspaceFile } from '@dispatch/client';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { LinkedImage, MarkdownLink } from '../runs/LinkedImage';

// A file a run wrote never loads an image on its own, not even a loopback one.
const PREVIEW_COMPONENTS: Components = {
  img: ({ src, alt }) => (
    <LinkedImage src={typeof src === 'string' ? src : undefined} alt={alt} />
  ),
  a: ({ href, children }) => (
    <MarkdownLink href={href}>{children}</MarkdownLink>
  ),
};

/**
 * What to show for a file the editor cannot hold as text — and the rendered
 * view of one it can.
 *
 * Markdown gets the same renderer the rest of the app uses, so a README reads
 * as a document rather than as source. Images, PDFs, audio and video are
 * served straight from the daemon's raw route; anything else binary says so
 * plainly instead of rendering as mojibake.
 */

interface FilePreviewProps {
  client: ApiClient;
  file: WorkspaceFile;
  runId: string | null;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilePreview({ client, file, runId }: FilePreviewProps) {
  const src = client.workspaceFileUrl(file.path, { runId });

  if (file.kind === 'text') {
    return (
      <div className="prose prose-sm dark:prose-invert h-full max-w-none overflow-auto p-4">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={PREVIEW_COMPONENTS}
        >
          {file.text ?? ''}
        </ReactMarkdown>
      </div>
    );
  }

  if (file.preview === 'image') {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-[var(--color-muted)] p-4">
        {/* Object-contain rather than a fixed size: a screenshot and an icon
            both have to be legible without the pane scrolling in two axes. */}
        <img
          src={src}
          alt={file.path}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }

  if (file.preview === 'pdf') {
    return (
      <iframe src={src} title={file.path} className="h-full w-full border-0" />
    );
  }

  if (file.preview === 'video') {
    return (
      <div className="flex h-full items-center justify-center bg-black p-4">
        {/* No caption track: these are arbitrary media files out of the
            user's own checkout, with no subtitle source to point at. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video src={src} controls className="max-h-full max-w-full" />
      </div>
    );
  }

  if (file.preview === 'audio') {
    return (
      <div className="flex h-full items-center justify-center p-4">
        {/* Same as the video case above: nothing to caption from. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio src={src} controls />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-xs text-[var(--color-muted-foreground)]">
      <p>
        {file.kind === 'too-large'
          ? `Too large to open in the editor (${formatBytes(file.size)}).`
          : `Binary file (${formatBytes(file.size)}, ${file.mime}).`}
      </p>
      <a href={src} download className="underline">
        Download
      </a>
    </div>
  );
}
