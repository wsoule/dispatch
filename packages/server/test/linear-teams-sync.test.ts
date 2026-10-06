import {
  fieldHash,
  getSection,
  ISSUE_FIELDS,
  loadConfig,
  TaskStore,
} from '@dispatch-foo/core';
import type { LinearIssue, LinearWorkflowState } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus } from '../src/events.js';
import {
  readBase,
  readLinearState,
  webhookHooks,
  writeBase,
  writeLinearState,
} from '../src/linear/state.js';
import { LinearSync } from '../src/linear/sync.js';
import { FakeLinearClient, STATES, VIEWER } from './linearFake.js';

// Two linked teams: Hydrogen (team-1) on the fake's stock workflow, and Ops
// (team-2) on one of its own, sharing Todo/In Progress/Done by name and type
// and adding a Design state.
const OPS_STATES: LinearWorkflowState[] = [
  { id: 'o-todo', name: 'Todo', type: 'unstarted', position: 0 },
  { id: 'o-progress', name: 'In Progress', type: 'started', position: 0 },
  { id: 'o-design', name: 'Design', type: 'started', position: 1 },
  { id: 'o-done', name: 'Done', type: 'completed', position: 0 },
  { id: 'o-canceled', name: 'Canceled', type: 'canceled', position: 0 },
];
const OPS = { id: 'team-2', key: 'OPS' };

let root: string;
let store: TaskStore;
let fake: FakeLinearClient;
const originalHome = process.env.DISPATCH_HOME;

function writeConfig(teams = '[team-1, team-2]', extra = ''): void {
  writeFileSync(
    join(root, '.dispatch', 'config.yml'),
    `autoCommit: false\nlinear:\n  enabled: true\n  teamIds: ${teams}\n${extra}`
  );
}

function makeSync(webhookUrl: string | null = null): LinearSync {
  return new LinearSync({
    rootDir: root,
    store,
    cache: new TaskCache(),
    events: new EventBus(),
    client: fake,
    localHumanRef: 'human:wyat',
    webhookUrl,
  });
}

function stateOf(id: string): LinearWorkflowState {
  const state = [...STATES, ...OPS_STATES].find((s) => s.id === id);
  if (state === undefined) throw new Error(`no state ${id}`);
  return state;
}

function taskFor(issue: LinearIssue) {
  return store.list().find((d) => d.meta.external === `linear:${issue.id}`);
}

function remote(issue: LinearIssue): LinearIssue {
  const found = fake.issues.find((i) => i.id === issue.id);
  if (found === undefined) throw new Error('issue vanished');
  return found;
}

beforeEach(() => {
  process.env.DISPATCH_HOME = mkdtempSync(join(tmpdir(), 'dispatch-lts-home-'));
  root = mkdtempSync(join(tmpdir(), 'dispatch-lts-'));
  store = TaskStore.init(root);
  fake = new FakeLinearClient();
  fake.members = [VIEWER];
  fake.teamList = [
    { id: 'team-1', key: 'HYD', name: 'Hydrogen' },
    { id: 'team-2', key: 'OPS', name: 'Ops' },
  ];
  fake.teamStates = { 'team-2': OPS_STATES };
  writeConfig();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
});

describe('several linked teams', () => {
  it('imports every team’s issues onto one merged status vocabulary', async () => {
    const hyd = fake.issue({
      title: 'Hydrogen work',
      state: stateOf('s-progress'),
    });
    const ops = fake.issue({
      title: 'Ops work',
      identifier: 'OPS-7',
      team: OPS,
      state: stateOf('o-design'),
    });
    fake.issues = [hyd, ops];

    await makeSync().importIssues();

    const config = loadConfig(root);
    expect(config.statuses).toEqual([
      'Backlog',
      'Todo',
      'In Progress',
      'Design',
      'In Review',
      'Done',
      'Canceled',
    ]);
    expect(taskFor(hyd)?.meta.status).toBe('In Progress');
    expect(taskFor(ops)?.meta.status).toBe('Design');
    expect(fake.calls.filter((c) => c === 'workspace')).toHaveLength(2);
  });

  it('follows an issue moved between linked teams instead of unlinking it', async () => {
    const issue = fake.issue({ state: stateOf('s-progress') });
    fake.issues = [issue];
    const sync = makeSync();
    await sync.importIssues();
    const id = taskFor(issue)?.meta.id ?? '';

    // Linear moves it to Ops, onto Ops' own In Progress.
    const moved = remote(issue);
    moved.team = OPS;
    moved.identifier = 'OPS-12';
    moved.state = stateOf('o-progress');
    moved.updatedAt = fake.stamp();
    const state = readLinearState(root);
    state.lastAuditAt = null;
    writeLinearState(root, state);
    fake.updated = [];
    const summary = await sync.syncOnce();

    const task = store.get(id);
    expect(task?.meta.external).toBe(`linear:${issue.id}`);
    expect(task?.meta.status).toBe('In Progress');
    expect(getSection(task?.body ?? '', 'Activity')).not.toContain('Unlinked');
    expect(summary.conflicts).toBe(0);
    expect(fake.updated).toEqual([]);
    expect(sync.links()[issue.id]?.identifier).toBe('OPS-12');

    // A status set here now goes up as Ops' own state.
    store.update(
      id,
      { status: 'Done' },
      new Date(Date.now() + 1000).toISOString()
    );
    await sync.syncOnce();
    expect(fake.updated.map((u) => u.input.stateId)).toEqual(['o-done']);
  });

  it('unlinks an issue only once it leaves every linked team', async () => {
    const issue = fake.issue({ team: OPS, identifier: 'OPS-3' });
    fake.issues = [issue];
    const sync = makeSync();
    await sync.importIssues();
    const id = taskFor(issue)?.meta.id ?? '';

    const moved = remote(issue);
    moved.team = { id: 'team-3', key: 'SEC' };
    moved.updatedAt = fake.stamp();
    const state = readLinearState(root);
    state.lastAuditAt = null;
    writeLinearState(root, state);
    await sync.syncOnce();

    expect(store.get(id)?.meta.external).toBeNull();
    expect(getSection(store.get(id)?.body ?? '', 'Activity')).toContain(
      'moved to SEC'
    );
  });

  it('pushes a status another team brought as the issue’s team’s state of that type', async () => {
    const issue = fake.issue({ state: stateOf('s-todo') });
    fake.issues = [issue];
    const sync = makeSync();
    await sync.importIssues();
    const id = taskFor(issue)?.meta.id ?? '';

    // Design is Ops' alone; Hydrogen's first started state stands in.
    store.update(
      id,
      { status: 'Design' },
      new Date(Date.now() + 1000).toISOString()
    );
    await sync.syncOnce();

    expect(fake.updated.map((u) => u.input.stateId)).toEqual(['s-progress']);
    // Linear now reads In Progress, and nothing flips back on the next pass.
    fake.updated = [];
    await sync.syncOnce();
    expect(fake.updated).toEqual([]);
    expect(store.get(id)?.meta.status).toBe('Design');
  });

  // A Hydrogen and an Ops issue, both on the Todo status the teams share.
  async function sharedTodo(): Promise<[LinearIssue, LinearIssue]> {
    const hyd = fake.issue({ title: 'hyd', state: stateOf('s-todo') });
    const ops = fake.issue({
      title: 'ops',
      identifier: 'OPS-1',
      team: OPS,
      state: stateOf('o-todo'),
    });
    fake.issues = [hyd, ops];
    await makeSync().importIssues();
    expect(taskFor(hyd)?.meta.status).toBe('Todo');
    expect(taskFor(ops)?.meta.status).toBe('Todo');
    return [hyd, ops];
  }

  it('moves only the renaming team’s tasks off a status two teams share', async () => {
    const [hyd, ops] = await sharedTodo();

    // Ops renames its Todo; a fresh engine re-reads the teams' workflows.
    const ready = { ...stateOf('o-todo'), name: 'Ready' };
    fake.teamStates['team-2'] = OPS_STATES.map((s) =>
      s.id === ready.id ? ready : s
    );
    remote(ops).state = ready;
    fake.updated = [];
    await makeSync().syncOnce();

    expect(taskFor(hyd)?.meta.status).toBe('Todo');
    expect(taskFor(ops)?.meta.status).toBe('Ready');
    expect(fake.updated).toEqual([]);
  });

  it('keeps the other team’s tasks when the primary renames a shared status', async () => {
    const [hyd, ops] = await sharedTodo();

    const queued = { ...stateOf('s-todo'), name: 'Queued' };
    fake.states = STATES.map((s) => (s.id === queued.id ? queued : s));
    remote(hyd).state = queued;
    fake.updated = [];
    await makeSync().syncOnce();

    expect(taskFor(hyd)?.meta.status).toBe('Queued');
    expect(taskFor(ops)?.meta.status).toBe('Todo');
    expect(fake.updated).toEqual([]);
  });

  it('keeps the primary’s lifecycle roles when a team whose board leads with its own states is linked', async () => {
    // Ops lists Design and Shipped first among its started and completed.
    fake.teamStates['team-2'] = [
      { id: 'o-todo', name: 'Todo', type: 'unstarted', position: 0 },
      { id: 'o-design', name: 'Design', type: 'started', position: 0 },
      { id: 'o-progress', name: 'In Progress', type: 'started', position: 1 },
      { id: 'o-shipped', name: 'Shipped', type: 'completed', position: 0 },
      { id: 'o-done', name: 'Done', type: 'completed', position: 1 },
    ];
    writeConfig('[team-1]');
    const sync = makeSync();
    await sync.syncOnce();
    const alone = loadConfig(root).statusRoles;
    expect(alone?.dispatched).toBe('In Progress');

    writeConfig();
    await sync.syncOnce();

    const linked = loadConfig(root);
    expect(linked.statuses).toContain('Design');
    expect(linked.statuses).toContain('Shipped');
    expect(linked.statusRoles).toEqual(alone);
  });

  it('creates a sub-issue in its parent’s team, other work in the primary', async () => {
    const parent = fake.issue({ team: OPS, identifier: 'OPS-1' });
    fake.issues = [parent];
    const sync = makeSync();
    await sync.importIssues();
    const parentId = taskFor(parent)?.meta.id ?? '';
    const later = new Date(Date.now() + 1000).toISOString();
    store.create({ title: 'Sub-issue', parent: parentId }, later);
    store.create({ title: 'Loose task' }, later);

    await sync.syncOnce();

    const created = new Map(fake.created.map((c) => [c.title, c.teamId]));
    expect(created.get('Sub-issue')).toBe('team-2');
    expect(created.get('Loose task')).toBe('team-1');
  });

  it('keeps each team’s own label for a key both teams spell', async () => {
    fake.labelList = [
      { id: 'l-bug-hyd', name: 'bug', color: '#ff0000', teamId: 'team-1' },
      { id: 'l-bug-ops', name: 'bug', color: '#00ff00', teamId: 'team-2' },
    ];
    const issue = fake.issue({ team: OPS, identifier: 'OPS-4', labels: [] });
    fake.issues = [issue];
    const sync = makeSync();
    await sync.importIssues();
    const id = taskFor(issue)?.meta.id ?? '';

    store.update(
      id,
      { labels: ['bug'] },
      new Date(Date.now() + 1000).toISOString()
    );
    await sync.syncOnce();

    expect(fake.updated.map((u) => u.input.labelIds)).toEqual([['l-bug-ops']]);
    expect(fake.calls).not.toContain('createLabel');
  });

  it('keeps syncing when a team renames its label to one another team’s label spells', async () => {
    fake.labelList = [
      { id: 'l-a', name: 'Bug', color: '#eb5757', teamId: 'team-1' },
      { id: 'l-b', name: 'defect', color: '#5e6ad2', teamId: 'team-2' },
    ];
    const issue = fake.issue({ title: 'before', labels: [] });
    fake.issues = [issue];
    await makeSync().importIssues();

    // Linear allows one name per team, so Ops can spell Hydrogen's label.
    fake.labelList[1] = { ...fake.labelList[1], name: 'bug' };
    remote(issue).title = 'after';
    remote(issue).updatedAt = fake.stamp();
    const summary = await makeSync().syncOnce();

    expect(summary.errors).toEqual([]);
    expect(taskFor(issue)?.meta.title).toBe('after');
    expect(loadConfig(root).labels).toEqual([
      { name: 'Bug', color: '#eb5757', group: null, external: 'linear:l-a' },
      { name: 'defect', color: '#5e6ad2', group: null, external: null },
    ]);
  });

  it('registers one webhook per team, sharing a secret, and redoes them when the teams change', async () => {
    const url = 'https://dispatch.example.com/api/linear/webhook';
    const sync = makeSync(url);
    await sync.syncOnce();

    const hooks = [...fake.webhooks.values()];
    expect(hooks.map((h) => h.teamId).sort()).toEqual(['team-1', 'team-2']);
    expect(new Set(hooks.map((h) => h.secret)).size).toBe(1);
    const record = readLinearState(root).webhook;
    expect(record === null ? [] : webhookHooks(record)).toHaveLength(2);

    fake.calls = [];
    await sync.syncOnce();
    expect(fake.calls).not.toContain('createWebhook');

    writeConfig('[team-1]');
    await sync.syncOnce();
    expect([...fake.webhooks.values()].map((h) => h.teamId)).toEqual([
      'team-1',
    ]);
  });

  it('reads a base hashed over state ids as the same status, not a change', async () => {
    writeConfig('[team-1]');
    const issue = fake.issue({ state: stateOf('s-progress') });
    fake.issues = [issue];
    const sync = makeSync();
    await sync.importIssues();
    const id = taskFor(issue)?.meta.id ?? '';
    // Rewind the stored base to the pre-upgrade value space (state ids).
    const state = readLinearState(root);
    const base = readBase(state, id, 'issue');
    if (base === null) throw new Error('no base');
    base.local.state = fieldHash('s-progress');
    base.remote.state = fieldHash('s-progress');
    writeBase(state, id, 'issue', ISSUE_FIELDS, base);
    delete state.baseVersion;
    writeLinearState(root, state);

    // Linear moves it on; nothing local changed.
    remote(issue).state = stateOf('s-review');
    remote(issue).updatedAt = fake.stamp();
    fake.updated = [];
    const summary = await sync.syncOnce();

    expect(summary.conflicts).toBe(0);
    expect(fake.updated).toEqual([]);
    expect(store.get(id)?.meta.status).toBe('In Review');
    expect(readLinearState(root).baseVersion).toBe(4);
  });
});
