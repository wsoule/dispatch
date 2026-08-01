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

// One issue-link fetch per pass: `versions` is set once, to null when the fetch failed.
interface IssueRefCache {
  versions?: Map<string, string> | null;
}

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
    this.foldLegacyWatermark(state);
    const direction = session.linear.direction;
    // Local tasks this pass just wrote from Linear — never pushed straight back
    // out in the same pass.
    const pulledTaskIds = new Set<string>();
    // Issues the pull decided Linear wins on, so push does not overwrite them.
    const remoteWins = new Set<string>();
    // Issues this pass already holds a remote version for, so an explicit push does
    // not re-fetch what the pull has answered.
    const verifiedIssues = new Set<string>();
    // One issue-link fetch per pass at most, shared by the baseline backfill and the push.
    const refs: IssueRefCache = {};

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
      // Everything on disk is accounted for BEFORE the push: nothing local has been
      // reconciled yet, so a fresh clone must send none of it over a linked issue.
      this.accountForAll(state);
      state.bootstrappedAt = now;
      await this.refreshIssueRefs(session, state, summary, refs);
    } else if (pulling) {
      pullFailed = !(await this.pull(
        session,
        state,
        summary,
        pulledTaskIds,
        remoteWins,
        verifiedIssues,
        opts.mode === 'import'
      ));
    }

    if (
      opts.mode !== 'import' &&
      direction !== 'pull' &&
      !summary.rateLimited
    ) {
      await this.push(session, state, summary, {
        taskIds: opts.taskIds,
        pulledTaskIds,
        remoteWins,
        verifiedIssues,
        createOnly: pullFailed,
        refs,
      });
    }

    // The link is established once the team answered, not once a data pass came back
    // clean — otherwise one persistent error would freeze the integration forever.
    if (state.bootstrappedAt === null) {
      // An import establishes the link without ever pushing, so the same rule as the
      // baseline path applies: nothing already on disk goes up automatically.
      this.accountForAll(state);
      state.bootstrappedAt = new Date().toISOString();
    }
    return this.finish(summary, state, session.linear.intervalSec);
  }

  // Records every task on disk at its current version, so establishing the link leaves
  // nothing outstanding for the push to send.
  private accountForAll(state: LinearSyncState): void {
    for (const doc of this.deps.store.listSafe().docs) {
      state.pushed[doc.meta.id] = doc.meta.updated;
    }
  }

  // A state file written before per-task accounting carries only a watermark. Everything at
  // or before it is recorded once, so an upgrade neither re-sends work nor strands it.
  private foldLegacyWatermark(state: LinearSyncState): void {
    if (state.lastPushAt === null) return;
    if (Object.keys(state.pushed).length === 0) {
      const mark = Date.parse(state.lastPushAt);
      // Ids in `pushRetry` were outstanding despite the watermark covering them.
      const queued = new Set(state.pushRetry ?? []);
      for (const doc of this.deps.store.listSafe().docs) {
        if (queued.has(doc.meta.id)) continue;
        if (Date.parse(doc.meta.updated) <= mark) {
          state.pushed[doc.meta.id] = doc.meta.updated;
        }
      }
    }
    delete state.pushRetry;
    state.lastPushAt = null;
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

  // Current version and display fields for every issue a local task links to, so chips fill
  // in and an explicit push can see whether Linear is ahead. Null when the fetch failed.
  private async refreshIssueRefs(
    session: SyncSession,
    state: LinearSyncState,
    summary: LinearSyncSummary,
    cache: IssueRefCache
  ): Promise<Map<string, string> | null> {
    if (cache.versions !== undefined) return cache.versions;
    const linked = new Set<string>();
    for (const doc of this.deps.store.listSafe().docs) {
      const id = parseExternal(doc.meta.external);
      if (id !== null) linked.add(id);
    }
    if (linked.size === 0) {
      cache.versions = new Map();
      return cache.versions;
    }
    const result = await session.client.issueLinks(session.teamId);
    if (!result.ok) {
      summary.errors.push(this.note(result));
      summary.rateLimited ||= result.kind === 'rate-limit';
      cache.versions = null;
      return null;
    }
    const versions = new Map<string, string>();
    for (const issue of result.data) {
      if (!linked.has(issue.id)) continue;
      this.recordLink(state, issue);
      versions.set(issue.id, issue.updatedAt);
    }
    cache.versions = versions;
    return versions;
  }

  // Linked candidates this pass holds no verdict for: an explicit push names tasks the pull
  // never covered, and an unrecorded version means the engine has never reconciled the issue.
  private async verifyBeforeSending(
    session: SyncSession,
    state: LinearSyncState,
    summary: LinearSyncSummary,
    candidates: TaskDoc[],
    opts: {
      explicit: boolean;
      verifiedIssues: Set<string>;
      remoteWins: Set<string>;
      refs: IssueRefCache;
    }
  ): Promise<Set<string>> {
    const { explicit, verifiedIssues, remoteWins, refs } = opts;
    // Task ids the check could not answer for. They are skipped without being recorded,
    // so a failed lookup postpones the decision instead of settling it.
    const unchecked = new Set<string>();
    const pending = candidates.filter((doc) => {
      const issueId = parseExternal(doc.meta.external);
      if (issueId === null) return false;
      if (verifiedIssues.has(issueId) || remoteWins.has(issueId)) return false;
      return explicit || state.pushed[doc.meta.id] === undefined;
    });
    if (pending.length === 0) return unchecked;

    const versions = await this.refreshIssueRefs(session, state, summary, refs);
    let withheld = 0;
    for (const doc of pending) {
      const issueId = parseExternal(doc.meta.external) ?? '';
      const remote = versions?.get(issueId);
      // A version this engine itself wrote is already reconciled, so Linear being ahead only
      // because of its own stamp must not block a push the user asked for by name.
      if (
        explicit &&
        remote !== undefined &&
        this.isAlreadyApplied(state, issueId, remote)
      ) {
        continue;
      }
      const verdict =
        remote === undefined
          ? 'unknown'
          : this.compareVersions(doc.meta.updated, remote);
      if (verdict === 'local') continue;
      // A tie means the two sides already agree, so there is nothing to send or report.
      if (verdict === 'none') {
        remoteWins.add(issueId);
        continue;
      }
      withheld++;
      if (verdict === 'unknown') unchecked.add(doc.meta.id);
      else remoteWins.add(issueId);
    }
    if (withheld > 0) {
      summary.errors.push(
        `withheld ${withheld} issue update(s): Linear holds a newer copy, or its version could not be checked`
      );
    }
    return unchecked;
  }

  // resolveConflict folds an unreadable timestamp into the same 'none' as a genuine tie,
  // which would withhold a task silently. Unreadable is surfaced as its own verdict.
  private compareVersions(
    local: string,
    remote: string
  ): 'local' | 'remote' | 'none' | 'unknown' {
    if (Number.isNaN(Date.parse(local)) || Number.isNaN(Date.parse(remote))) {
      return 'unknown';
    }
    return resolveConflict(local, remote);
  }

  // Returns false when the pull failed, which makes the push skip updates to
  // linked issues: without pull data there is no conflict information to act on.
  private async pull(
    session: SyncSession,
    state: LinearSyncState,
    summary: LinearSyncSummary,
    pulledTaskIds: Set<string>,
    remoteWins: Set<string>,
    verifiedIssues: Set<string>,
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
      verifiedIssues.add(issue.id);
      const existing = byExternal.get(issue.id);
      // Recorded before the already-applied check so a linked issue that never
      // changes again still backfills the identifier its chip needs.
      if (existing !== undefined) this.recordLink(state, issue);
      if (this.isAlreadyApplied(state, issue.id, issue.updatedAt)) continue;
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
        this.deps.store.update(
          doc.meta.id,
          { external: externalId(issue) },
          issue.updatedAt
        );
        state.pushed[doc.meta.id] = issue.updatedAt;
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
      // Stamped with the snapshot's `updatedAt` rather than a fresh clock: the task now
      // holds exactly this remote version, so the push has nothing left to send for it.
      this.deps.store.update(existing.meta.id, patch, issue.updatedAt);
      state.pushed[existing.meta.id] = issue.updatedAt;
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
    issueId: string,
    updatedAt: string
  ): boolean {
    return state.echoes.some(
      (e) => e.issueId === issueId && e.updatedAt === updatedAt
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
      verifiedIssues: Set<string>;
      createOnly: boolean;
      refs: IssueRefCache;
    }
  ): Promise<void> {
    const { taskIds, pulledTaskIds, remoteWins, createOnly } = opts;
    const explicit = taskIds !== undefined;
    const candidates = this.deps.store
      .listSafe()
      .docs.filter((doc) =>
        explicit
          ? taskIds.includes(doc.meta.id)
          : !pulledTaskIds.has(doc.meta.id) &&
            doc.meta.archivedAt === undefined &&
            this.isOutstanding(state, doc)
      );
    const unchecked = createOnly
      ? new Set<string>()
      : await this.verifyBeforeSending(session, state, summary, candidates, {
          explicit,
          verifiedIssues: opts.verifiedIssues,
          remoteWins,
          refs: opts.refs,
        });
    if (summary.rateLimited) return;
    let skippedForFailedPull = 0;

    for (const doc of candidates) {
      // The version being decided on. Recording it is what marks the task handled; an
      // edit landing mid-pass moves the task off it and so stays outstanding.
      const version = doc.meta.updated;
      const issueId = parseExternal(doc.meta.external);
      if (unchecked.has(doc.meta.id)) continue;
      if (issueId !== null && remoteWins.has(issueId)) {
        state.pushed[doc.meta.id] = version;
        continue;
      }
      if (issueId !== null && createOnly) {
        // Left outstanding on purpose: with no conflict information there is no safe
        // decision to record, so the next pass reconsiders it.
        skippedForFailedPull++;
        continue;
      }
      if (issueId === null && !explicit && !this.mayAutoCreate(state, doc)) {
        state.pushed[doc.meta.id] = version;
        continue;
      }
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
          if (result.kind === 'rate-limit') {
            summary.rateLimited = true;
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
        state.pushed[doc.meta.id] = version;
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
        if (result.kind === 'rate-limit') {
          summary.rateLimited = true;
          break;
        }
        continue;
      }
      this.recordSeen(state, result.data);
      state.pushed[doc.meta.id] = version;
      summary.pushed++;
    }

    if (skippedForFailedPull > 0) {
      summary.errors.push(
        `skipped ${skippedForFailedPull} issue update(s): the pull failed, so no conflict check was possible`
      );
    }
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
    return Date.parse(doc.meta.updated) >= Date.parse(state.bootstrappedAt);
  }

  // A task is outstanding when its content has moved past the version the push last
  // accounted for. Never when it moved backwards: a branch switch must not re-send old work.
  private isOutstanding(state: LinearSyncState, doc: TaskDoc): boolean {
    const accounted = state.pushed[doc.meta.id];
    if (accounted === undefined) return true;
    return Date.parse(doc.meta.updated) > Date.parse(accounted);
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
