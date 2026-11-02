import type { TaskAttachment } from '@dispatch-foo/core/browser';
import type { ApiClient } from '@dispatch/client';
import { Button, Chip, Spinner } from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import type { RefObject } from 'react';
import { useCallback, useRef, useState } from 'react';

import { describeError } from '../../../lib/actionFeedback';
import {
  absoluteAttachmentPath,
  attachmentLabel,
  splitOversized,
} from '../../../lib/attachments';
import { isTauri, openPath } from '../../../lib/tauri';
import { useToasts } from '../../shell/Toasts';
import styles from './pageBlocks.module.css';

/**
 * The upload half of the row, held by its host (the page rail, the drawer): splits off
 * files over the daemon's cap (one toast naming them) and sends the rest one request
 * each, so a failure names its file and the others still land. No manual refetch — the
 * daemon's `task.changed` broadcast refreshes the doc.
 */
export function useAttachmentUpload(
  client: ApiClient | null,
  taskId: string
): { upload: (files: File[]) => Promise<void>; uploading: boolean } {
  const toasts = useToasts();
  const [uploading, setUploading] = useState(false);
  const upload = useCallback(
    async (files: File[]) => {
      const { accepted, rejected } = splitOversized(files);
      if (rejected.length > 0) {
        toasts.push({
          title: 'File too large',
          description: `${rejected.map((f) => f.name).join(', ')} — the limit is 25 MB`,
          tone: 'error',
        });
      }
      if (accepted.length === 0 || client === null) return;
      setUploading(true);
      try {
        for (const file of accepted) {
          try {
            await client.uploadTaskAttachments(taskId, [file]);
          } catch (err) {
            toasts.push({
              title: `Could not attach ${file.name}`,
              description: describeError(err),
              tone: 'error',
            });
          }
        }
      } finally {
        setUploading(false);
      }
    },
    [client, taskId, toasts]
  );
  return { upload, uploading };
}

export interface AttachmentsRowProps {
  taskId: string;
  attachments: TaskAttachment[];
  client: ApiClient | null;
  /** The daemon port, namespacing the health query the open action reads `rootDir` from. */
  port: number | undefined;
  /** False on an archived task: the chips still open, but nothing can be added or removed. */
  editable: boolean;
  /** The host's `useAttachmentUpload`, so its `uploading` flag outlives the row. */
  upload: (files: File[]) => Promise<void>;
  uploading: boolean;
  /** Exposes the hidden file input so another control (the comment composer's paperclip)
   * can open the same picker. */
  inputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * The icon row under the description (linear-reference §8): one chip per attachment
 * — a paperclip glyph and `name · size` that open the file, and an `×` — plus the Attach
 * button over a hidden multi-file input, and a spinner with `Uploading…` while a send is
 * in flight. A chip opens
 * the file: in Tauri through the daemon machine's path once a HEAD confirms the blob
 * is there (`open` would otherwise resolve on a missing file), in a browser through
 * a blob URL. Either way a missing blob (a teammate's frontmatter without the bytes)
 * is a toast.
 */
export function AttachmentsRow({
  taskId,
  attachments,
  client,
  port,
  editable,
  upload,
  uploading,
  inputRef,
}: AttachmentsRowProps) {
  const toasts = useToasts();
  const ownInputRef = useRef<HTMLInputElement | null>(null);
  const fileInput = inputRef ?? ownInputRef;
  const health = useQuery({
    queryKey: ['dispatch-health', port],
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchHealth();
    },
    enabled: client !== null && isTauri(),
  });

  function toastMissing(attachment: TaskAttachment) {
    toasts.push({
      title: 'Attachment not on this machine',
      description: attachment.name,
      tone: 'error',
    });
  }

  async function open(attachment: TaskAttachment) {
    if (client === null) return;
    if (isTauri() && health.data !== undefined) {
      try {
        if (!(await client.hasTaskAttachment(taskId, attachment.name))) {
          toastMissing(attachment);
          return;
        }
        await openPath(absoluteAttachmentPath(health.data.rootDir, attachment));
      } catch (err) {
        toasts.push({
          title: 'Open failed',
          description: describeError(err),
          tone: 'error',
        });
      }
      return;
    }
    // The tab opens inside the click's user activation; a `window.open` after
    // the fetch would be a blocked popup in WebKit.
    const tab = window.open('', '_blank');
    try {
      const blob = await client.fetchTaskAttachment(taskId, attachment.name);
      const url = URL.createObjectURL(blob);
      if (tab === null) window.open(url, '_blank');
      else tab.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      tab?.close();
      if ((err as { status?: unknown }).status === 404) {
        toastMissing(attachment);
        return;
      }
      toasts.push({
        title: 'Open failed',
        description: describeError(err),
        tone: 'error',
      });
    }
  }

  async function remove(attachment: TaskAttachment) {
    if (client === null) return;
    try {
      await client.removeTaskAttachment(taskId, attachment.name);
    } catch (err) {
      toasts.push({
        title: 'Remove failed',
        description: describeError(err),
        tone: 'error',
      });
    }
  }

  const canAttach = editable && client !== null;
  if (!canAttach && attachments.length === 0) return null;

  return (
    <div data-slot="attachments-row" className={styles.chipRow}>
      {attachments.map((attachment) => (
        // The chip stays a span: its words are a button that opens the file, and the
        // × (only while the task is editable) is the chip's own remove button.
        <Chip
          key={attachment.name}
          data-slot="attachment-chip"
          onRemove={canAttach ? () => void remove(attachment) : undefined}
          removeLabel={`Remove ${attachment.name}`}
        >
          <button
            type="button"
            className={styles.chipOpen}
            title={attachment.name}
            onClick={() => void open(attachment)}
          >
            <Paperclip size={12} strokeWidth={1.8} aria-hidden />
            <span className={styles.chipOpenText}>
              {attachmentLabel(attachment)}
            </span>
          </button>
        </Chip>
      ))}
      {canAttach && (
        <>
          <Button
            size="sm"
            variant="quiet"
            aria-label="Attach"
            title="Attach"
            disabled={uploading}
            icon={<Paperclip size={14} strokeWidth={1.8} aria-hidden />}
            onClick={() => fileInput.current?.click()}
          />
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              const files = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = '';
              if (files.length > 0) void upload(files);
            }}
          />
        </>
      )}
      {uploading && (
        <span data-slot="attachments-uploading" className={styles.uploading}>
          <Spinner size="xs" label="" />
          Uploading…
        </span>
      )}
    </div>
  );
}
