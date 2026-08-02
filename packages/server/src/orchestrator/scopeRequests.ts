import { randomBytes } from 'node:crypto';

import {
  OrchestratorConflictError,
  OrchestratorNotFoundError,
} from './types.js';

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
}

// How long one long-poll parks before returning the still-undecided record.
// Well under the 65s socket budget /api/ requests get in index.ts.
export const SCOPE_REQUEST_POLL_MS = 30_000;

type Waiter = (request: RunScopeRequest) => void;

/** Pending fence-extension requests from run agents, keyed by request id: an agent asks to
 * edit outside its scope, its tool call parks on `waitForDecision`, and a grant/deny resolves it. */
export class ScopeRequestRegistry {
  private readonly requests = new Map<string, RunScopeRequest>();
  private readonly waiters = new Map<string, Set<Waiter>>();

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
    };
    this.requests.set(record.id, record);
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

  decide(id: string, granted: boolean, reason?: string): RunScopeRequest {
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
