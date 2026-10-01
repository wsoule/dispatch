import { expect } from 'bun:test';

import type { Member } from './cluster.js';

/** The merge state a member holds (fields, tombstones, activity) and the
 *  tasks it renders, by id. */
export async function boardProjection(m: Member): Promise<unknown> {
  const rows = <T>(sql: string) => m.handle.stateDb<T>(sql);
  const tasks = (await m.handle.api('/api/tasks')).body as unknown;
  const list = (Array.isArray(tasks) ? tasks : []) as {
    meta: { id: string; title: string; status: string };
  }[];
  return {
    fields: rows(
      'SELECT task, field, hlc, value FROM fields ORDER BY task, field'
    ),
    tombstones: rows('SELECT task, hlc FROM tombstones ORDER BY task'),
    activity: rows(
      'SELECT task, hlc, idx, line FROM activity ORDER BY task, hlc, idx'
    ),
    tasks: list
      .map((t) => ({
        id: t.meta.id,
        title: t.meta.title,
        status: t.meta.status,
      }))
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
