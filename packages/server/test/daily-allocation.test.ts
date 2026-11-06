import { FileCommentStore, TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AllocationRunStore } from '../src/planning/allocationRuns.js';
import {
  type AllocationDeps,
  applyAllocation,
  dailyRunDue,
} from '../src/planning/dailyAllocation.js';

// The daemon's daily allocation over a real file-backed project: Storefront
// (lead Ana) has a next milestone with a done-means line and one unassigned
// backlog issue; the run assigns it to Ana, moves it out of Backlog, comments
// why and logs a daily run. dailyRunDue gates it on the config, the hour and
// whether today already has a daily run.

function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

let root: string;
let store: TaskStore;
let runs: AllocationRunStore;
let issueId: string;
let changed: string[][];

function deps(now: Date = new Date()): AllocationDeps {
  return {
    rootDir: root,
    store,
    comments: new FileCommentStore(root),
    runs,
    actor: 'human:wyat',
    people: () => [{ ref: 'human:ana', name: 'Ana' }],
    changed: (ids) => changed.push(ids),
    now: () => now,
  };
}

function writeConfig(allocation: 'daily' | 'manual'): void {
  writeFileSync(
    join(root, '.dispatch', 'config.yml'),
    `planning:\n  allocation: ${allocation}\n`
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-daily-alloc-'));
  store = TaskStore.init(root);
  runs = new AllocationRunStore(join(root, 'runs.db'));
  changed = [];
  const project = store.create({
    title: 'Storefront',
    kind: 'project',
    status: 'working',
    assignee: 'human:ana',
  });
  const milestone = store.create({
    title: 'Beta',
    kind: 'milestone',
    parent: project.meta.id,
    dueDate: day(9),
    description: 'Done means: a guest can pay.',
  });
  issueId = store.create({
    title: 'Take payments',
    parent: milestone.meta.id,
    status: 'backlog',
    assignee: 'none',
  }).meta.id;
});

afterEach(() => {
  runs.close();
  rmSync(root, { recursive: true, force: true });
});

describe('applyAllocation', () => {
  it('assigns the issue to the lead, moves it out of Backlog, comments and logs a daily run', () => {
    writeConfig('daily');
    const run = applyAllocation(deps());
    const issue = store.get(issueId);
    expect(issue?.meta.assignee).toBe('human:ana');
    expect(issue?.meta.status).not.toBe('backlog');
    expect(new FileCommentStore(root).list(issueId)[0]?.body).toContain(
      'you lead Storefront'
    );
    expect(changed).toEqual([[issueId]]);
    expect(run.trigger).toBe('daily');
    expect(run.counts.assigned).toBe(1);
    expect(runs.list()[0]?.id).toBe(run.id);
  });

  it('finds nothing to do the second time', () => {
    writeConfig('daily');
    applyAllocation(deps());
    expect(applyAllocation(deps()).counts.assigned).toBe(0);
  });
});

describe('dailyRunDue', () => {
  const at = (hour: number) => {
    const d = new Date();
    d.setHours(hour, 5, 0, 0);
    return d;
  };

  it('is due from 8:00 when the project asks for it', () => {
    writeConfig('daily');
    expect(dailyRunDue(deps(), at(7))).toBe(false);
    expect(dailyRunDue(deps(), at(9))).toBe(true);
  });

  it('is never due when allocation is manual', () => {
    writeConfig('manual');
    expect(dailyRunDue(deps(), at(9))).toBe(false);
  });

  it('runs once a day: a daily run today makes it not due, a manual one does not', () => {
    writeConfig('daily');
    runs.record({ mode: 'dry_run', items: [], projects: [] }, 'human:wyat');
    expect(dailyRunDue(deps(), at(9))).toBe(true);
    applyAllocation(deps());
    expect(dailyRunDue(deps(), at(9))).toBe(false);
  });
});
