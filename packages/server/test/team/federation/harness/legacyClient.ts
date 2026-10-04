import type { TaskDoc } from '@dispatch/core';
import { newTaskDoc } from '@dispatch/core';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultAsyncGitRunner } from '../../../../src/sync/worktree.js';
import type { BoardOp } from '../../../../src/team/boardSync/engine.js';
import {
  applyOp,
  diffTask,
  recordLocal,
} from '../../../../src/team/boardSync/engine.js';
import { SyncLedger } from '../../../../src/team/boardSync/ledger.js';
import { SyncRepo } from '../../../../src/team/boardSync/repo.js';
import type { Member } from './cluster.js';

/** A v1 replica driven through today's v1 code on its own clone and state.db. */
export interface LegacyClient {
  replica: string;
  create(title: string): Promise<string>;
  edit(id: string, fields: Record<string, unknown>): Promise<void>;
  pull(): Promise<void>;
  title(id: string): string | null;
  close(): void;
}

export async function legacyClient(
  remote: string,
  handle: string,
  now: () => number = Date.now
): Promise<LegacyClient> {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), `fed-legacy-${handle}-`))
  );
  const ledger = new SyncLedger(join(dir, 'state.db'), handle, now);
  const repo = new SyncRepo(
    join(dir, 'repo'),
    remote,
    'dispatch-sync',
    ledger.replica,
    defaultAsyncGitRunner
  );
  await repo.ensure();
  const docs = new Map<string, TaskDoc>();
  // Stamps a change, sends it and exchanges, as the v1 daemon's pass does.
  const send = async (id: string, before: TaskDoc | null, after: TaskDoc) => {
    const change = diffTask(before, after);
    if (change === null) return;
    ledger.commitLocal({ task: id, ...change }, recordLocal);
    docs.set(id, after);
    const outbox = ledger.outbox();
    await repo.write(outbox);
    const last = outbox.at(-1);
    if (last !== undefined) ledger.sent(last.seq);
    await repo.exchange();
  };
  return {
    replica: ledger.replica,
    create: async (title) => {
      const id = `t-${randomBytes(3).toString('hex')}`;
      await send(
        id,
        null,
        newTaskDoc(id, 'task', { title }, new Date(now()).toISOString())
      );
      return id;
    },
    edit: async (id, fields) => {
      const before = docs.get(id) ?? null;
      if (before === null) throw new Error(`${id} is not on this board`);
      await send(id, before, {
        ...before,
        meta: { ...before.meta, ...fields },
      });
    },
    pull: async () => {
      await repo.exchange();
      const ops: BoardOp[] = repo
        .readOthers((r) => ledger.cursor(r))
        .sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
      for (const op of ops) {
        const result = applyOp(op, docs.get(op.task) ?? null, ledger.state);
        if (result.doc === null) docs.delete(op.task);
        else docs.set(op.task, result.doc);
        if (op.seq > ledger.cursor(op.replica))
          ledger.setCursor(op.replica, op.seq);
      }
    },
    title: (id) => docs.get(id)?.meta.title ?? null,
    close: () => {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The previous release's write on a stopped member's root: its own ledger
 *  stamps the change and its clone gets the v1 line, outbox cleared. */
export async function olderBuildEdit(
  m: Member,
  taskId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const ledger = new SyncLedger(
    join(m.handle.syncDir, 'state.db'),
    m.handle.handle,
    () => m.clock.ms
  );
  try {
    const op = ledger.commitLocal(
      { task: taskId, kind: 'put', fields },
      recordLocal
    );
    const repo = new SyncRepo(
      join(m.handle.syncDir, 'repo'),
      '',
      'dispatch-sync',
      ledger.replica,
      defaultAsyncGitRunner
    );
    await repo.write([op]);
    ledger.sent(op.seq);
  } finally {
    ledger.close();
  }
}
