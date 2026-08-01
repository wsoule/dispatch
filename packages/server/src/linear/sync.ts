import {
  DEFAULT_LINEAR,
  externalId,
  getSection,
  issueFromTask,
  loadConfig,
  parseExternal,
  resolveConflict,
  resolveLinearApiKey,
  taskCreateFromIssue,
  taskPatchFromIssue,
} from '@dispatch/core';
import type {
  CredentialSource,
  DispatchConfig,
  LinearConfig,
  LinearIssue,
  LinearLabel,
  LinearWorkflowState,
  TaskDoc,
  TaskStore,
} from '@dispatch/core';

import type { TaskCache } from '../cache.js';
import type { EventBus } from '../events.js';
import type { LinearClient, LinearFailure } from './client.js';
import { HttpLinearClient } from './client.js';
import type { LinearIssueLink, LinearSyncState } from './state.js';
import {
  echoTtlMs,
  pruneEchoes,
  readLinearState,
  writeLinearState,
} from './state.js';

/** One sync's outcome. `created` counts new local tasks; `createdIssues` counts new Linear issues. */
export interface LinearSyncSummary {
  at: string;
  pulled: number;
  pushed: number;
  created: number;
  createdIssues: number;
  conflicts: number;
  errors: string[];
  rateLimited: boolean;
}

export interface LinearStatus {
  enabled: boolean;
  connected: boolean;
  keySource: CredentialSource;
  teamId: string | null;
  direction: LinearConfig['direction'];
  intervalSec: number;
  statusMap: Record<string, string>;
  cursor: string | null;
  bootstrappedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  lastSummary: LinearSyncSummary | null;
  syncing: boolean;
}

export interface LinearSyncDeps {
  rootDir: string;
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
  /** A ready-made client, bypassing credential lookup entirely. Tests inject a fake here. */
  client?: LinearClient;
  /** Overridden in tests that need a real client against a stub endpoint. */
  createClient?: (apiKey: string) => LinearClient;
  /** Debounce for the push triggered by a local task change. */
  pushDebounceMs?: number;
}

// Everything one sync pass needs, resolved once so pull and push share the same
// team metadata instead of re-fetching states and labels per direction.
interface SyncSession {
  client: LinearClient;
  config: DispatchConfig;
  linear: LinearConfig;
  teamId: string;
  states: LinearWorkflowState[];
  labels: LinearLabel[];
}

// 'both' is the ordinary pass; 'push' is the debounced local-edit trigger;
// 'import' is the explicit "bring existing Linear issues down" action.
type SyncMode = 'both' | 'push' | 'import';

interface RunOptions {
  mode: SyncMode;
  taskIds?: string[];
}

function emptySummary(at: string): LinearSyncSummary {
  return {
    at,
    pulled: 0,
    pushed: 0,
    created: 0,
    createdIssues: 0,
    conflicts: 0,
    errors: [],
    rateLimited: false,
  };
}

const DEFAULT_PUSH_DEBOUNCE_MS = 5_000;

/** Polls Linear for issue changes and pushes local task changes back, one team at a time,
 *  against a cursor in `~/.dispatch/`. Its own writes are recorded and skipped on the next pull. */
export class LinearSync {
  private readonly deps: LinearSyncDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<LinearSyncSummary> | null = null;
  private lastSummary: LinearSyncSummary | null = null;
  // Set after a rate-limit failure; the timer and the debounced push both stand
  // down until it passes rather than spending the remaining hourly budget.
  private backoffUntil = 0;
  // Mirrors config.linear.enabled as of the last start(), so a task change on a
  // project with no Linear sync costs nothing and schedules no timer.
  private enabled = false;
  // Set when .dispatch/config.yml cannot be parsed. Sync stands down rather than
  // throwing out of a timer or blocking daemon boot.
  private configError: string | null = null;

  constructor(deps: LinearSyncDeps) {
    this.deps = deps;
  }

  // Config is read on every pass, from a file a person edits by hand, so a parse
  // failure is a normal state to be in rather than an exception to propagate.
  private safeConfig(): DispatchConfig | null {
    try {
      const config = loadConfig(this.deps.rootDir);
      this.configError = null;
      return config;
    } catch (err) {
      this.configError = `invalid config, Linear sync paused: ${(err as Error).message}`;
      return null;
    }
  }

  status(): LinearStatus {
    const config = this.safeConfig();
    const linear = config?.linear ?? DEFAULT_LINEAR;
    const state = readLinearState(this.deps.rootDir);
    const { source } = resolveLinearApiKey();
    return {
      enabled: config !== null && linear.enabled,
      connected: this.deps.client !== undefined || source !== null,
      keySource: source,
      teamId: linear.teamId,
      direction: linear.direction,
      intervalSec: linear.intervalSec,
      statusMap: linear.statusMap,
      cursor: state.cursor,
      bootstrappedAt: state.bootstrappedAt,
      lastSyncAt: state.lastSyncAt,
      lastError: this.configError ?? state.lastError,
      lastSummary: this.lastSummary,
      syncing: this.inFlight !== null,
    };
  }

  /** Issue UUID -> display identifier and URL, for clients holding only `TaskMeta.external`. */
  links(): Record<string, LinearIssueLink> {
    return readLinearState(this.deps.rootDir).links;
  }

  /** Builds a client for ad-hoc reads (the team/state pickers), or null when no key is available. */
  client(): LinearClient | null {
    if (this.deps.client !== undefined) return this.deps.client;
    const { apiKey } = resolveLinearApiKey();
    if (apiKey === null) return null;
    const make =
      this.deps.createClient ?? ((key: string) => new HttpLinearClient(key));
    return make(apiKey);
  }

  /** Starts the poll timer when the config enables it. Safe to call repeatedly. */
  start(): void {
    this.stopTimers();
    const config = this.safeConfig();
    this.enabled = config?.linear.enabled ?? false;
    if (config === null || !config.linear.enabled) return;
    this.timer = setInterval(() => {
      void this.syncOnce().catch(() => undefined);
    }, config.linear.intervalSec * 1000);
  }

  private stopTimers(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = null;
  }

  // Clears both timers and waits for any pass already running, so shutdown cannot
  // race a sync that is still writing task files and broadcasting.
  async stop(): Promise<void> {
    this.stopTimers();
    const pending = this.inFlight;
    if (pending !== null) await pending.catch(() => undefined);
  }

  // A local task changed: push it up shortly, coalescing a burst of edits into
  // one call. Pull is left to the timer — a local edit says nothing about Linear.
  notifyTaskChanged(): void {
    if (!this.enabled) return;
    if (this.debounce !== null) clearTimeout(this.debounce);
    const delay = this.deps.pushDebounceMs ?? DEFAULT_PUSH_DEBOUNCE_MS;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      const config = this.safeConfig();
      if (config === null) return;
      if (!config.linear.enabled || config.linear.direction === 'pull') return;
      void this.enqueue({ mode: 'push' }).catch(() => undefined);
    }, delay);
  }

  /** Pull then push, per the configured direction. Concurrent callers share one pass. */
  async syncOnce(taskIds?: string[]): Promise<LinearSyncSummary> {
    // An explicit push carries tasks the in-flight pass never considered, so it
    // queues behind that pass instead of being answered by it.
    if (taskIds === undefined && this.inFlight !== null) return this.inFlight;
    return this.enqueue({ mode: 'both', taskIds });
  }

  /** Creates local tasks for Linear issues that have none — the explicit first-sync import. */
  async importIssues(): Promise<LinearSyncSummary> {
    return this.enqueue({ mode: 'import' });
  }

  private enqueue(opts: RunOptions): Promise<LinearSyncSummary> {
    const previous = this.inFlight;
    const settled =
      previous === null
        ? Promise.resolve()
        : previous.then(
            () => undefined,
            () => undefined
          );
    const next = settled.then(() => this.run(opts));
    this.inFlight = next;
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.inFlight === next) this.inFlight = null;
      });
    return next;
  }

  private async run(opts: RunOptions): Promise<LinearSyncSummary> {
    const summary = emptySummary(new Date().toISOString());
    if (Date.now() < this.backoffUntil) {
      summary.rateLimited = true;
      summary.errors.push('linear rate limit backoff in effect');
      return this.finish(summary, readLinearState(this.deps.rootDir), 300);
    }

    const opened = await this.openSession();
    if (!opened.ok) {
      summary.errors.push(opened.error);
      // Persisted so `status().lastError` explains a misconfiguration, not just the summary.
      return this.finish(summary, readLinearState(this.deps.rootDir), 300);
    }
    const session = opened.session;
    const state = readLinearState(this.deps.rootDir);
    const direction = session.linear.direction;
    // Local tasks this pass just wrote from Linear — never pushed straight back
    // out in the same pass.
    const pulledTaskIds = new Set<string>();
    // Issues the pull decided Linear wins on, so push does not overwrite them.
    const remoteWins = new Set<string>();

    // A first sync reconciles nothing — no task to create, no link to update — so it
    // takes a cursor instead of scanning a whole team it has no use for.
    const baselining = state.bootstrappedAt === null && opts.mode !== 'import';
    const pulling =
      !baselining &&
      (opts.mode === 'import' ||
        (opts.mode === 'both' && direction !== 'push'));
    let pullFailed = false;
    if (baselining) {
      const now = new Date().toISOString();
      state.cursor = now;
      // Both markers are set BEFORE the push: nothing local has been reconciled yet, and
      // a fresh clone would otherwise push stale content over the whole linked backlog.
      state.bootstrappedAt = now;
      state.lastPushAt = now;
      await this.backfillLinks(session, state);
    } else if (pulling) {
      pullFailed = !(await this.pull(
        session,
        state,
        summary,
        pulledTaskIds,
        remoteWins,
        opts.mode === 'import'
      ));
    }

    if (
      opts.mode !== 'import' &&
      direction !== 'pull' &&
      !summary.rateLimited
    ) {
      // Captured BEFORE the push so an edit made mid-loop stays a candidate; anything
      // the loop could not send is named in `pushRetry` rather than dropped.
      const pushStartedAt = new Date().toISOString();
      await this.push(session, state, summary, {
        taskIds: opts.taskIds,
        pulledTaskIds,
        remoteWins,
        createOnly: pullFailed,
      });
      state.lastPushAt = pushStartedAt;
    }

    // The link is established once the team answered, not once a data pass came back
    // clean — otherwise one persistent error would freeze the integration forever.
    if (state.bootstrappedAt === null) {
      state.bootstrappedAt = new Date().toISOString();
      // An import establishes the link without ever pushing, so the same rule as the
      // baseline path applies: nothing predating the link goes up automatically.
      state.lastPushAt ??= state.bootstrappedAt;
    }
    return this.finish(summary, state, session.linear.intervalSec);
  }

  // Records the pass: persists cursor/echo state, refreshes the read cache when local
  // files changed, and tells connected clients the sync ran.
  private finish(
    summary: LinearSyncSummary,
    state: LinearSyncState,
    intervalSec: number
  ): LinearSyncSummary {
    state.lastSyncAt = summary.at;
    state.lastError = summary.errors[0] ?? null;
    state.echoes = pruneEchoes(
      state.echoes,
      Date.now(),
      echoTtlMs(intervalSec)
    );
    writeLinearState(this.deps.rootDir, state);
    this.lastSummary = summary;
    if (summary.pulled > 0 || summary.created > 0) {
      this.deps.cache.rebuild(this.deps.store);
      this.deps.events.broadcast({ type: 'task.changed' });
    }
    this.deps.events.broadcast({ type: 'linear.changed', summary });
    return summary;
  }

  private async openSession(): Promise<
    { ok: true; session: SyncSession } | { ok: false; error: string }
  > {
    const config = this.safeConfig();
    if (config === null) {
      return { ok: false, error: this.configError ?? 'invalid config' };
    }
    const teamId = config.linear.teamId;
    if (teamId === null || teamId.trim() === '') {
      return { ok: false, error: 'no Linear team selected' };
    }
    const client = this.client();
    if (client === null) {
      return { ok: false, error: 'no Linear API key configured' };
    }
    const states = await client.workflowStates(teamId);
    if (!states.ok) return { ok: false, error: this.note(states) };
    const labels = await client.labels(teamId);
    if (!labels.ok) return { ok: false, error: this.note(labels) };
    return {
      ok: true,
      session: {
        client,
        config,
        linear: config.linear,
        teamId,
        states: states.data,
        labels: labels.data,
      },
    };
  }

  // Turns a client failure into a summary message, arming the backoff clock when
  // the failure was a throttle.
  private note(failure: LinearFailure): string {
    if (failure.kind === 'rate-limit') {
      this.backoffUntil = Date.now() + (failure.retryAfterMs ?? 60_000);
    }
    return failure.error;
  }

  // Fills in display identifiers for tasks that arrive already linked, whose issues may
  // never change again and so never appear in a pull. Skipped when nothing is linked.
  private async backfillLinks(
    session: SyncSession,
    state: LinearSyncState
  ): Promise<void> {
    const linked = new Set<string>();
    for (const doc of this.deps.store.listSafe().docs) {
      const id = parseExternal(doc.meta.external);
      if (id !== null && state.links[id] === undefined) linked.add(id);
    }
    if (linked.size === 0) return;
    const result = await session.client.issueLinks(session.teamId);
    if (!result.ok) return;
    for (const issue of result.data) {
      if (linked.has(issue.id)) this.recordLink(state, issue);
    }
  }

  // Returns false when the pull failed, which makes the push skip updates to
  // linked issues: without pull data there is no conflict information to act on.
  private async pull(
    session: SyncSession,
    state: LinearSyncState,
    summary: LinearSyncSummary,
    pulledTaskIds: Set<string>,
    remoteWins: Set<string>,
    importing: boolean
  ): Promise<boolean> {
    // An import considers the whole team, not just what changed since the cursor.
    const result = await session.client.issuesUpdatedSince(
      session.teamId,
      importing ? null : state.cursor
    );
    if (!result.ok) {
      summary.errors.push(this.note(result));
      summary.rateLimited ||= result.kind === 'rate-limit';
      return false;
    }

    const byExternal = new Map<string, TaskDoc>();
    for (const doc of this.deps.store.listSafe().docs) {
      const id = parseExternal(doc.meta.external);
      if (id !== null) byExternal.set(id, doc);
    }
    const statuses = session.config.statuses;
    const issues = [...result.data.issues].sort((a, b) =>
      a.updatedAt.localeCompare(b.updatedAt)
    );
    let high = state.cursor;

    for (const issue of issues) {
      if (high === null || issue.updatedAt > high) high = issue.updatedAt;
      const existing = byExternal.get(issue.id);
      // Recorded before the already-applied check so a linked issue that never
      // changes again still backfills the identifier its chip needs.
      if (existing !== undefined) this.recordLink(state, issue);
      if (this.isAlreadyApplied(state, issue)) continue;
      if (existing === undefined) {
        if (issue.archivedAt !== null) continue;
        const doc = this.deps.store.create(
          taskCreateFromIssue(issue, {
            statusMap: session.linear.statusMap,
            statuses,
            fallbackStatus: statuses[0] ?? 'todo',
          }),
          issue.createdAt
        );
        // Deliberately the snapshot's `updatedAt`: the task is being replaced with this
        // exact remote version, which is the invariant the push's in-sync check needs.
        this.deps.store.update(
          doc.meta.id,
          { external: externalId(issue) },
          issue.updatedAt
        );
        this.recordSeen(state, issue);
        pulledTaskIds.add(doc.meta.id);
        summary.created++;
        summary.pulled++;
        continue;
      }
      const verdict = resolveConflict(existing.meta.updated, issue.updatedAt);
      if (verdict === 'local') {
        summary.conflicts++;
        continue;
      }
      if (verdict === 'none') continue;
      remoteWins.add(issue.id);
      const patch = taskPatchFromIssue(issue, {
        statusMap: session.linear.statusMap,
        statuses,
        fallbackStatus: existing.meta.status,
      });
      if (issue.archivedAt !== null) patch.archivedAt = issue.archivedAt;
      this.deps.store.update(existing.meta.id, patch, issue.updatedAt);
      this.recordSeen(state, issue);
      pulledTaskIds.add(existing.meta.id);
      summary.pulled++;
    }

    if (result.data.truncated) {
      // The cursor must not move past issues this walk never reached.
      summary.errors.push(
        'linear returned more issues than one sync could page through; cursor held'
      );
      return false;
    }
    // Rewound a second before the newest issue seen: `gt` would otherwise drop any
    // issue that shares that exact timestamp, and re-reading one issue is free.
    state.cursor =
      high === null ? null : new Date(Date.parse(high) - 1000).toISOString();
    return true;
  }

  // True when this exact version of the issue has already been reconciled — either
  // written by this engine or applied locally on an earlier pass.
  private isAlreadyApplied(
    state: LinearSyncState,
    issue: LinearIssue
  ): boolean {
    return state.echoes.some(
      (e) => e.issueId === issue.id && e.updatedAt === issue.updatedAt
    );
  }

  private async push(
    session: SyncSession,
    state: LinearSyncState,
    summary: LinearSyncSummary,
    opts: {
      taskIds: string[] | undefined;
      pulledTaskIds: Set<string>;
      remoteWins: Set<string>;
      createOnly: boolean;
    }
  ): Promise<void> {
    const { taskIds, pulledTaskIds, remoteWins, createOnly } = opts;
    const explicit = taskIds !== undefined;
    const retryable = new Set(state.pushRetry);
    const candidates = this.deps.store
      .listSafe()
      .docs.filter((doc) =>
        explicit
          ? taskIds.includes(doc.meta.id)
          : !pulledTaskIds.has(doc.meta.id) &&
            doc.meta.archivedAt === undefined &&
            (retryable.has(doc.meta.id) ||
              state.lastPushAt === null ||
              Date.parse(doc.meta.updated) > Date.parse(state.lastPushAt))
      );
    // Tasks this pass could not send — failed outright, or never reached after a
    // throttle. Carried in state so the cursor can advance without dropping them.
    const retry = new Set<string>();
    let skippedForFailedPull = 0;

    for (const [index, doc] of candidates.entries()) {
      const issueId = parseExternal(doc.meta.external);
      if (issueId !== null && remoteWins.has(issueId)) continue;
      if (issueId !== null && createOnly) {
        skippedForFailedPull++;
        retry.add(doc.meta.id);
        continue;
      }
      // The task's content is provably the version Linear already holds, so there is
      // nothing to send — this is what stops an import from writing itself straight back.
      if (issueId !== null && this.isInSyncWithIssue(state, issueId, doc)) {
        continue;
      }
      if (issueId === null && !explicit && !this.mayAutoCreate(state, doc)) {
        continue;
      }
      const abandonRest = (): void => {
        for (const pending of candidates.slice(index))
          retry.add(pending.meta.id);
      };
      const input = issueFromTask(doc, {
        teamId: session.teamId,
        statusMap: session.linear.statusMap,
        states: session.states,
        labels: session.labels,
        description: getSection(doc.body, 'Description'),
      });

      if (issueId === null) {
        const result = await session.client.createIssue(input);
        if (!result.ok) {
          summary.errors.push(this.note(result));
          retry.add(doc.meta.id);
          if (result.kind === 'rate-limit') {
            summary.rateLimited = true;
            abandonRest();
            break;
          }
          continue;
        }
        // Recording the link is bookkeeping, not a user edit, so the task's own
        // `updated` is preserved — bumping it would re-queue the task next pass.
        this.deps.store.update(
          doc.meta.id,
          { external: externalId(result.data) },
          this.currentUpdatedAt(doc)
        );
        this.recordSeen(state, result.data);
        summary.createdIssues++;
        summary.pushed++;
        continue;
      }

      // teamId would move the issue between teams. labelIds replaces the whole label set,
      // which would silently drop labels a person added in Linear — neither is sent on an update.
      const updateInput = { ...input };
      delete updateInput.teamId;
      delete updateInput.labelIds;
      const result = await session.client.updateIssue(issueId, updateInput);
      if (!result.ok) {
        summary.errors.push(this.note(result));
        retry.add(doc.meta.id);
        if (result.kind === 'rate-limit') {
          summary.rateLimited = true;
          abandonRest();
          break;
        }
        continue;
      }
      this.recordSeen(state, result.data);
      summary.pushed++;
    }

    // Merged, not replaced: an explicit `taskIds` push only ever considers its own
    // tasks, so overwriting would strand a failure recorded by an earlier pass.
    const considered = new Set(candidates.map((doc) => doc.meta.id));
    state.pushRetry = [
      ...new Set([
        ...state.pushRetry.filter((id) => !considered.has(id)),
        ...retry,
      ]),
    ];
    if (skippedForFailedPull > 0) {
      summary.errors.push(
        `skipped ${skippedForFailedPull} issue update(s): the pull failed, so no conflict check was possible`
      );
    }
  }

  // True when the task still holds the exact issue version already reconciled: pull and
  // import stamp `updated` with the issue's own, and a real local edit moves it off that.
  private isInSyncWithIssue(
    state: LinearSyncState,
    issueId: string,
    doc: TaskDoc
  ): boolean {
    return state.echoes.some(
      (e) => e.issueId === issueId && e.updatedAt === doc.meta.updated
    );
  }

  // Re-read right before the write-back so a local edit made during the network
  // round-trip keeps its own timestamp instead of being rolled backwards.
  private currentUpdatedAt(doc: TaskDoc): string {
    return this.deps.store.get(doc.meta.id)?.meta.updated ?? doc.meta.updated;
  }

  // Whether an unlinked task may be auto-created in Linear. Tasks predating the link
  // are left alone so connecting a tracker does not dump a whole backlog; explicit pushes still do.
  private mayAutoCreate(state: LinearSyncState, doc: TaskDoc): boolean {
    if (state.bootstrappedAt === null) return false;
    return Date.parse(doc.meta.updated) > Date.parse(state.bootstrappedAt);
  }

  // Marks this issue version as reconciled, and keeps its display identifier around
  // for clients that only hold the UUID in `TaskMeta.external`.
  private recordSeen(state: LinearSyncState, issue: LinearIssue): void {
    state.echoes.push({
      issueId: issue.id,
      updatedAt: issue.updatedAt,
      recordedAt: new Date().toISOString(),
    });
    this.recordLink(state, issue);
  }

  private recordLink(
    state: LinearSyncState,
    issue: { id: string; identifier: string; url: string }
  ): void {
    state.links[issue.id] = { identifier: issue.identifier, url: issue.url };
  }
}
