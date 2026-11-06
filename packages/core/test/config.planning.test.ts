import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError, loadConfig, updateConfig } from '../src/config.js';

// The `planning:` block: the milestone planner's tuning, watchers, weights
// and allocation mode, read and written field by field.

function root(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-planning-'));
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  if (contents !== undefined) {
    writeFileSync(join(dir, '.dispatch', 'config.yml'), contents);
  }
  return dir;
}

describe('planning config', () => {
  it('is absent when the file has no block', () => {
    expect(loadConfig(root('autoCommit: true\n')).planning).toBeUndefined();
  });

  it('reads tuning, watchers, weights and the allocation mode', () => {
    const dir = root(
      [
        'planning:',
        '  tuning:',
        '    warnLeadDays: 10',
        '    activeProjectStatuses: [started, paused, started]',
        '  watchers: [human:ana, human:ana]',
        '  weights:',
        '    t-abc123: 2',
        '  allocation: daily',
        '',
      ].join('\n')
    );
    expect(loadConfig(dir).planning).toEqual({
      tuning: {
        warnLeadDays: 10,
        activeProjectStatuses: ['started', 'paused'],
      },
      watchers: ['human:ana'],
      weights: { 't-abc123': 2 },
      allocation: 'daily',
    });
  });

  it.each([
    ['planning:\n  tuning:\n    warnLeadDays: -1\n', /warnLeadDays/],
    ['planning:\n  tuning:\n    overdueRepeatDays: 0\n', /overdueRepeatDays/],
    ['planning:\n  tuning:\n    nope: 3\n', /unknown field: nope/],
    [
      'planning:\n  tuning:\n    activeProjectStatuses: []\n',
      /activeProjectStatuses/,
    ],
    ['planning:\n  watchers: [ana]\n', /watchers/],
    ['planning:\n  weights:\n    t-1: 1.5\n', /weights/],
    ['planning:\n  allocation: hourly\n', /allocation/],
  ])('refuses %p', (text, message) => {
    expect(() => loadConfig(root(text))).toThrow(ConfigError);
    expect(() => loadConfig(root(text))).toThrow(message);
  });

  it('patches field by field and drops the block once empty', () => {
    const dir = root('autoCommit: true\n');
    const set = updateConfig(dir, {
      planning: {
        tuning: { stallDays: 3 },
        watchers: ['human:ana'],
        weights: { 't-abc123': 1 },
        allocation: 'daily',
      },
    });
    expect(set.planning).toEqual({
      tuning: { stallDays: 3 },
      watchers: ['human:ana'],
      weights: { 't-abc123': 1 },
      allocation: 'daily',
    });
    const cleared = updateConfig(dir, {
      planning: {
        tuning: { stallDays: null },
        watchers: [],
        weights: { 't-abc123': null },
        allocation: 'manual',
      },
    });
    expect(cleared.planning).toBeUndefined();
    expect(readFileSync(join(dir, '.dispatch', 'config.yml'), 'utf8')).toBe(
      'autoCommit: true\n'
    );
  });
});
