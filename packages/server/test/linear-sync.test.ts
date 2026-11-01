import {
  FileCommentStore,
  getSection,
  normalizeProjectPath,
  readCredentials,
  TaskStore,
  writeCredential,
  writeProjectCredential,
} from '@dispatch-foo/core';
import type { LinearWorkflowState } from '@dispatch-foo/core';
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
import { LINEAR_USAGE_LIMIT_MESSAGE } from '../src/linear/client.js';
import type { LinearSyncState, PushAttempt } from '../src/linear/state.js';
import {
  emptyLinearState,
  readLinearState,
  writeLinearState,
} from '../src/linear/state.js';
import { LinearSync } from '../src/linear/sync.js';
import { FakeLinearClient, STATES } from './linearFake.js';

// A custom state with no entry in the status map. It maps down to in-progress via
// its `type`, and would map back up to "In Progress" — losing the real state.
const BLOCKED_STATE: LinearWorkflowState = {
  id: 's-blocked',
  name: 'Blocked',
  type: 'started',
};

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
    // Statuses are the team's workflow states once linked.
    expect(docs[0].meta.status).toBe('In Progress');
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

  it('keeps a locally-newer edit on first contact and records each conflict', async () => {
    const remote = fake.issue({
      title: 'Renamed in Linear',
      updatedAt: '2026-07-05T00:00:00.000Z',
    });
    fake.issues = [remote];
    const doc = store.create({ title: 'Newer locally' });
    store.update(doc.meta.id, { external: `linear:${remote.id}` });
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });

    const summary = await makeSync().syncOnce();

    // Title, description, state and priority all differ with no base to say
    // who moved, so each is a conflict the newer (local) edit wins.
    expect(summary.conflicts).toBe(4);
    const after = store.get(doc.meta.id);
    expect(after?.meta.title).toBe('Newer locally');
    expect(getSection(after?.body ?? '', 'Activity')).toContain(
      'Linear sync conflict'
    );
    // Fields the old sync never pushed take Linear's value.
    expect(after?.meta.labels).toEqual(['web']);
    expect(fake.updated).toHaveLength(1);
    expect(fake.updated[0].input.title).toBe('Newer locally');
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
      status: 'review',
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

  // A derived task's description is a stranger's PR body. Auto-creating an
  // issue for it puts that prose in front of a whole team's tracker.
  it('never creates an issue for a task derived from an external artifact', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    store.create({
      title: 'Review PR #7: Bump deps',
      derivedFrom: 'github-pr:7',
    });
    // Non-vacuous: an authored task in the same pass does go out.
    store.create({ title: 'Local work' });

    const summary = await makeSync().syncOnce();

    expect(summary.createdIssues).toBe(1);
    expect(fake.created.map((c) => c.title)).toEqual(['Local work']);
  });

  it('refuses even an explicit push of a derived task', async () => {
    const doc = store.create({
      title: 'Review PR #7: Bump deps',
      derivedFrom: 'github-pr:7',
    });
    const summary = await makeSync().syncOnce([doc.meta.id]);

    expect(summary.createdIssues).toBe(0);
    expect(fake.created).toHaveLength(0);
    expect(store.get(doc.meta.id)?.meta.external).toBeNull();
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

  it('records the issue limit once and sends no further create that pass', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    for (const n of [1, 2, 3, 4, 5]) store.create({ title: `Task ${n}` });
    fake.issueLimit = 2;

    const summary = await makeSync().syncOnce();

    // Two land, the third is refused, and the last two are never sent.
    expect(fake.calls.filter((c) => c === 'createIssue')).toHaveLength(3);
    expect(fake.created).toHaveLength(2);
    expect(summary.createdIssues).toBe(2);
    expect(summary.errors).toEqual([LINEAR_USAGE_LIMIT_MESSAGE]);
    expect(summary.usageLimited).toBe(true);
    expect(summary.rateLimited).toBe(false);
    const capacity = readLinearState(root).capacity;
    expect(capacity?.message).toBe(LINEAR_USAGE_LIMIT_MESSAGE);
    expect(Date.parse(capacity?.retryAt ?? '')).toBeGreaterThan(Date.now());
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
  // Found against a real, empty Linear team: with no cursor, every later
  // poll skipped the cheap probe and re-read the whole team.
  it('takes a cursor from an import that finds nothing', async () => {
    fake.issues = [];
    const sync = new LinearSync({
      rootDir: root,
      store,
      cache,
      events,
      client: fake,
      comments: new FileCommentStore(root),
    });

    await sync.importIssues();
    expect(readLinearState(root).cursor).not.toBeNull();
    expect(readLinearState(root).commentCursor).not.toBeNull();

    fake.sinceSeen.length = 0;
    await sync.syncOnce();
    expect(fake.sinceSeen).not.toContain(null);
  });

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
    // Something changed after the cursor, so the probe sends the pass to page.
    fake.issues[0].updatedAt = new Date(Date.now() + 60_000).toISOString();
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
  // A linked task the engine holds no merge base for: it cannot know which side
  // moved, so it fetches the issue and lets the newer copy win.
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

  it('takes Linear’s newer copy of a link it has no base for, writing nothing back', async () => {
    const { id } = seedUnrecordedLink('2027-01-01T00:00:00.000Z');

    const summary = await makeSync().syncOnce();

    expect(fake.updated).toHaveLength(0);
    expect(fake.issues[0].title).toBe('Owned by Linear');
    expect(fake.issues[0].state?.name).toBe('Blocked');
    expect(store.get(id)?.meta.title).toBe('Owned by Linear');
    expect(summary.errors).toEqual([]);
  });

  it('sends it once the check shows the local copy is newer', async () => {
    seedUnrecordedLink('2026-01-01T00:00:00.000Z');

    const summary = await makeSync().syncOnce();

    expect(summary.pushed).toBe(1);
    expect(fake.updated).toHaveLength(1);
  });

  it('leaves it outstanding when the check could not be made', async () => {
    seedUnrecordedLink('2026-01-01T00:00:00.000Z');
    fake.failures.issuesByIds = {
      ok: false,
      kind: 'graphql',
      error: 'issue query blew up',
    };

    const sync = makeSync();
    const first = await sync.syncOnce();
    expect(fake.updated).toHaveLength(0);
    expect(first.errors.some((e) => e.includes('could not be fetched'))).toBe(
      true
    );

    delete fake.failures.issuesByIds;
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
  it('lets Linear’s newer copy win an explicit push, and records the conflict', async () => {
    const { id } = seedClonedRepo();

    const summary = await makeSync().syncOnce([id]);

    expect(fake.updated).toHaveLength(0);
    expect(fake.issues[0].title).toBe('Owned by Linear');
    expect(fake.issues[0].state?.name).toBe('Blocked');
    expect(store.get(id)?.meta.title).toBe('Owned by Linear');
    expect(summary.conflicts).toBeGreaterThan(0);
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

  it('withholds an explicit update when the fresh copy could not be fetched', async () => {
    const { id } = seedClonedRepo('2026-01-01T00:00:00.000Z');
    fake.failures.issuesByIds = {
      ok: false,
      kind: 'graphql',
      error: 'issue query blew up',
    };

    const summary = await makeSync().syncOnce([id]);

    expect(fake.updated).toHaveLength(0);
    expect(summary.errors.some((e) => e.includes('could not be fetched'))).toBe(
      true
    );
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
  it('still merges a linked task against a fresh copy when the pull failed', async () => {
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

    // The failure is reported, but the push merges against its own fresh
    // copy of the issue, so the local edit still goes out safely.
    expect(summary.errors).toContain('issues query blew up');
    expect(fake.updated).toHaveLength(1);
    expect(fake.updated[0].input.title).toBe('Linked and edited');
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

  it('answers a tagged request with the summary its pass gave it', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    const sync = makeSync();
    expect(sync.status('req-1').answered).toBeNull();
    expect(sync.status().answered).toBeUndefined();

    const joined = sync.syncOnce(undefined, 'req-1');
    // A second sync naming no tasks joins the pass already running.
    const again = sync.syncOnce(undefined, 'req-2');
    const summary = await joined;
    expect(await again).toBe(summary);
    expect(sync.status('req-1').answered).toEqual(summary);
    expect(sync.status('req-2').answered).toEqual(summary);
    expect(sync.status('unknown').answered).toBeNull();
  });
});

describe('LinearSync credential scope', () => {
  it('connect stores the key against this project, not the global slot', () => {
    const sync = makeSync();
    sync.connect('lin_api_project_key');

    const file = readCredentials();
    expect(file.linear).toBeUndefined();
    expect(file.projects?.[normalizeProjectPath(root)]?.linear?.apiKey).toBe(
      'lin_api_project_key'
    );
  });

  it('disconnect clears only this project and falls back to the global key', async () => {
    writeCredential('linear', { apiKey: 'lin_api_global_key' });
    const sync = makeSync();
    sync.connect('lin_api_project_key');
    expect(sync.status().keySource).toBe('project');

    await sync.disconnect();

    expect(
      readCredentials().projects?.[normalizeProjectPath(root)]
    ).toBeUndefined();
    expect(readCredentials().linear?.apiKey).toBe('lin_api_global_key');
    expect(sync.status().keySource).toBe('global');
  });

  it('a project key beats LINEAR_API_KEY for the same daemon', () => {
    process.env.LINEAR_API_KEY = 'lin_api_from_env';
    writeProjectCredential(root, 'linear', { apiKey: 'lin_api_project_key' });
    expect(makeSync().status().keySource).toBe('project');
  });
});

const DONE_STATE = STATES[4];
const CANCELED_STATE = STATES[5];

// A queued create as an explicit push or an export leaves it.
function queuedEntry(overrides: Partial<PushAttempt> = {}): PushAttempt {
  return {
    origin: 'explicit',
    queuedAt: '2026-07-01T00:00:00.000Z',
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    lastErrorKind: null,
    retryAt: null,
    ...overrides,
  };
}

function createCalls(): number {
  return fake.calls.filter((c) => c === 'createIssue').length;
}

describe('LinearSync held-back accounting', () => {
  it('holds unlinked tasks back in localOnly at the baseline, keeping pushed for linked ones', async () => {
    const remote = fake.issue({ updatedAt: '2027-01-01T00:00:00.000Z' });
    fake.issues = [remote];
    const linked = store.create({ title: 'Linked' });
    store.update(linked.meta.id, { external: `linear:${remote.id}` });
    const local = store.create({ title: 'Local only' });

    await makeSync().syncOnce();

    const state = readLinearState(root);
    expect(Object.keys(state.pushed)).toEqual([linked.meta.id]);
    expect(Object.keys(state.localOnly ?? {})).toEqual([local.meta.id]);
    expect(fake.created).toHaveLength(0);
    expect(fake.updated).toHaveLength(0);
  });

  it('folds a state written before the split, once, creating nothing', async () => {
    const remote = fake.issue({ updatedAt: '2027-01-01T00:00:00.000Z' });
    fake.issues = [remote];
    const a = store.create({ title: 'Linked' });
    store.update(a.meta.id, { external: `linear:${remote.id}` });
    const b = store.create({ title: 'Never sent' });
    const at = (id: string) => store.get(id)?.meta.updated ?? '';
    seedState({
      bootstrappedAt: '2030-01-01T00:00:00.000Z',
      pushed: { [a.meta.id]: at(a.meta.id), [b.meta.id]: at(b.meta.id) },
    });
    expect(readLinearState(root).localOnly).toBeUndefined();

    await makeSync().syncOnce();

    const state = readLinearState(root);
    expect(state.pushed).toEqual({ [a.meta.id]: at(a.meta.id) });
    expect(state.localOnly).toEqual({ [b.meta.id]: at(b.meta.id) });
    expect(fake.created).toHaveLength(0);
  });

  it('keeps a task that left the linked teams in pushed when folding', async () => {
    const moved = store.create({ title: 'Moved away' });
    const at = store.get(moved.meta.id)?.meta.updated ?? '';
    seedState({
      bootstrappedAt: '2030-01-01T00:00:00.000Z',
      pushed: { [moved.meta.id]: at },
      movedOut: { 'issue-gone': moved.meta.id },
    });

    await makeSync().syncOnce();

    const state = readLinearState(root);
    expect(state.pushed[moved.meta.id]).toBe(at);
    expect(state.localOnly).toEqual({});
  });

  it('reports coverage counts in status from the task cache', async () => {
    const remote = fake.issue();
    fake.issues = [remote];
    const linked = store.create({ title: 'Linked' });
    store.update(linked.meta.id, { external: `linear:${remote.id}` });
    store.create({ title: 'Held back' });
    store.create({ title: 'Review PR #7', derivedFrom: 'github-pr:7' });
    const sync = makeSync();
    await sync.syncOnce();
    cache.rebuild(store);

    expect(sync.status().coverage).toEqual({
      total: 2,
      linked: 1,
      notLinked: 1,
      heldBack: 1,
      queued: 0,
      failed: 0,
      excluded: 1,
    });
  });
});

describe('LinearSync push queue', () => {
  it('queues a failed explicit create and retries it on a later ordinary pass', async () => {
    const doc = store.create({ title: 'Predates the link' });
    fake.createFailure = {
      ok: false,
      kind: 'graphql',
      error: 'validation failed',
    };
    const sync = makeSync();

    const first = await sync.syncOnce([doc.meta.id]);

    expect(first.failedTaskIds).toEqual([doc.meta.id]);
    expect(first.queued).toBe(1);
    const entry = readLinearState(root).pushQueue[doc.meta.id];
    expect(entry).toMatchObject({
      origin: 'explicit',
      attempts: 1,
      lastError: 'validation failed',
      lastErrorKind: 'graphql',
    });
    // Five minutes out on the first failure.
    expect(Date.parse(entry?.retryAt ?? '')).toBeGreaterThan(
      Date.now() + 4 * 60_000
    );

    // Not due yet: an ordinary pass leaves it alone.
    fake.createFailure = null;
    await sync.syncOnce();
    expect(fake.created).toHaveLength(0);

    const state = readLinearState(root);
    state.pushQueue[doc.meta.id] = {
      ...queuedEntry(),
      ...state.pushQueue[doc.meta.id],
      retryAt: '2020-01-01T00:00:00.000Z',
    };
    writeLinearState(root, state);
    const retried = await sync.syncOnce();

    expect(retried.createdIssues).toBe(1);
    expect(store.get(doc.meta.id)?.meta.external).toBe('linear:issue-1');
    expect(readLinearState(root).pushQueue).toEqual({});
    expect(readLinearState(root).localOnly?.[doc.meta.id]).toBeUndefined();
  });

  it('keeps every task a rate limit cut short queued, and sends them all later', async () => {
    seedState({ bootstrappedAt: '2030-01-01T00:00:00.000Z' });
    const ids = ['One', 'Two', 'Three'].map(
      (title) => store.create({ title }).meta.id
    );
    fake.createFailure = {
      ok: false,
      kind: 'rate-limit',
      error: 'linear rate limit reached',
      retryAfterMs: 1,
    };
    const sync = makeSync();

    await sync.syncOnce(ids);

    const queue = readLinearState(root).pushQueue;
    expect(Object.keys(queue).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(queue[id]).toMatchObject({ attempts: 0, lastError: null });
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.createFailure = null;
    // The tasks predate the link, so only the queue sends them.
    const later = await sync.syncOnce();

    expect(later.createdIssues).toBe(3);
    expect(readLinearState(root).pushQueue).toEqual({});
  });

  it('runs an idle poll through to the push when a queued create is due', async () => {
    seedState({ bootstrappedAt: '2030-01-01T00:00:00.000Z' });
    const doc = store.create({ title: 'Queued' });
    const sync = makeSync();
    await sync.syncOnce();
    await sync.pollOnce();
    const idleCalls = fake.calls.length;
    await sync.pollOnce();
    // Idle: one probe and nothing else.
    expect(fake.calls.slice(idleCalls)).toEqual(['probe']);

    const state = readLinearState(root);
    state.pushQueue[doc.meta.id] = queuedEntry({
      attempts: 1,
      lastError: 'validation failed',
      retryAt: '2020-01-01T00:00:00.000Z',
    });
    writeLinearState(root, state);
    await sync.pollOnce();

    expect(fake.created).toHaveLength(1);
    expect(readLinearState(root).pushQueue).toEqual({});
  });

  it('drops queued creates whose task is gone, derived or already linked', async () => {
    const remote = fake.issue({ updatedAt: '2027-01-01T00:00:00.000Z' });
    fake.issues = [remote];
    const linked = store.create({ title: 'Linked meanwhile' });
    store.update(linked.meta.id, { external: `linear:${remote.id}` });
    const derived = store.create({
      title: 'Review PR #7',
      derivedFrom: 'github-pr:7',
    });
    seedState({
      bootstrappedAt: '2030-01-01T00:00:00.000Z',
      pushQueue: {
        't-deleted': queuedEntry({ retryAt: '2099-01-01T00:00:00.000Z' }),
        [derived.meta.id]: queuedEntry({ retryAt: '2099-01-01T00:00:00.000Z' }),
        [linked.meta.id]: queuedEntry({ retryAt: '2099-01-01T00:00:00.000Z' }),
      },
    });

    const summary = await makeSync().syncOnce();

    expect(readLinearState(root).pushQueue).toEqual({});
    expect(summary.queued).toBe(0);
    expect(fake.created).toHaveLength(0);
  });

  it('sends a named update that failed again on the next ordinary pass', async () => {
    const { id } = seedClonedRepo('2026-01-01T00:00:00.000Z');
    const sync = makeSync();
    await sync.syncOnce();
    fake.failures.updateIssue = {
      ok: false,
      kind: 'graphql',
      error: 'update refused',
    };

    await sync.syncOnce([id]);
    expect(fake.updated).toHaveLength(0);
    expect(readLinearState(root).pushed[id]).toBeUndefined();

    delete fake.failures.updateIssue;
    await sync.syncOnce();

    expect(fake.updated).toHaveLength(1);
    expect(fake.updated[0].input.title).toBe('Stale committed content');
  });

  it('forgets a queued create: it is held back and no longer retried', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    const doc = store.create({ title: 'Keeps failing' });
    fake.createFailure = { ok: false, kind: 'graphql', error: 'nope' };
    const sync = makeSync();
    await sync.syncOnce([doc.meta.id]);
    cache.rebuild(store);
    expect(sync.coverage().unlinked[0]?.reason).toBe('failed');

    expect(sync.forget([doc.meta.id, 't-unknown'])).toBe(1);

    const state = readLinearState(root);
    expect(state.pushQueue).toEqual({});
    expect(state.localOnly?.[doc.meta.id]).toBe(
      store.get(doc.meta.id)?.meta.updated ?? ''
    );
    expect(sync.coverage().unlinked[0]?.reason).toBe('held-back');
    fake.createFailure = null;
    await sync.syncOnce();
    expect(fake.created).toHaveLength(0);
  });
});

describe('LinearSync issue limit pause', () => {
  it('queues what the limit refused, pauses ordinary creates, and resumes once there is room', async () => {
    const remote = fake.issue({ updatedAt: '2026-01-01T00:00:00.000Z' });
    fake.issues = [remote];
    const linked = store.create({ title: 'Linked and edited' });
    store.update(linked.meta.id, { external: `linear:${remote.id}` });
    // Created after the link, so an ordinary pass would create them itself.
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    const ids = ['A', 'B', 'C', 'D'].map(
      (title) => store.create({ title }).meta.id
    );
    // The linked issue takes one slot, so two creates fit.
    fake.issueLimit = 3;
    const sync = makeSync();

    const first = await sync.syncOnce(ids);

    expect(createCalls()).toBe(3);
    expect(first.createdIssues).toBe(2);
    expect(first.usageLimited).toBe(true);
    expect(first.errors).toEqual([LINEAR_USAGE_LIMIT_MESSAGE]);
    expect(first.queued).toBe(2);
    const queue = readLinearState(root).pushQueue;
    expect(Object.keys(queue)).toHaveLength(2);
    for (const entry of Object.values(queue)) {
      expect(entry).toMatchObject({
        attempts: 0,
        lastError: LINEAR_USAGE_LIMIT_MESSAGE,
        lastErrorKind: 'usage-limit',
      });
    }

    // Paused: no create goes out, but the linked task's edit still does.
    const paused = await sync.syncOnce();
    expect(createCalls()).toBe(3);
    expect(paused.errors).toEqual([]);
    expect(fake.updated.map((u) => u.id)).toEqual([remote.id]);
    const status = sync.status();
    expect(status.capacity?.message).toBe(LINEAR_USAGE_LIMIT_MESSAGE);
    expect(status.lastError).toBe(LINEAR_USAGE_LIMIT_MESSAGE);

    // Room again: a fresh measurement ends the pause.
    fake.issueLimit = null;
    const measured = await sync.capacity(true);
    expect(measured.ok && measured.data.active).toBe(3);
    expect(measured.ok && measured.data.limitHitAt).not.toBeNull();
    expect(sync.status().capacity).toMatchObject({
      retryAt: null,
      message: null,
      active: 3,
      limit: 250,
      plan: 'free',
    });
    expect(sync.status().lastError).toBeNull();

    const resumed = await sync.syncOnce();
    expect(resumed.createdIssues).toBe(2);
    expect(readLinearState(root).pushQueue).toEqual({});
  });

  it('lets a push by name try during the pause, and a create that lands ends it', async () => {
    const doc = store.create({ title: 'Named while paused' });
    seedState({
      bootstrappedAt: '2020-01-01T00:00:00.000Z',
      capacity: {
        limitedAt: '2026-07-01T00:00:00.000Z',
        retryAt: '2099-01-01T00:00:00.000Z',
        message: LINEAR_USAGE_LIMIT_MESSAGE,
        active: null,
        limit: null,
        limitSource: null,
        plan: 'unknown',
        checkedAt: null,
      },
    });
    const sync = makeSync();

    const summary = await sync.syncOnce([doc.meta.id]);

    expect(summary.createdIssues).toBe(1);
    expect(sync.status().capacity).toMatchObject({
      limitedAt: '2026-07-01T00:00:00.000Z',
      retryAt: null,
      message: null,
    });
  });

  it('retries now on request: the pause ends and the queued creates go', async () => {
    const doc = store.create({ title: 'Refused at the limit' });
    seedState({
      bootstrappedAt: '2030-01-01T00:00:00.000Z',
      capacity: {
        limitedAt: '2026-07-01T00:00:00.000Z',
        retryAt: '2099-01-01T00:00:00.000Z',
        message: LINEAR_USAGE_LIMIT_MESSAGE,
        active: 250,
        limit: 250,
        limitSource: 'plan',
        plan: 'free',
        checkedAt: null,
      },
      pushQueue: {
        [doc.meta.id]: queuedEntry({
          origin: 'export',
          lastError: LINEAR_USAGE_LIMIT_MESSAGE,
          lastErrorKind: 'usage-limit',
        }),
      },
    });
    const sync = makeSync();

    const started = sync.startRetry();
    expect(started).toMatchObject({ ok: true, candidates: 1 });
    await sync.idle();

    expect(fake.created).toHaveLength(1);
    const status = sync.status();
    expect(status.capacity?.retryAt).toBeNull();
    expect(status.running).toBeNull();
    expect(status.lastExport).toMatchObject({
      action: 'retry',
      candidates: 1,
      done: 1,
      remaining: 0,
      halted: null,
    });
  });
});

describe('LinearSync export', () => {
  // One task of every shape an export scope decides on.
  function seedBoard(): Record<string, string> {
    const remote = fake.issue({ updatedAt: '2027-01-01T00:00:00.000Z' });
    fake.issues = [remote];
    const linked = store.create({ title: 'Linked' });
    store.update(linked.meta.id, { external: `linear:${remote.id}` });
    const archived = store.create({ title: 'Archived open', status: 'todo' });
    store.update(archived.meta.id, { archivedAt: '2026-07-01T00:00:00.000Z' });
    const ids = {
      open: store.create({ title: 'Open', status: 'todo' }).meta.id,
      done: store.create({ title: 'Finished', status: 'done' }).meta.id,
      archived: archived.meta.id,
      derived: store.create({
        title: 'Review PR #7',
        derivedFrom: 'github-pr:7',
      }).meta.id,
      linked: linked.meta.id,
    };
    seedState({ bootstrappedAt: '2030-01-01T00:00:00.000Z' });
    cache.rebuild(store);
    return ids;
  }

  it('previews every scope without calling Linear', () => {
    seedBoard();
    expect(makeSync().exportPreview()).toEqual({
      open: 1,
      all: 2,
      allArchiveFinished: 3,
      finished: 1,
      archived: 1,
      derived: 1,
      containers: 0,
    });
    expect(fake.calls).toEqual([]);
  });

  it('sends open work only, reporting its own progress and outcome', async () => {
    seedBoard();
    const sync = makeSync();

    const started = sync.startExport('open');
    expect(started).toMatchObject({ ok: true, candidates: 1 });
    expect(sync.status().running?.action).toBe('export');
    await sync.idle();

    expect(fake.created.map((c) => c.title)).toEqual(['Open']);
    const progress = broadcasts.flatMap((e) =>
      e.type === 'linear.progress' ? [e.progress] : []
    );
    expect(progress.at(-1)).toEqual({
      phase: 'creating',
      done: 1,
      total: 1,
      action: 'export',
    });
    expect(progress.every((p) => p.phase === 'creating')).toBe(true);
    const status = sync.status();
    expect(status.progress).toBeNull();
    expect(status.running).toBeNull();
    expect(status.lastExport).toMatchObject({
      action: 'export',
      scope: 'open',
      startedAt: started.ok ? started.startedAt : '',
      candidates: 1,
      done: 1,
      remaining: 0,
      halted: null,
      errors: [],
    });
  });

  it('sends finished work as closed issues under all, archiving nothing', async () => {
    seedBoard();
    const sync = makeSync();

    sync.startExport('all');
    await sync.idle();

    expect(fake.created.map((c) => c.title ?? '').sort()).toEqual([
      'Finished',
      'Open',
    ]);
    expect(fake.created.find((c) => c.title === 'Finished')?.stateId).toBe(
      's-done'
    );
    expect(fake.calls).not.toContain('archiveIssue');
  });

  it('archives finished and archived tasks on arrival, and leaves them be afterwards', async () => {
    const ids = seedBoard();
    const sync = makeSync();

    sync.startExport('all-archive-finished');
    await sync.idle();

    expect(fake.created.map((c) => c.title ?? '').sort()).toEqual([
      'Archived open',
      'Finished',
      'Open',
    ]);
    expect(fake.calls.filter((c) => c === 'archiveIssue')).toHaveLength(2);
    const archivedTitles = fake.issues
      .filter((i) => i.archivedAt !== null)
      .map((i) => i.title)
      .sort();
    expect(archivedTitles).toEqual(['Archived open', 'Finished']);
    expect(sync.status().lastExport).toMatchObject({
      candidates: 3,
      done: 3,
      archivedOnArrival: 2,
    });

    await sync.syncOnce();

    expect(fake.calls).not.toContain('unarchiveIssue');
    expect(fake.updated).toHaveLength(0);
    expect(store.get(ids.done)?.meta.archivedAt).toBeUndefined();
  });

  it('works before the link exists: it baselines, then creates the targets', async () => {
    store.create({ title: 'Predates everything' });
    cache.rebuild(store);
    const sync = makeSync();

    sync.startExport('open');
    await sync.idle();

    expect(fake.created.map((c) => c.title)).toEqual(['Predates everything']);
    const state = readLinearState(root);
    expect(state.bootstrappedAt).not.toBeNull();
    expect(state.localOnly).toEqual({});
  });

  it('stops creating at the issue limit and reports what remains', async () => {
    seedState({ bootstrappedAt: '2030-01-01T00:00:00.000Z' });
    for (const title of ['One', 'Two', 'Three']) store.create({ title });
    cache.rebuild(store);
    fake.issueLimit = 1;
    const sync = makeSync();

    sync.startExport('open');
    await sync.idle();

    expect(createCalls()).toBe(2);
    expect(sync.status().lastExport).toMatchObject({
      candidates: 3,
      done: 1,
      remaining: 2,
      halted: 'usage-limit',
      errors: [LINEAR_USAGE_LIMIT_MESSAGE],
    });
    expect(Object.keys(readLinearState(root).pushQueue)).toHaveLength(2);
  });

  it('counts a repeated failure once in the outcome', async () => {
    seedState({ bootstrappedAt: '2030-01-01T00:00:00.000Z' });
    for (const title of ['One', 'Two', 'Three']) store.create({ title });
    cache.rebuild(store);
    fake.createFailure = {
      ok: false,
      kind: 'graphql',
      error: 'validation failed',
    };
    const sync = makeSync();

    sync.startExport('open');
    await sync.idle();

    expect(sync.status().lastExport?.errors).toEqual([
      'validation failed (x3)',
    ]);
    const queue = readLinearState(root).pushQueue;
    expect(Object.values(queue).map((e) => e.origin)).toEqual([
      'export',
      'export',
      'export',
    ]);
  });

  it('refuses a second bulk action while one runs, and a pull-only link', async () => {
    seedBoard();
    const sync = makeSync();

    expect(sync.startExport('open').ok).toBe(true);
    expect(sync.startExport('all')).toEqual({
      ok: false,
      status: 409,
      error: 'an export or archive is already running',
    });
    await sync.idle();

    writeConfig('pull');
    expect(sync.startExport('open')).toEqual({
      ok: false,
      status: 409,
      error: 'sync direction is pull only; export needs push',
    });
  });
});

describe('LinearSync archive closed issues', () => {
  // Linked Done and Canceled issues, an unlinked Done one, and a live one.
  async function seedClosed(): Promise<{
    sync: LinearSync;
    done: string;
    canceled: string;
  }> {
    // Newer than the local tasks, so the first pass takes Linear's states.
    const updatedAt = '2027-01-01T00:00:00.000Z';
    fake.issues = [
      fake.issue({ title: 'Done linked', state: DONE_STATE, updatedAt }),
      fake.issue({ title: 'Done unlinked', state: DONE_STATE, updatedAt }),
      fake.issue({
        title: 'Canceled linked',
        state: CANCELED_STATE,
        updatedAt,
      }),
      fake.issue({ title: 'Still going', updatedAt }),
    ];
    const done = store.create({ title: 'Done linked' });
    store.update(done.meta.id, { external: `linear:${fake.issues[0].id}` });
    const canceled = store.create({ title: 'Canceled linked' });
    store.update(canceled.meta.id, {
      external: `linear:${fake.issues[2].id}`,
    });
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    const sync = makeSync();
    await sync.syncOnce();
    return { sync, done: done.meta.id, canceled: canceled.meta.id };
  }

  it('refuses before the link exists', () => {
    expect(makeSync().startArchiveClosed({ includeCanceled: false })).toEqual({
      ok: false,
      status: 409,
      error: 'Linear is not linked yet; sync once first',
    });
  });

  it('archives completed issues in Linear and pulls the archive onto their tasks', async () => {
    const { sync, done, canceled } = await seedClosed();

    const started = sync.startArchiveClosed({ includeCanceled: false });
    expect(started.ok).toBe(true);
    await sync.idle();

    const archived = fake.issues
      .filter((i) => i.archivedAt !== null)
      .map((i) => i.title)
      .sort();
    expect(archived).toEqual(['Done linked', 'Done unlinked']);
    expect(store.get(done)?.meta.archivedAt).toBeDefined();
    expect(store.get(canceled)?.meta.archivedAt).toBeUndefined();
    const progress = broadcasts.flatMap((e) =>
      e.type === 'linear.progress' ? [e.progress] : []
    );
    expect(progress.at(-1)).toEqual({
      phase: 'archiving',
      done: 2,
      total: 2,
      action: 'archive',
    });
    expect(sync.status().lastArchive).toMatchObject({
      action: 'archive',
      includeCanceled: false,
      candidates: 2,
      done: 2,
      remaining: 0,
      halted: null,
    });
    // Nothing local was pushed back.
    expect(fake.updated).toHaveLength(0);

    sync.startArchiveClosed({ includeCanceled: true });
    await sync.idle();

    expect(store.get(canceled)?.meta.archivedAt).toBeDefined();
    expect(fake.issues.find((i) => i.title === 'Still going')?.archivedAt).toBe(
      null
    );
  });

  it('ends the issue-limit pause and drains the creates queued behind it', async () => {
    fake.issues = [fake.issue({ title: 'Closed', state: DONE_STATE })];
    const doc = store.create({ title: 'Waiting for room' });
    seedState({
      bootstrappedAt: '2030-01-01T00:00:00.000Z',
      capacity: {
        limitedAt: '2026-07-01T00:00:00.000Z',
        retryAt: '2099-01-01T00:00:00.000Z',
        message: LINEAR_USAGE_LIMIT_MESSAGE,
        active: 250,
        limit: 250,
        limitSource: 'plan',
        plan: 'free',
        checkedAt: null,
      },
      pushQueue: {
        [doc.meta.id]: queuedEntry({
          origin: 'export',
          lastError: LINEAR_USAGE_LIMIT_MESSAGE,
          lastErrorKind: 'usage-limit',
        }),
      },
    });
    const sync = new LinearSync({
      rootDir: root,
      store,
      cache,
      events,
      client: fake,
      pushDebounceMs: 1,
    });

    sync.startArchiveClosed({ includeCanceled: false });
    await sync.idle();
    expect(sync.status().capacity?.retryAt).toBeNull();

    await waitFor(() => fake.created.length === 1);
    await sync.stop();
    expect(store.get(doc.meta.id)?.meta.external).toBe('linear:issue-2');
  });
});

describe('LinearSync creates a throttle cuts short', () => {
  it('links an issue a throttle stopped after its create, and never creates it twice', async () => {
    seedState({ bootstrappedAt: '2030-01-01T00:00:00.000Z' });
    const doc = store.create({ title: 'Finished thing', status: 'done' });
    cache.rebuild(store);
    fake.failures.archiveIssue = {
      ok: false,
      kind: 'rate-limit',
      error: 'linear rate limit reached',
      retryAfterMs: 1,
    };
    const sync = makeSync();

    sync.startExport('all-archive-finished');
    await sync.idle();

    expect(fake.issues).toHaveLength(1);
    const issueId = fake.issues[0]?.id;
    expect(store.get(doc.meta.id)?.meta.external).toBe(`linear:${issueId}`);
    expect(readLinearState(root).pushQueue).toEqual({});
    expect(sync.status().lastExport).toMatchObject({
      done: 1,
      halted: 'rate-limit',
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    delete fake.failures.archiveIssue;
    await sync.syncOnce();

    expect(createCalls()).toBe(1);
    expect(
      store.list().filter((d) => d.meta.title === 'Finished thing')
    ).toHaveLength(1);
    // The archive it was to arrive with goes on the next pass.
    expect(fake.issues[0]?.archivedAt).not.toBeNull();
  });

  it('retries an arrival archive that failed, without archiving the task here', async () => {
    seedState({ bootstrappedAt: '2030-01-01T00:00:00.000Z' });
    const doc = store.create({ title: 'Finished', status: 'done' });
    cache.rebuild(store);
    fake.failures.archiveIssue = {
      ok: false,
      kind: 'network',
      error: 'socket hang up',
    };
    const sync = makeSync();

    sync.startExport('all-archive-finished');
    await sync.idle();
    expect(fake.issues[0]?.archivedAt).toBeNull();
    expect(sync.status().lastExport).toMatchObject({
      done: 1,
      archivedOnArrival: 0,
      errors: ['socket hang up'],
    });

    delete fake.failures.archiveIssue;
    await sync.syncOnce();
    expect(fake.issues[0]?.archivedAt).not.toBeNull();
    expect(readLinearState(root).pendingArchives).toEqual({});

    fake.calls = [];
    await sync.syncOnce();
    expect(fake.calls).not.toContain('archiveIssue');
    expect(fake.calls).not.toContain('unarchiveIssue');
    expect(store.get(doc.meta.id)?.meta.archivedAt).toBeUndefined();
  });

  it('queues an export a throttle stops before any create, so later passes send it', async () => {
    seedState({ bootstrappedAt: '2030-01-01T00:00:00.000Z' });
    const doc = store.create({ title: 'Waits out the throttle' });
    cache.rebuild(store);
    fake.failures.capacity = {
      ok: false,
      kind: 'rate-limit',
      error: 'linear rate limit reached',
      retryAfterMs: 300,
    };
    const sync = makeSync();
    await sync.capacity(true);

    expect(sync.startExport('open')).toMatchObject({ ok: true, candidates: 1 });
    await sync.idle();

    expect(createCalls()).toBe(0);
    expect(sync.status().lastExport).toMatchObject({
      done: 0,
      remaining: 1,
      halted: 'rate-limit',
    });
    expect(readLinearState(root).pushQueue[doc.meta.id]).toMatchObject({
      origin: 'export',
      attempts: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 350));
    await sync.syncOnce();
    expect(store.get(doc.meta.id)?.meta.external).toBe('linear:issue-1');
  });

  it('never exports a task whose issue moved out of the linked teams', async () => {
    seedState({
      bootstrappedAt: '2030-01-01T00:00:00.000Z',
      movedOut: { 'issue-elsewhere': '' },
    });
    const moved = store.create({ title: 'Moved away' });
    const open = store.create({ title: 'Open' });
    const state = readLinearState(root);
    state.movedOut = { 'issue-elsewhere': moved.meta.id };
    writeLinearState(root, state);
    cache.rebuild(store);
    const sync = makeSync();

    expect(sync.exportPreview().open).toBe(1);
    sync.startExport('all');
    await sync.idle();

    expect(fake.created.map((c) => c.title)).toEqual(['Open']);
    expect(store.get(open.meta.id)?.meta.external).not.toBeNull();
    expect(store.get(moved.meta.id)?.meta.external).toBeNull();
  });

  it('sends the archive and comments of a create a throttle stopped after it landed', async () => {
    const comments = new FileCommentStore(root);
    const doc = store.create({ title: 'Shelved' });
    const shelved = store.update(doc.meta.id, {
      archivedAt: '2026-07-01T00:00:00.000Z',
    });
    comments.add({ taskId: doc.meta.id, author: 'human:me', body: 'Context' });
    // Held back, as linking the board records every unlinked task.
    seedState({
      bootstrappedAt: '2030-01-01T00:00:00.000Z',
      localOnly: { [doc.meta.id]: shelved.meta.updated },
    });
    cache.rebuild(store);
    fake.failures.archiveIssue = {
      ok: false,
      kind: 'rate-limit',
      error: 'linear rate limit reached',
      retryAfterMs: 1,
    };
    const sync = new LinearSync({
      rootDir: root,
      store,
      cache,
      events,
      client: fake,
      comments,
    });

    sync.startExport('all-archive-finished');
    await sync.idle();
    expect(store.get(doc.meta.id)?.meta.external).toBe('linear:issue-1');

    await new Promise((resolve) => setTimeout(resolve, 5));
    delete fake.failures.archiveIssue;
    await sync.syncOnce();

    expect(createCalls()).toBe(1);
    expect(fake.issues[0]?.archivedAt).not.toBeNull();
    expect(fake.commentList.map((c) => c.body)).toEqual(['Context']);
  });

  it.each([
    ['a throttle', 'rate-limit'],
    ['a failure', 'network'],
  ] as const)(
    'sends the comments of a new issue %s stopped them on',
    async (_, kind) => {
      seedState({ bootstrappedAt: '2030-01-01T00:00:00.000Z' });
      const comments = new FileCommentStore(root);
      const doc = store.create({ title: 'Talked about' });
      comments.add({ taskId: doc.meta.id, author: 'human:me', body: 'One' });
      // Comments go in creation order; a shared millisecond would tie them.
      await new Promise((resolve) => setTimeout(resolve, 3));
      comments.add({ taskId: doc.meta.id, author: 'human:me', body: 'Two' });
      cache.rebuild(store);
      fake.failures.createComment = {
        ok: false,
        kind,
        error: 'comment refused',
        retryAfterMs: 1,
      };
      const sync = new LinearSync({
        rootDir: root,
        store,
        cache,
        events,
        client: fake,
        comments,
      });

      sync.startExport('open');
      await sync.idle();
      expect(store.get(doc.meta.id)?.meta.external).toBe('linear:issue-1');

      await new Promise((resolve) => setTimeout(resolve, 5));
      delete fake.failures.createComment;
      await sync.syncOnce();

      expect(fake.commentList.map((c) => c.body)).toEqual(['One', 'Two']);
    }
  );

  it('drops an arrival archive once the task is reopened', async () => {
    seedState({ bootstrappedAt: '2030-01-01T00:00:00.000Z' });
    const doc = store.create({ title: 'Finished', status: 'done' });
    cache.rebuild(store);
    fake.failures.archiveIssue = {
      ok: false,
      kind: 'network',
      error: 'socket hang up',
    };
    const sync = makeSync();
    sync.startExport('all-archive-finished');
    await sync.idle();
    expect(readLinearState(root).pendingArchives).toEqual({
      [doc.meta.id]: 'issue-1',
    });

    delete fake.failures.archiveIssue;
    const issue = fake.issues[0];
    if (issue === undefined) throw new Error('no issue created');
    issue.state = STATES[2];
    issue.updatedAt = fake.stamp();
    fake.calls = [];
    await sync.syncOnce();

    expect(store.get(doc.meta.id)?.meta.status).toBe('In Progress');
    expect(fake.calls).not.toContain('archiveIssue');
    expect(issue.archivedAt).toBeNull();
    expect(readLinearState(root).pendingArchives).toEqual({});
  });

  it('stops retrying arrival archives at an auth refusal or a run of refusals', async () => {
    seedState({ bootstrappedAt: '2030-01-01T00:00:00.000Z' });
    for (let i = 0; i < 8; i++) {
      store.create({ title: `Finished ${i}`, status: 'done' });
    }
    cache.rebuild(store);
    fake.failures.archiveIssue = {
      ok: false,
      kind: 'graphql',
      error: 'forbidden',
    };
    const sync = makeSync();
    sync.startExport('all-archive-finished');
    await sync.idle();
    const pending = () =>
      Object.keys(readLinearState(root).pendingArchives ?? {});
    const first = pending();
    expect(first).toHaveLength(8);

    fake.calls = [];
    await sync.syncOnce();
    expect(fake.calls.filter((c) => c === 'archiveIssue')).toHaveLength(5);
    // The refused ones go to the back, so the next pass tries the others.
    expect(pending().slice(0, 3)).toEqual(first.slice(5));

    fake.failures.archiveIssue = {
      ok: false,
      kind: 'auth',
      error: 'invalid Linear API key',
    };
    fake.calls = [];
    await sync.syncOnce();
    expect(fake.calls.filter((c) => c === 'archiveIssue')).toHaveLength(1);
    expect(pending()).toHaveLength(8);
  });
});

describe('LinearSync capacity and the pause', () => {
  it('keeps the pause a pass set when a measurement taken during it showed room', async () => {
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    const ids = ['A', 'B'].map((title) => store.create({ title }).meta.id);
    fake.issueLimit = 1;
    const sync = makeSync();
    const measuring: Promise<unknown>[] = [];
    fake.onCall = (method) => {
      if (method === 'createIssue' && measuring.length === 0) {
        measuring.push(sync.capacity(true));
      }
    };

    const summary = await sync.syncOnce(ids);
    await Promise.all(measuring);

    expect(summary.usageLimited).toBe(true);
    expect(sync.status().capacity).toMatchObject({
      message: LINEAR_USAGE_LIMIT_MESSAGE,
    });
    expect(sync.status().capacity?.retryAt).not.toBeNull();
  });

  it('ends the pause only once the count drops, since the key may not see every team', async () => {
    seedState({
      bootstrappedAt: '2030-01-01T00:00:00.000Z',
      capacity: {
        limitedAt: '2026-07-01T00:00:00.000Z',
        retryAt: '2099-01-01T00:00:00.000Z',
        message: LINEAR_USAGE_LIMIT_MESSAGE,
        active: 1,
        limit: 250,
        limitSource: 'plan',
        plan: 'free',
        checkedAt: '2026-06-30T00:00:00.000Z',
      },
    });
    fake.issues = [fake.issue()];
    const sync = makeSync();

    await sync.capacity(true);
    expect(sync.status().capacity?.retryAt).toBe('2099-01-01T00:00:00.000Z');

    fake.issues = [];
    await sync.capacity(true);
    expect(sync.status().capacity?.retryAt).toBeNull();
  });

  it('ends a pause on an unread plan only once the count drops', async () => {
    seedState({
      bootstrappedAt: '2030-01-01T00:00:00.000Z',
      capacity: {
        limitedAt: '2026-07-01T00:00:00.000Z',
        retryAt: '2099-01-01T00:00:00.000Z',
        message: LINEAR_USAGE_LIMIT_MESSAGE,
        active: 1,
        limit: null,
        limitSource: null,
        plan: 'unknown',
        checkedAt: '2026-06-30T00:00:00.000Z',
      },
    });
    fake.plan = 'unknown';
    fake.issues = [fake.issue()];
    const sync = makeSync();

    await sync.capacity(true);
    expect(sync.status().capacity).toMatchObject({
      retryAt: '2099-01-01T00:00:00.000Z',
      limit: 250,
    });

    fake.issues = [];
    await sync.capacity(true);
    expect(sync.status().capacity?.retryAt).toBeNull();
  });

  it('takes the Free plan’s limit as observed once Linear refused a create on an unread plan', async () => {
    seedState({
      bootstrappedAt: '2030-01-01T00:00:00.000Z',
      capacity: {
        limitedAt: '2026-07-01T00:00:00.000Z',
        retryAt: null,
        message: null,
        active: null,
        limit: null,
        limitSource: null,
        plan: 'unknown',
        checkedAt: null,
      },
    });
    fake.plan = 'unknown';
    const sync = makeSync();

    const measured = await sync.capacity(true);

    expect(measured.ok && measured.data).toMatchObject({
      limit: 250,
      limitSource: 'observed',
      plan: 'unknown',
    });
    expect(sync.status().capacity).toMatchObject({
      limit: 250,
      limitSource: 'observed',
    });
  });

  it('reuses a paid plan’s closed counts between measurements, and shares one in flight', async () => {
    fake.plan = 'paid';
    const sync = makeSync();

    const [a, b] = await Promise.all([
      sync.capacity(true),
      sync.capacity(true),
    ]);
    expect(a).toBe(b);
    expect(fake.calls.filter((c) => c === 'capacity')).toHaveLength(1);

    // Past the minute the measurement is reused for: the counts are re-read
    // but the closed walks are not.
    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 60_000;
    try {
      await sync.capacity();
    } finally {
      Date.now = realNow;
    }
    expect(fake.capacityReuse).toHaveLength(2);
    expect(fake.capacityReuse[0]).toBeUndefined();
    expect(fake.capacityReuse[1]?.teams.map((t) => t.id)).toEqual(['team-1']);
  });

  it('answers a refresh with closed counts walked afresh, even beside a plain read', async () => {
    fake.plan = 'paid';
    fake.issues = [fake.issue({ state: DONE_STATE })];
    const sync = makeSync();
    await sync.capacity(true);
    fake.issues.push(
      fake.issue({ state: DONE_STATE }),
      fake.issue({ state: DONE_STATE })
    );

    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 60_000;
    try {
      const [, refreshed] = await Promise.all([
        sync.capacity(),
        sync.capacity(true),
      ]);
      expect(refreshed.ok && refreshed.data.teams[0]?.completed).toBe(3);
    } finally {
      Date.now = realNow;
    }
  });

  it('leaves the stored counts and the pause to a newer measurement', async () => {
    const paused = {
      limitedAt: '2026-07-01T00:00:00.000Z',
      retryAt: '2099-01-01T00:00:00.000Z',
      message: LINEAR_USAGE_LIMIT_MESSAGE,
    };
    seedState({
      bootstrappedAt: '2020-01-01T00:00:00.000Z',
      capacity: {
        ...paused,
        active: 250,
        limit: 250,
        limitSource: 'plan',
        plan: 'free',
        checkedAt: '2026-07-01T00:00:00.000Z',
      },
    });
    fake.issues = Array.from({ length: 240 }, () => fake.issue());
    const sync = makeSync();

    // A plain read counts 240, then answers only after a refresh counts 250.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const measure = fake.capacity.bind(fake);
    fake.capacity = (teamIds, reuse) => {
      const counted = measure(teamIds, reuse);
      fake.capacity = measure;
      return gate.then(() => counted);
    };
    const held = sync.capacity();
    fake.issues.push(...Array.from({ length: 10 }, () => fake.issue()));
    await sync.capacity(true);
    release();
    await held;

    expect(sync.status().capacity).toMatchObject({ ...paused, active: 250 });
  });

  it('never caches a measurement begun before an archive pass ended', async () => {
    fake.plan = 'paid';
    fake.issues = [
      fake.issue({ state: DONE_STATE }),
      fake.issue({ state: DONE_STATE }),
    ];
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    const sync = makeSync();
    await sync.capacity(true);

    // A plain read, held open while the archive runs, reuses the counts.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const measure = fake.capacity.bind(fake);
    fake.capacity = (teamIds, reuse) =>
      gate.then(() => measure(teamIds, reuse));
    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 60_000;
    let held: Promise<unknown>;
    try {
      held = sync.capacity();
    } finally {
      Date.now = realNow;
    }
    sync.startArchiveClosed({ includeCanceled: false });
    await sync.idle();
    release();
    await held;
    fake.capacity = measure;

    const after = await sync.capacity();
    expect(after.ok && after.data.teams[0]?.completed).toBe(0);
  });
});

describe('LinearSync archive closed issues, refused', () => {
  function linkedClosed(n: number): LinearSync {
    fake.issues = Array.from({ length: n }, (_, i) =>
      fake.issue({ title: `Closed ${i}`, state: DONE_STATE })
    );
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    return makeSync();
  }

  it('stops at the first auth failure', async () => {
    const sync = linkedClosed(4);
    fake.failures.archiveIssue = {
      ok: false,
      kind: 'auth',
      error: 'invalid Linear API key',
    };

    sync.startArchiveClosed({ includeCanceled: false });
    await sync.idle();

    expect(fake.calls.filter((c) => c === 'archiveIssue')).toHaveLength(1);
    expect(sync.status().lastArchive?.errors).toContain(
      'stopped archiving after 1 of 4: Linear refused the archive'
    );
  });

  it('stops after a run of refusals', async () => {
    const sync = linkedClosed(12);
    fake.failures.archiveIssue = {
      ok: false,
      kind: 'graphql',
      error: 'forbidden',
    };

    sync.startArchiveClosed({ includeCanceled: false });
    await sync.idle();

    expect(fake.calls.filter((c) => c === 'archiveIssue')).toHaveLength(5);
  });

  it('archives Duplicate issues with the canceled ones', async () => {
    const duplicate = {
      id: 's-duplicate',
      name: 'Duplicate',
      type: 'duplicate',
      position: 6,
    };
    fake.states = [...STATES, duplicate];
    fake.issues = [fake.issue({ title: 'Dupe', state: duplicate })];
    seedState({ bootstrappedAt: '2020-01-01T00:00:00.000Z' });
    const sync = makeSync();

    const measured = await sync.capacity(true);
    expect(measured.ok && measured.data.teams[0]?.canceled).toBe(1);
    sync.startArchiveClosed({ includeCanceled: true });
    await sync.idle();

    expect(fake.issues[0]?.archivedAt).not.toBeNull();
  });
});
