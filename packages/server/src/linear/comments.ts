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

/** The person signed in with Linear on this daemon. */
export interface LinearPersonWriter {
  client: LinearClient;
  /** Their Linear user id. */
  userId: string;
  /** The daemon owner's person ref, a local comment's `author`. */
  ref: string;
}

/**
 * The signed-in person, for the comment writes that are theirs: a comment
 * goes out with their client only when its body (or its delete) is one the
 * owner sent through this daemon's API (linear/personEdits.ts). A comment
 * file that arrived by git or board sync, even one authored as the owner,
 * goes through the project connection.
 */
interface CommentPerson extends LinearPersonWriter {
  /** Whether the owner wrote this comment's current body here. */
  wrote: (commentId: string, body: string) => boolean;
  /** Whether the owner deleted this comment here. */
  deleted: (commentId: string) => boolean;
}

export interface CommentSyncDeps {
  comments: CommentStorePort;
  client: LinearClient;
  /** Everyone signed in here (the owner, and on a shared host each teammate
   *  with a grant); empty or absent, every comment write uses `client`. */
  persons?: readonly CommentPerson[];
  /** Hears each comment whose write or delete reached Linear. */
  onSettled?: (commentId: string) => void;
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

  // Records a twin. `author` is the remote comment's Linear user when known;
  // undefined keeps what the link already held.
  private link(
    localId: string,
    remoteId: string,
    taskId: string,
    body: string,
    author?: string | null
  ): void {
    const known =
      author === undefined ? this.d.state.comments[localId]?.[3] : author;
    this.d.state.comments[localId] =
      known === undefined || known === null
        ? [remoteId, taskId, fieldHash(body)]
        : [remoteId, taskId, fieldHash(body), known];
    this.byRemote.set(remoteId, localId);
  }

  // The client an edit or delete of a linked comment goes out with: the
  // person's when Linear says they wrote it and the owner made this change
  // here (`mine`), else the project connection. Linear lets only a
  // comment's author change it, so anything else stays as it is today.
  private editorFor(
    localId: string,
    mine: (person: CommentPerson) => boolean
  ): LinearClient {
    const author = this.d.state.comments[localId]?.[3];
    const person = (this.d.persons ?? []).find(
      (p) => author === p.userId && mine(p)
    );
    return person?.client ?? this.d.client;
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
      let localId =
        this.byRemote.get(c.id) ?? this.adopt(taskId, c.id, c.userId);
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
        this.link(localId, c.id, taskId, c.body, c.userId);
        this.note(taskId, localId);
        continue;
      }
      await this.merge(taskId, localId, c);
    }
    for (const issueId of complete) this.dropMissing(issueId, seen);
  }

  // A local comment already carrying this remote id (state lost, or written
  // by an import on another machine) is its twin.
  private adopt(
    taskId: string,
    remoteId: string,
    author: string | null
  ): string | undefined {
    const twin = this.d.comments
      .list(taskId)
      .find((c) => remoteIdOf(c) === remoteId);
    if (twin === undefined) return undefined;
    this.link(twin.id, remoteId, taskId, twin.body, author);
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
      this.link(localId, c.id, taskId, c.body, c.userId);
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

  /** Queues every comment on a task that just got its Linear issue, so one
   *  a throttle or a failure leaves unsent goes on a later pass. */
  queueAll(taskId: string): void {
    const ids = this.d.comments.list(taskId).map((c) => c.id);
    if (ids.length === 0) return;
    const pending = this.d.state.pendingComments;
    pending[taskId] = [...new Set([...(pending[taskId] ?? []), ...ids])];
  }

  private async sendDelete(localId: string): Promise<boolean> {
    const link = this.d.state.comments[localId];
    if (link === undefined) return true;
    const done = this.d.pass.take(
      await this.editorFor(localId, (p) => p.deleted(localId)).deleteComment(
        link[0]
      )
    );
    if (done === null) return false;
    this.unlink(localId);
    this.d.onSettled?.(localId);
    return true;
  }

  private async send(
    taskId: string,
    local: TaskComment,
    all: Map<string, TaskComment> = new Map(
      this.d.comments.list(taskId).map((c) => [c.id, c])
    )
  ): Promise<boolean> {
    const { pass, state } = this.d;
    const link = state.comments[local.id];
    if (link !== undefined) {
      if (fieldHash(local.body) === link[2]) return true;
      const updated = pass.take(
        await this.editorFor(local.id, (p) =>
          p.wrote(local.id, local.body)
        ).updateComment(link[0], local.body)
      );
      if (updated === null) return false;
      pass.recordEcho(updated.id, updated.updatedAt);
      this.link(local.id, updated.id, taskId, local.body);
      this.d.onSettled?.(local.id);
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
    // A comment the owner wrote here goes out as them when they are signed
    // in; one that only claims them as author (a file from git or board
    // sync) goes through the project connection.
    const writer =
      (this.d.persons ?? []).find(
        (p) => local.author === p.ref && p.wrote(local.id, local.body)
      )?.client ?? this.d.client;
    const created = pass.take(
      await writer.createComment({
        issueId,
        body: local.body,
        ...(parentId === undefined ? {} : { parentId }),
      })
    );
    if (created === null) return false;
    pass.recordEcho(created.id, created.updatedAt);
    this.link(local.id, created.id, taskId, local.body, created.userId);
    this.d.onSettled?.(local.id);
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
