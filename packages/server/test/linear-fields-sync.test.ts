import {
  fieldHash,
  getSection,
  labelRef,
  loadConfig,
  MILESTONE_FIELDS,
  PROJECT_FIELDS,
  TaskStore,
  updateConfig,
  withLabelColor,
} from '@dispatch/core';
import type { LinearIssue, LinearUser } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus } from '../src/events.js';
import type { ServerEvent } from '../src/events.js';
import {
  readBase,
  readLinearState,
  writeBase,
  writeLinearState,
} from '../src/linear/state.js';
import { LinearSync } from '../src/linear/sync.js';
import { FakeLinearClient, STATES, TEAMMATE, VIEWER } from './linearFake.js';
import type { Method } from './linearFake.js';

let root: string;
let store: TaskStore;
let cache: TaskCache;
let events: EventBus;
let broadcasts: ServerEvent[];
let fake: FakeLinearClient;
const originalHome = process.env.DISPATCH_HOME;

function writeConfig(direction: 'both' | 'pull' | 'push' = 'both'): void {
  writeFileSync(
    join(root, '.dispatch', 'config.yml'),
    `statuses: [draft, ready, working, review, landing, landed, dropped]\nautoCommit: false\nlinear:\n  enabled: true\n  teamId: team-1\n  direction: ${direction}\n`
  );
}

function makeSync(): LinearSync {
  return new LinearSync({
    rootDir: root,
    store,
    cache,
    events,
    client: fake,
    localHumanRef: 'human:wyat',
  });
}

// Moves the clock on for a remote edit, the way Linear stamps a write.
function touch(issue: LinearIssue): void {
  issue.updatedAt = fake.stamp();
}

// An imported, fully linked pair: one remote issue and its task, with a
// merge base recorded for every field.
async function linkedPair(
  overrides: Partial<LinearIssue> = {}
): Promise<{ issue: LinearIssue; id: string; sync: LinearSync }> {
  const issue = fake.issue(overrides);
  fake.issues.push(issue);
  const sync = makeSync();
  await sync.importIssues();
  const doc = store
    .list()
    .find((d) => d.meta.external === `linear:${issue.id}`);
  if (doc === undefined) throw new Error('import did not link the issue');
  fake.created = [];
  fake.updated = [];
  fake.calls = [];
  return { issue, id: doc.meta.id, sync };
}

// A local edit a person makes, stamped after everything the sync recorded.
function edit(id: string, patch: Parameters<TaskStore['update']>[1]): void {
  store.update(id, patch, new Date(Date.now() + 1000).toISOString());
}

beforeEach(() => {
  process.env.DISPATCH_HOME = mkdtempSync(join(tmpdir(), 'dispatch-lfs-home-'));
  root = mkdtempSync(join(tmpdir(), 'dispatch-lfs-'));
  store = TaskStore.init(root);
  cache = new TaskCache();
  events = new EventBus();
  broadcasts = [];
  events.subscribe((event) => broadcasts.push(event));
  fake = new FakeLinearClient();
  fake.members = [VIEWER, TEAMMATE];
  writeConfig();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
});

describe('workflow states and people', () => {
  it('mirrors the team’s workflow as the project’s statuses on the first sync', async () => {
    const ready = store.create({ title: 'Specified', status: 'ready' });
    const working = store.create({ title: 'Going', status: 'working' });

    await makeSync().syncOnce();

    const config = loadConfig(root);
    expect(
      config.statusDefinitions?.map((d) => [d.name, d.type, d.color])
    ).toEqual(STATES.map((s) => [s.name, s.type, s.color ?? null]));
    expect(config.statusRoles).toEqual({
      ready: 'Todo',
      dispatched: 'In Progress',
      review: 'In Review',
      landing: null,
      landed: 'Done',
      dropped: 'Canceled',
    });
    // Existing tasks move onto the state the old status map pointed at, as
    // bookkeeping: their `updated` stays put.
    expect(store.get(ready.meta.id)?.meta.status).toBe('Todo');
    expect(store.get(working.meta.id)?.meta.status).toBe('In Progress');
    expect(store.get(ready.meta.id)?.meta.updated).toBe(ready.meta.updated);
    expect(broadcasts.some((e) => e.type === 'config.changed')).toBe(true);
  });

  it('keeps a role the user overrode, and follows a renamed state', async () => {
    await makeSync().syncOnce();
    updateConfig(root, {
      statusRoles: { ...loadConfig(root).statusRoles!, review: 'In Progress' },
    });
    const inReview = store.create({ title: 'Reviewing', status: 'In Review' });
    fake.states = STATES.map((s) =>
      s.id === 's-review' ? { ...s, name: 'Code Review' } : s
    );

    await makeSync().syncOnce();

    const config = loadConfig(root);
    expect(config.statuses).toContain('Code Review');
    expect(config.statuses).not.toContain('In Review');
    expect(config.statusRoles?.review).toBe('In Progress');
    expect(store.get(inReview.meta.id)?.meta.status).toBe('Code Review');
  });

  it('folds team members into people, the key’s own user as the local human', async () => {
    await makeSync().syncOnce();

    const people = loadConfig(root).people ?? [];
    expect(people.map((p) => [p.ref, p.external])).toEqual([
      ['human:wyat', 'linear:u-me'],
      ['human:ana', 'linear:u-ana'],
    ]);
  });

  it('round-trips a custom workflow state without collapsing it', async () => {
    const blocked = {
      id: 's-blocked',
      name: 'Blocked',
      type: 'started',
      position: 9,
    };
    fake.states = [...STATES, blocked];
    const { issue, id, sync } = await linkedPair({ state: blocked });
    expect(store.get(id)?.meta.status).toBe('Blocked');

    edit(id, { title: 'Renamed here' });
    await sync.syncOnce();
    expect(fake.updated.map((u) => u.input)).toEqual([
      { title: 'Renamed here' },
    ]);

    edit(id, { status: 'Todo' });
    await sync.syncOnce();
    edit(id, { status: 'Blocked' });
    await sync.syncOnce();
    expect(fake.updated.map((u) => u.input.stateId)).toEqual([
      undefined,
      's-todo',
      's-blocked',
    ]);
    expect(fake.issues.find((i) => i.id === issue.id)?.state?.name).toBe(
      'Blocked'
    );
  });
});

describe('field-level merge', () => {
  it('pushes only the field that changed locally', async () => {
    const { id, sync } = await linkedPair({ priority: 2 });
    edit(id, { title: 'Sharper title' });

    await sync.syncOnce();

    expect(fake.updated.map((u) => u.input)).toEqual([
      { title: 'Sharper title' },
    ]);
  });

  it('pulls a remote-only change without writing anything back', async () => {
    const { issue, id, sync } = await linkedPair({ priority: 2 });
    issue.priority = 1;
    touch(issue);

    const summary = await sync.syncOnce();

    expect(summary.pulled).toBe(1);
    expect(store.get(id)?.meta.priority).toBe('urgent');
    expect(fake.updated).toEqual([]);
  });

  it('lands both sides when they changed different fields', async () => {
    const { issue, id, sync } = await linkedPair({ priority: 2 });
    edit(id, { title: 'Local title' });
    issue.priority = 4;
    touch(issue);

    const summary = await sync.syncOnce();

    expect(summary.conflicts).toBe(0);
    expect(store.get(id)?.meta.priority).toBe('low');
    expect(store.get(id)?.meta.title).toBe('Local title');
    expect(fake.updated.map((u) => u.input)).toEqual([
      { title: 'Local title' },
    ]);
  });

  it('lets the newer edit win a field both sides changed, and notes it', async () => {
    const { issue, id, sync } = await linkedPair();
    edit(id, { title: 'Local rename' });
    issue.title = 'Remote rename';
    issue.updatedAt = new Date(Date.now() + 60_000).toISOString();

    const summary = await sync.syncOnce();

    expect(summary.conflicts).toBe(1);
    const doc = store.get(id);
    expect(doc?.meta.title).toBe('Remote rename');
    expect(getSection(doc?.body ?? '', 'Activity')).toContain(
      'title kept the Linear edit'
    );
    expect(fake.updated).toEqual([]);
    expect(sync.status().conflicts.total).toBe(1);
    expect(sync.status().conflicts.recent[0]).toMatchObject({
      taskId: id,
      field: 'title',
      kept: 'remote',
    });
  });

  it('pushes the local side of a conflict when it is the newer edit', async () => {
    const { issue, id, sync } = await linkedPair();
    issue.title = 'Remote rename';
    issue.updatedAt = new Date(Date.now() - 60_000).toISOString();
    store.update(
      id,
      { title: 'Local rename' },
      new Date(Date.now() + 120_000).toISOString()
    );

    await sync.syncOnce();

    expect(fake.updated.map((u) => u.input.title)).toEqual(['Local rename']);
  });

  it('does not re-apply or re-send its own write on the next pass', async () => {
    const { id, sync } = await linkedPair();
    edit(id, { title: 'Once' });
    await sync.syncOnce();
    fake.updated = [];

    const again = await sync.syncOnce();

    expect(again.pulled).toBe(0);
    expect(again.pushed).toBe(0);
    expect(fake.updated).toEqual([]);
  });

  it('costs one probe when nothing changed on either side', async () => {
    const { sync } = await linkedPair();
    await sync.syncOnce();
    fake.calls = [];

    await sync.syncOnce();

    expect(fake.calls).toEqual(['probe']);
  });
});

describe('labels', () => {
  it('creates a missing team label and sends the whole set', async () => {
    const { issue, id, sync } = await linkedPair();
    edit(id, { labels: ['web', 'perf'] });

    await sync.syncOnce();

    expect(fake.calls).toContain('createLabel');
    const perf = fake.labelList.find((l) => l.name === 'perf');
    expect(new Set(fake.updated[0].input.labelIds)).toEqual(
      new Set(['l-web', perf?.id ?? 'missing'])
    );
    expect(
      fake.issues
        .find((i) => i.id === issue.id)
        ?.labels.map((l) => l.name)
        .sort()
    ).toEqual(['perf', 'web']);
  });

  it('takes a label removed in Linear off the task', async () => {
    const { issue, id, sync } = await linkedPair();
    issue.labels = [];
    touch(issue);

    await sync.syncOnce();

    expect(store.get(id)?.meta.labels).toEqual([]);
  });
});

describe('label registry', () => {
  function registry() {
    return (loadConfig(root).labels ?? []).map((l) => [
      labelRef(l),
      l.color,
      l.external,
    ]);
  }

  function recolor(ref: string, color: string): void {
    updateConfig(root, {
      labels: withLabelColor(loadConfig(root).labels ?? [], ref, color),
    });
  }

  it('registers the team’s labels with their colors on the first sync', async () => {
    fake.labelList = [
      { id: 'l-web', name: 'web', color: '#5e6ad2', teamId: 'team-1' },
      {
        id: 'l-bug',
        name: 'Bug',
        color: '#eb5757',
        group: 'Type',
        teamId: null,
      },
    ];
    await makeSync().syncOnce();
    expect(registry()).toEqual([
      ['web', '#5e6ad2', 'linear:l-web'],
      ['Type/Bug', '#eb5757', 'linear:l-bug'],
    ]);
  });

  it('pushes a local recolor once, and pulls a color Linear changed', async () => {
    fake.labelList = [
      { id: 'l-web', name: 'web', color: '#5e6ad2', teamId: 'team-1' },
    ];
    const sync = makeSync();
    await sync.syncOnce();
    recolor('web', '#0f783c');

    await sync.syncOnce();
    expect(fake.calls.filter((c) => c === 'updateLabel')).toHaveLength(1);
    expect(fake.labelList[0]?.color).toBe('#0f783c');
    // The next pass reads the label back as written, not as first cached.
    await sync.syncOnce();
    expect(fake.calls.filter((c) => c === 'updateLabel')).toHaveLength(1);
    expect(registry()).toEqual([['web', '#0f783c', 'linear:l-web']]);

    fake.labelList = [{ ...fake.labelList[0], color: '#f2c94c' }];
    // An import refreshes the cached workspace, labels included.
    await sync.importIssues();
    expect(registry()).toEqual([['web', '#f2c94c', 'linear:l-web']]);
  });

  it('pushes the registry’s colors from a push-only project', async () => {
    writeConfig('push');
    updateConfig(root, { labels: [{ name: 'web', color: '#111111' }] });
    fake.labelList = [
      { id: 'l-web', name: 'web', color: '#222222', teamId: 'team-1' },
    ];
    const sync = makeSync();
    await sync.syncOnce();
    expect(fake.labelList[0]?.color).toBe('#111111');

    recolor('web', '#333333');
    await sync.syncOnce();
    expect(fake.labelList[0]?.color).toBe('#333333');
    expect(fake.calls.filter((c) => c === 'updateLabel')).toHaveLength(2);
  });

  it('retries a recolor Linear refused', async () => {
    fake.labelList = [
      { id: 'l-web', name: 'web', color: '#5e6ad2', teamId: 'team-1' },
    ];
    const sync = makeSync();
    await sync.syncOnce();
    recolor('web', '#0f783c');
    fake.failures.updateLabel = {
      ok: false,
      kind: 'graphql',
      error: 'not allowed',
    };
    await sync.syncOnce();
    expect(readLinearState(root).labelColors['l-web']).toBe('#5e6ad2');
    delete fake.failures.updateLabel;
    await sync.syncOnce();
    expect(fake.labelList[0]?.color).toBe('#0f783c');
  });

  it('folds a local-only entry into a Linear label renamed onto it', async () => {
    updateConfig(root, { labels: [{ name: 'feature', color: '#00ff00' }] });
    fake.labelList = [
      { id: 'l-d', name: 'Defect', color: '#eb5757', teamId: 'team-1' },
    ];
    const { issue, id } = await linkedPair({ title: 'before', labels: [] });

    fake.labelList = [{ ...fake.labelList[0], name: 'Feature' }];
    issue.title = 'after';
    touch(issue);
    // A fresh engine reads the renamed label, as after a restart.
    const summary = await makeSync().syncOnce();

    expect(summary.errors).toEqual([]);
    expect(store.get(id)?.meta.title).toBe('after');
    expect(registry()).toEqual([['Feature', '#eb5757', 'linear:l-d']]);
  });

  it('reports a registry it cannot write and still runs the pass', async () => {
    const { issue, id } = await linkedPair({ title: 'before' });
    // A color the registry refuses, so the labels: write is rejected.
    fake.labelList = [
      { id: 'l-odd', name: 'odd', color: 'not-a-color', teamId: 'team-1' },
    ];
    issue.title = 'after';
    touch(issue);
    const summary = await makeSync().syncOnce();

    expect(summary.errors.join('\n')).toContain('label registry not updated');
    expect(readLinearState(root).lastError).toContain(
      'label registry not updated'
    );
    expect(store.get(id)?.meta.title).toBe('after');
  });

  it('creates a missing label in the registry’s color', async () => {
    const { id, sync } = await linkedPair();
    recolor('perf', '#26b5ce');
    edit(id, { labels: ['web', 'perf'] });

    await sync.syncOnce();

    expect(fake.labelList.find((l) => l.name === 'perf')?.color).toBe(
      '#26b5ce'
    );
  });
});

describe('archive', () => {
  it('archives in Linear, and unarchives here, both ways', async () => {
    const { issue, id, sync } = await linkedPair();
    edit(id, { archivedAt: new Date().toISOString() });
    await sync.syncOnce();
    expect(fake.calls).toContain('archiveIssue');
    expect(
      fake.issues.find((i) => i.id === issue.id)?.archivedAt
    ).not.toBeNull();

    const remote = fake.issues.find((i) => i.id === issue.id);
    if (remote === undefined) throw new Error('issue vanished');
    remote.archivedAt = null;
    touch(remote);
    await sync.syncOnce();
    expect(store.get(id)?.meta.archivedAt).toBeUndefined();
  });

  it('leaves a finished task’s archive to Linear’s own schedule', async () => {
    const done = STATES.find((s) => s.name === 'Done') ?? null;
    const { id, sync } = await linkedPair({ state: done });
    edit(id, { archivedAt: new Date().toISOString() });

    await sync.syncOnce();

    expect(fake.calls).not.toContain('archiveIssue');
  });
});

describe('project statuses by name', () => {
  const PAUSED = { id: 'ps-paused', name: 'Paused', type: 'paused' };

  function projectTask(projectId: string) {
    const doc = store
      .list()
      .find((d) => d.meta.external === `linear-project:${projectId}`);
    if (doc === undefined) throw new Error('project not imported');
    return doc;
  }

  it('shows a paused project as the team’s Paused state, and resumes it by name', async () => {
    fake.states = [
      ...STATES,
      { id: 's-paused', name: 'Paused', type: 'backlog', position: 1 },
    ];
    const project = fake.project({ status: PAUSED });
    fake.projectList = [project];
    const sync = makeSync();
    await sync.importIssues();
    const id = projectTask(project.id).meta.id;
    expect(store.get(id)?.meta.status).toBe('Paused');

    edit(id, { status: 'In Progress' });
    await sync.syncOnce();
    expect(fake.projectList[0]?.status?.id).toBe('ps-started');
  });

  it('never unpauses a project when upgrading a base kept by category', async () => {
    const project = fake.project({ status: PAUSED });
    fake.projectList = [project];
    const sync = makeSync();
    await sync.importIssues();
    const id = projectTask(project.id).meta.id;
    // No Paused state here: the project reads as started locally.
    expect(store.get(id)?.meta.status).toBe('In Progress');
    // Rewind the base to the category-only value space.
    const state = readLinearState(root);
    const base = readBase(state, id, 'project');
    if (base === null) throw new Error('no base');
    base.local.status = fieldHash('started');
    base.remote.status = fieldHash('started');
    writeBase(state, id, 'project', PROJECT_FIELDS, base);
    delete state.baseVersion;
    writeLinearState(root, state);
    fake.projectList[0].name = 'Renamed there';
    fake.projectList[0].updatedAt = fake.stamp();
    fake.calls = [];

    await sync.syncOnce();

    expect(store.get(id)?.meta.title).toBe('Renamed there');
    expect(fake.calls).not.toContain('updateProject');
    expect(fake.projectList[0]?.status?.id).toBe('ps-paused');
  });
});

describe('relations and hierarchy', () => {
  it('pushes a blocker added here as a relation, and deletes it when removed', async () => {
    const blocker = fake.issue({ title: 'Blocker' });
    fake.issues.push(blocker);
    const { issue, id, sync } = await linkedPair({ title: 'Blocked one' });
    const blockerTask = store
      .list()
      .find((d) => d.meta.external === `linear:${blocker.id}`);

    edit(id, { blockedBy: [blockerTask?.meta.id ?? ''] });
    await sync.syncOnce();
    const remote = fake.issues.find((i) => i.id === issue.id);
    expect(remote?.relations).toMatchObject([
      { type: 'blocks', issueId: blocker.id, relatedIssueId: issue.id },
    ]);

    edit(id, { blockedBy: [] });
    await sync.syncOnce();
    expect(fake.calls).toContain('deleteRelation');
    expect(fake.issues.find((i) => i.id === issue.id)?.relations).toEqual([]);
  });

  it('imports initiatives, projects, milestones, issues and sub-issues as one tree', async () => {
    const initiative = fake.initiative({ name: 'Grow' });
    fake.initiativeList = [initiative];
    const project = fake.project({
      name: 'Checkout',
      initiatives: [{ id: 'i2p', initiativeId: initiative.id }],
    });
    fake.projectList = [project];
    fake.milestoneList = [
      {
        id: 'ms-1',
        name: 'Beta',
        description: null,
        targetDate: '2026-09-01',
        sortOrder: 2,
        projectId: project.id,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
        archivedAt: null,
      },
    ];
    const parent = fake.issue({
      title: 'Parent',
      projectId: project.id,
      projectMilestoneId: 'ms-1',
    });
    const child = fake.issue({
      title: 'Child',
      parentId: parent.id,
      projectId: project.id,
      projectMilestoneId: 'ms-1',
    });
    fake.issues = [child, parent];

    const sync = makeSync();
    await sync.importIssues();

    const byTitle = new Map(store.list().map((d) => [d.meta.title, d.meta]));
    expect(byTitle.get('Grow')?.kind).toBe('initiative');
    expect(byTitle.get('Checkout')?.kind).toBe('project');
    expect(byTitle.get('Checkout')?.parent).toBe(byTitle.get('Grow')?.id);
    expect(byTitle.get('Beta')?.kind).toBe('milestone');
    expect(byTitle.get('Beta')?.parent).toBe(byTitle.get('Checkout')?.id);
    expect(byTitle.get('Beta')?.dueDate).toBe('2026-09-01');
    expect(byTitle.get('Parent')?.parent).toBe(byTitle.get('Beta')?.id);
    expect(byTitle.get('Child')?.parent).toBe(byTitle.get('Parent')?.id);
    expect(byTitle.get('Beta')?.sortOrder).toBe(2);

    // Reordering the milestone in Linear moves it here too.
    const beta = fake.milestoneList[0];
    beta.sortOrder = -1;
    beta.updatedAt = fake.stamp();
    await sync.syncOnce();
    expect(store.get(byTitle.get('Beta')?.id ?? '')?.meta.sortOrder).toBe(-1);
  });

  it('reads every linked milestone once after the upgrade that added its order', async () => {
    const project = fake.project({ name: 'Checkout' });
    fake.projectList = [project];
    fake.milestoneList = [
      {
        id: 'ms-1',
        name: 'Beta',
        description: null,
        targetDate: null,
        sortOrder: 7,
        projectId: project.id,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
        archivedAt: null,
      },
    ];
    const sync = makeSync();
    await sync.importIssues();
    const beta = store.list().find((d) => d.meta.title === 'Beta');
    if (beta === undefined) throw new Error('no milestone');
    // Rewind to a link made before sortOrder: no local order, none in the base.
    store.update(beta.meta.id, { sortOrder: null }, beta.meta.updated);
    const state = readLinearState(root);
    const base = readBase(state, beta.meta.id, 'milestone');
    if (base === null) throw new Error('no base');
    delete base.local.sortOrder;
    delete base.remote.sortOrder;
    writeBase(state, beta.meta.id, 'milestone', MILESTONE_FIELDS, base);
    state.baseVersion = 3;
    state.echoes = [];
    writeLinearState(root, state);
    // One the cursor has passed with no task here (deleted locally, say).
    fake.milestoneList.push({
      ...fake.milestoneList[0],
      id: 'ms-2',
      name: 'Old',
    });

    await sync.syncOnce();

    expect(store.get(beta.meta.id)?.meta.sortOrder).toBe(7);
    expect(store.list().map((d) => d.meta.title)).not.toContain('Old');
    expect(readLinearState(root).milestoneWalk).toBeUndefined();
    // The walk happens once: later passes read from the cursor again.
    fake.calls = [];
    await sync.syncOnce();
    expect(fake.calls).not.toContain('projectMilestones');
  });

  it('publishes a legacy epic as a parent issue with its tasks as sub-issues', async () => {
    const sync = makeSync();
    await sync.syncOnce();
    const epic = store.create(
      { title: 'Epic', kind: 'milestone' },
      new Date(Date.now() + 1000).toISOString()
    );
    store.create(
      { title: 'Part one', parent: epic.meta.id },
      new Date(Date.now() + 2000).toISOString()
    );

    await sync.syncOnce();

    const epicIssue = fake.issues.find((i) => i.title === 'Epic');
    const part = fake.issues.find((i) => i.title === 'Part one');
    expect(epicIssue).toBeDefined();
    expect(part?.parentId).toBe(epicIssue?.id);
    expect(store.get(epic.meta.id)?.meta.external).toBe(
      `linear:${epicIssue?.id}`
    );
  });

  it('creates a project, its milestone and an issue inside both', async () => {
    const sync = makeSync();
    await sync.syncOnce();
    const at = (n: number) => new Date(Date.now() + n * 1000).toISOString();
    const project = store.create({ title: 'Launch', kind: 'project' }, at(1));
    const milestone = store.create(
      { title: 'M1', kind: 'milestone', parent: project.meta.id },
      at(2)
    );
    store.create({ title: 'Do it', parent: milestone.meta.id }, at(3));

    await sync.syncOnce();

    const remoteProject = fake.projectList.find((p) => p.name === 'Launch');
    const remoteMilestone = fake.milestoneList.find((m) => m.name === 'M1');
    const issue = fake.issues.find((i) => i.title === 'Do it');
    expect(remoteProject?.teamIds).toEqual(['team-1']);
    expect(remoteMilestone?.projectId).toBe(remoteProject?.id);
    expect(issue?.projectId).toBe(remoteProject?.id);
    expect(issue?.projectMilestoneId).toBe(remoteMilestone?.id);
    expect(store.get(project.meta.id)?.meta.external).toBe(
      `linear-project:${remoteProject?.id}`
    );
    expect(store.get(milestone.meta.id)?.meta.external).toBe(
      `linear-milestone:${remoteMilestone?.id}`
    );
  });

  it('gives a milestone made here the order Linear assigns it', async () => {
    const sync = makeSync();
    await sync.syncOnce();
    const at = (n: number) => new Date(Date.now() + n * 1000).toISOString();
    const project = store.create({ title: 'Launch', kind: 'project' }, at(1));
    const ids = ['M1', 'M2'].map(
      (title, i) =>
        store.create(
          { title, kind: 'milestone', parent: project.meta.id },
          at(2 + i)
        ).meta.id
    );

    await sync.syncOnce();
    fake.calls = [];
    await sync.syncOnce();

    const orders = ['M1', 'M2'].map(
      (name) => fake.milestoneList.find((m) => m.name === name)?.sortOrder
    );
    expect(orders).toEqual([0, 1]);
    expect(ids.map((id) => store.get(id)?.meta.sortOrder)).toEqual(orders);
    expect(fake.calls).not.toContain('updateMilestone');
  });

  it('maps assignee and creator onto people refs', async () => {
    const { id } = await linkedPair({
      assigneeId: TEAMMATE.id,
      creatorId: VIEWER.id,
    });
    const meta = store.get(id)?.meta;
    expect(meta?.assignee).toBe('human:ana');
    expect(meta?.creator).toBe('human:wyat');
  });

  describe('an assignee the registry could not name', () => {
    const GUEST: LinearUser = {
      id: 'u-gus',
      name: 'Gus Guest',
      displayName: 'gus',
      email: 'gus@example.com',
      avatarUrl: null,
      active: true,
    };

    // Imported while the lookup that would name Gus fails.
    async function heldPair() {
      fake.failures.users = { ok: false, kind: 'network', error: 'offline' };
      const pair = await linkedPair({ assigneeId: GUEST.id });
      delete fake.failures.users;
      expect(store.get(pair.id)?.meta.assignee).toBe('human:linear-user');
      return pair;
    }

    function nameGus(): void {
      updateConfig(root, {
        people: [
          ...(loadConfig(root).people ?? []),
          { ref: 'human:gus', name: 'Gus', external: `linear:${GUEST.id}` },
        ],
      });
    }

    // A person reassigns the task to Ana the first time the pass calls `method`.
    function reassignDuring(id: string, method: Method): void {
      fake.onCall = (called) => {
        if (called !== method) return;
        fake.onCall = null;
        edit(id, { assignee: 'human:ana' });
      };
    }

    it('becomes the person once the registry names them, as a pull', async () => {
      const { issue, id, sync } = await heldPair();
      // Nobody new to name: the issue is not read again.
      await sync.syncOnce();
      expect(fake.calls).not.toContain('issuesByIds');
      expect(store.get(id)?.meta.assignee).toBe('human:linear-user');

      nameGus();
      await sync.syncOnce();

      const meta = store.get(id)?.meta;
      expect(meta?.assignee).toBe('human:gus');
      // Linear already had Gus: nothing goes back, and the pull left no
      // local edit for a later pass to send.
      expect(fake.updated).toEqual([]);
      expect(readLinearState(root).pushed[id]).toBe(meta?.updated ?? '');
      await sync.syncOnce();
      expect(fake.updated).toEqual([]);
      expect(issue.assigneeId).toBe(GUEST.id);
    });

    it('becomes the person when a users sync brings them onto the team', async () => {
      const { id } = await heldPair();
      fake.members = [VIEWER, TEAMMATE, GUEST];

      await makeSync().syncOnce();

      expect(store.get(id)?.meta.assignee).toBe('human:gus');
      expect(fake.updated).toEqual([]);
    });

    it('keeps a reassignment made while the pass re-reads the issue', async () => {
      const { issue, id, sync } = await heldPair();
      nameGus();
      reassignDuring(id, 'issuesByIds');

      await sync.syncOnce();

      expect(store.get(id)?.meta.assignee).toBe('human:ana');
      expect(fake.updated).toEqual([
        { id: issue.id, input: { assigneeId: TEAMMATE.id } },
      ]);
    });

    it('keeps a reassignment made while the pull reads the team', async () => {
      const { issue, id, sync } = await heldPair();
      nameGus();
      // Changed in Linear, so the pull itself meets the placeholder.
      issue.title = 'Renamed in Linear';
      issue.updatedAt = fake.stamp();
      reassignDuring(id, 'projects');

      await sync.syncOnce();

      const meta = store.get(id)?.meta;
      expect(meta?.title).toBe('Renamed in Linear');
      expect(meta?.assignee).toBe('human:ana');
      expect(fake.updated).toEqual([
        { id: issue.id, input: { assigneeId: TEAMMATE.id } },
      ]);
    });
  });
});

describe('team moves and deletions', () => {
  function auditDue(): void {
    const state = readLinearState(root);
    state.lastAuditAt = null;
    writeLinearState(root, state);
  }

  it('unlinks an issue that left the team, and links it again when it comes back', async () => {
    const { issue, id, sync } = await linkedPair();
    const remote = fake.issues.find((i) => i.id === issue.id);
    if (remote === undefined) throw new Error('issue vanished');
    remote.team = { id: 'team-2', key: 'OPS' };
    touch(remote);
    auditDue();

    await sync.syncOnce();
    expect(store.get(id)?.meta.external).toBeNull();
    expect(getSection(store.get(id)?.body ?? '', 'Activity')).toContain(
      'moved to OPS'
    );
    expect(readLinearState(root).movedOut[issue.id]).toBe(id);

    remote.team = { id: 'team-1', key: 'HYD' };
    touch(remote);
    await sync.syncOnce();
    expect(store.get(id)?.meta.external).toBe(`linear:${issue.id}`);
    expect(store.list()).toHaveLength(1);
  });

  it('archives and unlinks a task whose issue was deleted in Linear', async () => {
    const { issue, id, sync } = await linkedPair();
    fake.issues = fake.issues.filter((i) => i.id !== issue.id);
    auditDue();

    await sync.syncOnce();

    const meta = store.get(id)?.meta;
    expect(meta?.external).toBeNull();
    expect(meta?.archivedAt).toBeDefined();
  });
});

describe('directions', () => {
  it('keeps a pull-only project’s local edits until it may push', async () => {
    writeConfig('pull');
    const { id, sync } = await linkedPair();
    edit(id, { title: 'Waiting to go' });
    await sync.syncOnce();
    expect(fake.updated).toEqual([]);

    writeConfig('both');
    await sync.syncOnce([id]);
    expect(fake.updated.map((u) => u.input.title)).toEqual(['Waiting to go']);
  });
});

describe('the poll timer’s pass', () => {
  // Counts full reads of the task store, the cost an idle poll must skip.
  function countReads(): () => number {
    let reads = 0;
    const listSafe = store.listSafe.bind(store);
    store.listSafe = (filter) => {
      reads++;
      return listSafe(filter);
    };
    return () => reads;
  }

  it('ends at one probe, without reading the store, when nothing moved', async () => {
    const { sync } = await linkedPair();
    sync.start();
    await sync.pollOnce();
    const reads = countReads();
    fake.calls = [];
    broadcasts = [];

    await sync.pollOnce();

    expect(fake.calls).toEqual(['probe']);
    expect(reads()).toBe(0);
    expect(broadcasts.some((e) => e.type === 'linear.changed')).toBe(false);
    await sync.stop();
  });

  it('runs a full pass once something local changed', async () => {
    const { id, sync } = await linkedPair();
    sync.start();
    await sync.pollOnce();
    edit(id, { title: 'Edited here' });
    sync.notifyTaskChanged();

    await sync.pollOnce();

    expect(fake.updated.map((u) => u.input.title)).toEqual(['Edited here']);
    await sync.stop();
  });

  it('pulls when the probe finds a change in Linear', async () => {
    const { issue, id, sync } = await linkedPair();
    sync.start();
    await sync.pollOnce();
    issue.title = 'Renamed there';
    touch(issue);

    await sync.pollOnce();

    expect(store.get(id)?.meta.title).toBe('Renamed there');
    await sync.stop();
  });
});
