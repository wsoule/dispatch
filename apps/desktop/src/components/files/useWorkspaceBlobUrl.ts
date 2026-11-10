import type { ApiClient } from '@dispatch/client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { whenDisconnected } from '../../lib/whenDisconnected';

/**
 * A workspace file's bytes as a URL an `img`, `iframe`, `video` or `audio`
 * element can load.
 *
 * The daemon's raw route needs the bearer header like every other route, and
 * an element `src` cannot send one: on the loopback page the daemon serves
 * and in the desktop webview (cross-origin to the daemon) a plain `src` gets a
 * 401. So the bytes are read through the client, re-typed to what the preview
 * expects, and handed to the element as a URL of their own.
 *
 * That URL is a `blob:` object URL, except for an SVG. A blob URL belongs to
 * the page's origin and carries none of the raw route's headers, its
 * `default-src 'none'` CSP included, so an SVG opened from one as a page
 * (Open image in new tab, a drag to the tab bar) would run its scripts
 * against the daemon with this page's origin. An SVG gets a `data:` URL
 * instead, whose document has an opaque origin and which browsers refuse to
 * open as a top-level page from script.
 *
 * The URL lives as long as the file is shown: it is revoked when the file
 * changes or the preview unmounts, and kept while a hidden Activity hides
 * the preview (Settings or the Overseer over the Files page), so showing it
 * again neither reads the file again nor restarts a video or a PDF.
 */

/** The file to read, or null when nothing should be fetched. `version`
 *  (the file's mtime and size) refetches a file that changed on disk, and
 *  anything else equal never fetches twice. `type` is the MIME type the blob
 *  is given, whatever the response said. */
export interface BlobRequest {
  path: string;
  runId: string | null;
  version: string;
  type: string;
}

type BlobUrlState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; message: string };

export interface BlobUrl {
  state: BlobUrlState;
  /** Marks the current file failed: the element could not decode the bytes
   *  (a truncated image, a codec the webview lacks), so the preview shows
   *  the error line instead of a broken-image icon. */
  fail: (message: string) => void;
  /** Put on the element the preview renders (any of its states): a cleanup
   *  that finds it still in the document is a hide, not an unmount. */
  anchor: (element: Element | null) => void;
}

/** Types whose file is a document that can run script when opened as a
 *  page; they get a `data:` URL, never a same-origin `blob:` one. */
const SCRIPTABLE_TYPES: ReadonlySet<string> = new Set(['image/svg+xml']);

// One string per distinct read: a re-render with an equal request (a new
// WorkspaceFile object for the same file) keys the same and fetches nothing.
function requestKey(request: BlobRequest): string {
  return JSON.stringify([
    request.path,
    request.runId,
    request.version,
    request.type,
  ]);
}

// The words the error line shows: the daemon's own message when it sent one
// ("no such file"), else a plain fallback.
function describeFailure(err: unknown): string {
  return err instanceof Error && err.message !== ''
    ? err.message
    : 'The daemon did not send the file.';
}

// The bytes as a `data:` URL, for a type that must not get a blob URL.
function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // readAsDataURL settles with a string; anything else is a failed read.
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('The file could not be read.'));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsDataURL(blob);
  });
}

// The URL an element loads for `blob`, typed `type` whatever the response
// said: a frame gets application/pdf, so the bytes can never be read as an
// HTML document in the app's origin.
async function urlFor(blob: Blob, type: string): Promise<string> {
  const typed = blob.type === type ? blob : new Blob([blob], { type });
  return SCRIPTABLE_TYPES.has(type)
    ? readAsDataUrl(typed)
    : URL.createObjectURL(typed);
}

// Lets go of a URL this hook made; a data: URL holds nothing to revoke.
function release(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url);
}

export function useWorkspaceBlobUrl(
  client: Pick<ApiClient, 'fetchWorkspaceBlob'>,
  request: BlobRequest | null
): BlobUrl {
  const key = request === null ? null : requestKey(request);
  // What settled, and for which read: a new file never shows the old one's
  // image or error while its own bytes are on the way.
  const [settled, setSettled] = useState<{
    key: string;
    state: BlobUrlState;
  } | null>(null);
  // The URL made for the file on show, kept across a hide; the element the
  // preview last rendered (refs are detached while hidden, so a null is
  // ignored); and the watch a hide starts for the preview leaving for good.
  const held = useRef<{ key: string; url: string } | null>(null);
  const element = useRef<Element | null>(null);
  const stopWatch = useRef<(() => void) | null>(null);

  const path = request?.path;
  const runId = request?.runId ?? null;
  const type = request?.type;
  useEffect(() => {
    stopWatch.current?.();
    stopWatch.current = null;
    // Revokes the held URL now (a new file, or the preview is gone).
    const releaseHeld = () => {
      if (held.current === null) return;
      release(held.current.url);
      held.current = null;
    };
    // The cleanup: an element still in the document means a hide, so the
    // URL stays for the next show unless the hidden preview is removed;
    // otherwise the preview unmounted and the URL goes now.
    const keepOrRelease = () => {
      const shown = element.current;
      if (shown !== null && shown.isConnected) {
        stopWatch.current = whenDisconnected(shown, releaseHeld);
      } else {
        releaseHeld();
      }
    };
    // Shown again (or StrictMode's rehearsal) with the same file: the URL
    // still holds its bytes and settled still names it.
    if (held.current !== null && held.current.key === key) {
      return keepOrRelease;
    }
    releaseHeld();
    if (key === null || path === undefined || type === undefined) return;
    const controller = new AbortController();
    client
      .fetchWorkspaceBlob(path, { runId, signal: controller.signal })
      // A read that lands after the file changed makes no URL at all; one
      // whose data: URL finishes after that is dropped.
      .then((blob) => (controller.signal.aborted ? null : urlFor(blob, type)))
      .then(
        (url) => {
          if (url === null) return;
          if (controller.signal.aborted) {
            release(url);
            return;
          }
          held.current = { key, url };
          setSettled({ key, state: { status: 'ready', url } });
        },
        (err: unknown) => {
          if (controller.signal.aborted) return;
          setSettled({
            key,
            state: { status: 'error', message: describeFailure(err) },
          });
        }
      );
    return () => {
      controller.abort();
      keepOrRelease();
    };
    // `key` covers path, runId, version and type.
  }, [client, key, path, runId, type]);

  const fail = useCallback(
    (message: string) => {
      if (key !== null)
        setSettled({ key, state: { status: 'error', message } });
    },
    [key]
  );

  const anchor = useCallback((next: Element | null) => {
    if (next !== null) element.current = next;
  }, []);

  if (key === null) return { state: { status: 'idle' }, fail, anchor };
  const state =
    settled !== null && settled.key === key
      ? settled.state
      : { status: 'loading' as const };
  return { state, fail, anchor };
}
