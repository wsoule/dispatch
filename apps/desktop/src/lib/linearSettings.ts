import { describeValue, parseLinearExternal } from '@dispatch-foo/core/browser';
import type { StatusRoles } from '@dispatch-foo/core/browser';
import { ApiError } from '@dispatch/client';
import type {
  LinearBulkAction,
  LinearBulkOutcome,
  LinearCapacity,
  LinearCapacityState,
  LinearCoverage,
  LinearExportPreview,
  LinearExportScope,
  LinearIssueLink,
  LinearProgress,
  LinearStatus,
  LinearSyncSummary,
  LinearUnlinkedReason,
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
  creating: 'Creating issues',
  archiving: 'Archiving issues',
};

/** Where a long pass has got to: "Fetching issues… 1,200", or "… of 2,000". */
export function formatLinearProgress(progress: LinearProgress): string {
  const done = count(progress.done);
  const phase = PROGRESS_PHASE[progress.phase];
  return progress.total === null
    ? `${phase}… ${done}`
    : `${phase}… ${done} of ${count(progress.total)}`;
}

/** The live progress when it belongs to `action`, else null, so each row shows
 *  only its own pass. A daemon predating `action` only reports imports. */
export function progressFor(
  progress: LinearProgress | null | undefined,
  action: 'import' | LinearBulkAction
): LinearProgress | null {
  if (progress === null || progress === undefined) return null;
  return (progress.action ?? 'import') === action ? progress : null;
}

function count(n: number): string {
  return n.toLocaleString('en-US');
}

const BULK_VERB: Record<LinearBulkAction, string> = {
  export: 'Exported',
  retry: 'Sent',
  archive: 'Archived',
};

/** One line on how the last export, retry or archive ended, or null before
 *  the first: "Exported 47 of 47 · 12 archived on arrival". */
export function describeBulkOutcome(
  outcome: LinearBulkOutcome | null | undefined
): string | null {
  if (outcome === null || outcome === undefined) return null;
  const { done, candidates, remaining, halted } = outcome;
  const tally = `${count(done)} of ${count(candidates)}`;
  // A stopped export or retry leaves the rest queued; an archive does not.
  const rest =
    outcome.action === 'archive'
      ? 'archive again for the rest'
      : 'the rest retry on their own';
  let line =
    halted === 'usage-limit'
      ? `Stopped after ${tally} at the issue limit`
      : halted === 'rate-limit'
        ? `Stopped after ${tally}: Linear rate-limited the run; ${rest}`
        : `${BULK_VERB[outcome.action]} ${tally}`;
  if (halted === null && remaining > 0) line += ` · ${count(remaining)} left`;
  const arrived = outcome.archivedOnArrival ?? 0;
  if (arrived > 0) line += ` · ${count(arrived)} archived on arrival`;
  return line;
}

/** How many tasks an export of `scope` sends. */
export function exportScopeCount(
  preview: LinearExportPreview,
  scope: LinearExportScope
): number {
  if (scope === 'open') return preview.open;
  return scope === 'all' ? preview.all : preview.allArchiveFinished;
}

/** How many issues an export of `scope` leaves active in Linear: finished
 *  tasks arrive archived under 'all-archive-finished'. */
export function exportActiveCount(
  preview: LinearExportPreview,
  scope: LinearExportScope
): number {
  return scope === 'all' ? preview.all : preview.open;
}

const PLAN_NAME: Record<LinearCapacity['plan'], string | null> = {
  free: 'the Free plan',
  paid: 'a paid plan',
  trial: 'a trial',
  unknown: null,
};

/** Active issues against the plan's cap: "188 of 250 active issues on the
 *  Free plan · HYD 120 · OPS 68". Null before anything was measured. */
export function describeCapacity(
  capacity: LinearCapacity | null
): string | null {
  if (capacity === null || capacity.active === null) return null;
  const plan = PLAN_NAME[capacity.plan];
  const scope = capacity.activeScope === 'workspace' ? ' in the workspace' : '';
  let line =
    capacity.limit === null
      ? `${count(capacity.active)} active issues${scope}`
      : `${count(capacity.active)} of ${count(capacity.limit)} active issues${scope}`;
  if (plan !== null) line += ` on ${plan}`;
  if (capacity.limit === null && capacity.plan === 'paid') {
    line += ', with no issue limit';
  }
  if (capacity.teams.length > 1) {
    line += capacity.teams
      .map((t) => ` · ${t.key} ${count(t.active)}`)
      .join('');
  }
  return line;
}

/** How many closed issues an archive would take from the linked teams. */
export function archivableCount(
  capacity: LinearCapacity,
  includeCanceled: boolean
): number {
  return capacity.teams.reduce(
    (n, t) => n + t.completed + (includeCanceled ? t.canceled : 0),
    0
  );
}

/** Whether ordinary passes are holding new issues back after the usage limit. */
export function capacityPaused(
  capacity: LinearCapacityState | null | undefined,
  now = Date.now()
): boolean {
  const retryAt = capacity?.retryAt ?? null;
  return retryAt !== null && now < Date.parse(retryAt);
}

/** "in 25m" or "in 2h": how long until a future timestamp. */
export function formatUntil(iso: string, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((Date.parse(iso) - now) / 60_000));
  return minutes < 60
    ? `in ${String(minutes)}m`
    : `in ${String(Math.round(minutes / 60))}h`;
}

/** A coverage reason as a badge reads. */
export const UNLINKED_REASON_LABEL: Record<LinearUnlinkedReason, string> = {
  failed: 'Failed',
  'at-capacity': 'Issue limit',
  queued: 'Queued',
  'moved-out': 'Left team',
  'pull-only': 'Pull only',
  'held-back': 'Held back',
  pending: 'Next sync',
};

const UNLINKED_REASON_COUNT: Record<LinearUnlinkedReason, string> = {
  failed: 'failed',
  'at-capacity': 'over the issue limit',
  queued: 'queued to send',
  'moved-out': 'left the linked teams',
  'pull-only': 'stay here (pull only)',
  'held-back': 'held back',
  pending: 'waiting for the next sync',
};

/** Why the unlinked tasks are unlinked, every empty reason omitted:
 *  "12 failed · 47 held back". */
export function describeUnlinkedCounts(
  counts: LinearCoverage['counts']
): string {
  const parts = (Object.keys(UNLINKED_REASON_COUNT) as LinearUnlinkedReason[])
    .filter((reason) => counts[reason] > 0)
    .map(
      (reason) => `${count(counts[reason])} ${UNLINKED_REASON_COUNT[reason]}`
    );
  return parts.length === 0 ? 'Every task is in Linear.' : parts.join(' · ');
}

/** Whether a reason means a create is waiting to be retried. */
export function isRetryable(reason: LinearUnlinkedReason): boolean {
  return reason === 'failed' || reason === 'at-capacity' || reason === 'queued';
}

/** The tasks whose create failed or waits in the retry queue. */
export function retryableTaskIds(coverage: LinearCoverage): string[] {
  return coverage.unlinked
    .filter((t) => isRetryable(t.reason))
    .map((t) => t.id);
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
  const archived = summary.archivedIssues ?? 0;
  if (archived > 0) parts.push(`${archived} archived in Linear`);
  const queued = summary.queued ?? 0;
  if (queued > 0) parts.push(`${queued} waiting to retry`);
  return parts.length === 0 ? 'Nothing changed' : parts.join(' · ');
}

/** The pass that moved tasks onto the linked team's workflow says so, or null:
 *  linking adopts the team's states, which otherwise changes statuses silently. */
export function describeMigrated(
  summary: LinearSyncSummary,
  teamName: string | null
): string | null {
  const moved = summary.migrated ?? 0;
  if (moved === 0) return null;
  const team = teamName === null ? 'the team’s' : `${teamName}’s`;
  return `Moved ${count(moved)} task${moved === 1 ? '' : 's'} onto ${team} workflow.`;
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
