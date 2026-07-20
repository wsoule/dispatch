import { readyTasks } from '@dispatch/core';
import type { TaskDoc, TaskStore } from '@dispatch/core';
import { Database } from 'bun:sqlite';

// Loose query shape (plain strings, not core's TaskKind/Priority unions) since
// values here come straight off HTTP query params.
export interface CacheFilter {
  status?: string;
  kind?: string;
  parent?: string;
}

interface TaskRow {
  json: string;
}

/**
 * In-memory read cache for the task graph, derived one-way from on-disk task
 * files via TaskStore. The cache never writes files — `rebuild()` is the only
 * way data enters it, so it is always safely reconstructible from source (the
 * files remain the single source of truth; see spec §4).
 *
 * The full TaskDoc is stashed as a `json` column and reconstructed on read;
 * the other columns exist purely so SQL can filter/sort without touching the
 * blob, per the phase-2 plan's schema.
 */
export class TaskCache {
  private readonly db: Database;

  constructor() {
    this.db = new Database(':memory:');
    this.db.run(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT,
        status TEXT,
        kind TEXT,
        parent TEXT,
        priority TEXT,
        assignee TEXT,
        created TEXT,
        updated TEXT,
        json TEXT
      )
    `);
  }

  // Truncates and repopulates the cache from the store's current files. A
  // full rescan on every change is O(task count); acceptable at v1 scale — an
  // on-disk cache with incremental updates is a later optimization (see the
  // phase-2 plan's "Deviations from spec" note).
  rebuild(store: TaskStore): void {
    this.db.run('DELETE FROM tasks');
    const insert = this.db.prepare(
      `INSERT INTO tasks (id, title, status, kind, parent, priority, assignee, created, updated, json)
       VALUES ($id, $title, $status, $kind, $parent, $priority, $assignee, $created, $updated, $json)`
    );
    for (const doc of store.list()) {
      insert.run({
        $id: doc.meta.id,
        $title: doc.meta.title,
        $status: doc.meta.status,
        $kind: doc.meta.kind,
        $parent: doc.meta.parent,
        $priority: doc.meta.priority,
        $assignee: doc.meta.assignee,
        $created: doc.meta.created,
        $updated: doc.meta.updated,
        $json: JSON.stringify(doc),
      });
    }
  }

  // Matches TaskStore.list()'s filter semantics and sort order (created, then
  // id) so API responses stay consistent whether they hit the store directly
  // or the cache.
  query(filter: CacheFilter = {}): TaskDoc[] {
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (filter.status !== undefined) {
      clauses.push('status = $status');
      params.$status = filter.status;
    }
    if (filter.kind !== undefined) {
      clauses.push('kind = $kind');
      params.$kind = filter.kind;
    }
    if (filter.parent !== undefined) {
      clauses.push('parent = $parent');
      params.$parent = filter.parent;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .query(`SELECT json FROM tasks ${where} ORDER BY created, id`)
      .all(params) as TaskRow[];
    return rows.map((row) => JSON.parse(row.json) as TaskDoc);
  }

  get(id: string): TaskDoc | null {
    const row = this.db
      .query('SELECT json FROM tasks WHERE id = $id')
      .get({ $id: id }) as TaskRow | null;
    return row !== null ? (JSON.parse(row.json) as TaskDoc) : null;
  }

  // Graph logic (blockers, priority ordering) stays in core's readyTasks — the
  // cache only supplies the current doc set, never reimplements the graph
  // rules in SQL.
  ready(): TaskDoc[] {
    return readyTasks(this.query());
  }
}
