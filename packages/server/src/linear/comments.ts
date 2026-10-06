// Task comments <-> Linear issue comments: threaded, with edits and deletes
// in both directions. Each local comment's twin is remembered in sync state
// with the body hash both sides agreed on, which is the base an edit on
// either side is measured against.
import { fieldHash, parseLinearExternal } from '@dispatch-foo/core';
import type {
  CommentStorePort,
  LinearComment,
  TaskComment,
} from '@dispatch-foo/core';

import type { LinearClient } from './client.js';
import type { LinearPass } from './reconcile.js';
import type { LinearSyncState } from './state.js';
import type { PassContext } from './workspace.js';

const EXTERNAL_PREFIX = 'linear:';

function remoteIdOf(comment: TaskComment): string | null {
  const ext = comment.external;
  return ext !== null && ext.startsWith(EXTERNAL_PREFIX)
    ? ext.slice(EXTERNAL_PREFIX.length)
    : null;
}

export interface CommentSyncDeps {
  comments: CommentStorePort;
  client: LinearClient;
  state: LinearSyncState;
  ctx: PassContext;
  pass: LinearPass;
  /** Task id -> local comment ids this pass wrote, for `comment.changed`. */
  changed: Map<string, Set<string>>;
}

/** One pass's comment writes, both directions. */
export class CommentSync {
  // Linear comment id -> local comment id, built from sync state.
  private readonly byRemote = new Map<string, string>();

  constructor(private readonly d: CommentSyncDeps) {
    for (const [localId, [remoteId]] of Object.entries(d.state.comments)) {
      this.byRemote.set(remoteId, localId);
    }
  }

  private note(taskId: string, id: string): void {
    const ids = this.d.changed.get(taskId) ?? new Set<string>();
    ids.add(id);
    this.d.changed.set(taskId, ids);
  }

  private link(
    localId: string,
    remoteId: string,
    taskId: string,
    body: string
  ): void {
    this.d.state.comments[localId] = [remoteId, taskId, fieldHash(body)];
    this.byRemote.set(remoteId, localId);
  }

  private unlink(localId: string): void {
    const link = this.d.state.comments[localId];
    if (link !== undefined) this.byRemote.delete(link[0]);
    delete this.d.state.comments[localId];
  }

  // The task a comment's issue is linked to, when it is one this project has.
  private taskFor(issueId: string): string | null {
    const taskId = this.d.ctx.taskByRemote.get(issueId);
    if (taskId === undefined) return null;
    const ref = parseLinearExternal(this.d.ctx.tasks.get(taskId)?.external);
    return ref?.entity === 'issue' ? taskId : null;
  }

  /**
   * Applies Linear's comments: new ones are added under their thread, edits
   * land unless the local copy moved too (then the newer edit wins), and an
   * archived comment is removed here. `complete` names issues whose comments
   * were fetched in full, so a local twin missing from them was deleted.
   */
  async pull(
    remote: readonly LinearComment[],
    complete: ReadonlySet<string> = new Set()
  ): Promise<void> {
    const { comments, pass } = this.d;
    const sorted = [...remote].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    );
    const seen = new Set<string>();
    for (const c of sorted) {
      seen.add(c.id);
      const taskId = this.taskFor(c.issueId);
      if (taskId === null || pass.isEcho(c.id, c.updatedAt)) continue;
      let localId = this.byRemote.get(c.id) ?? this.adopt(taskId, c.id);
      if (c.archivedAt !== null) {
        if (localId !== undefined) {
          for (const id of comments.remove(taskId, localId)) {
            this.unlink(id);
            this.note(taskId, id);
          }
        }
        continue;
      }
      if (localId === undefined) {
        const parentLocal =
          c.parentId === null ? undefined : this.byRemote.get(c.parentId);
        const added = comments.add(
          {
            taskId,
            author:
              c.userId === null
                ? 'none'
                : (this.d.ctx.people.refByUser.get(c.userId) ?? 'none'),
            body: c.body,
            parentId: parentLocal ?? null,
            external: `${EXTERNAL_PREFIX}${c.id}`,
            created: c.createdAt,
          },
          c.updatedAt
        );
        localId = added.id;
        this.link(localId, c.id, taskId, c.body);
        this.note(taskId, localId);
        continue;
      }
      await this.merge(taskId, localId, c);
    }
    for (const issueId of complete) this.dropMissing(issueId, seen);
  }

  // A local comment already carrying this remote id (state lost, or written
  // by an import on another machine) is its twin.
  private adopt(taskId: string, remoteId: string): string | undefined {
    const twin = this.d.comments
      .list(taskId)
      .find((c) => remoteIdOf(c) === remoteId);
    if (twin === undefined) return undefined;
    this.link(twin.id, remoteId, taskId, twin.body);
    return twin.id;
  }

  private async merge(
    taskId: string,
    localId: string,
    c: LinearComment
  ): Promise<void> {
    const local = this.d.comments.get(taskId, localId);
    const link = this.d.state.comments[localId];
    // Deleted here: the pending push deletes it there.
    if (local === null || link === undefined) return;
    const base = link[2];
    const remoteChanged = fieldHash(c.body) !== base;
    const localChanged = fieldHash(local.body) !== base;
    if (!remoteChanged) return;
    const remoteWins =
      !localChanged || Date.parse(c.updatedAt) >= Date.parse(local.updated);
    if (remoteWins) {
      this.d.comments.update(taskId, localId, { body: c.body }, c.updatedAt);
      this.link(localId, c.id, taskId, c.body);
      this.note(taskId, localId);
      return;
    }
    await this.send(taskId, local);
  }

  private dropMissing(issueId: string, seen: ReadonlySet<string>): void {
    const taskId = this.taskFor(issueId);
    if (taskId === null) return;
    for (const c of this.d.comments.list(taskId)) {
      const remoteId = remoteIdOf(c);
      if (remoteId === null || seen.has(remoteId)) continue;
      for (const id of this.d.comments.remove(taskId, c.id)) {
        this.unlink(id);
        this.note(taskId, id);
      }
    }
  }

  /** Removes a comment Linear deleted outright (a webhook's `remove`). */
  removeRemote(remoteId: string): void {
    const localId = this.byRemote.get(remoteId);
    const link =
      localId === undefined ? undefined : this.d.state.comments[localId];
    if (localId === undefined || link === undefined) return;
    const taskId = link[1];
    for (const id of this.d.comments.remove(taskId, localId)) {
      this.unlink(id);
      this.note(taskId, id);
    }
  }

  /**
   * Sends local comment changes: a new comment is created under its thread's
   * top comment (Linear threads are one level deep), an edited one updated,
   * and a deleted one deleted. Returns the ids that still need a retry.
   */
  async push(taskId: string, ids: readonly string[]): Promise<string[]> {
    const ref = parseLinearExternal(this.d.ctx.tasks.get(taskId)?.external);
    if (ref?.entity !== 'issue') return [];
    const all = new Map(this.d.comments.list(taskId).map((c) => [c.id, c]));
    const ordered = [...new Set(ids)].sort((a, b) =>
      (all.get(a)?.created ?? '').localeCompare(all.get(b)?.created ?? '')
    );
    const retry: string[] = [];
    for (const id of ordered) {
      const local = all.get(id);
      const ok =
        local === undefined
          ? await this.sendDelete(id)
          : await this.send(taskId, local, all);
      if (!ok) retry.push(id);
    }
    return retry;
  }

  /** Every comment on a task, for one that just got its Linear issue. */
  async pushAll(taskId: string): Promise<void> {
    await this.push(
      taskId,
      this.d.comments.list(taskId).map((c) => c.id)
    );
  }

  private async sendDelete(localId: string): Promise<boolean> {
    const link = this.d.state.comments[localId];
    if (link === undefined) return true;
    const done = this.d.pass.take(await this.d.client.deleteComment(link[0]));
    if (done === null) return false;
    this.unlink(localId);
    return true;
  }

  private async send(
    taskId: string,
    local: TaskComment,
    all: Map<string, TaskComment> = new Map(
      this.d.comments.list(taskId).map((c) => [c.id, c])
    )
  ): Promise<boolean> {
    const { client, pass, state } = this.d;
    const link = state.comments[local.id];
    if (link !== undefined) {
      if (fieldHash(local.body) === link[2]) return true;
      const updated = pass.take(
        await client.updateComment(link[0], local.body)
      );
      if (updated === null) return false;
      pass.recordEcho(updated.id, updated.updatedAt);
      this.link(local.id, updated.id, taskId, local.body);
      return true;
    }
    const known = remoteIdOf(local);
    if (known !== null) {
      this.link(local.id, known, taskId, local.body);
      return true;
    }
    const issueId = parseLinearExternal(
      this.d.ctx.tasks.get(taskId)?.external
    )?.id;
    if (issueId === undefined) return false;
    // Linear threads one level deep: a reply goes under its thread's root.
    let root = local;
    for (let hops = 0; root.parentId !== null && hops < 20; hops++) {
      const parent = all.get(root.parentId);
      if (parent === undefined) break;
      root = parent;
    }
    let parentId: string | undefined;
    if (root.id !== local.id) {
      if (
        state.comments[root.id] === undefined &&
        !(await this.send(taskId, root, all))
      ) {
        return false;
      }
      parentId = state.comments[root.id]?.[0];
    }
    const created = pass.take(
      await client.createComment({
        issueId,
        body: local.body,
        ...(parentId === undefined ? {} : { parentId }),
      })
    );
    if (created === null) return false;
    pass.recordEcho(created.id, created.updatedAt);
    this.link(local.id, created.id, taskId, local.body);
    // Bookkeeping: the comment keeps its own `updated`.
    this.d.comments.update(
      taskId,
      local.id,
      { external: `${EXTERNAL_PREFIX}${created.id}` },
      local.updated
    );
    return true;
  }
}
