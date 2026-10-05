import { ATTACHMENT_MAX_BYTES } from '@dispatch-foo/core/browser';
import type { TaskAttachment } from '@dispatch-foo/core/browser';

import { formatBytes } from './formatBytes';

// Pure helpers behind the task page's attachments row and the create dialog's
// pending files: what a paste or drop carried, what is too large to send, and
// how a chip labels an attachment.

/** The files a paste (`clipboardData`) or drop (`dataTransfer`) carried; empty
 * for a text paste so the fields keep their normal paste behaviour. */
export function filesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (dt === null) return [];
  const fromItems: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file !== null) fromItems.push(file);
  }
  if (fromItems.length > 0) return fromItems;
  return Array.from(dt.files ?? []);
}

/** Splits files against the daemon's size cap so the oversized ones get one
 * toast instead of a 413 each. */
export function splitOversized(files: File[]): {
  accepted: File[];
  rejected: File[];
} {
  const accepted: File[] = [];
  const rejected: File[] = [];
  for (const file of files) {
    (file.size > ATTACHMENT_MAX_BYTES ? rejected : accepted).push(file);
  }
  return { accepted, rejected };
}

/** `spec.png · 48 KB` — the chip text. */
export function attachmentLabel(attachment: TaskAttachment): string {
  return `${attachment.name} · ${formatBytes(attachment.size)}`;
}

/** Where the blob sits on the daemon's machine, for `openPath` in Tauri. */
export function absoluteAttachmentPath(
  rootDir: string,
  attachment: TaskAttachment
): string {
  const root = rootDir.endsWith('/') ? rootDir.slice(0, -1) : rootDir;
  return `${root}/${attachment.path}`;
}
