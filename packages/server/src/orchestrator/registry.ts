import type { ExecutorRun, RunMeta } from './types.js';
import { TERMINAL_RUN_STATES } from './types.js';

export interface PendingApproval {
  requestId: string;
  toolName: string;
  input: unknown;
}

interface RunRecord {
  meta: RunMeta;
  executorRun?: ExecutorRun;
  // Tool calls parked on a human, by requestId, in the order they parked.
  pendingApprovals: Map<string, PendingApproval>;
}

/**
 * In-memory registry of every run dispatchd knows about in this process
 * lifetime — live runs with a real ExecutorRun handle, plus terminal runs
 * hydrated from transcripts at boot for `GET /api/runs` to list. Nothing
 * here is persisted; the transcript files are the durable record (see
 * transcript.ts), which is why every mutating method here has a matching
 * transcript append call in orchestrator.ts.
 */
export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();

  create(meta: RunMeta): void {
    this.runs.set(meta.id, { meta, pendingApprovals: new Map() });
  }

  get(id: string): RunMeta | undefined {
    return this.runs.get(id)?.meta;
  }

  getExecutorRun(id: string): ExecutorRun | undefined {
    return this.runs.get(id)?.executorRun;
  }

  setExecutorRun(id: string, executorRun: ExecutorRun): void {
    const record = this.runs.get(id);
    if (record !== undefined) record.executorRun = executorRun;
  }

  pendingApprovals(id: string): PendingApproval[] {
    return [...(this.runs.get(id)?.pendingApprovals.values() ?? [])];
  }

  getPendingApproval(
    id: string,
    requestId: string
  ): PendingApproval | undefined {
    return this.runs.get(id)?.pendingApprovals.get(requestId);
  }

  addPendingApproval(id: string, approval: PendingApproval): void {
    this.runs.get(id)?.pendingApprovals.set(approval.requestId, approval);
  }

  removePendingApproval(id: string, requestId: string): void {
    this.runs.get(id)?.pendingApprovals.delete(requestId);
  }

  // Forgets every call parked on the run and returns them, oldest first.
  clearPendingApprovals(id: string): PendingApproval[] {
    const record = this.runs.get(id);
    if (record === undefined) return [];
    const parked = [...record.pendingApprovals.values()];
    record.pendingApprovals.clear();
    return parked;
  }

  // Merges `patch` into a run's meta and returns the updated meta, or
  // undefined if the run isn't registered (defensive — callers should only
  // ever call this for runs they just created or looked up).
  updateMeta(id: string, patch: Partial<RunMeta>): RunMeta | undefined {
    const record = this.runs.get(id);
    if (record === undefined) return undefined;
    record.meta = { ...record.meta, ...patch };
    return record.meta;
  }

  // Most-recent-first, matching the "live + recent" listing the plan asks
  // GET /api/runs to serve.
  list(): RunMeta[] {
    return [...this.runs.values()]
      .map((r) => r.meta)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // The one live run for a task, if any — the source of truth for the
  // "one live run per task" concurrency rule (409 on double-dispatch).
  liveRunForTask(taskId: string): RunMeta | undefined {
    for (const record of this.runs.values()) {
      if (
        record.meta.taskId === taskId &&
        !TERMINAL_RUN_STATES.has(record.meta.state)
      ) {
        return record.meta;
      }
    }
    return undefined;
  }
}
