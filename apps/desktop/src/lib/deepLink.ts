// The `dispatch://` link format and its browser-harness twin, plus the hosted
// planner's web link for a Linear issue. Pure: no React, no Tauri —
// `hooks/useDeepLinks.ts` delivers the URLs, `useDeepLinkRouter` acts on the
// parsed shape, and `DeepLinkContext` formats them.

import { parseLinearExternal } from '@dispatch-foo/core/browser';
import type { LinearIssueLink } from '@dispatch/client';

/** The URL scheme the bundled app registers (`plugins.deep-link` in
 * tauri.conf.json writes it into the .app's `CFBundleURLTypes`). */
export const DEEP_LINK_SCHEME = 'dispatch';

// Hand-copied from packages/core/src/ids.ts's TASK_ID_PATTERN: core's `ids.ts`
// imports `node:crypto` and is not re-exported from `@dispatch-foo/core/browser`,
// so the desktop cannot import `isTaskId`. Kept byte-identical so a link never
// accepts an id the store would refuse.
const TASK_ID_PATTERN = /^[te]-[0-9a-f]{6,12}$/;
// Core's `generateRunId` shape: 6 hex characters, 12 on a synced board.
const RUN_ID_PATTERN = /^r-[0-9a-f]{6,12}$/;
// A Linear issue identifier: the team key (a letter, then letters or digits)
// and the issue number. Uppercase only, as Linear writes it.
const ISSUE_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}$/;

/** Where the hosted planner (apps/web) serves a Linear workspace. */
const WEB_APP_ORIGIN = 'https://app.dispatch.foo';

export interface TaskLink {
  taskId: string;
  /** The project's absolute git root — the link switches the window to it. */
  project: string;
}

/**
 * Formats a task link for one of the two places the UI runs. `'app'` is the
 * `dispatch://task/<id>?project=<root>` form the bundled app opens; `'browser'`
 * is the browser-dev harness's own URL with `task=<id>` set — `root`/`port`
 * ride along so the link lands on the same daemon, but neither daemon token
 * rides on a pasted link: `token` (the agent tier) nor `appToken` (the decide
 * tier the overseer harness carries).
 */
export function formatTaskLink(
  link: TaskLink,
  target: 'app' | 'browser',
  browserLocation: string = window.location.href
): string {
  if (target === 'app') {
    return `${DEEP_LINK_SCHEME}://task/${link.taskId}?project=${encodeURIComponent(link.project)}`;
  }
  const url = new URL(browserLocation);
  url.searchParams.set('task', link.taskId);
  url.searchParams.delete('token');
  url.searchParams.delete('appToken');
  return url.toString();
}

/** Every link the router acts on. Task and run links name the project they
 * live in; an issue link does not, since each project keeps its own task ids
 * and only the Linear identifier is shared, so it resolves in the open one. */
export type DeepLink =
  | ({ kind: 'task' } & TaskLink)
  | { kind: 'run'; runId: string; project: string }
  | { kind: 'issue'; identifier: string };

/** Whether `value` has a Linear issue identifier's shape (`ABC-123`). */
function isIssueIdentifier(value: string): boolean {
  return ISSUE_IDENTIFIER_PATTERN.test(value);
}

/** `dispatch://issue/<IDENTIFIER>`: opens the task linked to that Linear
 * issue in whichever project the app has open. */
export function formatIssueLink(identifier: string): string {
  return `${DEEP_LINK_SCHEME}://issue/${identifier}`;
}

// A link's `project` param as an absolute root without a trailing slash (a
// hand-edited or shell-completed path), so it compares equal to the active
// project's root instead of re-keying the daemon on a second spelling of it.
function projectParam(parsed: URL): string | null {
  const raw = parsed.searchParams.get('project');
  if (raw === null || !raw.startsWith('/')) return null;
  return raw.replace(/\/+$/, '') || '/';
}

/**
 * Parses a `dispatch://` link, or `null` for anything else: another scheme,
 * an unknown host, an id or identifier of the wrong shape, or a task or run
 * link with a missing or relative `project`. WHATWG parses
 * `dispatch://task/<id>` with `task` as the host and `/<id>` as the path.
 */
export function parseDeepLink(url: string): DeepLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  if (!parsed.pathname.startsWith('/')) return null;
  const tail = parsed.pathname.slice(1);
  switch (parsed.hostname) {
    case 'task': {
      const project = projectParam(parsed);
      if (!TASK_ID_PATTERN.test(tail) || project === null) return null;
      return { kind: 'task', taskId: tail, project };
    }
    case 'run': {
      const project = projectParam(parsed);
      if (!RUN_ID_PATTERN.test(tail) || project === null) return null;
      return { kind: 'run', runId: tail, project };
    }
    case 'issue':
      return isIssueIdentifier(tail)
        ? { kind: 'issue', identifier: tail }
        : null;
    default:
      return null;
  }
}

/** The fields of a task an issue link is resolved against. */
interface LinkableTask {
  meta: { id: string; external?: string | null; archivedAt?: string };
}

/**
 * The id of the task in `tasks` linked to the Linear issue `identifier`, or
 * null when none is. `links` is the daemon's `GET /api/linear/links` (issue
 * id to identifier); a task names its issue by id in `meta.external`. A live
 * task wins over an archived one linked to the same issue.
 */
export function resolveIssueTask(
  identifier: string,
  links: Readonly<Record<string, LinearIssueLink>>,
  tasks: readonly LinkableTask[]
): string | null {
  const issueIds = new Set(
    Object.entries(links)
      .filter(([, link]) => link.identifier === identifier)
      .map(([id]) => id)
  );
  if (issueIds.size === 0) return null;
  const linked = tasks.filter((task) => {
    const ref = parseLinearExternal(task.meta.external);
    return ref?.entity === 'issue' && issueIds.has(ref.id);
  });
  const live = linked.find((task) => task.meta.archivedAt === undefined);
  return (live ?? linked[0])?.meta.id ?? null;
}

/**
 * The hosted planner's link for a Linear issue,
 * `https://app.dispatch.foo/w/<urlKey>/?issue=<IDENTIFIER>`, or null when the
 * issue's own URL does not name its workspace. Linear's issue URLs are
 * `https://linear.app/<urlKey>/issue/<IDENTIFIER>/<slug>`, so the workspace
 * comes from the link itself and needs no extra lookup.
 */
export function formatWebIssueLink(link: LinearIssueLink): string | null {
  if (!isIssueIdentifier(link.identifier)) return null;
  let parsed: URL;
  try {
    parsed = new URL(link.url);
  } catch {
    return null;
  }
  const [urlKey, kind] = parsed.pathname.split('/').slice(1);
  if (
    parsed.hostname !== 'linear.app' ||
    kind !== 'issue' ||
    urlKey === undefined ||
    !/^[a-z0-9][a-z0-9-]*$/i.test(urlKey)
  ) {
    return null;
  }
  const url = new URL(`/w/${urlKey}/`, WEB_APP_ORIGIN);
  url.searchParams.set('issue', link.identifier);
  return url.toString();
}
