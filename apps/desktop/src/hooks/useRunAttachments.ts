import type { RunAttachment } from '@dispatch/client';
import { useCallback, useEffect, useRef, useState } from 'react';

/** A file uploaded for a run's next follow-up, with a local preview when it is
 *  an image (an object URL of the dropped file itself, so no fetch back). */
export interface PendingRunAttachment {
  attachment: RunAttachment;
  previewUrl?: string;
}

/**
 * The files waiting on a run composer's next send. Each drop, paste or pick
 * uploads right away, so Send only ever waits on the message; the composer
 * then lists the answered paths in the body (withRunAttachmentNote) and calls
 * `clear`. Without `upload` (a window that cannot attach) `attach` does
 * nothing. An upload failure goes to `onError`, the composer's error line.
 */
export function useRunAttachments(
  upload: ((files: File[]) => Promise<RunAttachment[]>) | undefined,
  onError: (message: string | null) => void
) {
  const [pending, setPending] = useState<PendingRunAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  // Every preview URL still alive, so unmounting frees what was never sent.
  const previews = useRef(new Set<string>());

  useEffect(() => {
    const live = previews.current;
    return () => {
      for (const url of live) URL.revokeObjectURL(url);
      live.clear();
    };
  }, []);

  // The list as last rendered, so remove and clear can free previews outside
  // a state updater (which StrictMode runs twice).
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const release = useCallback((items: readonly PendingRunAttachment[]) => {
    for (const item of items) {
      if (item.previewUrl === undefined) continue;
      URL.revokeObjectURL(item.previewUrl);
      previews.current.delete(item.previewUrl);
    }
  }, []);

  const attach = useCallback(
    async (files: File[]) => {
      if (upload === undefined || files.length === 0) return;
      setAttaching(true);
      onError(null);
      try {
        const uploaded = await upload(files);
        // The daemon answers one entry per file, in the order they were sent.
        const added = uploaded.map((attachment, i) => {
          const file = files[i];
          if (file === undefined || !file.type.startsWith('image/')) {
            return { attachment };
          }
          const previewUrl = URL.createObjectURL(file);
          previews.current.add(previewUrl);
          return { attachment, previewUrl };
        });
        setPending((current) => [...current, ...added]);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setAttaching(false);
      }
    },
    [upload, onError]
  );

  const remove = useCallback(
    (path: string) => {
      release(pendingRef.current.filter((p) => p.attachment.path === path));
      setPending((current) =>
        current.filter((p) => p.attachment.path !== path)
      );
    },
    [release]
  );

  const clear = useCallback(() => {
    release(pendingRef.current);
    setPending([]);
  }, [release]);

  return { pending, attaching, attach, remove, clear };
}
