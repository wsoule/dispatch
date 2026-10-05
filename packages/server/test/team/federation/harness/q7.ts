import { localOnlyReason } from '@dispatch/protocol';
import type { Message } from '@dispatch/protocol';
import {
  fromB64u,
  isStub,
  openPayload,
  openWithKey,
} from '@dispatch/protocol/federation';
import type { FederatedOp, LogEntry } from '@dispatch/protocol/federation';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGitSync } from '../../../orchestrator/helpers.js';
import type { Member } from './cluster.js';
import { keysOf } from './forge.js';

// A scratch clone of the branch, removed after `use`.
function withClone<T>(remote: string, use: (dir: string) => T): T {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fed-q7-')));
  try {
    runGitSync(dir, ['clone', '-q', '-b', 'dispatch-sync', remote, '.']);
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Every op line on the branch, every replica, every segment, read whole: the
// check reads all of it, never one budgeted pass (FW-R32 note on q7).
function allEntries(dir: string): LogEntry[] {
  const out: LogEntry[] = [];
  const fed = join(dir, 'fed');
  for (const replica of readdirSync(fed))
    for (const name of readdirSync(join(fed, replica)))
      if (/^\d{12}\.jsonl$/.test(name))
        for (const line of readFileSync(join(fed, replica, name), 'utf8').split(
          '\n'
        ))
          if (line.trim() !== '')
            try {
              out.push(JSON.parse(line) as LogEntry);
            } catch {
              // A line no honest build wrote is not mail.
            }
  return out;
}

// The messages a mail payload carries: its own, or a forward's inner one.
function messagesIn(
  op: FederatedOp,
  payload: unknown,
  reader: { replica: string; sealPriv: string }
): Message[] {
  const body = op.body as { forward?: FederatedOp } | undefined;
  if (body?.forward !== undefined) {
    const key = (payload as { key?: string } | null)?.key;
    if (typeof key !== 'string') return [];
    const inner = openWithKey(body.forward, fromB64u(key)) as {
      message?: Message;
    } | null;
    return inner?.message === undefined ? [] : [inner.message];
  }
  void reader;
  const m = (payload as { message?: Message } | null)?.message;
  return m === undefined ? [] : [m];
}

/** Q7 holds when no sealed payload on the branch carries gate data, a marker
 *  or an overseer or A2A participant, and no member stores such a row with
 *  an origin (spec "Q7 holds"). The harness holds every member's keys. */
export function q7Violations(remote: string, members: Member[]): string[] {
  const keys = new Map(members.map((m) => [keysOf(m).replica, keysOf(m)]));
  const out: string[] = [];
  withClone(remote, (dir) => {
    for (const e of allEntries(dir)) {
      if (isStub(e) || e.type !== 'mail') continue;
      const reader = (e.to ?? []).find((r) => keys.has(r));
      const k = reader === undefined ? undefined : keys.get(reader);
      if (k === undefined) continue;
      const payload = openPayload(e, k.replica, k.sealPriv);
      if (payload === null) {
        out.push(`${e.replica}:${e.seq} does not open for ${k.replica}`);
        continue;
      }
      for (const message of messagesIn(e, payload, k)) {
        const why = localOnlyReason(message, null, null);
        if (why !== null)
          out.push(`${e.replica}:${e.seq} carries ${why}: ${message.id}`);
      }
    }
  });
  for (const m of members)
    for (const row of m.handle.messagesDb<{
      id: string;
      thread: string;
      reply_to: string | null;
      from_addr: string;
      kind: string;
      data_json: string | null;
      origin: string | null;
    }>(
      'SELECT id, thread, reply_to, from_addr, kind, data_json, origin FROM messages WHERE origin IS NOT NULL'
    )) {
      const to = m.handle
        .messagesDb<{ addr: string }>(
          'SELECT addr FROM recipients WHERE message_id = ? ORDER BY position',
          [row.id]
        )
        .map((r) => r.addr);
      const message = {
        id: row.id,
        thread: row.thread,
        replyTo: row.reply_to,
        from: row.from_addr,
        to,
        kind: row.kind,
        ...(row.data_json === null
          ? {}
          : { data: JSON.parse(row.data_json) as unknown }),
      } as Message;
      if (localOnlyReason(message, null, null) !== null)
        out.push(`${m.name} stores ${row.id} from another replica`);
    }
  return out;
}

/** The planted bodies `git log -p --all` shows: sealing covers history too. */
export function plantedBodiesInHistory(
  remote: string,
  bodies: readonly string[]
): string[] {
  return withClone(remote, (dir) => {
    const log = runGitSync(dir, ['log', '-p', '--all']);
    return bodies.filter((b) => log.includes(b));
  });
}
