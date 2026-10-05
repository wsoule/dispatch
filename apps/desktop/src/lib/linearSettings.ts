import { describeValue, parseLinearExternal } from '@dispatch-foo/core/browser';
import type { StatusRoles } from '@dispatch-foo/core/browser';
import { ApiError } from '@dispatch/client';
import type {
  LinearIssueLink,
  LinearProgress,
  LinearStatus,
  LinearSyncSummary,
} from '@dispatch/client';

import { formatRelativeTimeFromIso } from './format';

/** Whether there is enough Linear config to actually run a sync: connected and a team chosen.
 *  Gates the enable toggle and the "Sync now" button. */
export function isLinearConfigured(status: LinearStatus | null): boolean {
  return (
    status !== null &&
    status.connected &&
    status.teamId !== null &&
    status.teamId.trim() !== ''
  );
}

/** The lifecycle roles in the order Settings lists them, with what each one
 *  makes Dispatch write. `landing` may be left unset. */
export const STATUS_ROLE_ROWS: readonly {
  key: keyof StatusRoles;
  title: string;
  subtitle: string;
}[] = [
  {
    key: 'ready',
    title: 'Ready',
    subtitle: 'Where a discarded run hands its task back.',
  },
  {
    key: 'dispatched',
    title: 'Run starts',
    subtitle: 'Written when a run is dispatched.',
  },
  {
    key: 'review',
    title: 'Run finishes',
    subtitle: 'Written when a run has work to review.',
  },
  {
    key: 'landing',
    title: 'Merge queue',
    subtitle: 'Written when work enters the merge queue, if at all.',
  },
  { key: 'landed', title: 'Landed', subtitle: 'Written when work merges.' },
  {
    key: 'dropped',
    title: 'Dropped',
    subtitle: 'Written when work is abandoned.',
  },
];

/** One line on how Linear's changes reach this project. */
export function describeLinearDelivery(status: LinearStatus): string {
  const hook = status.webhook;
  if (hook === undefined)
    return `Polling every ${String(status.intervalSec)}s.`;
  const every = `every ${String(hook.pollSec)}s`;
  switch (hook.state) {
    case 'active': {
      const last =
        hook.lastDeliveryAt === null
          ? ''
          : `, last ${formatRelativeTimeFromIso(hook.lastDeliveryAt)}`;
      return `Live: Linear delivers changes as they happen${last}. Polling ${every} as a safety net.`;
    }
    case 'error':
      return `Polling ${every}: registering a webhook failed (${hook.error ?? 'unknown error'}).`;
    case 'polling':
      return hook.url === null
        ? `Polling ${every}. Give the daemon a public HTTPS origin (--public-origin) to get changes live.`
        : `Polling ${every}.`;
    default:
      return 'Sync is off.';
  }
}

const PROGRESS_PHASE: Record<LinearProgress['phase'], string> = {
  containers: 'Reading projects',
  issues: 'Fetching issues',
  applying: 'Writing tasks',
};

/** Where an import has got to: "Fetching issues… 1,200", or "… of 2,000". */
export function formatLinearProgress(progress: LinearProgress): string {
  const done = progress.done.toLocaleString('en-US');
  const phase = PROGRESS_PHASE[progress.phase];
  return progress.total === null
    ? `${phase}… ${done}`
    : `${phase}… ${done} of ${progress.total.toLocaleString('en-US')}`;
}

/** A short line of what one sync pass did, every zero-valued count omitted — "Nothing changed"
 *  for a no-op pass. Errors/rate-limit are the caller's own concern, not folded in here. */
export function formatSyncCounts(summary: LinearSyncSummary): string {
  const parts: string[] = [];
  if (summary.pulled > 0) parts.push(`${summary.pulled} pulled`);
  if (summary.pushed > 0) parts.push(`${summary.pushed} pushed`);
  if (summary.created > 0) parts.push(`${summary.created} created locally`);
  if (summary.createdIssues > 0) {
    parts.push(`${summary.createdIssues} created in Linear`);
  }
  if (summary.conflicts > 0) {
    parts.push(`${summary.conflicts} conflict(s) resolved`);
  }
  return parts.length === 0 ? 'Nothing changed' : parts.join(' · ');
}

/** What a finished "Push to Linear" should report, or null when an issue really went up. A
 *  clean summary that pushed nothing means the push was skipped (pull-only, rate limited). */
export function pushToLinearError(summary: LinearSyncSummary): string | null {
  if (summary.errors.length > 0) return summary.errors[0];
  if (summary.pushed + summary.createdIssues === 0) {
    return 'Nothing was pushed. Check the Linear sync direction in Settings.';
  }
  return null;
}

/** A task's Linear display link, resolved from its `external` field (an issue's `linear:<uuid>`,
 *  or a project's or initiative's) against the links map — null when unlinked, or when linked
 *  but the map has no entry yet. */
export function resolveLinearLink(
  external: string | null,
  links: Record<string, LinearIssueLink>
): LinearIssueLink | null {
  const ref = parseLinearExternal(external);
  return ref === null ? null : (links[ref.id] ?? null);
}

/** The paragraph shown above the API key input, explaining which key is in play. Returns null
 *  when the project has its own key and the input is hidden entirely. */
export function linearKeySourceNote(
  keySource: LinearStatus['keySource']
): string | null {
  switch (keySource) {
    case 'project':
      return null;
    case 'env':
      return 'Using LINEAR_API_KEY from your environment. Connect a key here to override it, or unset it and restart Dispatch.';
    case 'global':
      return 'Using your shared default key. Connect a key here to use a different Linear workspace for this project.';
    default:
      return 'Paste a Linear API key to connect. It is saved once and never shown again.';
  }
}

/** Turns a failed teams/states fetch into something worth showing. A 401 means the stored key
 *  was rejected, which otherwise looks identical to having no key at all. */
export function describeFetchFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : describeValue(error);
  // Key on ApiError's numeric status, never the message: the message is the server's prose
  // (`body.error`) and carries no status digits, as ApiError's own `code` doc comment warns.
  const status = error instanceof ApiError ? error.status : null;
  if (status === 401) {
    return 'Linear rejected this key. Reconnect with a new one.';
  }
  if (status === 409) {
    return 'No Linear API key is configured.';
  }
  return `Couldn’t reach Linear: ${message}`;
}
