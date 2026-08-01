import {
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
import type { LinearSyncState } from './state.js';
import { pruneEchoes, readLinearState, writeLinearState } from './state.js';

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

  constructor(deps: LinearSyncDeps) {
    this.deps = deps;
  }

  status(): LinearStatus {
    const config = loadConfig(this.deps.rootDir);
    const state = readLinearState(this.deps.rootDir);
    const { source } = resolveLinearApiKey();
    return {
      enabled: config.linear.enabled,
      connected: this.deps.client !== undefined || source !== null,
      keySource: source,
      teamId: config.linear.teamId,
      direction: config.linear.direction,
      intervalSec: config.linear.intervalSec,
      statusMap: config.linear.statusMap,
      cursor: state.cursor,
      bootstrappedAt: state.bootstrappedAt,
      lastSyncAt: state.lastSyncAt,
      lastError: state.lastError,
      lastSummary: this.lastSummary,
      syncing: this.inFlight !== null,
    };
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
    this.stop();
    const config = loadConfig(this.deps.rootDir);
    this.enabled = config.linear.enabled;
    if (!config.linear.enabled) return;
    this.timer = setInterval(() => {
      void this.syncOnce().catch(() => undefined);
    }, config.linear.intervalSec * 1000);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = null;
  }

  // A local task changed: push it up shortly, coalescing a burst of edits into
  // one call. Pull is left to the timer — a local edit says nothing about Linear.
  notifyTaskChanged(): void {
    if (!this.enabled) return;
    if (this.debounce !== null) clearTimeout(this.debounce);
    const delay = this.deps.pushDebounceMs ?? DEFAULT_PUSH_DEBOUNCE_MS;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      const config = loadConfig(this.deps.rootDir);
      if (!config.linear.enabled || config.linear.direction === 'pull') return;
      void this.runPushOnly().catch(() => undefined);
    }, delay);
  }

  /** Pull then push, per the configured direction. Concurrent callers share one pass. */
  async syncOnce(taskIds?: string[]): Promise<LinearSyncSummary> {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.run(taskIds, 'both').finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runPushOnly(): Promise<LinearSyncSummary> {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.run(undefined, 'push').finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(
    taskIds: string[] | undefined,
    only: 'both' | 'push'
  ): Promise<LinearSyncSummary> {
    const summary = emptySummary(new Date().toISOString());
    if (Date.now() < this.backoffUntil) {
      summary.rateLimited = true;
      summary.errors.push('linear rate limit backoff in effect');
      return this.finish(summary, null);
    }

    const opened = await this.openSession();
    if (!opened.ok) {
      summary.errors.push(opened.error);
      // Persisted so `status().lastError` explains a misconfiguration, not just the summary.
      return this.finish(summary, readLinearState(this.deps.rootDir));
    }
    const session = opened.session;
    const state = readLinearState(this.deps.rootDir);
    const direction = session.linear.direction;
    // Local tasks this pass just wrote from Linear — never pushed straight back
    // out in the same pass.
    const pulledTaskIds = new Set<string>();
    // Issues the pull decided Linear wins on, so push does not overwrite them.
    const remoteWins = new Set<string>();

    if (only === 'both' && direction !== 'push') {
      await this.pull(session, state, summary, pulledTaskIds, remoteWins);
    }
    if (direction !== 'pull' && !summary.rateLimited) {
      await this.push(
        session,
        state,
        summary,
        taskIds,
        pulledTaskIds,
        remoteWins
      );
      state.lastPushAt = new Date().toISOString();
    }
    if (state.bootstrappedAt === null && summary.errors.length === 0) {
      state.bootstrappedAt = new Date().toISOString();
    }
    return this.finish(summary, state);
  }

  // Records the pass: persists cursor/echo state, refreshes the read cache when local
  // files changed, and tells connected clients the sync ran.
  private finish(
    summary: LinearSyncSummary,
    state: LinearSyncState | null
  ): LinearSyncSummary {
    if (state !== null) {
      state.lastSyncAt = summary.at;
      state.lastError = summary.errors[0] ?? null;
      state.echoes = pruneEchoes(state.echoes, Date.now());
      writeLinearState(this.deps.rootDir, state);
    }
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
    const config = loadConfig(this.deps.rootDir);
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

  private async pull(
    session: SyncSession,
    state: LinearSyncState,
    summary: LinearSyncSummary,
    pulledTaskIds: Set<string>,
    remoteWins: Set<string>
  ): Promise<void> {
    const result = await session.client.issuesUpdatedSince(
      session.teamId,
      state.cursor
    );
    if (!result.ok) {
      summary.errors.push(this.note(result));
      summary.rateLimited ||= result.kind === 'rate-limit';
      return;
    }

    const byExternal = new Map<string, TaskDoc>();
    for (const doc of this.deps.store.list()) {
      const id = parseExternal(doc.meta.external);
      if (id !== null) byExternal.set(id, doc);
    }
    const statuses = session.config.statuses;
    const issues = [...result.data].sort((a, b) =>
      a.updatedAt.localeCompare(b.updatedAt)
    );
    let high = state.cursor;

    for (const issue of issues) {
      if (high === null || issue.updatedAt > high) high = issue.updatedAt;
      if (this.isEcho(state, issue)) continue;
      const existing = byExternal.get(issue.id);
      if (existing === undefined) {
        if (issue.archivedAt !== null) continue;
        const doc = this.deps.store.create(
          taskCreateFromIssue(issue, {
            statusMap: session.linear.statusMap,
            statuses,
            fallbackStatus: statuses[0] ?? 'todo',
          })
        );
        this.deps.store.update(doc.meta.id, { external: externalId(issue) });
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
      this.deps.store.update(existing.meta.id, patch);
      pulledTaskIds.add(existing.meta.id);
      summary.pulled++;
    }

    // Rewound a second before the newest issue seen: `gt` would otherwise drop any
    // issue that shares that exact timestamp, and re-reading one issue is free.
    state.cursor =
      high === null ? null : new Date(Date.parse(high) - 1000).toISOString();
  }

  // True when this issue's current version is one this engine just wrote, in which
  // case applying it locally would be re-applying our own edit.
  private isEcho(state: LinearSyncState, issue: LinearIssue): boolean {
    return state.echoes.some(
      (e) => e.issueId === issue.id && e.updatedAt === issue.updatedAt
    );
  }

  private async push(
    session: SyncSession,
    state: LinearSyncState,
    summary: LinearSyncSummary,
    taskIds: string[] | undefined,
    pulledTaskIds: Set<string>,
    remoteWins: Set<string>
  ): Promise<void> {
    const explicit = taskIds !== undefined;
    const candidates = this.deps.store
      .list()
      .filter((doc) =>
        explicit
          ? taskIds.includes(doc.meta.id)
          : !pulledTaskIds.has(doc.meta.id) &&
            doc.meta.archivedAt === undefined &&
            (state.lastPushAt === null ||
              Date.parse(doc.meta.updated) > Date.parse(state.lastPushAt))
      );

    for (const doc of candidates) {
      const issueId = parseExternal(doc.meta.external);
      if (issueId !== null && remoteWins.has(issueId)) continue;
      if (issueId === null && !explicit && !this.mayAutoCreate(state, doc)) {
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
            return;
          }
          continue;
        }
        this.deps.store.update(doc.meta.id, {
          external: externalId(result.data),
        });
        this.recordEcho(state, result.data);
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
          return;
        }
        continue;
      }
      this.recordEcho(state, result.data);
      summary.pushed++;
    }
  }

  // Whether an unlinked task may be auto-created in Linear. Tasks predating the link
  // are left alone so connecting a tracker does not dump a whole backlog; explicit pushes still do.
  private mayAutoCreate(state: LinearSyncState, doc: TaskDoc): boolean {
    if (state.bootstrappedAt === null) return false;
    return Date.parse(doc.meta.updated) > Date.parse(state.bootstrappedAt);
  }

  private recordEcho(state: LinearSyncState, issue: LinearIssue): void {
    state.echoes.push({
      issueId: issue.id,
      updatedAt: issue.updatedAt,
      recordedAt: new Date().toISOString(),
    });
  }
}
