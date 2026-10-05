import type { TaskDoc, TaskStorePort } from '@dispatch-foo/core';

import type { TaskCache } from '../cache.js';

/** The longest a pass holds written ids before publishing them. */
const FLUSH_EVERY_MS = 1_500;

/**
 * Collects the ids of tasks a sync pass wrote and publishes them together:
 * one `task.changed` naming them per flush, at most one flush every 1.5s
 * while a pass runs, plus one when it ends. A client patches a small set in
 * place and refetches its list once for a big one, so even a 2000-issue
 * import costs a handful of refreshes.
 *
 * The cache takes each doc the moment the pass writes it, not at the flush:
 * the pass awaits between writes, and a user's edit landing there must not be
 * overwritten by the older doc the pass held.
 */
export class TaskChangeBatch {
  private readonly pending = new Set<string>();
  private total = 0;
  private lastFlush = Date.now();

  constructor(
    private readonly store: TaskStorePort,
    private readonly cache: TaskCache,
    private readonly resolve: (id: string) => TaskDoc | undefined,
    private readonly publish: (ids: string[]) => void
  ) {}

  add(id: string): void {
    const doc = this.resolve(id);
    if (doc === undefined) this.cache.refresh(this.store, [id]);
    else this.cache.upsert([doc]);
    this.pending.add(id);
    if (Date.now() - this.lastFlush >= FLUSH_EVERY_MS) this.flush();
  }

  /** Ids written so far, flushed or not. */
  count(): number {
    return this.total + this.pending.size;
  }

  flush(): void {
    this.lastFlush = Date.now();
    if (this.pending.size === 0) return;
    const ids = [...this.pending];
    this.pending.clear();
    this.total += ids.length;
    this.publish(ids);
  }
}
