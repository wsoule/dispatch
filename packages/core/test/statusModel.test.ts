import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError, loadConfig, updateConfig } from '../src/config.js';
import { readyTasks } from '../src/graph.js';
import {
  DEFAULT_STATUS_MODEL,
  hasStatusRole,
  isDoneStatus,
  isSatisfiedForDispatchStatus,
  isUnstartedStatus,
  statusColor,
  statusModelOf,
  statusType,
} from '../src/status.js';
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
