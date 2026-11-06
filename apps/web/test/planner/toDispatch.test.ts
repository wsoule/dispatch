import { describe, expect, it } from 'bun:test';

import { createShowcaseWorkspace } from '../../src/planner/linear/showcase.js';
import { toDispatch } from '../../src/planner/toDispatch.js';

// A Linear workspace as the Dispatch task list the desktop's planning views
// read (apps/desktop/src/adapters/workspaceData.ts turns it back).

const NOW = '2026-11-06T12:00:00.000Z';
const data = createShowcaseWorkspace('2026-11-06');
const model = toDispatch(data, NOW);
const byKind = (kind: string) =>
  model.tasks.filter((t) => t.meta.kind === kind);
const ids = new Set(model.tasks.map((t) => t.meta.id));

describe('toDispatch', () => {
  it('makes one task per initiative, project, milestone and issue', () => {
    expect(byKind('initiative').length).toBe(data.initiatives.length);
    expect(byKind('project').length).toBe(data.projects.length);
    expect(byKind('milestone').length).toBe(data.milestones.length);
    expect(byKind('task').length).toBe(data.issues.length);
    expect(ids.size).toBe(model.tasks.length);
  });

  it('mints stable task ids the desktop accepts', () => {
    for (const id of ids) expect(id).toMatch(/^[te]-[0-9a-f]{10}$/);
    const again = toDispatch(createShowcaseWorkspace('2026-11-06'), NOW);
    expect(again.tasks.map((t) => t.meta.id)).toEqual(
      model.tasks.map((t) => t.meta.id)
    );
  });

  it('nests issues under milestone or project, milestones under projects, projects under initiatives', () => {
    const kindOf = new Map(model.tasks.map((t) => [t.meta.id, t.meta.kind]));
    for (const t of model.tasks) {
      const parent = t.meta.parent;
      if (parent === null) continue;
      expect(ids.has(parent)).toBe(true);
      const up = kindOf.get(parent);
      if (t.meta.kind === 'task')
        expect(up === 'milestone' || up === 'project').toBe(true);
      if (t.meta.kind === 'milestone') expect(up).toBe('project');
      if (t.meta.kind === 'project') expect(up).toBe('initiative');
    }
    const withMilestone = data.issues.filter(
      (i) => i.milestoneId !== null
    ).length;
    const underMilestone = byKind('task').filter(
      (t) => kindOf.get(t.meta.parent ?? '') === 'milestone'
    ).length;
    expect(underMilestone).toBe(withMilestone);
  });

  it('keeps every blocking relation between issues as blockedBy', () => {
    const edges = byKind('task').reduce(
      (n, t) => n + t.meta.blockedBy.length,
      0
    );
    expect(edges).toBe(data.relations.length);
    for (const t of model.tasks)
      for (const b of t.meta.blockedBy) expect(ids.has(b)).toBe(true);
  });

  it('turns workflow states into typed statuses that every task uses', () => {
    const names = model.statusDefinitions.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const state of data.states)
      expect(
        model.statusDefinitions.find((d) => d.name === state.name)?.type
      ).toBe(state.type);
    for (const t of model.tasks) expect(names).toContain(t.meta.status);
  });

  it('turns users into people, and issue assignees into their refs', () => {
    const refs = model.people.map((p) => p.ref);
    expect(new Set(refs).size).toBe(refs.length);
    for (const ref of refs) expect(ref).toMatch(/^human:[a-z0-9][a-z0-9._-]*$/);
    const assigned = data.issues.filter((i) => i.assigneeId !== null).length;
    expect(
      byKind('task').filter((t) => t.meta.assignee !== 'none').length
    ).toBe(assigned);
    for (const t of byKind('task'))
      if (t.meta.assignee !== 'none') expect(refs).toContain(t.meta.assignee);
    expect(
      model.people.find((p) => p.external === `linear:${data.users[0].id}`)
    ).toBeDefined();
  });

  it('links each issue back to Linear by identifier and url', () => {
    expect(Object.keys(model.links).length).toBe(data.issues.length);
    const first = data.issues[0];
    expect(model.links[first.id]).toEqual({
      identifier: first.identifier,
      url: first.url,
    });
    const task = byKind('task').find((t) => t.meta.title === first.title);
    expect(task?.meta.external).toBe(`linear:${first.id}`);
  });

  it('never leaves a date undefined', () => {
    for (const t of model.tasks) {
      expect(
        t.meta.dueDate === null || typeof t.meta.dueDate === 'string'
      ).toBe(true);
      expect(
        t.meta.startDate === null || typeof t.meta.startDate === 'string'
      ).toBe(true);
    }
  });

  it('carries priority, creation time and a project lead', () => {
    const issue = data.issues.find((i) => i.priority === 1)!;
    const task = byKind('task').find(
      (t) => t.meta.external === `linear:${issue.id}`
    )!;
    expect(task.meta.priority).toBe('urgent');
    expect(task.meta.created).toBe(issue.createdAt);
    const dated = data.issues.find((i) => typeof i.dueDate === 'string');
    if (dated !== undefined)
      expect(
        byKind('task').find((t) => t.meta.external === `linear:${dated.id}`)
          ?.meta.dueDate
      ).toBe(dated.dueDate ?? 'missing');
    const led = data.projects.find((p) => p.leadId !== null)!;
    const project = byKind('project').find((t) => t.meta.title === led.name)!;
    expect(project.meta.assignee).toMatch(/^human:/);
  });
});
