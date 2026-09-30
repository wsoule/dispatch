import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatMilestoneMigrationReport,
  migrateLegacyMilestones,
} from '../src/milestoneMigration.js';
import { openDispatchDb } from '../src/sqliteDb.js';
import { SqliteTaskStore } from '../src/sqliteTaskStore.js';
import { TaskStore } from '../src/store.js';
import type { TaskStorePort } from '../src/store.js';

// A board as the legacy milestone field left it: two milestones, an epic
// child that already has a parent, a task with none, and a stray project.
function fixture(store: TaskStorePort) {
  const epic = store.create({
    title: 'Auth epic',
    kind: 'epic',
    milestone: 'v1',
  });
  const child = store.create({
    title: 'Login',
    parent: epic.meta.id,
    milestone: 'v1',
  });
  const loose = store.create({ title: 'Docs', milestone: ' v1 ' });
  const other = store.create({ title: 'Billing', milestone: 'v2' });
  const plain = store.create({ title: 'No milestone' });
  const project = store.create({
    title: 'Elsewhere',
    kind: 'project',
    milestone: 'v2',
  });
  return { epic, child, loose, other, plain, project };
}

function eachBackend(run: (store: TaskStorePort) => void): void {
  run(TaskStore.init(mkdtempSync(join(tmpdir(), 'dispatch-milestones-'))));
  const db = openDispatchDb(':memory:');
  run(new SqliteTaskStore(mkdtempSync(join(tmpdir(), 'dispatch-ms-')), db));
  db.close();
}

describe('migrateLegacyMilestones', () => {
  it('dry-runs without writing and reports the plan', () => {
    eachBackend((store) => {
      const f = fixture(store);
      const before = JSON.stringify(store.list());
      const report = migrateLegacyMilestones(store, { dryRun: true });
      expect(JSON.stringify(store.list())).toBe(before);
      expect(report.tasksBefore).toBe(6);
      expect(report.tasksAfter).toBe(6);
      expect(report.projects.map((p) => [p.name, p.created])).toEqual([
        ['v1', true],
        ['v2', true],
      ]);
      expect(report.projectsCreated).toEqual([]);
      expect(report.reparented.map((r) => r.id).sort()).toEqual(
        [f.epic.meta.id, f.loose.meta.id, f.other.meta.id].sort()
      );
      expect(report.skipped).toEqual([
        {
          id: f.child.meta.id,
          milestone: 'v1',
          reason: `already has parent ${f.epic.meta.id}`,
        },
        {
          id: f.project.meta.id,
          milestone: 'v2',
          reason: 'a project cannot sit under a project',
        },
      ]);
      expect(formatMilestoneMigrationReport(report)).toContain('Parity: ok');
    });
  });

  it('migrates with count parity, then is a no-op on a second run', () => {
    eachBackend((store) => {
      const f = fixture(store);
      const first = migrateLegacyMilestones(store, { status: 'ready' });
      expect(first.tasksAfter).toBe(first.tasksBefore + 2);
      expect(first.parity).toBe(true);
      expect(first.projectsCreated).toHaveLength(2);
      const v1 = first.projects.find((p) => p.name === 'v1')!.projectId!;
      const v1Doc = store.get(v1)!;
      expect(v1Doc.meta.kind).toBe('project');
      expect(v1Doc.meta.title).toBe('v1');
      expect(store.get(f.epic.meta.id)!.meta.parent).toBe(v1);
      expect(store.get(f.loose.meta.id)!.meta.parent).toBe(v1);
      // The legacy field is kept, not cleared.
      expect(store.get(f.loose.meta.id)!.meta.milestone).toBe(' v1 ');
      expect(store.get(f.child.meta.id)!.meta.parent).toBe(f.epic.meta.id);
      expect(store.get(f.plain.meta.id)!.meta.parent).toBeNull();

      const second = migrateLegacyMilestones(store);
      expect(second.tasksAfter).toBe(second.tasksBefore);
      expect(second.projectsCreated).toEqual([]);
      expect(second.reparented).toEqual([]);
      expect(second.projects.every((p) => !p.created)).toBe(true);
      expect(
        second.skipped.filter((s) => s.reason === 'already under its project')
      ).toHaveLength(3);
      expect(second.parity).toBe(true);
    });
  });

  it('files a task whose value is a container id under that container', () => {
    // An older "+" stored the container's id in the legacy field, parent unset.
    eachBackend((store) => {
      const beta = store.create({ title: 'Beta', kind: 'milestone' });
      const issue = store.create({ title: 'Schema' });
      const made = store.create({ title: 'From +', milestone: beta.meta.id });
      const sub = store.create({ title: 'Sub', milestone: issue.meta.id });
      const project = store.create({
        title: 'Too broad',
        kind: 'project',
        milestone: beta.meta.id,
      });
      const first = migrateLegacyMilestones(store);
      expect(first.projects).toEqual([]);
      expect(first.tasksAfter).toBe(first.tasksBefore);
      expect(first.parity).toBe(true);
      expect(store.get(made.meta.id)!.meta.parent).toBe(beta.meta.id);
      expect(store.get(sub.meta.id)!.meta.parent).toBe(issue.meta.id);
      expect(first.skipped).toEqual([
        {
          id: project.meta.id,
          milestone: beta.meta.id,
          reason: 'a project cannot sit under a milestone',
        },
      ]);
      const second = migrateLegacyMilestones(store);
      expect(second.reparented).toEqual([]);
      expect(second.skipped.map((s) => s.reason).sort()).toEqual([
        'a project cannot sit under a milestone',
        'already under its milestone',
        'already under its task',
      ]);
    });
  });

  it('never files a task under its own sub-task', () => {
    eachBackend((store) => {
      const top = store.create({ title: 'Top' });
      const below = store.create({ title: 'Below', parent: top.meta.id });
      store.update(top.meta.id, { milestone: below.meta.id });
      const report = migrateLegacyMilestones(store);
      expect(store.get(top.meta.id)!.meta.parent).toBeNull();
      expect(report.skipped).toEqual([
        {
          id: top.meta.id,
          milestone: below.meta.id,
          reason: `${below.meta.id} sits under it`,
        },
      ]);
    });
  });

  it('orders by milestone name when creation times tie', () => {
    // Every task shares one timestamp, and the ids put the v2 tasks first, so
    // the store's own order (created, then id) is the reverse of name order.
    const ids = ['t-000001', 't-000002', 't-000003', 't-000004'];
    const db = openDispatchDb(':memory:');
    const store = new SqliteTaskStore(
      mkdtempSync(join(tmpdir(), 'dispatch-ms-tie-')),
      db,
      () => ids.shift() ?? 't-ffffff'
    );
    const now = '2026-09-23T12:00:00.000Z';
    const v2 = store.create({ title: 'Billing', milestone: 'v2' }, now);
    const v2Project = store.create(
      { title: 'Elsewhere', kind: 'project', milestone: 'v2' },
      now
    );
    const v1 = store.create({ title: 'Docs', milestone: 'v1' }, now);
    const v1Child = store.create(
      { title: 'Login', parent: v2.meta.id, milestone: 'v1' },
      now
    );

    const report = migrateLegacyMilestones(store, { dryRun: true });

    expect(report.projects.map((p) => p.name)).toEqual(['v1', 'v2']);
    expect(report.reparented.map((r) => r.id)).toEqual([
      v1.meta.id,
      v2.meta.id,
    ]);
    expect(report.skipped.map((s) => s.id)).toEqual([
      v1Child.meta.id,
      v2Project.meta.id,
    ]);
    db.close();
  });
});
