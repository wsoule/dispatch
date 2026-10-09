import { createContext, useCallback, useContext } from 'react';

import { describeError } from '../../lib/actionFeedback';
import { formatTaskLink } from '../../lib/deepLink';
import { isTauri } from '../../lib/tauri';
import { useToasts } from './Toasts';

/** What a surface with a `Copy link` verb needs — the task page, the row
 * menu, the command palette — provided by `App` from `useCopyTaskLink`. */
export interface DeepLinkActions {
  /** Copies the active project's link for `taskId` and toasts the outcome. */
  copyTaskLink(taskId: string): void;
}

const DeepLinkContext = createContext<DeepLinkActions | null>(null);

export const DeepLinkProvider = DeepLinkContext.Provider;

/** `null` outside the provider — the Tasks
 * page also renders in the browser-dev harness and in view tests that never
 * mount App's providers, and a consumer simply shows no `Copy link` then. */
export function useDeepLinkActions(): DeepLinkActions | null {
  return useContext(DeepLinkContext);
}

/**
 * The callback App hands `DeepLinkProvider`. Formats the link for where the
 * UI runs (`dispatch://` in the app, the harness URL with `?task=` in a
 * browser) and writes it to the clipboard. Best-effort like `copyTaskId`: a
 * denied permission is a toast, never a silent nothing; so is a link asked
 * for before a project is active.
 */
export function useCopyTaskLink(
  projectRoot: string | null,
  // Which link form to write; the app's `dispatch://` or the harness's `?task=`. Read
  // once per call from the window, so a test can name the surface without touching it.
  surface: () => 'app' | 'browser' = () => (isTauri() ? 'app' : 'browser')
): (taskId: string) => void {
  const toasts = useToasts();
  return useCallback(
    (taskId: string) => {
      if (projectRoot === null) {
        toasts.push({
          title: 'Copy failed',
          description: 'No project is open',
          tone: 'error',
        });
        return;
      }
      const link = formatTaskLink({ taskId, project: projectRoot }, surface());
      void navigator.clipboard
        .writeText(link)
        .then(() => toasts.push({ title: 'Copied link', tone: 'success' }))
        .catch((err: unknown) =>
          toasts.push({
            title: 'Copy failed',
            description: describeError(err),
            tone: 'error',
          })
        );
    },
    [projectRoot, surface, toasts]
  );
}
