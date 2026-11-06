import { useCallback, useEffect, useState } from 'react';

// A loopback host (with an optional port), which a bare entry opens over http.
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(:\d+)?$/i;

/**
 * Turns what was typed in the browser pane's address field into a URL to
 * frame, or null when it is not an http(s) address. A bare port opens on
 * localhost, a loopback host over http, and any other bare host over https.
 */
export function normalizeBrowserUrl(input: string): string | null {
  const text = input.trim();
  if (text === '' || /\s/.test(text)) return null;
  let candidate: string;
  if (/^\d{2,5}$/.test(text)) candidate = `http://localhost:${text}`;
  else if (/^:\d{2,5}(\/.*)?$/.test(text))
    candidate = `http://localhost${text}`;
  else if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) candidate = text;
  else {
    const host = text.split(/[/?#]/, 1)[0];
    if (LOOPBACK.test(host)) candidate = `http://${text}`;
    else if (host.includes('.')) candidate = `https://${text}`;
    else return null;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href;
}

/**
 * Why `url` may not be framed, or null when it may. The pane frames pages
 * with their own origin's rights, so it refuses the two origins whose rights
 * matter: the app itself (a frame there could reach the app's IPC) and the
 * daemon (its `/` carries the agent token).
 */
export function browserRefusal(
  url: string,
  origins: { app: string; daemon: string | null | undefined }
): string | null {
  const origin = originOf(url);
  if (origin === null) return 'That is not a web address.';
  if (origin === originOf(origins.app)) {
    return 'The pane does not open Dispatch itself.';
  }
  if (origin === originOf(origins.daemon)) {
    return "The pane does not open the Dispatch daemon's own address.";
  }
  return null;
}

// A URL's origin, or null for a missing or unparsable one.
function originOf(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const storageKey = (projectPath: string | null) =>
  `dispatch:browser-url:${projectPath ?? ''}`;

// Reads the last address a project's pane opened, re-checked as an http(s)
// URL before it can reach a frame; storage may be unavailable.
function readStoredUrl(projectPath: string | null): string | null {
  try {
    const stored = window.localStorage.getItem(storageKey(projectPath));
    return stored === null ? null : normalizeBrowserUrl(stored);
  } catch {
    return null;
  }
}

/**
 * The Overseer's browser pane state: whether it is open and the page it shows.
 * The page is remembered per project, so reopening the pane returns to the
 * dev server it last showed.
 */
export function useBrowserPane(projectPath: string | null) {
  const [open, setOpen] = useState(false);
  const [url, setUrlState] = useState<string | null>(() =>
    readStoredUrl(projectPath)
  );
  useEffect(() => {
    setUrlState(readStoredUrl(projectPath));
  }, [projectPath]);
  const setUrl = useCallback(
    (next: string) => {
      setUrlState(next);
      try {
        window.localStorage.setItem(storageKey(projectPath), next);
      } catch {
        // Unpersisted is fine: the pane still shows the page.
      }
    },
    [projectPath]
  );
  const openAt = useCallback(
    (next: string) => {
      setUrl(next);
      setOpen(true);
    },
    [setUrl]
  );
  return {
    open,
    url,
    setUrl,
    openAt,
    toggle: () => setOpen((o) => !o),
    close: () => setOpen(false),
  };
}
