import { createContext, useCallback, useContext, useMemo } from 'react';

import { describeError } from '../../lib/actionFeedback';
import { formatIssueLink, formatTaskLink } from '../../lib/deepLink';
import { isTauri, openUrl } from '../../lib/tauri';
import { useToasts } from './Toasts';

/** What a surface with a `Copy link` verb needs — the task page, the row
 * menu, the command palette — provided by `App` from `useCopyTaskLink`. */
export interface DeepLinkActions {
  /** Copies the active project's link for `taskId` and toasts the outcome. */
  copyTaskLink(taskId: string): void;
  /** The hosted planner only: opens the task linked to a Linear issue in the
   * desktop app, through `dispatch://issue/<identifier>`. */
  openIssueInDesktop?: (identifier: string) => void;
  /** The desktop app only: opens or copies a hosted planner link
   * (`formatWebIssueLink`) for a task linked to a Linear issue. */
  openWebLink?: (url: string) => void;
  copyWebLink?: (url: string) => void;
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

type WebLinkActions = Pick<
  DeepLinkActions,
  'openIssueInDesktop' | 'openWebLink' | 'copyWebLink'
>;

/**
 * The verbs that cross between the hosted planner and the desktop app for a
 * Linear-linked task. Each side only gets the ones pointing at the other: the
 * hosted page opens the desktop app, the desktop app opens or copies the web
 * link. Task ids differ between the two stores, so both carry the Linear
 * identifier, the key they share.
 */
export function useWebLinkActions(hosted: boolean): WebLinkActions {
  const toasts = useToasts();
  return useMemo(() => {
    if (hosted) {
      return {
        openIssueInDesktop: (identifier: string) =>
          window.location.assign(formatIssueLink(identifier)),
      };
    }
    return {
      openWebLink: (url: string) => {
        if (isTauri()) {
          openUrl(url).catch((err: unknown) =>
            toasts.push({
              title: 'Could not open the link',
              description: describeError(err),
              tone: 'error',
            })
          );
        } else window.open(url, '_blank', 'noopener');
      },
      copyWebLink: (url: string) => {
        void navigator.clipboard
          .writeText(url)
          .then(() =>
            toasts.push({ title: 'Copied web link', tone: 'success' })
          )
          .catch((err: unknown) =>
            toasts.push({
              title: 'Copy failed',
              description: describeError(err),
              tone: 'error',
            })
          );
      },
    };
  }, [hosted, toasts]);
}
