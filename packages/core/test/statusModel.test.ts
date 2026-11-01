import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError, loadConfig, updateConfig } from '../src/config.js';
import { readyTasks } from '../src/graph.js';
import {
  CANONICAL_STATUSES,
  DEFAULT_STATUS_MODEL,
  draftStatus,
  hasDistinctReviewRole,
  hasStatusRole,
  isDoneStatus,
  isReviewStatus,
  isSatisfiedForDispatchStatus,
  isUnstartedStatus,
  resolveStatusName,
  statusColor,
  statusModelOf,
  statusType,
} from '../src/status.js';
import type { StatusModel } from '../src/status.js';
import type { TaskDoc } from '../src/types.js';

function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-status-'));
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  writeFileSync(join(dir, '.dispatch/config.yml'), contents);
  return dir;
}

const LINEAR_CONFIG = `statuses:
  - { name: Triage, type: triage }
  - { name: Todo, type: unstarted, color: '#e2e2e2' }
  - { name: In Progress, type: started }
  - { name: In Review, type: started }
  - { name: Done, type: completed, color: '#5e6ad2' }
  - { name: Canceled, type: canceled }
statusRoles:
  ready: Todo
  dispatched: In Progress
  review: In Review
  landing: null
  landed: Done
  dropped: Canceled
`;

describe('status model', () => {
  it('types the built-in statuses', () => {
    expect(statusType('draft')).toBe('backlog');
    expect(statusType('ready')).toBe('unstarted');
    expect(statusType('working')).toBe('started');
    expect(statusType('review')).toBe('started');
    expect(statusType('landing')).toBe('started');
    expect(statusType('landed')).toBe('completed');
    expect(statusType('dropped')).toBe('canceled');
    // Legacy aliases resolve first.
    expect(statusType('done')).toBe('completed');
    // Unknown custom statuses are backlog: never dispatched, never done.
    expect(statusType('qa')).toBe('backlog');
  });

  it('keeps the default dispatch-satisfied set', () => {
    const satisfied = [
      'draft',
      'ready',
      'working',
      'review',
      'landing',
      'landed',
      'dropped',
    ].filter((s) => isSatisfiedForDispatchStatus(s));
    expect(satisfied).toEqual(['review', 'landing', 'landed', 'dropped']);
  });

  it('leaves an untyped config exactly as before', () => {
    const config = loadConfig(writeConfig('statuses: [draft, ready, qa]\n'));
    expect(config.statuses).toEqual(['draft', 'ready', 'qa']);
    expect(config.statusDefinitions).toBeUndefined();
    expect(config.statusRoles).toBeUndefined();
    const model = statusModelOf(config);
    expect(model.roles).toEqual(DEFAULT_STATUS_MODEL.roles);
    expect(statusType('qa', model)).toBe('backlog');
  });

  it('reads typed statuses, colors and roles', () => {
    const config = loadConfig(writeConfig(LINEAR_CONFIG));
    expect(config.statuses).toEqual([
      'Triage',
      'Todo',
      'In Progress',
      'In Review',
      'Done',
      'Canceled',
    ]);
    const model = statusModelOf(config);
    expect(statusType('Todo', model)).toBe('unstarted');
    expect(statusColor('Done', model)).toBe('#5e6ad2');
    expect(isDoneStatus('Canceled', model)).toBe(true);
    expect(isUnstartedStatus('Todo', model)).toBe(true);
    expect(hasStatusRole('In Review', 'review', model)).toBe(true);
    expect(isSatisfiedForDispatchStatus('In Review', model)).toBe(true);
    expect(isSatisfiedForDispatchStatus('In Progress', model)).toBe(false);
    expect(model.roles.landing).toBeNull();
  });

  it('rejects a role naming an unknown status and a bad type', () => {
    expect(() =>
      loadConfig(writeConfig('statuses: [ready]\nstatusRoles:\n  review: qa\n'))
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(writeConfig('statuses:\n  - { name: x, type: doing }\n'))
    ).toThrow(/type doing/);
  });

  it('round-trips typed statuses through updateConfig', () => {
    const root = writeConfig('statuses: [ready]\n');
    updateConfig(root, {
      statuses: [
        'ready',
        { name: 'Shipped', type: 'completed', color: '#0f0' },
      ],
      statusRoles: {
        ready: 'ready',
        dispatched: 'ready',
        review: 'ready',
        landing: null,
        landed: 'Shipped',
        dropped: 'Shipped',
      },
    });
    const config = loadConfig(root);
    expect(config.statusDefinitions).toEqual([
      { name: 'ready', type: 'unstarted', color: null },
      { name: 'Shipped', type: 'completed', color: '#0f0' },
    ]);
    expect(config.statusRoles?.landed).toBe('Shipped');
  });

  it('builds the ready queue from the unstarted type', () => {
    const model = statusModelOf(loadConfig(writeConfig(LINEAR_CONFIG)));
    const task = (id: string, status: string): TaskDoc =>
      ({
        meta: {
          id,
          title: id,
          status,
          kind: 'task',
          parent: null,
          blockedBy: [],
          priority: 'none',
          created: `2026-01-01T00:00:0${id.slice(-1)}.000Z`,
        },
        body: '',
      }) as unknown as TaskDoc;
    const ids = readyTasks(
      [task('t-000001', 'Todo'), task('t-000002', 'In Progress')],
      model
    ).map((t) => t.meta.id);
    expect(ids).toEqual(['t-000001']);
  });
});

// A Linear team with no review state: review falls back to dispatched.
const SHARED: StatusModel = {
  definitions: [
    { name: 'Backlog', type: 'backlog', color: null },
    { name: 'Todo', type: 'unstarted', color: null },
    { name: 'In Progress', type: 'started', color: null },
    { name: 'Done', type: 'completed', color: null },
    { name: 'Canceled', type: 'canceled', color: null },
    { name: 'Duplicate', type: 'canceled', color: null },
  ],
  roles: {
    ready: 'Todo',
    dispatched: 'In Progress',
    review: 'In Progress',
    landing: null,
    landed: 'Done',
    dropped: 'Canceled',
  },
};
const SHARED_NAMES = SHARED.definitions.map((d) => d.name);

describe('a review role shared with dispatched', () => {
  const linear = statusModelOf(loadConfig(writeConfig(LINEAR_CONFIG)));

  it('says whether the review role has a status of its own', () => {
    expect(hasDistinctReviewRole()).toBe(true);
    expect(hasDistinctReviewRole(linear)).toBe(true);
    expect(hasDistinctReviewRole(SHARED)).toBe(false);
  });

  it('reads review by status alone when the role is distinct', () => {
    expect(isReviewStatus('review')).toBe(true);
    expect(isReviewStatus('review', DEFAULT_STATUS_MODEL, true)).toBe(true);
    expect(isReviewStatus('working', DEFAULT_STATUS_MODEL, true)).toBe(false);
    expect(isReviewStatus('In Review', linear)).toBe(true);
    expect(isReviewStatus('In Progress', linear, true)).toBe(false);
  });

  it('needs a finished run when review shares the dispatched status', () => {
    expect(isReviewStatus('In Progress', SHARED)).toBe(false);
    expect(isReviewStatus('In Progress', SHARED, true)).toBe(true);
    expect(isSatisfiedForDispatchStatus('In Progress', SHARED)).toBe(false);
    expect(isSatisfiedForDispatchStatus('In Progress', SHARED, true)).toBe(
      true
    );
    expect(isSatisfiedForDispatchStatus('Todo', SHARED, true)).toBe(false);
    expect(isSatisfiedForDispatchStatus('Done', SHARED)).toBe(true);
    expect(isSatisfiedForDispatchStatus('Duplicate', SHARED)).toBe(true);
  });
});

describe('draftStatus', () => {
  it('is the first backlog status, else triage, else none', () => {
    expect(draftStatus()).toBe('draft');
    expect(draftStatus(SHARED)).toBe('Backlog');
    // LINEAR_CONFIG has Triage and no backlog status.
    expect(
      draftStatus(statusModelOf(loadConfig(writeConfig(LINEAR_CONFIG))))
    ).toBe('Triage');
    // Never the ready status, which would queue the draft for dispatch.
    expect(
      draftStatus({
        definitions: SHARED.definitions.filter((d) => d.type !== 'backlog'),
        roles: SHARED.roles,
      })
    ).toBeNull();
  });

  it('refuses draft on a board with no backlog or triage status', () => {
    const model = statusModelOf(
      loadConfig(
        writeConfig('statuses: [ready, working, review, landed, dropped]\n')
      )
    );
    const names = model.definitions.map((d) => d.name);
    expect(resolveStatusName('draft', names, model)).toBeNull();
    expect(resolveStatusName('ready', names, model)).toBe('ready');
  });
});

describe('resolveStatusName', () => {
  it('takes an exact name first', () => {
    expect(resolveStatusName('Done', SHARED_NAMES, SHARED)).toBe('Done');
    // A board that defines a built-in word keeps it over the role it names.
    expect(
      resolveStatusName('review', ['review', 'In Review'], {
        ...SHARED,
        roles: { ...SHARED.roles, review: 'In Review' },
      })
    ).toBe('review');
  });

  it('then a unique case-insensitive match, ahead of the legacy aliases', () => {
    expect(resolveStatusName('done', SHARED_NAMES, SHARED)).toBe('Done');
    expect(resolveStatusName('in progress', SHARED_NAMES, SHARED)).toBe(
      'In Progress'
    );
    expect(resolveStatusName('TODO', SHARED_NAMES, SHARED)).toBe('Todo');
    // Two names folding alike: neither is guessed.
    expect(
      resolveStatusName('qa', ['QA', 'Qa'], DEFAULT_STATUS_MODEL)
    ).toBeNull();
  });

  it('then a legacy alias', () => {
    const names = [...CANONICAL_STATUSES];
    expect(resolveStatusName('done', names)).toBe('landed');
    expect(resolveStatusName('todo', names)).toBe('ready');
    expect(resolveStatusName('in-progress', names)).toBe('working');
    expect(resolveStatusName('landed', names)).toBe('landed');
  });

  it('then a built-in word read through its role', () => {
    expect(resolveStatusName('landed', SHARED_NAMES, SHARED)).toBe('Done');
    expect(resolveStatusName('Landed', SHARED_NAMES, SHARED)).toBe('Done');
    expect(resolveStatusName('working', SHARED_NAMES, SHARED)).toBe(
      'In Progress'
    );
    expect(resolveStatusName('review', SHARED_NAMES, SHARED)).toBe(
      'In Progress'
    );
    expect(resolveStatusName('ready', SHARED_NAMES, SHARED)).toBe('Todo');
    expect(resolveStatusName('draft', SHARED_NAMES, SHARED)).toBe('Backlog');
    expect(resolveStatusName('dropped', SHARED_NAMES, SHARED)).toBe('Canceled');
    expect(resolveStatusName('cancelled', SHARED_NAMES, SHARED)).toBe(
      'Canceled'
    );
    // No landing role on this board, so the word means nothing here.
    expect(resolveStatusName('landing', SHARED_NAMES, SHARED)).toBeNull();
  });

  it('refuses what fits nothing, but accepts an untyped custom name', () => {
    expect(resolveStatusName('shipped', SHARED_NAMES, SHARED)).toBeNull();
    // A role whose status the caller's names lack does not count.
    expect(
      resolveStatusName('landed', ['Todo', 'In Progress'], SHARED)
    ).toBeNull();
    expect(resolveStatusName('qa', ['draft', 'ready', 'qa'])).toBe('qa');
  });
});
