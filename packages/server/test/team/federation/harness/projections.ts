import type { TaskDoc } from '@dispatch/core';
import { expect } from 'bun:test';

import { taskFields } from '../../../../src/team/boardSync/engine.js';
import type { Member } from './cluster.js';

/** The merge state a member holds (fields, tombstones, activity) and the
 *  task docs it renders, by id, as the synced fields and Activity. */
export async function boardProjection(m: Member): Promise<unknown> {
  const rows = <T>(sql: string) => m.handle.stateDb<T>(sql);
  const tasks = (await m.handle.api('/api/tasks')).body as unknown;
  const list = (Array.isArray(tasks) ? tasks : []) as TaskDoc[];
  return {
    fields: rows(
      'SELECT task, field, hlc, value FROM fields ORDER BY task, field'
    ),
    tombstones: rows('SELECT task, hlc FROM tombstones ORDER BY task'),
    activity: rows(
      'SELECT task, hlc, idx, line FROM activity ORDER BY task, hlc, idx'
    ),
    // Each task as rendered: every synced field and its Activity lines.
    tasks: list
      .map((t) => ({ id: t.meta.id, ...taskFields(t) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Who is on the team and how: admitted replicas, roles, ranks, hosts,
 *  observers, recovery, and the team's id and seats. */
export async function rosterProjection(m: Member): Promise<unknown> {
  const keys = await m.handle.keys();
  return {
    team: keys.team,
    seats: keys.license?.seats ?? null,
    roster: keys.roster
      .map((r) => ({
        replica: r.replica,
        handle: r.handle,
        role: r.role,
        rank: r.rank,
        hosts: r.hosts,
        observer: r.observer,
        recovered: r.recovered,
      }))
      .sort((a, b) => a.replica.localeCompare(b.replica)),
  };
}

/** Every message more than one member holds reads the same on each: its
 *  body, and whether it is the accepted answer (accepted on one, accepted on
 *  all). A losing answer may stay pending where the winner never arrives
 *  (FW-R33), so that is not compared. */
export function expectMessagesConverged(members: Member[]): void {
  const held = new Map<string, { name: string; row: unknown }[]>();
  for (const m of members)
    for (const row of m.handle.messagesDb<{
      id: string;
      kind: string;
      settled_as: string | null;
      body: string;
    }>('SELECT id, kind, settled_as, body FROM messages')) {
      const list = held.get(row.id) ?? [];
      list.push({
        name: m.name,
        row: { body: row.body, accepted: row.settled_as === 'accepted' },
      });
      held.set(row.id, list);
    }
  for (const [id, copies] of held) {
    const [first, ...rest] = copies;
    for (const other of rest)
      expect({ id, on: other.name, ...(other.row as object) }).toEqual({
        id,
        on: other.name,
        ...(first?.row as object),
      });
  }
}

/** Every projection is the same on every member. */
export async function expectConverged(
  members: Member[],
  projections: ((m: Member) => Promise<unknown>)[]
): Promise<void> {
  for (const project of projections) {
    const [first, ...rest] = await Promise.all(members.map(project));
    for (const other of rest) expect(other).toEqual(first);
  }
}
