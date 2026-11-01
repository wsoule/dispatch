import type { Command } from 'commander';
import { randomUUID } from 'node:crypto';

import type {
  LinearApiClient,
  LinearBulkOutcome,
  LinearBulkStart,
  LinearCapacity,
  LinearCoverage,
  LinearExportPreview,
  LinearExportScope,
  LinearProgress,
  LinearStatus,
  LinearSyncSummary,
  LinearUnlinkedTask,
} from '../apiClient.js';
import { createLinearApiClient, DaemonUnreachableError } from '../apiClient.js';
import { type CliContext, CliError } from '../context.js';
import { formatTable } from '../output.js';
import { confirmNo } from '../prompt.js';
import {
  appTokenConnection,
  attachToRunningDaemon,
  optionalAppToken,
} from './appToken.js';

const TOKEN_HELP = 'the daemon app token (or DISPATCH_APP_TOKEN)';

// Mirrors the server's LINEAR_USAGE_LIMIT_MESSAGE.
const USAGE_LIMIT_MESSAGE =
  'Workspace is at its issue limit — archive closed issues or upgrade';

const STILL_RUNNING =
  'the Linear pass is still running in dispatchd; check it with: dispatch linear status';

const PROGRESS_PHASE: Partial<Record<string, string>> = {
  containers: 'Reading projects',
  issues: 'Fetching issues',
  applying: 'Writing tasks',
  creating: 'Creating in Linear',
  archiving: 'Archiving in Linear',
};

const DIRECTION_WORDS: Record<LinearStatus['direction'], string> = {
  both: 'both ways',
  pull: 'from Linear only',
  push: 'to Linear only',
};

const KEY_SOURCE_WORDS: Record<
  NonNullable<LinearStatus['keySource']>,
  string
> = {
  project: "this project's key",
  env: 'LINEAR_API_KEY',
  global: 'your shared default key',
};

const RUN_WORDS: Record<LinearBulkOutcome['action'], string> = {
  export: 'An export to Linear',
  retry: 'A retry of failed creates',
  archive: 'An archive of closed issues',
};

/** Where a long pass has got to: "Fetching issues… 1,200", or "… of 2,000". */
export function formatProgress(p: LinearProgress): string {
  const phase = PROGRESS_PHASE[p.phase] ?? p.phase;
  const done = p.done.toLocaleString('en-US');
  return p.total === null
    ? `${phase}… ${done}`
    : `${phase}… ${done} of ${p.total.toLocaleString('en-US')}`;
}

/** What one pass did, zero counts left out: "Nothing changed" for a no-op. */
function summaryCounts(summary: LinearSyncSummary): string {
  const parts: string[] = [];
  if (summary.pulled > 0) parts.push(`${summary.pulled} pulled`);
  if (summary.pushed > 0) parts.push(`${summary.pushed} pushed`);
  if (summary.created > 0) parts.push(`${summary.created} created locally`);
  if (summary.createdIssues > 0)
    parts.push(`${summary.createdIssues} created in Linear`);
  if ((summary.archivedIssues ?? 0) > 0)
    parts.push(`${summary.archivedIssues} archived in Linear`);
  if ((summary.migrated ?? 0) > 0)
    parts.push(`${summary.migrated} moved to a new status`);
  if (summary.conflicts > 0)
    parts.push(`${summary.conflicts} conflict(s) resolved`);
  return parts.length === 0 ? 'Nothing changed' : parts.join(' · ');
}

/** Repeated errors as one line each: 'usage limit exceeded (x44)'. */
function collapseErrors(errors: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const e of errors) counts.set(e, (counts.get(e) ?? 0) + 1);
  return [...counts].map(([e, n]) => (n > 1 ? `${e} (x${n})` : e));
}

/** A pass's counts, then why it fell short: the issue limit, a throttle,
 *  each distinct error once. */
export function describeLinearSummary(summary: LinearSyncSummary): string[] {
  const lines = [summaryCounts(summary)];
  if ((summary.queued ?? 0) > 0)
    lines.push(
      `${summary.queued} create(s) still queued; later passes retry them.`
    );
  if (summary.usageLimited === true)
    lines.push(
      "Linear's issue limit stopped new creates. Free room: dispatch linear archive-closed"
    );
  if (summary.rateLimited)
    lines.push('Rate limited by Linear; the next pass continues.');
  for (const e of collapseErrors(summary.errors)) lines.push(`Error: ${e}`);
  return lines;
}

// Why a pass counts as failed (exit 1), or null when it went through.
function summaryFailure(summary: LinearSyncSummary): string | null {
  if (summary.usageLimited === true) return USAGE_LIMIT_MESSAGE;
  return (
    summary.errors[0] ?? (summary.rateLimited ? 'rate limited by Linear' : null)
  );
}

// One line for a finished export, retry or archive.
function bulkHeadline(outcome: LinearBulkOutcome): string {
  if (outcome.action === 'archive')
    return `${outcome.done} of ${outcome.candidates} closed issues archived in Linear`;
  const arrived =
    (outcome.archivedOnArrival ?? 0) > 0
      ? `, ${outcome.archivedOnArrival} archived on arrival`
      : '';
  return `${outcome.done} of ${outcome.candidates} sent to Linear${arrived}`;
}

/** A finished export, retry or archive-closed run as a person reads it. */
export function describeBulkOutcome(outcome: LinearBulkOutcome): string[] {
  const lines = [`${bulkHeadline(outcome)}.`];
  if (outcome.remaining > 0)
    lines.push(
      outcome.action === 'archive'
        ? `${outcome.remaining} not archived.`
        : `${outcome.remaining} not sent yet; they stay queued and later passes retry them (dispatch linear coverage lists them).`
    );
  if (outcome.halted === 'usage-limit')
    lines.push(
      "Linear's issue limit stopped it. Free room: dispatch linear archive-closed, or upgrade the plan."
    );
  if (outcome.halted === 'rate-limit')
    lines.push('Rate limited by Linear; a later pass sends the rest.');
  for (const e of outcome.errors) lines.push(`Error: ${e}`);
  return lines;
}

function bulkFailure(outcome: LinearBulkOutcome): string | null {
  if (outcome.halted === 'usage-limit') return USAGE_LIMIT_MESSAGE;
  if (outcome.halted === 'rate-limit') return 'rate limited by Linear';
  return outcome.errors[0] ?? null;
}

/** Linear's link as a few lines: whether it runs, how the last pass went,
 *  and what is not in Linear yet. */
export function describeLinearStatus(
  status: LinearStatus,
  opts: { now?: Date } = {}
): string[] {
  if (!status.connected)
    return [
      "Linear isn't connected. Connect it in Settings → Linear; the key is kept for this project only.",
    ];
  const key =
    status.keySource === null
      ? ''
      : ` (key from ${KEY_SOURCE_WORDS[status.keySource]})`;
  if (!status.enabled)
    return [
      `Linear is connected${key} but sync is off; turn it on in Settings → Linear.`,
    ];
  const lines: string[] = [];
  if (status.teamId === null) {
    lines.push(
      'Sync is on but no Linear team is selected; pick one in Settings → Linear.'
    );
  } else {
    const more = (status.teamIds?.length ?? 1) - 1;
    lines.push(
      `Syncing ${DIRECTION_WORDS[status.direction]} with team ${status.teamId.slice(0, 8)}${more > 0 ? ` and ${more} more` : ''}, every ${status.intervalSec}s.`
    );
  }
  const hook = status.webhook;
  if (hook?.state === 'active') lines.push('Changes arrive by webhook.');
  if (hook?.state === 'polling') lines.push(`Polling every ${hook.pollSec}s.`);
  if (hook?.state === 'error')
    lines.push(
      `Polling every ${hook.pollSec}s: registering a webhook failed (${hook.error ?? 'unknown error'}).`
    );
  if (status.lastSyncAt === null) lines.push('Not synced yet.');
  else if (status.lastSummary === null)
    lines.push(`Last synced ${status.lastSyncAt}.`);
  else
    lines.push(
      `Last synced ${status.lastSyncAt}: ${summaryCounts(status.lastSummary)}.`
    );
  const now = (opts.now ?? new Date()).getTime();
  const pause = status.capacity ?? null;
  const paused =
    pause !== null && pause.retryAt !== null && Date.parse(pause.retryAt) > now;
  if (paused)
    lines.push(
      `Stopped creating in Linear: ${pause.message ?? USAGE_LIMIT_MESSAGE}. Tries again after ${pause.retryAt}; see dispatch linear capacity.`
    );
  if (
    status.lastError !== null &&
    !(paused && status.lastError === pause.message)
  )
    lines.push(`Last error: ${status.lastError}`);
  if (status.lastSummary?.rateLimited === true)
    lines.push('Rate limited by Linear; the next pass continues.');
  const coverage = status.coverage ?? null;
  if (coverage !== null) {
    if (coverage.notLinked > 0)
      lines.push(
        `${coverage.notLinked} of ${coverage.total} tasks are not in Linear; see dispatch linear coverage.`
      );
    if (coverage.failed > 0)
      lines.push(
        `${coverage.failed} failed to reach Linear; retry them with dispatch linear push --failed.`
      );
    if (coverage.queued > 0)
      lines.push(
        `${coverage.queued} queued for Linear; the next pass sends them.`
      );
  }
  if (status.bootstrappedAt === null)
    lines.push(
      'Not linked yet: the first pass links the board and sends no existing task; send them with dispatch linear push --unlinked.'
    );
  const running = status.running ?? null;
  if (running !== null)
    lines.push(
      `${RUN_WORDS[running.action]} is running (started ${running.startedAt}).`
    );
  else if (status.syncing) lines.push('A pass is running.');
  const progress = status.progress ?? null;
  if (progress !== null && (running !== null || status.syncing))
    lines.push(formatProgress(progress));
  if (status.lastExport != null)
    lines.push(
      `Last ${status.lastExport.action} ${status.lastExport.at}: ${bulkHeadline(status.lastExport)}.`
    );
  if (status.lastArchive != null)
    lines.push(
      `Last archive ${status.lastArchive.at}: ${bulkHeadline(status.lastArchive)}.`
    );
  return lines;
}

// What the WHY column says for an unlinked task.
function unlinkedWhy(task: LinearUnlinkedTask): string {
  switch (task.reason) {
    case 'failed':
      return task.lastError ?? 'create failed';
    case 'at-capacity':
      return "Linear's issue limit";
    case 'queued':
      return 'queued for retry';
    case 'moved-out':
      return 'moved out of the linked teams';
    case 'pull-only':
      return 'sync is pull-only';
    case 'held-back':
      return 'predates the link: sent when edited or pushed';
    case 'pending':
      return 'the next pass sends it';
    default:
      return task.reason;
  }
}

function isFailure(task: LinearUnlinkedTask): boolean {
  return task.reason === 'failed' || task.reason === 'at-capacity';
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function lastTry(task: LinearUnlinkedTask): string {
  if (task.lastAttemptAt === null) return '-';
  const at = task.lastAttemptAt.slice(0, 16).replace('T', ' ');
  return task.attempts > 1 ? `${at} (${task.attempts} tries)` : at;
}

/** How much of the board is in Linear, then a table of the tasks that are
 *  not and why, cut at `limit` rows. */
export function describeCoverage(
  coverage: LinearCoverage,
  opts: { limit?: number; failedOnly?: boolean } = {}
): string[] {
  const limit = opts.limit ?? 50;
  const failedOnly = opts.failedOnly === true;
  const pct =
    coverage.total === 0
      ? 100
      : Math.floor((coverage.linked * 100) / coverage.total);
  const lines = [
    `${coverage.linked} of ${coverage.total} tasks are in Linear (${pct}%).`,
  ];
  if (coverage.excluded.derived > 0)
    lines.push(
      `${coverage.excluded.derived} derived tasks are left out; they never sync.`
    );
  const rows = failedOnly
    ? coverage.unlinked.filter(isFailure)
    : coverage.unlinked;
  if (rows.length === 0) {
    if (failedOnly) lines.push('Nothing failed.');
    return lines;
  }
  const shown = rows.slice(0, limit);
  lines.push(
    '',
    formatTable([
      ['ID', 'STATUS', 'WHY', 'LAST TRY', 'TITLE'],
      ...shown.map((t) => [
        t.id,
        t.status,
        clip(unlinkedWhy(t), 60),
        lastTry(t),
        clip(t.title, 50),
      ]),
    ])
  );
  if (rows.length > shown.length)
    lines.push(
      `... and ${rows.length - shown.length} more (--all lists every one)`
    );
  const failures = coverage.unlinked.filter(isFailure).length;
  const sendable =
    (coverage.counts['held-back'] ?? 0) + (coverage.counts.pending ?? 0);
  lines.push('');
  if (!failedOnly && sendable > 0)
    lines.push(
      'Push them: dispatch linear push --unlinked (--all takes finished ones too)'
    );
  if (failures > 0) lines.push('Retry failures: dispatch linear push --failed');
  return lines;
}

/** Active issues against the plan's limit, per linked team and overall,
 *  and how much room archiving closed issues would free. */
export function describeCapacity(cap: LinearCapacity): string[] {
  const lines = cap.teams.map(
    (t) =>
      `${t.key} ${t.name}: ${t.active} active issues (${t.completed} completed, ${t.canceled} canceled)`
  );
  const where = cap.activeScope === 'workspace' ? 'Workspace' : 'Linked teams';
  const plan = cap.plan === 'unknown' ? 'plan unknown' : `${cap.plan} plan`;
  if (cap.limit === null) {
    // Only a plan read as paid says there is no limit; an unread one does not.
    const limit =
      cap.plan === 'paid'
        ? 'Linear reports no issue limit for this workspace'
        : 'Linear did not say whether this workspace has an issue limit';
    lines.push(
      `${where}: ${cap.active ?? 'unknown'} active issues. ${limit} (${plan}).`
    );
  } else if (cap.active === null) {
    lines.push(
      `${where}: up to ${cap.limit} active issues (${plan}); the active count is unknown.`
    );
  } else {
    lines.push(
      `${where}: ${cap.active} of ${cap.limit} active issues (${plan}); room for ${Math.max(0, cap.limit - cap.active)}.`
    );
  }
  if (cap.limitSource === 'observed')
    lines.push(
      "Linear refused a create while the plan could not be read, so the limit is the Free plan's."
    );
  if (cap.limitHitAt !== null)
    lines.push(`Linear refused a create over the limit at ${cap.limitHitAt}.`);
  const closed = closedCounts(cap, true);
  if (closed.completed + closed.canceled > 0)
    lines.push(
      `${cap.truncated ? 'At least ' : ''}${closed.completed} completed and ${closed.canceled} canceled issues could be archived to free room: dispatch linear archive-closed${closed.canceled > 0 ? ' [--canceled]' : ''}`
    );
  return lines;
}

// The linked teams' closed issues an archive-closed run would take.
function closedCounts(
  cap: LinearCapacity,
  includeCanceled: boolean
): { completed: number; canceled: number; matched: number } {
  const completed = cap.teams.reduce((n, t) => n + t.completed, 0);
  const canceled = cap.teams.reduce((n, t) => n + t.canceled, 0);
  return {
    completed,
    canceled,
    matched: completed + (includeCanceled ? canceled : 0),
  };
}

function scopeCount(
  preview: LinearExportPreview,
  scope: LinearExportScope
): number {
  if (scope === 'open') return preview.open;
  return scope === 'all' ? preview.all : preview.allArchiveFinished;
}

/** What an export takes under the plan's limit: the issues it leaves active,
 *  and how many arrive archived, which free their slot as they land. */
interface ExportSlots {
  kept: number;
  arriving: number;
}

function exportSlots(
  preview: LinearExportPreview,
  scope: LinearExportScope
): ExportSlots {
  if (scope === 'all-archive-finished')
    return {
      kept: preview.open,
      arriving: preview.allArchiveFinished - preview.open,
    };
  return { kept: scope === 'all' ? preview.all : preview.open, arriving: 0 };
}

// The warning before an export that will not fit under the plan's limit. An
// issue archived on arrival needs one free slot to land, then frees it.
function capacityWarning(
  cap: LinearCapacity | null,
  { kept, arriving }: ExportSlots
): string | null {
  if (cap === null || cap.limit === null || cap.active === null) return null;
  const room = Math.max(0, cap.limit - cap.active);
  if (kept < room || (kept === room && arriving === 0)) return null;
  return `Room for ${room} more issues in Linear (${cap.active} of ${cap.limit} active); the push stops creating at the limit. Free room first: dispatch linear archive-closed`;
}

/** What an export would send, for one scope or (null) all three. */
export function describeExportPreview(
  preview: LinearExportPreview,
  scope: LinearExportScope | null,
  cap: LinearCapacity | null = null
): string[] {
  if (scope === null) {
    const lines = [
      'Would send to Linear:',
      `  --unlinked             ${preview.open} open tasks`,
      `  --all                  ${preview.all} tasks (${preview.finished} finished, arriving closed)`,
      `  --archive-on-arrival   ${preview.allArchiveFinished} tasks (${preview.finished + preview.archived} finished or archived, arriving archived)`,
    ];
    const warning = capacityWarning(cap, { kept: preview.open, arriving: 0 });
    if (warning !== null) lines.push(warning);
    return lines;
  }
  const n = scopeCount(preview, scope);
  if (n === 0)
    return ['Nothing to send: every task in that scope is in Linear already.'];
  const lines = [
    scope === 'open'
      ? `Would send ${n} open tasks to Linear.`
      : scope === 'all'
        ? `Would send ${n} tasks to Linear: ${preview.open} open, ${preview.finished} finished (arriving closed).`
        : `Would send ${n} tasks to Linear: ${preview.open} open, ${preview.finished + preview.archived} finished or archived (arriving archived).`,
  ];
  if (scope !== 'open' && preview.containers > 0)
    lines.push(
      `${preview.containers} of them are projects, milestones or initiatives, not issues.`
    );
  if (cap !== null && cap.limit !== null && cap.active !== null)
    lines.push(
      `Linear holds ${cap.active} of ${cap.limit} active issues; room for ${Math.max(0, cap.limit - cap.active)}.`
    );
  const warning = capacityWarning(cap, exportSlots(preview, scope));
  if (warning !== null) lines.push(warning);
  return lines;
}

export interface PushOptions {
  unlinked?: boolean;
  all?: boolean;
  scope?: string;
  archiveOnArrival?: boolean;
  failed?: boolean;
  forget?: string[];
  dryRun?: boolean;
}

/** What `dispatch linear push` was asked to do. */
export type PushPlan =
  | { kind: 'ids'; ids: string[] }
  | { kind: 'export'; scope: LinearExportScope; dryRun: boolean }
  | { kind: 'preview' }
  | { kind: 'failed' }
  | { kind: 'forget'; ids: string[] };

// Same shape as the server's TASK_ID_SHAPE.
const TASK_ID_SHAPE = /^[a-z]-[0-9a-z]{1,64}$/;

const ONE_MODE =
  'push takes task ids, --unlinked, --all, --failed or --forget (one of them)';

function checkIds(ids: readonly string[]): string[] {
  for (const id of ids)
    if (!TASK_ID_SHAPE.test(id)) throw new CliError(`invalid task id: ${id}`);
  return [...new Set(ids)];
}

/** Checks push's arguments before any request, so a bad combination sends
 *  nothing. --all is --unlinked --scope all; --archive-on-arrival widens it to
 *  archived tasks, which arrive archived. */
export function parsePushArgs(
  ids: readonly string[],
  opts: PushOptions
): PushPlan {
  const modes = [
    ids.length > 0,
    opts.unlinked === true,
    opts.all === true,
    opts.failed === true,
    opts.forget !== undefined,
  ].filter((m) => m).length;
  if (modes > 1) throw new CliError(ONE_MODE);
  if (opts.scope !== undefined && opts.unlinked !== true)
    throw new CliError('--scope goes with --unlinked');
  const scope = opts.scope ?? 'open';
  if (scope !== 'open' && scope !== 'all')
    throw new CliError(`invalid scope: ${scope} (expected open|all)`);
  const archive = opts.archiveOnArrival === true;
  const exporting =
    opts.unlinked === true || opts.all === true || (modes === 0 && archive);
  if (archive && !exporting)
    throw new CliError(
      '--archive-on-arrival goes with --all or --unlinked --scope all'
    );
  if (archive && opts.unlinked === true && scope === 'open')
    throw new CliError(
      '--archive-on-arrival sends finished and archived tasks too, so it needs --scope all'
    );
  if (opts.dryRun === true && !exporting && modes > 0)
    throw new CliError(
      '--dry-run previews an export: use it with --unlinked, --all or --archive-on-arrival'
    );
  if (exporting) {
    const wide = opts.all === true || scope === 'all';
    return {
      kind: 'export',
      scope: archive ? 'all-archive-finished' : wide ? 'all' : 'open',
      dryRun: opts.dryRun === true,
    };
  }
  if (modes === 0) {
    if (opts.dryRun === true) return { kind: 'preview' };
    throw new CliError(ONE_MODE);
  }
  if (opts.failed === true) return { kind: 'failed' };
  if (opts.forget !== undefined)
    return { kind: 'forget', ids: checkIds(opts.forget) };
  return { kind: 'ids', ids: checkIds(ids) };
}

export interface FollowOptions {
  /** Progress lines; left out in --json mode so stdout stays one document. */
  onProgress?: (line: string) => void;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

type StatusReader = Pick<LinearApiClient, 'linearStatus'>;
type ProgressReport = (p: LinearProgress | null | undefined) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Prints a progress line on a phase change or each tenth of the total (each
// 100 records when the total is unknown), dropping repeats.
function progressReporter(onProgress?: (line: string) => void): ProgressReport {
  let last: string | null = null;
  return (p) => {
    if (onProgress === undefined || p == null) return;
    const step =
      p.total !== null && p.total > 0
        ? Math.floor((p.done * 10) / p.total)
        : Math.floor(p.done / 100);
    const key = `${p.action ?? 'import'}:${p.phase}:${step}`;
    if (key === last) return;
    last = key;
    onProgress(formatProgress(p));
  };
}

// Reports progress from status while an awaited request is in flight, so a
// long import is not silent until it answers.
async function withProgress<T>(
  api: StatusReader,
  work: Promise<T>,
  report: ProgressReport,
  intervalMs: number
): Promise<T> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = (): void => {
    timer = setTimeout(() => {
      void api
        .linearStatus()
        .then(
          (s) => {
            if (!settled) report(s.progress);
          },
          () => undefined
        )
        .finally(() => {
          if (!settled) tick();
        });
    }, intervalMs);
  };
  tick();
  try {
    return await work;
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}

// Polls status until `settled` answers, reporting progress meanwhile, and
// gives up at the deadline: the pass carries on in dispatchd regardless.
async function pollStatus<T>(
  api: StatusReader,
  opts: FollowOptions,
  began: number,
  report: ProgressReport,
  settled: (status: LinearStatus) => T | undefined,
  request?: string
): Promise<T> {
  const { intervalMs = 1000, timeoutMs = 30 * 60_000, now = Date.now } = opts;
  for (;;) {
    const status = await api.linearStatus(request);
    const result = settled(status);
    if (result !== undefined) return result;
    report(status.progress);
    if (now() - began >= timeoutMs) throw new CliError(STILL_RUNNING);
    await sleep(intervalMs);
  }
}

const PASS_UNANSWERED =
  'the Linear pass ended without a summary; check it with: dispatch linear status';

/**
 * Runs an awaited pass (sync, import) and answers its summary. The daemon
 * cuts a request at 65s and the CLI gives up at 60s, so when the request
 * outlives that this follows the pass through status until it goes idle.
 * The request carries an id status answers with the summary it got; an
 * older dispatchd without that falls back to timing. `joins` says the
 * request joins a pass already running (a sync naming no tasks), which may
 * have started before it.
 */
export async function followLinearPass(
  api: StatusReader,
  start: (request: string) => Promise<LinearSyncSummary>,
  opts: FollowOptions & { joins?: boolean; request?: string } = {}
): Promise<LinearSyncSummary> {
  const began = (opts.now ?? Date.now)();
  const report = progressReporter(opts.onProgress);
  const request = opts.request ?? randomUUID();
  try {
    const work = start(request);
    return await (opts.onProgress === undefined
      ? work
      : withProgress(api, work, report, opts.intervalMs ?? 1000));
  } catch (err) {
    if (!(err instanceof DaemonUnreachableError)) throw err;
  }
  let found: string | null | undefined;
  let ours: LinearSyncSummary | null = null;
  let joined: LinearSyncSummary | null = null;
  return pollStatus(
    api,
    opts,
    began,
    report,
    (status) => {
      if (status.answered !== undefined) {
        if (status.answered !== null) return status.answered;
        if (status.syncing) return undefined;
        throw new CliError(PASS_UNANSWERED);
      }
      return byTiming(status);
    },
    request
  );

  // An older dispatchd, which cannot say what the request got, by timing.
  // The first summary to land after the request is this pass's: a pass
  // queued behind it (a push a task edit scheduled) replaces it before the
  // daemon goes idle. summary.at is when a pass started, with a second of
  // slack for rounding. A joined pass queued behind another starts after the
  // request too; one already running started before it, so with none after
  // it is the last summary to replace the one the first poll found, or that
  // one when the first poll found the daemon idle.
  function byTiming(status: LinearStatus): LinearSyncSummary | undefined {
    const last = status.lastSummary;
    const first = found === undefined;
    if (first) found = last?.at ?? null;
    if (last !== null) {
      if (ours === null && Date.parse(last.at) >= began - 1000) ours = last;
      if (
        opts.joins === true &&
        (last.at !== found || (first && !status.syncing))
      )
        joined = last;
    }
    if (status.syncing) return undefined;
    const result = ours ?? joined;
    if (result !== null) return result;
    throw new CliError(PASS_UNANSWERED);
  }
}

/**
 * Starts a background run (export, retry, archive-closed) and follows it
 * through status until the outcome carrying its startedAt lands. Null when
 * the daemon had nothing to send.
 */
export async function followLinearBulk(
  api: StatusReader,
  start: () => Promise<LinearBulkStart>,
  opts: FollowOptions = {}
): Promise<LinearBulkOutcome | null> {
  const began = (opts.now ?? Date.now)();
  const answer = await start();
  const { startedAt } = answer;
  if (!answer.started || startedAt === undefined) return null;
  const report = progressReporter(opts.onProgress);
  return pollStatus(api, opts, began, report, (status) => {
    // The daemon records the outcome and clears `running` in one step.
    const outcome = [status.lastExport, status.lastArchive].find(
      (o) => o?.startedAt === startedAt
    );
    if (outcome != null) return outcome;
    if (status.running?.startedAt === startedAt) return undefined;
    throw new CliError(
      'the Linear run ended without a result; check it with: dispatch linear status'
    );
  });
}

interface CommonOptions {
  json?: boolean;
  token?: string;
}

export function registerLinearCommands(
  program: Command,
  ctx: CliContext
): void {
  const linear = program
    .command('linear')
    .description(
      'Keep this board and Linear in step: status, push, import, coverage and capacity'
    );

  // Attaches to the running daemon, never starting one: on the app token when
  // one is given, else the agent token from the daemon file. `command` is the
  // subcommand run, which an older daemon's missing route is named for.
  async function client(
    token: string | undefined,
    command: string
  ): Promise<LinearApiClient> {
    const { baseUrl, agentToken } = await attachToRunningDaemon(ctx);
    return createLinearApiClient(
      baseUrl,
      optionalAppToken(token) ?? agentToken,
      command
    );
  }

  function follow(opts: CommonOptions): FollowOptions {
    return opts.json === true ? {} : { onProgress: (line) => ctx.log(line) };
  }

  function json(value: unknown): void {
    ctx.log(JSON.stringify(value, null, 2));
  }

  // Refuses before any pass when Linear cannot run one, in status's words.
  function requireLinked(
    status: LinearStatus,
    need: { enabled?: boolean; push?: boolean } = {}
  ): void {
    if (!status.connected || (need.enabled === true && !status.enabled))
      throw new CliError(describeLinearStatus(status)[0]);
    if (status.teamId === null)
      throw new CliError(
        'no Linear team is selected; pick one in Settings → Linear'
      );
    if (need.push === true && status.direction === 'pull')
      throw new CliError(
        'Linear sync is pull-only here (linear.direction: pull), so nothing is pushed'
      );
  }

  // The capacity for a warning, or null when the daemon cannot say: an older
  // daemon, no key, a throttle or a slow count never blocks the push itself.
  async function capacityOrNull(
    api: LinearApiClient
  ): Promise<LinearCapacity | null> {
    try {
      return await api.linearCapacity();
    } catch (err) {
      if (err instanceof CliError) return null;
      throw err;
    }
  }

  // After a push: how much of the board is still not in Linear.
  async function stillUnlinked(
    api: LinearApiClient,
    opts: CommonOptions
  ): Promise<void> {
    if (opts.json === true) return;
    const status = await api.linearStatus().catch(() => null);
    const n = status?.coverage?.notLinked ?? 0;
    if (n > 0)
      ctx.log(`${n} tasks still not in Linear: dispatch linear coverage`);
  }

  function printSummary(
    summary: LinearSyncSummary,
    opts: CommonOptions
  ): string | null {
    if (opts.json === true) json(summary);
    else for (const line of describeLinearSummary(summary)) ctx.log(line);
    return summaryFailure(summary);
  }

  function printOutcome(
    outcome: LinearBulkOutcome | null,
    nothing: string,
    opts: CommonOptions
  ): string | null {
    if (opts.json === true) json(outcome ?? { started: false, candidates: 0 });
    else if (outcome === null) ctx.log(nothing);
    else for (const line of describeBulkOutcome(outcome)) ctx.log(line);
    return outcome === null ? null : bulkFailure(outcome);
  }

  function fail(failure: string | null): void {
    if (failure !== null) throw new CliError(failure);
  }

  linear
    .command('status', { isDefault: true })
    .description(
      'Show whether Linear is linked, how the last pass went, and what is not in Linear yet'
    )
    .option('--json')
    .option('--token <token>', TOKEN_HELP)
    .action(async (opts: CommonOptions) => {
      const status = await (await client(opts.token, 'status')).linearStatus();
      if (opts.json === true) json(status);
      else for (const line of describeLinearStatus(status)) ctx.log(line);
    });

  linear
    .command('sync')
    .description(
      'Run a Linear pass now: pull what changed in Linear, push what changed here (board sync is dispatch sync)'
    )
    .option('--json')
    .option('--token <token>', TOKEN_HELP)
    .action(async (opts: CommonOptions) => {
      const api = await client(opts.token, 'sync');
      requireLinked(await api.linearStatus(), { enabled: true });
      const summary = await followLinearPass(
        api,
        (r) => api.linearSync(undefined, r),
        {
          ...follow(opts),
          joins: true,
        }
      );
      fail(printSummary(summary, opts));
    });

  linear
    .command('push [ids...]')
    .description(
      'Send tasks to Linear: by id, every task not there yet, or the creates that failed'
    )
    .option(
      '--unlinked',
      'every task not in Linear yet: open ones, or all with --scope all'
    )
    .option('--scope <scope>', 'with --unlinked: open (default) or all')
    .option(
      '--all',
      'every task not in Linear yet, finished ones included (--unlinked --scope all)'
    )
    .option(
      '--archive-on-arrival',
      'archived tasks too; finished and archived ones arrive archived'
    )
    .option('--failed', 'retry every create that failed or is queued')
    .option('--forget <ids...>', "stop retrying these tasks' creates")
    .option('--dry-run', 'say what an export would send, and send nothing')
    .option('--json')
    .option('--token <token>', TOKEN_HELP)
    .action(async (ids: string[], opts: PushOptions & CommonOptions) => {
      const plan = parsePushArgs(ids, opts);
      const api = await client(opts.token, 'push');
      if (plan.kind === 'forget') {
        const { forgotten } = await api.linearForget(plan.ids);
        if (opts.json === true) json({ forgotten });
        else
          ctx.log(
            forgotten === 0
              ? 'Nothing to forget: none of those tasks is queued or unlinked.'
              : `Stopped retrying ${forgotten} task(s); each goes to Linear only when edited or pushed by id.`
          );
        return;
      }
      if (plan.kind === 'preview' || (plan.kind === 'export' && plan.dryRun)) {
        const scope = plan.kind === 'export' ? plan.scope : null;
        const [preview, cap] = await Promise.all([
          api.linearExportPreview(),
          capacityOrNull(api),
        ]);
        if (opts.json === true) json({ scope, preview, capacity: cap });
        else
          for (const line of describeExportPreview(preview, scope, cap))
            ctx.log(line);
        return;
      }
      requireLinked(await api.linearStatus(), { enabled: true, push: true });
      let failure: string | null;
      if (plan.kind === 'ids') {
        const summary = await followLinearPass(
          api,
          (r) => api.linearSync(plan.ids, r),
          follow(opts)
        );
        failure = printSummary(summary, opts);
      } else if (plan.kind === 'failed') {
        const outcome = await followLinearBulk(
          api,
          () => api.linearRetry(),
          follow(opts)
        );
        failure = printOutcome(outcome, 'Nothing failed or queued.', opts);
      } else {
        if (opts.json !== true) {
          const [preview, cap] = await Promise.all([
            api.linearExportPreview(),
            capacityOrNull(api),
          ]);
          const warning = capacityWarning(
            cap,
            exportSlots(preview, plan.scope)
          );
          if (warning !== null) ctx.log(warning);
        }
        const outcome = await followLinearBulk(
          api,
          () => api.linearExport(plan.scope),
          follow(opts)
        );
        failure = printOutcome(
          outcome,
          'Nothing to send: every task in that scope is in Linear already.',
          opts
        );
      }
      await stillUnlinked(api, opts);
      fail(failure);
    });

  linear
    .command('import')
    .description(
      "Bring down the linked teams' Linear issues that have no task here yet"
    )
    .option('--json')
    .option('--token <token>', TOKEN_HELP)
    .action(async (opts: CommonOptions) => {
      const api = await client(opts.token, 'import');
      requireLinked(await api.linearStatus());
      const summary = await followLinearPass(
        api,
        (r) => api.linearImport(r),
        follow(opts)
      );
      fail(printSummary(summary, opts));
    });

  linear
    .command('coverage')
    .description('List the tasks that are not in Linear, and why')
    .option('--all', 'list every one, not the first 50')
    .option('--failed', 'only the creates that failed')
    .option('--json')
    .option('--token <token>', TOKEN_HELP)
    .action(
      async (opts: CommonOptions & { all?: boolean; failed?: boolean }) => {
        const coverage = await (
          await client(opts.token, 'coverage')
        ).linearCoverage();
        if (opts.json === true) {
          json(coverage);
          return;
        }
        for (const line of describeCoverage(coverage, {
          limit: opts.all === true ? Number.POSITIVE_INFINITY : 50,
          failedOnly: opts.failed === true,
        }))
          ctx.log(line);
      }
    );

  linear
    .command('capacity')
    .description(
      "Show how many active issues Linear holds against the plan's limit"
    )
    .option('--refresh', "count again now instead of using the last minute's")
    .option('--json')
    .option('--token <token>', TOKEN_HELP)
    .action(async (opts: CommonOptions & { refresh?: boolean }) => {
      const cap = await (
        await client(opts.token, 'capacity')
      ).linearCapacity(opts.refresh === true);
      if (opts.json === true) json(cap);
      else for (const line of describeCapacity(cap)) ctx.log(line);
    });

  linear
    .command('archive-closed')
    .description(
      "Archive the linked teams' completed issues in Linear to free room under the plan's limit; their tasks here are archived too, unless the link is push only (needs the app token)"
    )
    .option('--canceled', 'canceled issues too')
    .option('--dry-run', 'say how many would be archived, and archive nothing')
    .option('--yes', 'archive without asking')
    .option('--json')
    .option('--token <token>', TOKEN_HELP)
    .action(
      async (
        opts: CommonOptions & {
          canceled?: boolean;
          dryRun?: boolean;
          yes?: boolean;
        }
      ) => {
        const { baseUrl, appToken } = await appTokenConnection(
          ctx,
          opts.token,
          'dispatch linear archive-closed'
        );
        const api = createLinearApiClient(baseUrl, appToken, 'archive-closed');
        const includeCanceled = opts.canceled === true;
        const cap = await api.linearCapacity();
        const closed = closedCounts(cap, includeCanceled);
        const atLeast = cap.truncated ? 'at least ' : '';
        const what = includeCanceled
          ? `${atLeast}${closed.matched} closed issues (${closed.completed} completed and ${closed.canceled} canceled)`
          : `${atLeast}${closed.completed} completed issues`;
        if (opts.dryRun === true || closed.matched === 0) {
          if (opts.json === true)
            json({
              dryRun: opts.dryRun === true,
              includeCanceled,
              ...closed,
              truncated: cap.truncated,
            });
          else if (closed.matched === 0) ctx.log('Nothing to archive.');
          else ctx.log(`Would archive ${what} in Linear.`);
          if (opts.json !== true && !includeCanceled && closed.canceled > 0)
            ctx.log(
              `${closed.canceled} canceled issues stay; add --canceled to archive them too.`
            );
          return;
        }
        if (opts.yes !== true) {
          // A push-only link never takes Linear's changes, its archive included.
          const pushOnly = (await api.linearStatus()).direction === 'push';
          const tasks = pushOnly
            ? 'Their tasks here stay as they are, since this link only sends changes to Linear; the issues can be restored.'
            : 'Their tasks here are archived too; both stay searchable and can be restored.';
          const yes = await (ctx.confirm ?? confirmNo)(
            `Archive ${what} in Linear? ${tasks}`
          );
          if (!yes)
            throw new CliError(
              'not archived; pass --yes to archive without a prompt'
            );
        }
        const outcome = await followLinearBulk(
          api,
          () => api.linearArchiveClosed({ includeCanceled }),
          follow(opts)
        );
        fail(printOutcome(outcome, 'Nothing to archive.', opts));
      }
    );
}
