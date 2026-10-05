import type {
  Amendment,
  CreateInput,
  ListFilter,
  ListSafeResult,
  SqliteTaskStore,
  TaskDoc,
  TaskStorePort,
  UpdatePatch,
} from '@dispatch-foo/core';
import { MAX_CLOCK_LEAD_MS } from '@dispatch-foo/protocol/federation';

import type { TaskOpSigner } from '../federation/taskOps.js';
import { oversizedField, TaskTooLargeError } from '../federation/taskOps.js';
import type { ApplyResult, BoardOp } from './engine.js';
import { applyOp, diffTask, recordLocal } from './engine.js';
import type { SyncLedger } from './ledger.js';

/**
 * The task store a synced daemon hands everything it runs, which records
 * every write as a change for the other replicas.
 *
 * A wrapper at the store rather than hooks in the handlers because the store
 * is the one place every write passes through — API handlers, the
 * orchestrator, plans, the policy engine, Linear, some forty call sites in
 * all — and the port has exactly four writing methods. Wrapping those four
 * catches all of them, including ones added later.
 *
 * Remote changes are applied through `applyRemote`, which writes to the inner
 * store directly: a change that arrived from elsewhere is not this replica's
 * to send again.
 */
// Keeps a publishing task's risk where this replica set it (see setRiskGuard).
interface RiskGuard {
  publishing(taskId: string): boolean;
  // A teammate's change tried to move a publishing task's risk.
  riskChanged(taskId: string): void;
}

export class SyncedTaskStore implements TaskStorePort {
  private riskGuard: RiskGuard | null = null;
  private signer: TaskOpSigner | null = null;

  constructor(
    private readonly inner: SqliteTaskStore,
    private readonly ledger: SyncLedger,
    /** Called after each local change, so the scheduler can sync soon. */
    private readonly onLocalChange: () => void = () => {}
  ) {}

  /** Once a team is founded, changes are signed v2 ops instead of v1 lines. */
  setSigner(signer: TaskOpSigner): void {
    this.signer = signer;
  }

  get rootDir(): string {
    return this.inner.rootDir;
  }

  isInitialized(): boolean {
    return this.inner.isInitialized();
  }

  get(id: string): TaskDoc | null {
    return this.inner.get(id);
  }

  list(filter?: ListFilter): TaskDoc[] {
    return this.inner.list(filter);
  }

  listSafe(filter?: ListFilter): ListSafeResult {
    return this.inner.listSafe(filter);
  }

  create(input: CreateInput, now?: string): TaskDoc {
    this.checkSize(input);
    const doc = this.inner.create(input, now);
    this.capture(null, doc, doc.meta.id);
    return doc;
  }

  update(id: string, patch: UpdatePatch, now?: string): TaskDoc {
    this.checkSize(patch);
    const before = this.inner.get(id);
    const after = this.inner.update(id, patch, now);
    this.capture(before, after, id);
    return after;
  }

  amend(id: string, input: Omit<Amendment, 'date'>, now?: string): TaskDoc {
    this.checkSize(input);
    const before = this.inner.get(id);
    const after = this.inner.amend(id, input, now);
    this.capture(before, after, id);
    return after;
  }

  remove(id: string): boolean {
    const before = this.inner.get(id);
    const removed = this.inner.remove(id);
    if (removed) this.capture(before, null, id);
    return removed;
  }

  /**
   * Publishes every task this replica already holds, once, when sync is first
   * turned on — otherwise the board as it stood before would never reach
   * anyone, since only changes travel.
   */
  bootstrap(): number {
    if (this.ledger.isBootstrapped()) return 0;
    const tasks = this.inner.list();
    this.ledger.atomically(() => {
      for (const doc of tasks) this.capture(null, doc, doc.meta.id, true);
      this.ledger.markBootstrapped();
    });
    if (tasks.length > 0) this.onLocalChange();
    return tasks.length;
  }

  /** A publish task's elevated risk keeps a human on its merge, so a synced
   *  change never moves it while it publishes; the attempt is reported. */
  setRiskGuard(guard: RiskGuard | null): void {
    this.riskGuard = guard;
  }

  /** Folds a change from another replica into this board. */
  applyRemote(remote: BoardOp): ApplyResult {
    if (this.ledger.ahead(remote.hlc))
      return {
        changed: false,
        doc: null,
        held: true,
        problem: `a change from ${remote.replica} (seq ${remote.seq}) is stamped ${remote.hlc}, more than ${MAX_CLOCK_LEAD_MS / 60_000} minutes ahead of this machine's clock; it waits until the clock catches up`,
      };
    this.ledger.observe(remote.hlc);
    const op = this.withoutGuardedRisk(remote);
    const result = applyOp(op, this.inner.get(op.task), this.ledger.state);
    if (result.changed) {
      if (result.doc === null) this.inner.remove(op.task);
      else this.inner.put(result.doc);
    }
    return result;
  }

  // The op minus a risk change to a publishing task, reporting it when it differs.
  private withoutGuardedRisk(op: BoardOp): BoardOp {
    const guard = this.riskGuard;
    if (
      guard === null ||
      op.fields === undefined ||
      !Object.hasOwn(op.fields, 'risk') ||
      !guard.publishing(op.task)
    )
      return op;
    const { risk, ...fields } = op.fields;
    if (risk !== this.inner.get(op.task)?.meta.risk) guard.riskChanged(op.task);
    return { ...op, fields };
  }

  private capture(
    before: TaskDoc | null,
    after: TaskDoc | null,
    id: string,
    bootstrapping = false
  ): void {
    const change = diffTask(before, after);
    if (change === null) return;
    // bootstrap() stays v1: it runs once, when sync is first turned on.
    if (!bootstrapping && this.signer?.active() === true)
      this.signer.commit({ task: id, ...change });
    else this.ledger.commitLocal({ task: id, ...change }, recordLocal);
    if (!bootstrapping) this.onLocalChange();
  }

  // Refused before the inner write, since the inner store writes first and
  // capture runs after: a refusal there would leave the board changed but unsynced.
  private checkSize(input: object): void {
    if (this.signer?.active() !== true) return;
    const hit = oversizedField(input as Record<string, unknown>);
    if (hit !== null) throw new TaskTooLargeError(hit.field, hit.bytes);
  }
}
