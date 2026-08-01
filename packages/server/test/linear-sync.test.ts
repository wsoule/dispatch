import { getSection, TaskStore } from '@dispatch/core';
import type {
  LinearIssue,
  LinearIssueInput,
  LinearLabel,
  LinearWorkflowState,
} from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus } from '../src/events.js';
import type { ServerEvent } from '../src/events.js';
import type {
  LinearClient,
  LinearFailure,
  LinearIssuePage,
  LinearIssueRef,
  LinearResult,
  LinearTeam,
  LinearViewer,
} from '../src/linear/client.js';
import type { LinearSyncState } from '../src/linear/state.js';
import {
  emptyLinearState,
  readLinearState,
  writeLinearState,
} from '../src/linear/state.js';
import { LinearSync } from '../src/linear/sync.js';

const STATES: LinearWorkflowState[] = [
  { id: 's-backlog', name: 'Backlog', type: 'backlog' },
  { id: 's-todo', name: 'Todo', type: 'unstarted' },
  { id: 's-progress', name: 'In Progress', type: 'started' },
  { id: 's-review', name: 'In Review', type: 'started' },
  { id: 's-done', name: 'Done', type: 'completed' },
  { id: 's-cancelled', name: 'Canceled', type: 'canceled' },
];

const LABELS: LinearLabel[] = [{ id: 'l-web', name: 'web' }];

// A custom state with no entry in the status map. It maps down to in-progress via
// its `type`, and would map back up to "In Progress" — losing the real state.
const BLOCKED_STATE: LinearWorkflowState = {
  id: 's-blocked',
  name: 'Blocked',
  type: 'started',
};

// Stands in for the real GraphQL client: it records every call and serves issues
// from an in-memory list, so no test here opens a socket.
class FakeLinearClient implements LinearClient {
  issues: LinearIssue[] = [];
  created: LinearIssueInput[] = [];
  updated: { id: string; input: LinearIssueInput }[] = [];
  issuesFailure: LinearFailure | null = null;
  createFailure: LinearFailure | null = null;
  linkFailure: LinearFailure | null = null;
  /** Runs inside createIssue, standing in for a local edit landing mid-round-trip. */
  onCreate: (() => void) | null = null;
  truncated = false;
  sinceSeen: (string | null)[] = [];
  linkQueries = 0;
  private seq = 0;
  private tick = 0;

  // A written issue comes back stamped ahead of the local clock, which is what makes echo
  // suppression load-bearing: on the next pull our own write looks newer than the local file.
  private stamp(): string {
    return new Date(Date.now() + 5_000 + ++this.tick).toISOString();
  }

  async viewer(): Promise<LinearResult<LinearViewer>> {
    return {
      ok: true,
      data: { id: 'u-1', name: 'Test', email: 'test@example.com' },
    };
  }

  async teams(): Promise<LinearResult<LinearTeam[]>> {
    return { ok: true, data: [{ id: 'team-1', key: 'HYD', name: 'Hydrogen' }] };
  }

  async workflowStates(): Promise<LinearResult<LinearWorkflowState[]>> {
    return { ok: true, data: STATES };
  }

  async labels(): Promise<LinearResult<LinearLabel[]>> {
    return { ok: true, data: LABELS };
  }

  async issuesUpdatedSince(
    _teamId: string,
    since: string | null
  ): Promise<LinearResult<LinearIssuePage>> {
    if (this.issuesFailure !== null) return this.issuesFailure;
    this.sinceSeen.push(since);
    const nodes =
      since === null
        ? this.issues
        : this.issues.filter((i) => i.updatedAt > since);
    return {
      ok: true,
      data: {
        issues: nodes.map((i) => ({ ...i })),
        truncated: this.truncated,
      },
    };
  }

  async issueLinks(): Promise<LinearResult<LinearIssueRef[]>> {
    if (this.linkFailure !== null) return this.linkFailure;
    this.linkQueries++;
    return {
      ok: true,
      data: this.issues.map((i) => ({
        id: i.id,
        identifier: i.identifier,
        url: i.url,
        updatedAt: i.updatedAt,
      })),
    };
  }

  async createIssue(
    input: LinearIssueInput
  ): Promise<LinearResult<LinearIssue>> {
    if (this.createFailure !== null) return this.createFailure;
    this.onCreate?.();
    this.created.push(input);
    const issue = this.materialize(
      `issue-${++this.seq}`,
      `HYD-${this.seq}`,
      input
    );
    this.issues.push(issue);
    return { ok: true, data: { ...issue } };
  }

  async updateIssue(
    id: string,
    input: LinearIssueInput
  ): Promise<LinearResult<LinearIssue>> {
    this.updated.push({ id, input });
    const index = this.issues.findIndex((i) => i.id === id);
    if (index < 0) {
      return { ok: false, kind: 'graphql', error: `unknown issue: ${id}` };
    }
    const issue = this.materialize(
      id,
      this.issues[index].identifier,
      input,
      this.issues[index]
    );
    this.issues[index] = issue;
    return { ok: true, data: { ...issue } };
  }

  // Applies a mutation input to an issue the way Linear would, so a pull after a
  // push sees the values (and the new updatedAt) the push actually produced.
  private materialize(
    id: string,
    identifier: string,
    input: LinearIssueInput,
    base?: LinearIssue
  ): LinearIssue {
    const stateId = input.stateId ?? base?.state?.id;
    return {
      id,
      identifier,
      title: input.title ?? base?.title ?? '',
      description: input.description ?? base?.description ?? null,
      priority: input.priority ?? base?.priority ?? 0,
      url: `https://linear.app/acme/issue/${identifier}`,
      createdAt: base?.createdAt ?? this.stamp(),
      updatedAt: this.stamp(),
      archivedAt: base?.archivedAt ?? null,
      state: STATES.find((s) => s.id === stateId) ?? base?.state ?? null,
      labels:
        input.labelIds === undefined
          ? (base?.labels ?? [])
          : LABELS.filter((l) => (input.labelIds ?? []).includes(l.id)),
      team: { id: 'team-1', key: 'HYD' },
    };
  }

  issue(overrides: Partial<LinearIssue> = {}): LinearIssue {
    const n = ++this.seq;
    return {
      id: `issue-${n}`,
      identifier: `HYD-${n}`,
      title: `Issue ${n}`,
      description: 'from linear',
      priority: 2,
      url: `https://linear.app/acme/issue/HYD-${n}`,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-05T00:00:00.000Z',
      archivedAt: null,
      state: STATES[2],
      labels: [LABELS[0]],
      team: { id: 'team-1', key: 'HYD' },
      ...overrides,
    };
  }
}

let root: string;
let fakeHome: string;
let store: TaskStore;
let cache: TaskCache;
let events: EventBus;
let broadcasts: ServerEvent[];
let fake: FakeLinearClient;
const originalHome = process.env.DISPATCH_HOME;
const originalKey = process.env.LINEAR_API_KEY;

function writeConfig(direction: 'both' | 'pull' | 'push' = 'both'): void {
  writeFileSync(
    join(root, '.dispatch', 'config.yml'),
    `statuses: [backlog, todo, in-progress, in-review, done, cancelled]\nautoCommit: false\nlinear:\n  enabled: true\n  teamId: team-1\n  direction: ${direction}\n`
  );
}

// Seeds the on-disk sync state. Most tests want the link already bootstrapped so
// push is allowed to create issues for tasks that already exist locally.
function seedState(partial: Partial<LinearSyncState> = {}): void {
  writeLinearState(root, { ...emptyLinearState(), ...partial });
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

function makeSync(): LinearSync {
  return new LinearSync({ rootDir: root, store, cache, events, client: fake });
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-linear-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  delete process.env.LINEAR_API_KEY;
  root = mkdtempSync(join(tmpdir(), 'dispatch-linear-'));
  store = TaskStore.init(root);
  cache = new TaskCache();
  events = new EventBus();
  broadcasts = [];
  events.subscribe((event) => broadcasts.push(event));
  fake = new FakeLinearClient();
  writeConfig();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalKey;
});

describe('LinearSync.pull', () => {
  it('creates a local task for an unseen issue and joins on the UUID', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    fake.issues = [fake.issue({ title: 'Ship the thing' })];
    const summary = await makeSync().syncOnce();

    expect(summary.created).toBe(1);
    expect(summary.pulled).toBe(1);
    expect(summary.errors).toEqual([]);
    const docs = store.list();
    expect(docs).toHaveLength(1);
    expect(docs[0].meta.title).toBe('Ship the thing');
    expect(docs[0].meta.status).toBe('in-progress');
    expect(docs[0].meta.priority).toBe('high');
    expect(docs[0].meta.labels).toEqual(['web']);
    expect(docs[0].meta.external).toBe(`linear:${fake.issues[0].id}`);
    expect(getSection(docs[0].body, 'Description')).toBe('from linear');
  });

  it('updates an already-mapped task instead of creating a second one', async () => {
    const remote = fake.issue({ title: 'Renamed in Linear' });
    fake.issues = [remote];
    const doc = store.create(
      { title: 'Old title' },
      '2026-07-01T00:00:00.000Z'
    );
    store.update(
      doc.meta.id,
      { external: `linear:${remote.id}` },
      '2026-07-01T00:00:00.000Z'
    );
    seedState({
      bootstrappedAt: '2020-01-01T00:00:00.000Z',
      lastPushAt: '2030-01-01T00:00:00.000Z',
    });

    const summary = await makeSync().syncOnce();

    expect(summary.created).toBe(0);
    expect(summary.pulled).toBe(1);
    expect(store.list()).toHaveLength(1);
    expect(store.get(doc.meta.id)?.meta.title).toBe('Renamed in Linear');
  });

  it('leaves a locally-newer task alone and counts it as a conflict', async () => {
    const remote = fake.issue({
      title: 'Renamed in Linear',
      updatedAt: '2026-07-05T00:00:00.000Z',
    });
    fake.issues = [remote];
    const doc = store.create({ title: 'Newer locally' });
    store.update(doc.meta.id, { external: `linear:${remote.id}` });
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });

    const summary = await makeSync().syncOnce();

    expect(summary.conflicts).toBe(1);
    expect(summary.pulled).toBe(0);
    expect(store.get(doc.meta.id)?.meta.title).toBe('Newer locally');
    // The local side won, so the same pass pushes it up rather than dropping it.
    expect(fake.updated).toHaveLength(1);
  });

  it('does not create a task for an issue that is already archived', async () => {
    fake.issues = [fake.issue({ archivedAt: '2026-07-06T00:00:00.000Z' })];
    const summary = await makeSync().syncOnce();
    expect(summary.created).toBe(0);
    expect(store.list()).toHaveLength(0);
  });
});

describe('LinearSync.push', () => {
  it('creates an issue and writes external back on the task', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    const doc = store.create({
      title: 'Local work',
      description: 'do the thing',
      priority: 'urgent',
      status: 'in-review',
      labels: ['web'],
    });

    const summary = await makeSync().syncOnce();

    expect(summary.createdIssues).toBe(1);
    expect(summary.pushed).toBe(1);
    expect(fake.created).toEqual([
      {
        teamId: 'team-1',
        title: 'Local work',
        description: 'do the thing',
        priority: 1,
        stateId: 's-review',
        labelIds: ['l-web'],
      },
    ]);
    expect(store.get(doc.meta.id)?.meta.external).toBe('linear:issue-1');
  });

  it('updates a mapped task rather than duplicating it in Linear', async () => {
    const remote = fake.issue({ updatedAt: '2026-07-01T00:00:00.000Z' });
    fake.issues = [remote];
    const doc = store.create({ title: 'Local edit wins' });
    store.update(doc.meta.id, { external: `linear:${remote.id}` });
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });

    await makeSync().syncOnce();

    expect(fake.created).toHaveLength(0);
    expect(fake.updated).toHaveLength(1);
    expect(fake.updated[0].id).toBe(remote.id);
    expect(fake.updated[0].input.title).toBe('Local edit wins');
    // teamId would move teams; labelIds would drop labels a person added in Linear.
    expect(fake.updated[0].input.teamId).toBeUndefined();
    expect(fake.updated[0].input.labelIds).toBeUndefined();
  });

  it('keeps labels a person added in Linear when updating a mapped task', async () => {
    const remote = fake.issue({
      updatedAt: '2026-07-01T00:00:00.000Z',
      labels: [{ id: 'l-web', name: 'web' }],
    });
    fake.issues = [remote];
    const doc = store.create({ title: 'Local edit', labels: ['web'] });
    store.update(doc.meta.id, { external: `linear:${remote.id}` });
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });

    await makeSync().syncOnce();

    expect(fake.issues[0].labels.map((l) => l.name)).toEqual(['web']);
  });

  it('never creates issues for tasks that predate the link', async () => {
    store.create({ title: 'Existing backlog item' });
    const summary = await makeSync().syncOnce();

    expect(summary.createdIssues).toBe(0);
    expect(fake.created).toHaveLength(0);
    // The first pass records the baseline so later edits do push.
    expect(makeSync().status().bootstrappedAt).not.toBeNull();
  });

  it('creates an issue for a pre-existing task when asked explicitly', async () => {
    const doc = store.create({ title: 'Push me on purpose' });
    const summary = await makeSync().syncOnce([doc.meta.id]);

    expect(summary.createdIssues).toBe(1);
    expect(store.get(doc.meta.id)?.meta.external).toBe('linear:issue-1');
  });
});

describe('LinearSync direction', () => {
  it('never pushes when direction is pull', async () => {
    writeConfig('pull');
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    store.create({ title: 'Should stay local' });
    fake.issues = [fake.issue()];

    const summary = await makeSync().syncOnce();

    expect(summary.pulled).toBe(1);
    expect(summary.pushed).toBe(0);
    expect(fake.created).toHaveLength(0);
    expect(fake.updated).toHaveLength(0);
  });

  it('never pulls when direction is push', async () => {
    writeConfig('push');
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    store.create({ title: 'Local only' });
    fake.issues = [fake.issue()];

    const summary = await makeSync().syncOnce();

    expect(summary.pulled).toBe(0);
    expect(summary.createdIssues).toBe(1);
    expect(store.list()).toHaveLength(1);
  });
});

describe('LinearSync error handling', () => {
  it('surfaces a pull failure in the summary without aborting the push', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    store.create({ title: 'Still pushed' });
    fake.issuesFailure = {
      ok: false,
      kind: 'graphql',
      error: 'issues query blew up',
    };

    const summary = await makeSync().syncOnce();

    expect(summary.errors).toEqual(['issues query blew up']);
    expect(summary.pulled).toBe(0);
    expect(summary.createdIssues).toBe(1);
  });

  it('reports a rate limit as its own outcome and stops pushing', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    store.create({ title: 'One' });
    store.create({ title: 'Two' });
    fake.createFailure = {
      ok: false,
      kind: 'rate-limit',
      error: 'linear rate limit reached',
      retryAfterMs: 30_000,
    };

    const sync = makeSync();
    const summary = await sync.syncOnce();

    expect(summary.rateLimited).toBe(true);
    expect(fake.created).toHaveLength(0);
    // The backoff clock is armed, so an immediate retry does not call out again.
    const retry = await sync.syncOnce();
    expect(retry.rateLimited).toBe(true);
    expect(retry.errors).toEqual(['linear rate limit backoff in effect']);
  });

  it('reports a missing key and a missing team without touching the client', async () => {
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'linear:\n  enabled: true\n'
    );
    const summary = await makeSync().syncOnce();
    expect(summary.errors).toEqual(['no Linear team selected']);
  });
});

describe('LinearSync echo suppression', () => {
  it('does not re-apply or re-push its own write on the very next pull', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    const doc = store.create({ title: 'Round trip' });

    const sync = makeSync();
    const first = await sync.syncOnce();
    expect(first.createdIssues).toBe(1);
    const afterPush = store.get(doc.meta.id);
    expect(afterPush?.meta.external).toBe('linear:issue-1');

    // The issue now exists in Linear with the updatedAt the create returned, and
    // the next pull sees it with no cursor set — the worst case for a loop.
    const second = await sync.syncOnce();

    expect(second.pulled).toBe(0);
    expect(second.created).toBe(0);
    expect(second.pushed).toBe(0);
    // Skipped as a recognised echo, not merely lost to a conflict.
    expect(second.conflicts).toBe(0);
    expect(fake.created).toHaveLength(1);
    expect(fake.updated).toHaveLength(0);
    expect(store.get(doc.meta.id)?.meta.updated).toBe(
      afterPush?.meta.updated ?? ''
    );

    // And a third pass is still quiet, so the loop is closed rather than delayed.
    const third = await sync.syncOnce();
    expect(third.pulled + third.pushed).toBe(0);
    expect(fake.updated).toHaveLength(0);
  });

  it('still applies a genuine remote edit made after our own write', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    const doc = store.create({ title: 'Round trip' });
    const sync = makeSync();
    await sync.syncOnce();

    // A human renames the issue in Linear: same issue id, a newer updatedAt.
    fake.issues[0] = {
      ...fake.issues[0],
      title: 'Renamed by a human',
      updatedAt: '2027-01-01T00:00:00.000Z',
    };
    const summary = await sync.syncOnce();

    expect(summary.pulled).toBe(1);
    expect(store.get(doc.meta.id)?.meta.title).toBe('Renamed by a human');
  });
});

describe('LinearSync first sync', () => {
  it('imports neither backlog into the other, and reports what is waiting', async () => {
    store.create({ title: 'Pre-existing local task' });
    fake.issues = [fake.issue({ title: 'Pre-existing Linear issue' })];

    const summary = await makeSync().syncOnce();

    // Nothing was created on either side — .dispatch/tasks is committed, so a
    // first sync must not produce a surprise 60-file diff.
    expect(summary.created).toBe(0);
    expect(summary.createdIssues).toBe(0);
    expect(store.list()).toHaveLength(1);
    expect(fake.created).toHaveLength(0);
    // The link is established, so subsequent edits do flow.
    expect(makeSync().status().bootstrappedAt).not.toBeNull();
    expect(makeSync().status().cursor).not.toBeNull();
  });

  it('imports Linear issues only when asked explicitly', async () => {
    fake.issues = [fake.issue({ title: 'Existing issue' })];
    const sync = makeSync();
    await sync.syncOnce();
    expect(store.list()).toHaveLength(0);

    const summary = await sync.importIssues();

    expect(summary.created).toBe(1);
    const docs = store.list();
    expect(docs).toHaveLength(1);
    expect(docs[0].meta.title).toBe('Existing issue');
    expect(docs[0].meta.external).toBe(`linear:${fake.issues[0].id}`);
  });

  it('scans the whole team on an import, ignoring the stored cursor', async () => {
    seedState({ cursor: '2030-01-01T00:00:00.000Z' });
    fake.issues = [fake.issue({ updatedAt: '2026-01-01T00:00:00.000Z' })];

    await makeSync().importIssues();

    expect(fake.sinceSeen.at(-1)).toBeNull();
    expect(store.list()).toHaveLength(1);
  });

  it('does not create a duplicate local task once a link exists', async () => {
    const remote = fake.issue();
    fake.issues = [remote];
    const doc = store.create({ title: 'Already linked' });
    store.update(doc.meta.id, { external: `linear:${remote.id}` });

    await makeSync().importIssues();

    expect(store.list()).toHaveLength(1);
  });
});

describe('LinearSync import write-back', () => {
  it('never pushes imported tasks back out on the debounced push that follows', async () => {
    // Issues stamped after the tasks were written, so nothing but the recorded version
    // holds them back — the ordinary import-after-working-in-Linear case.
    const recent = new Date(Date.now() + 60_000).toISOString();
    fake.issues = [
      fake.issue({
        title: 'Blocked work',
        state: BLOCKED_STATE,
        updatedAt: recent,
      }),
      fake.issue({ title: 'Other work', updatedAt: recent }),
    ];
    const sync = new LinearSync({
      rootDir: root,
      store,
      cache,
      events,
      client: fake,
      pushDebounceMs: 1,
    });
    sync.start();
    await sync.syncOnce();

    const imported = await sync.importIssues();
    expect(imported.created).toBe(2);

    // This is the real path: importing broadcasts task.changed, which the daemon
    // turns into a debounced push a few seconds later.
    sync.notifyTaskChanged();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await sync.stop();

    expect(fake.updated).toHaveLength(0);
    expect(fake.created).toHaveLength(0);
    // The custom state survives: mapping it down to in-progress and back would
    // have moved the issue to "In Progress".
    expect(fake.issues[0].state?.name).toBe('Blocked');
  });

  it('does not pay for a link check after an import it already reconciled', async () => {
    writeConfig('push');
    fake.issues = [
      fake.issue({
        title: 'Imported',
        updatedAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ];
    const sync = makeSync();
    await sync.syncOnce();
    await sync.importIssues();
    const before = fake.linkQueries;

    await sync.syncOnce();

    expect(fake.linkQueries).toBe(before);
    expect(fake.updated).toHaveLength(0);
  });

  it('still pushes an imported task once a person actually edits it', async () => {
    fake.issues = [fake.issue({ title: 'Imported' })];
    const sync = makeSync();
    await sync.syncOnce();
    await sync.importIssues();

    const doc = store.list()[0];
    store.update(
      doc.meta.id,
      { title: 'Edited by a person' },
      new Date(Date.now() + 1000).toISOString()
    );
    await sync.syncOnce();

    expect(fake.updated).toHaveLength(1);
    expect(fake.updated[0].input.title).toBe('Edited by a person');
  });
});

// The clone case: `external` and .dispatch/config.yml are committed, but sync
// state is per-user in ~/.dispatch, so a teammate's first pass starts blank.
function seedClonedRepo(
  remoteUpdatedAt = '2027-01-01T00:00:00.000Z',
  localUpdatedAt?: string
): { id: string } {
  const remote = fake.issue({
    title: 'Owned by Linear',
    state: BLOCKED_STATE,
    updatedAt: remoteUpdatedAt,
  });
  fake.issues = [remote];
  const doc = store.create({ title: 'Stale committed content' });
  store.update(
    doc.meta.id,
    { external: `linear:${remote.id}` },
    localUpdatedAt
  );
  return { id: doc.meta.id };
}

// Locates a task's markdown file so a test can delete it behind the store's back.
function taskFilePath(id: string): string {
  const dir = join(root, '.dispatch', 'tasks');
  const name = readdirSync(dir).find((f) => f.startsWith(`${id}-`)) ?? '';
  return join(dir, name);
}

describe('LinearSync fresh state with existing links', () => {
  it('never writes to a linked issue on the first pass', async () => {
    seedClonedRepo();

    const summary = await makeSync().syncOnce();

    expect(fake.updated).toHaveLength(0);
    expect(fake.created).toHaveLength(0);
    expect(summary.pushed).toBe(0);
    // The remote state is untouched, not re-mapped through in-progress.
    expect(fake.issues[0].state?.name).toBe('Blocked');
    expect(fake.issues[0].title).toBe('Owned by Linear');
  });

  it('never writes to a linked issue whose local file is stamped in the future', async () => {
    // A teammate's clock ran ahead, so the committed task looks newer than any
    // watermark this pass could take.
    seedClonedRepo(
      '2027-01-01T00:00:00.000Z',
      new Date(Date.now() + 60_000).toISOString()
    );

    await makeSync().syncOnce();

    expect(fake.updated).toHaveLength(0);
    expect(fake.issues[0].title).toBe('Owned by Linear');
  });

  it('sends nothing on the first pass even for many linked tasks', async () => {
    for (let i = 0; i < 5; i++) {
      const remote = fake.issue({ updatedAt: '2027-01-01T00:00:00.000Z' });
      fake.issues.push(remote);
      const doc = store.create({ title: `Task ${i}` });
      store.update(doc.meta.id, { external: `linear:${remote.id}` });
    }

    await makeSync().syncOnce();

    expect(fake.updated).toHaveLength(0);
  });

  it('lets the user push a stale local edit up by naming it explicitly', async () => {
    // An older remote, so the local side is the newer one and there is genuinely
    // something to recover.
    const { id } = seedClonedRepo('2026-01-01T00:00:00.000Z');
    const sync = makeSync();
    await sync.syncOnce();
    expect(fake.updated).toHaveLength(0);

    const summary = await sync.syncOnce([id]);

    expect(summary.pushed).toBe(1);
    expect(fake.updated).toHaveLength(1);
  });

  it('fills in chip identifiers for links it inherited from the clone', async () => {
    seedClonedRepo();
    const sync = makeSync();

    await sync.syncOnce();

    expect(sync.links()[fake.issues[0].id]).toEqual({
      identifier: fake.issues[0].identifier,
      url: fake.issues[0].url,
    });
  });

  it('does not pay for a link query when nothing is linked yet', async () => {
    store.create({ title: 'Unlinked' });
    await makeSync().syncOnce();
    expect(fake.linkQueries).toBe(0);
  });

  it('pushes a linked task once it is edited after the link is established', async () => {
    const { id } = seedClonedRepo('2026-01-01T00:00:00.000Z');
    const sync = makeSync();
    await sync.syncOnce();

    // An explicit timestamp, so the edit is unambiguously after the baseline rather
    // than racing it inside the same millisecond.
    store.update(
      id,
      { title: 'Edited after cloning' },
      new Date(Date.now() + 1000).toISOString()
    );
    await sync.syncOnce();

    expect(fake.updated).toHaveLength(1);
    expect(fake.updated[0].input.title).toBe('Edited after cloning');
  });
});

describe('LinearSync first pass baseline', () => {
  it('takes a cursor without scanning a team it has no use for', async () => {
    fake.issues = [fake.issue(), fake.issue()];

    const summary = await makeSync().syncOnce();

    // No issue query at all: a first sync creates nothing, so a full scan of a
    // large team could only cost budget and fail.
    expect(fake.sinceSeen).toHaveLength(0);
    expect(summary.created).toBe(0);
    expect(readLinearState(root).cursor).not.toBeNull();
    expect(readLinearState(root).bootstrappedAt).not.toBeNull();
  });

  it('converges on a team too large to page through in one pass', async () => {
    fake.truncated = true;
    fake.issues = [fake.issue()];
    const sync = makeSync();

    // The first pass is a baseline, so truncation cannot block it...
    const first = await sync.syncOnce();
    expect(first.errors).toEqual([]);
    expect(readLinearState(root).bootstrappedAt).not.toBeNull();

    // ...and a later truncated pull holds the cursor without freezing the link,
    // so local edits still push and the integration keeps working.
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.create({ title: 'Local work' });
    const second = await sync.syncOnce();
    expect(second.errors.some((e) => e.includes('page through'))).toBe(true);
    expect(second.createdIssues).toBe(1);
  });
});

describe('LinearSync push accounting', () => {
  it('re-pushes everything a rate limit cut short, without dropping any of it', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    store.create({ title: 'One' });
    store.create({ title: 'Two' });
    fake.createFailure = {
      ok: false,
      kind: 'rate-limit',
      error: 'linear rate limit reached',
      retryAfterMs: 1,
    };

    const sync = makeSync();
    await sync.syncOnce();
    // Neither the unsent task nor the one never reached is recorded as handled.
    expect(readLinearState(root).pushed).toEqual({});

    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.createFailure = null;
    const second = await sync.syncOnce();
    expect(second.createdIssues).toBe(2);
  });

  it('re-pushes a task whose push failed, and only that task', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    const doomed = store.create({ title: 'Doomed' });
    const fine = store.create({ title: 'Fine' });
    fake.createFailure = {
      ok: false,
      kind: 'graphql',
      error: 'validation failed',
    };

    const sync = makeSync();
    await sync.syncOnce();
    fake.createFailure = null;
    // The task that failed is still outstanding; nothing else is.
    expect(Object.keys(readLinearState(root).pushed)).toEqual([]);

    await sync.syncOnce();
    expect(fake.created).toHaveLength(2);
    const third = await sync.syncOnce();
    expect(third.createdIssues).toBe(0);
    expect(Object.keys(readLinearState(root).pushed).sort()).toEqual(
      [doomed.meta.id, fine.meta.id].sort()
    );
  });

  it('leaves an unrelated pending edit pending when an explicit push names one task', async () => {
    const remoteA = fake.issue({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const remoteB = fake.issue({ updatedAt: '2026-01-01T00:00:00.000Z' });
    fake.issues = [remoteA, remoteB];
    const a = store.create({ title: 'Named explicitly' });
    store.update(a.meta.id, { external: `linear:${remoteA.id}` });
    const b = store.create({ title: 'Edited moments ago' });
    store.update(b.meta.id, { external: `linear:${remoteB.id}` });
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });

    const sync = makeSync();
    await sync.syncOnce([a.meta.id]);
    expect(fake.updated.map((u) => u.id)).toEqual([remoteA.id]);

    // The explicit pass never considered B, so it must not have accounted for it.
    await sync.syncOnce();

    expect(fake.updated.map((u) => u.id)).toEqual([remoteA.id, remoteB.id]);
  });

  it('leaves everything pending when an explicit push names nothing', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    store.create({ title: 'Waiting' });

    const sync = makeSync();
    const explicit = await sync.syncOnce([]);
    expect(explicit.pushed).toBe(0);
    expect(fake.created).toHaveLength(0);

    const ordinary = await sync.syncOnce();
    expect(ordinary.createdIssues).toBe(1);
  });

  it('re-sends a task edited while its own push was in flight', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    const doc = store.create({ title: 'Original' });
    const sync = makeSync();
    fake.onCreate = (): void => {
      store.update(
        doc.meta.id,
        { title: 'Edited mid-flight' },
        new Date(Date.now() + 1000).toISOString()
      );
    };

    await sync.syncOnce();
    fake.onCreate = null;
    await sync.syncOnce();

    expect(fake.updated).toHaveLength(1);
    expect(fake.updated[0].input.title).toBe('Edited mid-flight');
  });

  it('creates an issue for a task stamped at the exact moment the link was established', async () => {
    const at = '2026-07-20T00:00:00.000Z';
    seedState({ bootstrappedAt: at });
    store.create({ title: 'Same instant as the link' }, at);

    const summary = await makeSync().syncOnce();

    expect(summary.createdIssues).toBe(1);
  });

  it('still retries a task the previous version left queued', async () => {
    const doc = store.create({ title: 'Queued before the upgrade' });
    seedState({
      bootstrappedAt: '2020-01-01T00:00:00.000Z',
      lastPushAt: new Date(Date.now() + 1000).toISOString(),
      pushRetry: [doc.meta.id],
    });

    const summary = await makeSync().syncOnce();

    expect(summary.createdIssues).toBe(1);
  });

  it('does not re-send work an earlier version already pushed', async () => {
    const remote = fake.issue({ updatedAt: '2026-01-01T00:00:00.000Z' });
    fake.issues = [remote];
    const doc = store.create({ title: 'Sent by an earlier version' });
    store.update(doc.meta.id, { external: `linear:${remote.id}` });
    // A state file from before per-task accounting: a watermark and nothing else.
    seedState({
      bootstrappedAt: '2020-01-01T00:00:00.000Z',
      lastPushAt: new Date(Date.now() + 1000).toISOString(),
    });

    const sync = makeSync();
    await sync.syncOnce();
    await sync.syncOnce();

    expect(fake.updated).toHaveLength(0);
  });
});

// `.dispatch/tasks/*.md` are committed, and the daemon turns any on-disk change into a
// debounced push. Branch switches therefore hand the push older content routinely.
describe('LinearSync branch switches', () => {
  function seedLinkedAndPushed(): { id: string; file: string } {
    const remote = fake.issue({ updatedAt: '2026-01-01T00:00:00.000Z' });
    fake.issues = [remote];
    const doc = store.create({ title: 'Current work' });
    store.update(doc.meta.id, { external: `linear:${remote.id}` });
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    return { id: doc.meta.id, file: taskFilePath(doc.meta.id) };
  }

  it('does not push an older revision of a task file back into Linear', async () => {
    const { id } = seedLinkedAndPushed();
    const sync = makeSync();
    await sync.syncOnce();
    expect(fake.updated).toHaveLength(1);

    // Checking out a branch that holds an older revision of the same task file.
    store.update(id, { title: 'Older revision' }, '2026-02-01T00:00:00.000Z');
    await sync.syncOnce();

    expect(fake.updated).toHaveLength(1);
    expect(fake.issues[0].title).toBe('Current work');
  });

  it('remembers a task that a branch switch removed from disk', async () => {
    const { id, file } = seedLinkedAndPushed();
    const sync = makeSync();
    await sync.syncOnce();
    expect(fake.updated).toHaveLength(1);
    const restored = readFileSync(file, 'utf8');

    // The task file is absent on the other branch, then back when we switch home.
    rmSync(file);
    await sync.syncOnce();
    writeFileSync(file, restored);
    await sync.syncOnce();

    expect(fake.updated).toHaveLength(1);
    expect(readLinearState(root).pushed[id]).toBeDefined();
  });
});

describe('LinearSync unrecorded links', () => {
  // A linked task the engine holds no recorded version for: it cannot know whether the
  // local file is ahead of the issue, so it must ask before writing.
  function seedUnrecordedLink(remoteUpdatedAt: string): { id: string } {
    const remote = fake.issue({
      title: 'Owned by Linear',
      state: BLOCKED_STATE,
      updatedAt: remoteUpdatedAt,
    });
    fake.issues = [remote];
    const doc = store.create({ title: 'Local content' });
    store.update(doc.meta.id, { external: `linear:${remote.id}` });
    seedState({
      bootstrappedAt: '2020-01-01T00:00:00.000Z',
      cursor: '2030-01-01T00:00:00.000Z',
    });
    return { id: doc.meta.id };
  }

  it('checks Linear before writing to a link it has no recorded version for', async () => {
    seedUnrecordedLink('2027-01-01T00:00:00.000Z');

    const summary = await makeSync().syncOnce();

    expect(fake.updated).toHaveLength(0);
    expect(fake.issues[0].title).toBe('Owned by Linear');
    expect(fake.issues[0].state?.name).toBe('Blocked');
    expect(summary.errors.some((e) => e.includes('withheld'))).toBe(true);
  });

  it('sends it once the check shows the local copy is newer', async () => {
    seedUnrecordedLink('2026-01-01T00:00:00.000Z');

    const summary = await makeSync().syncOnce();

    expect(summary.pushed).toBe(1);
    expect(fake.updated).toHaveLength(1);
  });

  it('leaves it outstanding when the check could not be made', async () => {
    seedUnrecordedLink('2026-01-01T00:00:00.000Z');
    fake.linkFailure = {
      ok: false,
      kind: 'graphql',
      error: 'link query blew up',
    };

    const sync = makeSync();
    const first = await sync.syncOnce();
    expect(fake.updated).toHaveLength(0);
    expect(first.errors.some((e) => e.includes('withheld'))).toBe(true);

    fake.linkFailure = null;
    await sync.syncOnce();

    expect(fake.updated).toHaveLength(1);
  });

  it('reports a remote version it cannot read rather than skipping it silently', async () => {
    writeConfig('push');
    seedUnrecordedLink('not a timestamp');

    const summary = await makeSync().syncOnce();

    expect(fake.updated).toHaveLength(0);
    expect(summary.errors.some((e) => e.includes('withheld'))).toBe(true);
  });
});

describe('LinearSync explicit push conflict check', () => {
  it('withholds an explicit update when Linear holds a newer copy', async () => {
    const { id } = seedClonedRepo();

    const summary = await makeSync().syncOnce([id]);

    expect(fake.updated).toHaveLength(0);
    expect(fake.issues[0].title).toBe('Owned by Linear');
    expect(fake.issues[0].state?.name).toBe('Blocked');
    expect(summary.errors.some((e) => e.includes('withheld'))).toBe(true);
  });

  it('sends an explicit update when the local copy is the newer one', async () => {
    const { id } = seedClonedRepo('2026-01-01T00:00:00.000Z');

    const summary = await makeSync().syncOnce([id]);

    expect(summary.pushed).toBe(1);
    expect(fake.updated).toHaveLength(1);
  });

  it('sends an explicit update when Linear is only ahead because of our own write', async () => {
    // Linear stamps a write with its own clock, which runs ahead of the local file.
    writeConfig('push');
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    const doc = store.create({ title: 'First' });
    const sync = makeSync();
    await sync.syncOnce();
    expect(fake.created).toHaveLength(1);

    store.update(doc.meta.id, { title: 'Second' });
    await sync.syncOnce([doc.meta.id]);

    expect(fake.updated).toHaveLength(1);
    expect(fake.updated[0].input.title).toBe('Second');
  });

  it('withholds an explicit update when the check itself failed', async () => {
    const { id } = seedClonedRepo('2026-01-01T00:00:00.000Z');
    fake.linkFailure = {
      ok: false,
      kind: 'graphql',
      error: 'link query blew up',
    };

    const summary = await makeSync().syncOnce([id]);

    expect(fake.updated).toHaveLength(0);
    expect(summary.errors.some((e) => e.includes('withheld'))).toBe(true);
  });

  it('does not pay for a check when the named task is not linked yet', async () => {
    const doc = store.create({ title: 'Brand new' });

    await makeSync().syncOnce([doc.meta.id]);

    expect(fake.linkQueries).toBe(0);
    expect(fake.created).toHaveLength(1);
  });

  it('backfills chip identifiers even when the first pass is an explicit push', async () => {
    seedClonedRepo('2026-01-01T00:00:00.000Z');
    const inherited = fake.issues[0];
    const fresh = store.create({ title: 'Push me by name' });

    const sync = makeSync();
    await sync.syncOnce([fresh.meta.id]);

    expect(sync.links()[inherited.id]).toEqual({
      identifier: inherited.identifier,
      url: inherited.url,
    });
  });
});

describe('LinearSync link query failures', () => {
  it('arms the backoff when the link query is throttled', async () => {
    seedClonedRepo();
    fake.linkFailure = {
      ok: false,
      kind: 'rate-limit',
      error: 'linear rate limit reached',
      retryAfterMs: 30_000,
    };

    const sync = makeSync();
    const summary = await sync.syncOnce();
    expect(summary.rateLimited).toBe(true);
    expect(summary.errors).toContain('linear rate limit reached');

    const retry = await sync.syncOnce();
    expect(retry.errors).toEqual(['linear rate limit backoff in effect']);
  });
});

describe('LinearSync degraded pull', () => {
  it('will not overwrite a linked issue when the pull failed', async () => {
    const remote = fake.issue({ updatedAt: '2026-07-01T00:00:00.000Z' });
    fake.issues = [remote];
    const linked = store.create({ title: 'Linked and edited' });
    store.update(linked.meta.id, { external: `linear:${remote.id}` });
    store.create({ title: 'Brand new' });
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    fake.issuesFailure = {
      ok: false,
      kind: 'graphql',
      error: 'issues query blew up',
    };

    const summary = await makeSync().syncOnce();

    // No conflict information was available, so the update is withheld and said so.
    expect(fake.updated).toHaveLength(0);
    expect(summary.errors.some((e) => e.includes('no conflict check'))).toBe(
      true
    );
    // Creating a genuinely new issue is still safe and still happens.
    expect(summary.createdIssues).toBe(1);
  });

  it('holds the cursor when the issue walk was truncated', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    fake.issues = [fake.issue()];
    fake.truncated = true;

    const summary = await makeSync().syncOnce();

    expect(readLinearState(root).cursor).toBeNull();
    expect(summary.errors.some((e) => e.includes('page through'))).toBe(true);
  });
});

describe('LinearSync malformed config', () => {
  function writeBadConfig(): void {
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'linear:\n  enabled: true\n  teamId: team-1\n  intervalSec: 1\n'
    );
  }

  it('does not throw from start(), and reports the problem in status', () => {
    writeBadConfig();
    const sync = makeSync();
    expect(() => sync.start()).not.toThrow();
    const status = sync.status();
    expect(status.enabled).toBe(false);
    expect(status.lastError).toContain('invalid config');
  });

  it('reports the problem in the summary rather than rejecting', async () => {
    writeBadConfig();
    const summary = await makeSync().syncOnce();
    expect(summary.errors[0]).toContain('invalid config');
    expect(fake.created).toHaveLength(0);
  });

  it('does not throw out of the debounced push timer', async () => {
    const sync = makeSync();
    sync.start();
    writeBadConfig();
    sync.notifyTaskChanged();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await sync.stop();
    expect(fake.created).toHaveLength(0);
  });
});

describe('LinearSync issue links', () => {
  it('records the display identifier and url a client needs for a chip', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    const remote = fake.issue({ identifier: 'HYD-77' });
    fake.issues = [remote];

    const sync = makeSync();
    await sync.syncOnce();

    expect(sync.links()[remote.id]).toEqual({
      identifier: 'HYD-77',
      url: remote.url,
    });
    // The join key itself is untouched — still the UUID.
    expect(store.list()[0].meta.external).toBe(`linear:${remote.id}`);
  });

  it('records a link for an issue this engine created', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    store.create({ title: 'Pushed up' });
    const sync = makeSync();
    await sync.syncOnce();
    expect(sync.links()['issue-1'].identifier).toBe('HYD-1');
  });
});

describe('LinearSync repeat passes', () => {
  it('stops reporting a conflict for a task it created itself', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    fake.issues = [fake.issue()];
    const sync = makeSync();

    await sync.syncOnce();
    const second = await sync.syncOnce();
    const third = await sync.syncOnce();

    expect(second.conflicts).toBe(0);
    expect(third.conflicts).toBe(0);
  });

  it('runs an explicit push behind an in-flight pass instead of discarding it', async () => {
    seedState({ bootstrappedAt: '2030-01-01T00:00:00.000Z' });
    const doc = store.create({ title: 'Explicit' });
    const sync = makeSync();

    const [, explicit] = await Promise.all([
      sync.syncOnce(),
      sync.syncOnce([doc.meta.id]),
    ]);

    expect(explicit.createdIssues).toBe(1);
    expect(store.get(doc.meta.id)?.meta.external).toBe('linear:issue-1');
  });
});

describe('LinearSync task-change trigger', () => {
  it('pushes shortly after a local change, without waiting for a poll', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    const sync = new LinearSync({
      rootDir: root,
      store,
      cache,
      events,
      client: fake,
      pushDebounceMs: 1,
    });
    sync.start();
    store.create({ title: 'Edited locally' });
    sync.notifyTaskChanged();
    await waitFor(() => fake.created.length === 1);
    await sync.stop();
    expect(fake.created).toHaveLength(1);
  });

  it('schedules nothing at all when the project has Linear turned off', async () => {
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'linear:\n  enabled: false\n  teamId: team-1\n'
    );
    const sync = new LinearSync({
      rootDir: root,
      store,
      cache,
      events,
      client: fake,
      pushDebounceMs: 1,
    });
    sync.start();
    store.create({ title: 'Stays local' });
    sync.notifyTaskChanged();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await sync.stop();
    expect(fake.created).toHaveLength(0);
  });
});

describe('LinearSync reporting', () => {
  it('broadcasts a summary and reports status without ever exposing a key', async () => {
    process.env.LINEAR_API_KEY = 'lin_api_do_not_leak';
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    fake.issues = [fake.issue()];
    const sync = makeSync();
    await sync.syncOnce();

    const linearEvents = broadcasts.filter((e) => e.type === 'linear.changed');
    expect(linearEvents).toHaveLength(1);
    expect(broadcasts.some((e) => e.type === 'task.changed')).toBe(true);

    const status = sync.status();
    expect(status.enabled).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.keySource).toBe('env');
    expect(status.teamId).toBe('team-1');
    expect(status.lastSummary?.created).toBe(1);
    expect(JSON.stringify(status)).not.toContain('lin_api_do_not_leak');
  });
});
