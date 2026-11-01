import { statusModelOf, TaskStore } from '@dispatch-foo/core';
import type { TaskListItem } from '@dispatch-foo/core';
import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  coverageCounts,
  exportCandidates,
  exportPreview,
  linearCoverage,
} from '../src/linear/coverage.js';
import type { LinearSyncState, PushAttempt } from '../src/linear/state.js';
import { emptyLinearState } from '../src/linear/state.js';

const model = statusModelOf(undefined);
let store: TaskStore;

beforeEach(() => {
  store = TaskStore.init(mkdtempSync(join(tmpdir(), 'dispatch-coverage-')));
});

function task(
  title: string,
  opts: {
    status?: string;
    kind?: 'task' | 'project' | 'milestone' | 'initiative';
    external?: string;
    archived?: boolean;
    derived?: boolean;
  } = {}
): string {
  const doc = store.create({
    title,
    status: opts.status ?? 'ready',
    ...(opts.kind === undefined ? {} : { kind: opts.kind }),
    ...(opts.derived === true ? { derivedFrom: 'github-pr:7' } : {}),
  });
  if (opts.external !== undefined || opts.archived === true) {
    store.update(doc.meta.id, {
      ...(opts.external === undefined ? {} : { external: opts.external }),
      ...(opts.archived === true
        ? { archivedAt: '2026-07-01T00:00:00.000Z' }
        : {}),
    });
  }
  return doc.meta.id;
}

function items(): TaskListItem[] {
  return store.list();
}

function queued(overrides: Partial<PushAttempt> = {}): PushAttempt {
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

// One task of every export-relevant shape.
function board(): Record<string, string> {
  return {
    open: task('Open work'),
    done: task('Finished', { status: 'landed' }),
    dropped: task('Dropped', { status: 'dropped' }),
    archivedOpen: task('Archived open', { archived: true }),
    archivedDone: task('Archived done', { status: 'landed', archived: true }),
    derived: task('Review PR #7', { derived: true }),
    linked: task('Linked', { external: 'linear:issue-1' }),
    project: task('A project', { kind: 'project' }),
  };
}

describe('exportCandidates', () => {
  it('sends only open, unarchived, unlinked, non-derived work for open', () => {
    const ids = board();
    const plan = exportCandidates(items(), 'open', model, emptyLinearState());
    expect(plan.taskIds.sort()).toEqual([ids.open, ids.project].sort());
    expect(plan.archiveOnArrival).toEqual([]);
  });

  it('adds finished tasks for all, still leaving archived ones out', () => {
    const ids = board();
    const plan = exportCandidates(items(), 'all', model, emptyLinearState());
    expect(plan.taskIds.sort()).toEqual(
      [ids.open, ids.done, ids.dropped, ids.project].sort()
    );
    expect(plan.archiveOnArrival).toEqual([]);
  });

  it('takes archived tasks too for all-archive-finished, and archives finished and archived ones on arrival', () => {
    const ids = board();
    const plan = exportCandidates(
      items(),
      'all-archive-finished',
      model,
      emptyLinearState()
    );
    expect(plan.taskIds.sort()).toEqual(
      [
        ids.open,
        ids.done,
        ids.dropped,
        ids.archivedOpen,
        ids.archivedDone,
        ids.project,
      ].sort()
    );
    expect(plan.archiveOnArrival.sort()).toEqual(
      [ids.done, ids.dropped, ids.archivedOpen, ids.archivedDone].sort()
    );
  });

  it('leaves out a task whose issue moved out of the linked teams', () => {
    const ids = board();
    const moved = task('Moved away');
    const state = { movedOut: { 'issue-9': moved } };
    for (const scope of ['open', 'all', 'all-archive-finished'] as const) {
      expect(exportCandidates(items(), scope, model, state).taskIds).toContain(
        ids.open
      );
      expect(
        exportCandidates(items(), scope, model, state).taskIds
      ).not.toContain(moved);
    }
    expect(exportPreview(items(), model, state)).toEqual(
      exportPreview(
        items().filter((i) => i.meta.id !== moved),
        model,
        emptyLinearState()
      )
    );
  });
});

describe('exportPreview', () => {
  it('counts each scope from one walk, with archived and derived apart', () => {
    board();
    expect(exportPreview(items(), model, emptyLinearState())).toEqual({
      open: 2,
      all: 4,
      allArchiveFinished: 6,
      finished: 2,
      archived: 2,
      derived: 1,
      containers: 1,
    });
  });
});

describe('linearCoverage', () => {
  it('counts linked tasks by entity and keeps derived ones out of the total', () => {
    task('Issue', { external: 'linear:issue-1' });
    task('Project', { kind: 'project', external: 'linear-project:p-1' });
    task('Unlinked');
    task('Review PR #7', { derived: true });

    const c = linearCoverage(items(), emptyLinearState(), {
      direction: 'both',
      model,
    });

    expect(c.total).toBe(3);
    expect(c.linked).toBe(2);
    expect(c.notLinked).toBe(1);
    expect(c.excluded).toEqual({ derived: 1 });
    expect(c.byEntity).toEqual({
      issue: 1,
      project: 1,
      milestone: 0,
      initiative: 0,
    });
    expect(c.unlinked.map((t) => t.title)).toEqual(['Unlinked']);
  });

  it('gives each unlinked task its reason in precedence order', () => {
    const capped = task('Capped');
    const failed = task('Failed');
    const waiting = task('Waiting');
    const movedAndFailed = task('Moved and failed');
    const moved = task('Moved');
    const held = task('Held back', { status: 'landed', archived: true });
    const legacy = task('Held back before the split');
    task('Pending');
    const state: LinearSyncState = {
      ...emptyLinearState(),
      pushQueue: {
        [capped]: queued({
          lastError: 'Workspace is at its issue limit',
          lastErrorKind: 'usage-limit',
        }),
        [failed]: queued({
          attempts: 2,
          lastError: 'validation failed',
          lastErrorKind: 'graphql',
          lastAttemptAt: '2026-07-02T00:00:00.000Z',
          retryAt: '2026-07-02T00:10:00.000Z',
        }),
        [waiting]: queued(),
        [movedAndFailed]: queued({ lastError: 'boom', lastErrorKind: 'http' }),
      },
      movedOut: { 'issue-9': moved, 'issue-8': movedAndFailed },
      localOnly: {
        [held]: store.get(held)?.meta.updated ?? '',
      },
      // A state written before the split held tasks back in `pushed`.
      pushed: { [legacy]: store.get(legacy)?.meta.updated ?? '' },
    };

    const c = linearCoverage(items(), state, { direction: 'both', model });
    const reasons = Object.fromEntries(
      c.unlinked.map((t) => [t.title, t.reason])
    );

    expect(reasons).toEqual({
      Capped: 'at-capacity',
      Failed: 'failed',
      Waiting: 'queued',
      'Moved and failed': 'failed',
      Moved: 'moved-out',
      'Held back': 'held-back',
      'Held back before the split': 'held-back',
      Pending: 'pending',
    });
    // Failed first, then by reason, then by title.
    expect(c.unlinked.map((t) => t.title)).toEqual([
      'Failed',
      'Moved and failed',
      'Capped',
      'Waiting',
      'Moved',
      'Held back',
      'Held back before the split',
      'Pending',
    ]);
    expect(c.unlinked.find((t) => t.id === failed)).toMatchObject({
      attempts: 2,
      lastError: 'validation failed',
      lastAttemptAt: '2026-07-02T00:00:00.000Z',
      retryAt: '2026-07-02T00:10:00.000Z',
    });
    expect(c.unlinked.find((t) => t.id === held)).toMatchObject({
      finished: true,
      archived: true,
      kind: 'task',
    });
    expect(c.counts).toEqual({
      failed: 2,
      'at-capacity': 1,
      queued: 1,
      'moved-out': 1,
      'pull-only': 0,
      'held-back': 2,
      pending: 1,
    });
  });

  it('marks unqueued tasks pull-only on a pull link, and an edit since holding back as pending', () => {
    const edited = task('Edited since');
    const waiting = task('Waiting');
    const state: LinearSyncState = {
      ...emptyLinearState(),
      localOnly: { [edited]: '2020-01-01T00:00:00.000Z' },
      pushQueue: { [waiting]: queued() },
    };

    const pull = linearCoverage(items(), state, { direction: 'pull', model });
    expect(pull.unlinked.map((t) => [t.title, t.reason])).toEqual([
      ['Waiting', 'queued'],
      ['Edited since', 'pull-only'],
    ]);

    const both = linearCoverage(items(), state, { direction: 'both', model });
    expect(both.unlinked.find((t) => t.id === edited)?.reason).toBe('pending');
  });
});

describe('coverageCounts', () => {
  it('summarises the same walk without the list, capacity refusals counted as failed', () => {
    const capped = task('Capped');
    const failed = task('Failed');
    const waiting = task('Waiting');
    const held = task('Held');
    task('Linked', { external: 'linear:issue-1' });
    task('Review PR #7', { derived: true });
    const state: LinearSyncState = {
      ...emptyLinearState(),
      pushQueue: {
        [capped]: queued({ lastError: 'limit', lastErrorKind: 'usage-limit' }),
        [failed]: queued({ lastError: 'nope', lastErrorKind: 'graphql' }),
        [waiting]: queued(),
      },
      localOnly: { [held]: store.get(held)?.meta.updated ?? '' },
    };

    expect(
      coverageCounts(items(), state, { direction: 'both', model })
    ).toEqual({
      total: 5,
      linked: 1,
      notLinked: 4,
      heldBack: 1,
      queued: 1,
      failed: 2,
      excluded: 1,
    });
  });
});
