import { describe, expect, it } from 'bun:test';

import type { LabelDefinition } from '../src/labels.js';
import type { LabelSyncInput } from '../src/linearLabels.js';
import { syncLinearLabels } from '../src/linearLabels.js';
import type { LinearLabel } from '../src/linearMap.js';

const BUG: LinearLabel = {
  id: 'l-bug',
  name: 'Bug',
  color: '#eb5757',
  group: 'Type',
  teamId: 'team-1',
};
const WEB: LinearLabel = {
  id: 'l-web',
  name: 'web',
  color: '#5e6ad2',
  group: null,
  teamId: null,
};

function run(overrides: Partial<LabelSyncInput>) {
  return syncLinearLabels({
    configured: [],
    linear: [BUG, WEB],
    base: {},
    mayPull: true,
    mayPush: true,
    ...overrides,
  });
}

function linkedBug(color: string | null): LabelDefinition {
  return { name: 'Bug', group: 'Type', color, external: 'linear:l-bug' };
}

describe('syncLinearLabels', () => {
  it('registers every Linear label with its color, group and link', () => {
    const result = run({});
    expect(result.changed).toBe(true);
    expect(result.configured).toEqual([
      linkedBug('#eb5757'),
      { name: 'web', group: null, color: '#5e6ad2', external: 'linear:l-web' },
    ]);
    expect(result.base).toEqual({ 'l-bug': '#eb5757', 'l-web': '#5e6ad2' });
    expect(result.push).toEqual([]);
  });

  it('is a no-op once the registry and the base agree with Linear', () => {
    const first = run({});
    const second = run({ configured: first.configured, base: first.base });
    expect(second.changed).toBe(false);
    expect(second.push).toEqual([]);
  });

  it('claims a local entry by its ref, Linear winning on first contact', () => {
    const result = run({
      configured: [{ name: 'type/bug', color: '#000000', external: null }],
      linear: [BUG],
    });
    expect(result.configured).toEqual([linkedBug('#eb5757')]);
    expect(result.push).toEqual([]);
  });

  it('pushes a local color Linear has not moved from', () => {
    const result = run({
      configured: [linkedBug('#0f783c')],
      linear: [BUG],
      base: { 'l-bug': '#eb5757' },
    });
    expect(result.push).toEqual([{ id: 'l-bug', color: '#0f783c' }]);
    expect(result.base['l-bug']).toBe('#0f783c');
    expect(result.configured[0]?.color).toBe('#0f783c');
  });

  it('takes a color Linear changed, even over a local edit', () => {
    const result = run({
      configured: [linkedBug('#0f783c')],
      linear: [{ ...BUG, color: '#f2c94c' }],
      base: { 'l-bug': '#eb5757' },
    });
    expect(result.push).toEqual([]);
    expect(result.configured[0]?.color).toBe('#f2c94c');
    expect(result.base['l-bug']).toBe('#f2c94c');
  });

  it('holds a change a direction forbids, keeping its base for later', () => {
    const pullOnly = run({
      configured: [linkedBug('#0f783c')],
      linear: [BUG],
      base: { 'l-bug': '#eb5757' },
      mayPush: false,
    });
    expect(pullOnly.push).toEqual([]);
    expect(pullOnly.base['l-bug']).toBe('#eb5757');
    const pushOnly = run({
      configured: [linkedBug('#eb5757')],
      linear: [{ ...BUG, color: '#f2c94c' }],
      base: { 'l-bug': '#eb5757' },
      mayPull: false,
    });
    expect(pushOnly.configured[0]?.color).toBe('#eb5757');
    expect(pushOnly.base['l-bug']).toBe('#eb5757');
  });

  it('pushes the registry’s color on first contact when only pushes are allowed', () => {
    const result = run({
      configured: [{ name: 'type/bug', color: '#0f783c', external: null }],
      linear: [BUG],
      mayPull: false,
    });
    expect(result.push).toEqual([{ id: 'l-bug', color: '#0f783c' }]);
    expect(result.base['l-bug']).toBe('#0f783c');
  });

  it('follows a rename, and unlinks an entry whose label is gone', () => {
    const renamed = run({
      configured: [linkedBug('#eb5757')],
      linear: [{ ...BUG, name: 'Defect' }],
      base: { 'l-bug': '#eb5757' },
    });
    expect(renamed.configured[0]).toMatchObject({
      name: 'Defect',
      group: 'Type',
    });
    const gone = run({
      configured: [linkedBug('#eb5757')],
      linear: [],
      base: { 'l-bug': '#eb5757' },
    });
    expect(gone.configured).toEqual([
      { name: 'Bug', group: 'Type', color: '#eb5757', external: null },
    ]);
    expect(gone.base).toEqual({});
  });

  it('lets the first of two same-ref labels (one per team) claim the entry', () => {
    const other: LinearLabel = { ...WEB, id: 'l-web-2', teamId: 'team-2' };
    const result = run({ linear: [WEB, other] });
    expect(result.configured).toHaveLength(1);
    expect(result.configured[0]?.external).toBe('linear:l-web');
    expect(result.base).toEqual({ 'l-web': '#5e6ad2' });
  });

  describe('a label renamed onto another entry’s ref', () => {
    const linked = (id: string, name: string): LabelDefinition => ({
      name,
      group: null,
      color: '#5e6ad2',
      external: `linear:${id}`,
    });
    const label = (id: string, name: string, teamId: string): LinearLabel => ({
      id,
      name,
      color: '#5e6ad2',
      group: null,
      teamId,
    });

    it('folds in an unlinked entry, or one whose label is gone', () => {
      for (const external of [null, 'linear:l-gone']) {
        const result = run({
          configured: [
            { name: 'web', group: null, color: '#000000', external },
            linked('l-api', 'api'),
          ],
          linear: [label('l-api', 'Web', 'team-1')],
          base: { 'l-api': '#5e6ad2' },
        });
        expect(result.configured).toEqual([linked('l-api', 'Web')]);
      }
    });

    it('yields to the entry another label still spells, keeping its own unlinked', () => {
      const result = run({
        configured: [linked('l-a', 'Bug'), linked('l-b', 'defect')],
        linear: [label('l-a', 'Bug', 'team-1'), label('l-b', 'bug', 'team-2')],
        base: { 'l-a': '#5e6ad2', 'l-b': '#5e6ad2' },
      });
      expect(result.configured).toEqual([
        linked('l-a', 'Bug'),
        { ...linked('l-b', 'defect'), external: null },
      ]);
    });

    it('lets two labels swap names in one pass', () => {
      const result = run({
        configured: [linked('l-a', 'Bug'), linked('l-b', 'Defect')],
        linear: [
          label('l-a', 'Defect', 'team-1'),
          label('l-b', 'Bug', 'team-1'),
        ],
        base: { 'l-a': '#5e6ad2', 'l-b': '#5e6ad2' },
      });
      expect(result.configured).toEqual([
        linked('l-a', 'Defect'),
        linked('l-b', 'Bug'),
      ]);
    });
  });
});
