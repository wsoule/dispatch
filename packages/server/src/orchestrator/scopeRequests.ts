import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from './types.js';

/** Where a decision came in from: `app` carries the desktop app's webview
 *  origin, `api` is anything else — including a run's own agent. */
export type ScopeDecider = 'app' | 'api';

/** One out-of-scope edit an agent asked to make, and the decision once it lands. */
export interface RunScopeRequest {
  id: string;
  runId: string;
  paths: string[];
  reason: string;
  requestedAt: string;
  granted: boolean | null;
  decisionReason: string | null;
  decidedAt: string | null;
  /** So a self-grant cannot read as a human's ruling. Advisory only: the
   *  daemon is unauthenticated, so this attributes, it does not authenticate. */
  decidedBy: ScopeDecider | null;
}

// How long one long-poll parks before returning the still-undecided record.
// Well under the 65s socket budget /api/ requests get in index.ts.
export const SCOPE_REQUEST_POLL_MS = 30_000;

type Waiter = (request: RunScopeRequest) => void;

export interface ScopeRequestRegistryOptions {
  /** Where the registry persists itself (see scopeRequestsPath). Omitted, it
   *  is memory-only — the shape every unit test and the decision feed use. */
  path?: string;
}

// The on-disk shape: just the records. Kept behind a named key so a later
// field (a schema version, say) has somewhere to go without a format break.
interface ScopeRequestSnapshot {
  requests: RunScopeRequest[];
}

// Path-set identity for dedupe: the same files in any order are one request.
function pathKey(paths: readonly string[]): string {
  return [...paths].sort().join('\n');
}

/** Pending fence-extension requests from run agents, keyed by request id: an agent asks to
 * edit outside its scope, its tool call parks on `waitForDecision`, and a grant/deny resolves it.
 *
 * Persisted write-through to `path` when one is given, so a request a human has not decided
 * yet survives a daemon restart instead of vanishing with the process (the run it belongs to
 * is force-failed by reconcileOnBoot, then resumed — see `carry`). */
export class ScopeRequestRegistry {
  private readonly requests = new Map<string, RunScopeRequest>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly path: string | null;

  constructor(opts: ScopeRequestRegistryOptions = {}) {
    this.path = opts.path ?? null;
    this.hydrate();
  }

  private mintId(): string {
    let id = `sr-${randomBytes(3).toString('hex')}`;
    while (this.requests.has(id)) id = `sr-${randomBytes(3).toString('hex')}`;
    return id;
  }

  request(runId: string, paths: string[], reason: string): RunScopeRequest {
    const record: RunScopeRequest = {
      id: this.mintId(),
      runId,
      paths,
      reason,
      requestedAt: new Date().toISOString(),
      granted: null,
      decisionReason: null,
      decidedAt: null,
      decidedBy: null,
    };
    this.requests.set(record.id, record);
    this.persist();
    return record;
  }

  get(id: string): RunScopeRequest | undefined {
    return this.requests.get(id);
  }

  /** Every undecided request, oldest first — all runs, or just `runId`'s. */
  listOpen(runId?: string): RunScopeRequest[] {
    return [...this.requests.values()].filter(
      (r) => r.granted === null && (runId === undefined || r.runId === runId)
    );
  }

  /** The open request on `runId` asking for exactly these paths (any order), if one exists —
   * how a resumed agent re-issuing `request_scope` re-parks on the request already in front
   * of the human instead of filing a duplicate. */
  findOpen(runId: string, paths: readonly string[]): RunScopeRequest | null {
    const key = pathKey(paths);
    return this.listOpen(runId).find((r) => pathKey(r.paths) === key) ?? null;
  }

  decide(
    id: string,
    granted: boolean,
    reason?: string,
    decidedBy?: ScopeDecider
  ): RunScopeRequest {
    const record = this.requests.get(id);
    if (record === undefined) {
      throw new OrchestratorNotFoundError(`scope request not found: ${id}`);
    }
    if (record.granted !== null) {
      throw new OrchestratorConflictError(
        `scope request already decided: ${id}`
      );
    }
    record.granted = granted;
    record.decisionReason = reason ?? null;
    record.decidedAt = new Date().toISOString();
    record.decidedBy = decidedBy ?? null;
    this.persist();
    this.release(record);
    return record;
  }

  /** Resolves with the request once decided, or with the still-undecided record after
   * `timeoutMs` — a timeout means "poll again", not an error or a grant. */
  waitForDecision(id: string, timeoutMs: number): Promise<RunScopeRequest> {
    const record = this.requests.get(id);
    if (record === undefined) {
      return Promise.reject(
        new OrchestratorNotFoundError(`scope request not found: ${id}`)
      );
    }
    if (record.granted !== null) return Promise.resolve(record);

    return new Promise<RunScopeRequest>((resolve) => {
      const waiter: Waiter = (decided) => {
        clearTimeout(timer);
        resolve(decided);
      };
      const timer = setTimeout(() => {
        this.dropWaiter(id, waiter);
        resolve(this.requests.get(id) ?? record);
      }, timeoutMs);
      const set = this.waiters.get(id) ?? new Set<Waiter>();
      set.add(waiter);
      this.waiters.set(id, set);
    });
  }

  /** Drops one request, decided or not, and wakes anything parked on it — used when the run
   * that asked has stopped listening. */
  withdraw(id: string): boolean {
    const record = this.requests.get(id);
    if (record === undefined) return false;
    this.requests.delete(id);
    this.persist();
    this.release(record);
    return true;
  }

  /** Withdraws every request a run owns; returns how many there were. */
  closeRun(runId: string): number {
    let closed = 0;
    for (const record of [...this.requests.values()]) {
      if (record.runId === runId && this.withdraw(record.id)) closed += 1;
    }
    return closed;
  }

  /** Moves every request `fromRunId` holds onto `toRunId` — the successor a resume created in
   * the same worktree — and returns them. Open ones keep waiting, now against the run whose
   * agent is actually listening; decided ones ride along so the resumed agent can be told
   * what was ruled while nobody was there to hear it. Anything parked on the old id keeps
   * its waiter: the record is the same object, only its owner changed. */
  carry(fromRunId: string, toRunId: string): RunScopeRequest[] {
    const carried: RunScopeRequest[] = [];
    for (const record of this.requests.values()) {
      if (record.runId !== fromRunId) continue;
      record.runId = toRunId;
      carried.push(record);
    }
    if (carried.length > 0) this.persist();
    return carried;
  }

  /** Boot-time sweep over what hydrate() reloaded: withdraws every request whose run cannot
   * act on a decision any more — `keep(runId)` says whether the run is still live or still
   * resumable — so a stale card never outlives the run it belongs to. Returns the withdrawn
   * request ids. */
  reconcile(keep: (runId: string) => boolean): string[] {
    const withdrawn: string[] = [];
    // Answered once per run, not once per request: `keep` reads run state and
    // may consult the task store.
    const verdicts = new Map<string, boolean>();
    for (const record of [...this.requests.values()]) {
      let verdict = verdicts.get(record.runId);
      if (verdict === undefined) {
        verdict = keep(record.runId);
        verdicts.set(record.runId, verdict);
      }
      if (!verdict && this.withdraw(record.id)) withdrawn.push(record.id);
    }
    return withdrawn;
  }

  // Reloads what the previous process persisted, decided records included: a
  // ruling made on a force-failed run before the restart still has to reach
  // the agent that resumes it (carry hands it over; the prompt reports it).
  // Records whose run can no longer act are pruned by reconcile(), not here.
  // A missing or corrupt file is "nothing persisted yet", never a boot
  // failure, same as MergeQueue.loadPersistedFile.
  private hydrate(): void {
    if (this.path === null || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(
        readFileSync(this.path, 'utf8')
      ) as Partial<ScopeRequestSnapshot>;
      if (!Array.isArray(parsed.requests)) return;
      for (const record of parsed.requests as unknown[]) {
        if (!isPersistableRecord(record)) continue;
        this.requests.set(record.id, record);
      }
    } catch (err) {
      console.error(
        `dispatchd: failed to read scope requests, starting empty: ${(err as Error).message}`
      );
    }
  }

  // Write-through on every change, best-effort: a full disk must never fail
  // the request or decision that triggered it (the in-memory registry is still
  // right for this process; only the restart story degrades). Same non-atomic
  // writeFileSync convention as MergeQueue.persist.
  private persist(): void {
    if (this.path === null) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const snapshot: ScopeRequestSnapshot = {
        requests: [...this.requests.values()],
      };
      writeFileSync(this.path, `${JSON.stringify(snapshot)}\n`);
    } catch (err) {
      console.error(
        `dispatchd: failed to persist scope requests: ${(err as Error).message}`
      );
    }
  }

  private release(record: RunScopeRequest): void {
    const set = this.waiters.get(record.id);
    if (set === undefined) return;
    this.waiters.delete(record.id);
    for (const waiter of set) waiter(record);
  }

  private dropWaiter(id: string, waiter: Waiter): void {
    const set = this.waiters.get(id);
    if (set === undefined) return;
    set.delete(waiter);
    if (set.size === 0) this.waiters.delete(id);
  }
}

// A row from disk is trusted only as far as its shape: a hand-edited or
// truncated file must not put a record with no id or no paths into the map.
function isPersistableRecord(value: unknown): value is RunScopeRequest {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<RunScopeRequest>;
  return (
    typeof r.id === 'string' &&
    typeof r.runId === 'string' &&
    Array.isArray(r.paths) &&
    r.paths.every((p) => typeof p === 'string') &&
    typeof r.reason === 'string' &&
    typeof r.requestedAt === 'string' &&
    (r.granted === null || typeof r.granted === 'boolean')
  );
}
