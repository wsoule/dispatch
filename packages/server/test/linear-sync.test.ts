import { getSection, TaskStore } from '@dispatch/core';
import type {
  LinearIssue,
  LinearIssueInput,
  LinearLabel,
  LinearWorkflowState,
} from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus } from '../src/events.js';
import type { ServerEvent } from '../src/events.js';
import type {
  LinearClient,
  LinearFailure,
  LinearIssuePage,
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

// Stands in for the real GraphQL client: it records every call and serves issues
// from an in-memory list, so no test here opens a socket.
class FakeLinearClient implements LinearClient {
  issues: LinearIssue[] = [];
  created: LinearIssueInput[] = [];
  updated: { id: string; input: LinearIssueInput }[] = [];
  issuesFailure: LinearFailure | null = null;
  createFailure: LinearFailure | null = null;
  truncated = false;
  sinceSeen: (string | null)[] = [];
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

  async createIssue(
    input: LinearIssueInput
  ): Promise<LinearResult<LinearIssue>> {
    if (this.createFailure !== null) return this.createFailure;
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
    seedState({ lastPushAt: '2030-01-01T00:00:00.000Z' });

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
    expect(summary.pendingImport).toBe(1);
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

describe('LinearSync push cursor', () => {
  it('does not advance lastPushAt when a rate limit cuts the push short', async () => {
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
    expect(readLinearState(root).lastPushAt).toBeNull();

    // Once the throttle clears, both tasks are still candidates.
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.createFailure = null;
    const second = await sync.syncOnce();
    expect(second.createdIssues).toBe(2);
  });

  it('does not advance lastPushAt when one task fails to push', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    store.create({ title: 'Doomed' });
    fake.createFailure = {
      ok: false,
      kind: 'graphql',
      error: 'validation failed',
    };

    const sync = makeSync();
    await sync.syncOnce();
    expect(readLinearState(root).lastPushAt).toBeNull();

    fake.createFailure = null;
    const second = await sync.syncOnce();
    expect(second.createdIssues).toBe(1);
  });

  it('stamps lastPushAt from before the push, so a concurrent edit is not lost', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    store.create({ title: 'Clean push' });
    const before = new Date().toISOString();

    await makeSync().syncOnce();

    const stamped = readLinearState(root).lastPushAt;
    expect(stamped).not.toBeNull();
    expect(Date.parse(stamped ?? '')).toBeGreaterThanOrEqual(
      Date.parse(before) - 1
    );
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
