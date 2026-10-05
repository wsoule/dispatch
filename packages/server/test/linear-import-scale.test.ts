import { TaskStore } from '@dispatch-foo/core';
import type {
  CreateInput,
  LinearIssue,
  TaskDoc,
  UpdatePatch,
} from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus } from '../src/events.js';
import type { ServerEvent } from '../src/events.js';
import { HttpLinearClient } from '../src/linear/client.js';
import { ISSUE_PAGE } from '../src/linear/queries.js';
import { LinearSync } from '../src/linear/sync.js';
import {
  FakeLinearClient,
  LABELS,
  STATES,
  TEAMMATE,
  VIEWER,
} from './linearFake.js';
import { graphqlFetch } from './linearGraphqlFake.js';
import type { GraphqlWorld } from './linearGraphqlFake.js';

const ISSUES = 2000;

let root: string;
let store: TaskStore;
let cache: TaskCache;
let events: EventBus;
let broadcasts: ServerEvent[];
const originalHome = process.env.DISPATCH_HOME;

// A team of `count` issues across a project, with sub-issues, assignees,
// labels and blocking relations, as the real API would page them out.
function world(count: number): GraphqlWorld {
  const shape = new FakeLinearClient();
  const project = shape.project({ id: 'proj-big', name: 'Big project' });
  const issues: LinearIssue[] = [];
  for (let n = 0; n < count; n++) {
    const id = `iss-${n}`;
    issues.push(
      shape.issue({
        id,
        identifier: `HYD-${n}`,
        title: `Issue ${n}`,
        url: `https://linear.app/acme/issue/HYD-${n}`,
        updatedAt: new Date(Date.UTC(2026, 6, 1) + n * 1000).toISOString(),
        state: STATES[n % STATES.length],
        assigneeId: n % 3 === 0 ? TEAMMATE.id : null,
        projectId: n % 4 === 0 ? project.id : null,
        parentId: n % 10 === 5 ? `iss-${n - 1}` : null,
        relations:
          n % 25 === 1
            ? [
                {
                  id: `rel-${n}`,
                  type: 'blocks',
                  issueId: `iss-${n - 1}`,
                  relatedIssueId: id,
                },
              ]
            : [],
      })
    );
  }
  // Relations appear on both ends, as `relations` and `inverseRelations`.
  for (const issue of issues) {
    for (const r of issue.relations) {
      const other = issues.find((i) => i.id === r.issueId);
      if (other !== undefined && other !== issue)
        other.relations.push({ ...r });
    }
  }
  return {
    viewer: VIEWER,
    members: [VIEWER, TEAMMATE],
    states: STATES,
    labels: LABELS,
    issues,
    projects: [project],
  };
}

beforeEach(() => {
  process.env.DISPATCH_HOME = mkdtempSync(
    join(tmpdir(), 'dispatch-scale-home-')
  );
  root = mkdtempSync(join(tmpdir(), 'dispatch-scale-'));
  store = TaskStore.init(root);
  cache = new TaskCache();
  events = new EventBus();
  broadcasts = [];
  events.subscribe((event) => broadcasts.push(event));
  writeFileSync(
    join(root, '.dispatch', 'config.yml'),
    'autoCommit: false\nlinear:\n  enabled: true\n  teamId: team-1\n'
  );
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
});

describe(`importing ${ISSUES} issues through the GraphQL client`, () => {
  it('pages sanely, batches its events and reports progress', async () => {
    const team = world(ISSUES);
    const { fetch, requests } = graphqlFetch(team);
    const sync = new LinearSync({
      rootDir: root,
      store,
      cache,
      events,
      client: new HttpLinearClient('lin_api_test', { fetchImpl: fetch }),
      localHumanRef: 'human:wyat',
    });

    // What a timer sees of the apply phase: it only ever fires mid-apply if
    // the import hands the event loop back as it writes.
    const seenApplying: number[] = [];
    const tick = setInterval(() => {
      const progress = sync.status().progress;
      if (progress?.phase === 'applying') seenApplying.push(progress.done);
    }, 1);
    const started = Date.now();
    const summary = await sync.importIssues();
    const elapsed = Date.now() - started;
    clearInterval(tick);
    expect(seenApplying.some((done) => done < ISSUES)).toBe(true);

    expect(summary.errors).toEqual([]);
    expect(summary.created).toBe(ISSUES + 1);
    const docs = store.list();
    expect(docs).toHaveLength(ISSUES + 1);

    // Pages at the query's own size, and never refetches one issue at a time.
    const pages = requests.filter((r) => r.operation === 'IssuesAll').length;
    expect(pages).toBe(Math.ceil(ISSUES / ISSUE_PAGE));
    expect(requests.some((r) => r.operation === 'IssuesById')).toBe(false);
    expect(requests.length).toBeLessThan(pages + 15);

    // Writes reach clients as a handful of batched events naming their ids —
    // at most one per 1.5s of work plus the last — never one per task.
    const changed = broadcasts.filter(
      (e): e is Extract<ServerEvent, { type: 'task.changed' }> =>
        e.type === 'task.changed'
    );
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThanOrEqual(Math.ceil(elapsed / 1500) + 2);
    expect(changed.every((e) => e.ids !== undefined)).toBe(true);
    const named = new Set(changed.flatMap((e) => e.ids ?? []));
    for (const doc of docs) expect(named.has(doc.meta.id)).toBe(true);

    // Progress runs through fetching then applying, and ends cleared.
    const progress = broadcasts.flatMap((e) =>
      e.type === 'linear.progress' ? [e.progress] : []
    );
    const fetching = progress.filter((p) => p.phase === 'issues');
    expect(fetching.at(-1)?.done).toBe(ISSUES);
    const applying = progress.filter((p) => p.phase === 'applying');
    expect(applying.length).toBeGreaterThan(1);
    expect(applying.at(-1)?.done).toBeGreaterThanOrEqual(ISSUES);
    expect(sync.status().progress).toBeNull();

    // The mapping held at scale.
    const byExternal = new Map(docs.map((d) => [d.meta.external, d.meta]));
    const project = byExternal.get('linear-project:proj-big');
    expect(byExternal.get('linear:iss-4')?.parent).toBe(project?.id);
    expect(byExternal.get('linear:iss-5')?.parent).toBe(
      byExternal.get('linear:iss-4')?.id
    );
    expect(byExternal.get('linear:iss-26')?.blockedBy).toEqual([
      byExternal.get('linear:iss-25')?.id ?? '',
    ]);
    expect(byExternal.get('linear:iss-3')?.assignee).toBe('human:ana');
    // No wall-clock bound: it flakes on a loaded machine. The page count and
    // the missing per-issue refetch above are what guard the cost.
  }, 300_000);

  it("keeps a user's edit that lands while the import applies", async () => {
    // Names the task the pass wrote last, so an edit can land on one whose
    // task.changed has not gone out yet.
    class LastWriteStore extends TaskStore {
      last: string | null = null;
      override create(input: CreateInput, now?: string): TaskDoc {
        const doc = super.create(input, now);
        this.last = doc.meta.id;
        return doc;
      }
      override update(id: string, patch: UpdatePatch, now?: string): TaskDoc {
        const doc = super.update(id, patch, now);
        this.last = id;
        return doc;
      }
    }
    const passStore = new LastWriteStore(root);
    const userStore = new TaskStore(root);
    const { fetch } = graphqlFetch(world(400));
    const sync = new LinearSync({
      rootDir: root,
      store: passStore,
      cache,
      events,
      client: new HttpLinearClient('lin_api_test', { fetchImpl: fetch }),
      localHumanRef: 'human:wyat',
    });

    const edited = new Set<string>();
    const tick = setInterval(() => {
      const id = passStore.last;
      if (sync.status().progress?.phase !== 'applying') return;
      if (id === null || edited.has(id) || edited.size >= 10) return;
      // What PATCH /api/tasks/:id does: the store, then the cache.
      userStore.update(id, { title: `edited by the user ${id}` });
      cache.refresh(userStore, [id]);
      edited.add(id);
    }, 1);
    await sync.importIssues();
    clearInterval(tick);

    expect(edited.size).toBeGreaterThan(0);
    for (const id of edited) {
      expect(cache.get(id)?.meta.title).toBe(store.get(id)?.meta.title);
    }
  }, 120_000);

  it('follows an import with one cheap probe when nothing moved', async () => {
    const { fetch, requests } = graphqlFetch(world(300));
    const sync = new LinearSync({
      rootDir: root,
      store,
      cache,
      events,
      client: new HttpLinearClient('lin_api_test', { fetchImpl: fetch }),
      localHumanRef: 'human:wyat',
    });
    await sync.importIssues();
    await sync.syncOnce();
    requests.length = 0;

    await sync.syncOnce();

    expect(requests.map((r) => r.operation)).toEqual(['Probe']);
  }, 60_000);
});

describe(`importing ${ISSUES} issues across two linked teams`, () => {
  const OPS_STATES = STATES.map((s) => ({ ...s, id: `ops-${s.id}` }));

  // The same world, every other issue in Ops (on its own copy of the
  // workflow), and the project shared by both teams.
  function twoTeams(): GraphqlWorld {
    const base = world(ISSUES);
    base.projects = base.projects.map((p) => ({
      ...p,
      teamIds: ['team-1', 'team-2'],
    }));
    base.issues = base.issues.map((issue, n) =>
      n % 2 === 0
        ? issue
        : {
            ...issue,
            identifier: `OPS-${n}`,
            team: { id: 'team-2', key: 'OPS' },
            state: OPS_STATES[n % OPS_STATES.length],
          }
    );
    base.teams = [
      { id: 'team-2', key: 'OPS', name: 'Ops', states: OPS_STATES },
    ];
    return base;
  }

  it('pages each team once, shares one vocabulary, and idles on a probe per team', async () => {
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'autoCommit: false\nlinear:\n  enabled: true\n  teamIds: [team-1, team-2]\n'
    );
    const { fetch, requests } = graphqlFetch(twoTeams());
    const sync = new LinearSync({
      rootDir: root,
      store,
      cache,
      events,
      client: new HttpLinearClient('lin_api_test', { fetchImpl: fetch }),
      localHumanRef: 'human:wyat',
    });

    const summary = await sync.importIssues();

    expect(summary.errors).toEqual([]);
    // Every issue once, and the shared project once.
    expect(summary.created).toBe(ISSUES + 1);
    const pages = requests.filter((r) => r.operation === 'IssuesAll').length;
    expect(pages).toBe(2 * Math.ceil(ISSUES / 2 / ISSUE_PAGE));
    expect(requests.some((r) => r.operation === 'IssuesById')).toBe(false);
    // Both teams' identical workflows collapse into one set of statuses.
    const statuses = new Set(store.list().map((d) => d.meta.status));
    expect(statuses.size).toBeLessThanOrEqual(STATES.length);

    await sync.syncOnce();
    requests.length = 0;
    await sync.syncOnce();
    expect(requests.map((r) => r.operation)).toEqual(['Probe', 'Probe']);
  }, 300_000);
});
