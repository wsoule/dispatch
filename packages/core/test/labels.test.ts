import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError, loadConfig, updateConfig } from '../src/config.js';
import {
  isLabelColor,
  labelColorIndex,
  labelDefinitionError,
  labelRef,
  withLabelColor,
} from '../src/labels.js';

function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-labels-'));
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  writeFileSync(join(dir, '.dispatch/config.yml'), contents);
  return dir;
}

describe('label registry', () => {
  it('spells a grouped label the way a task carries it', () => {
    expect(labelRef({ name: 'Bug', group: 'Type' })).toBe('Type/Bug');
    expect(labelRef({ name: 'web', group: null })).toBe('web');
    expect(labelRef({ name: 'web' })).toBe('web');
  });

  it('accepts hex colors only, so a color is always safe in CSS', () => {
    expect(isLabelColor('#5e6ad2')).toBe(true);
    expect(isLabelColor('#FFF')).toBe(true);
    expect(isLabelColor('red')).toBe(false);
    expect(isLabelColor('#12345')).toBe(false);
    expect(isLabelColor('#fff; background: url(x)')).toBe(false);
  });

  it('explains a bad entry', () => {
    expect(labelDefinitionError({ name: 'web', color: '#00f' })).toBeNull();
    expect(labelDefinitionError({ name: '' })).toMatch(/name/);
    expect(labelDefinitionError({ name: 'web', color: 'blue' })).toMatch(
      /hex color/
    );
    expect(labelDefinitionError({ name: 'web', group: 3 })).toMatch(/group/);
    expect(labelDefinitionError('web')).toMatch(/map/);
  });

  it('indexes colors by lowercased ref, skipping uncolored labels', () => {
    const index = labelColorIndex([
      { name: 'Bug', group: 'Type', color: '#f00' },
      { name: 'web', color: null },
    ]);
    expect(index.get('type/bug')).toBe('#f00');
    expect(index.has('web')).toBe(false);
  });

  it('sets a color on an existing entry or appends a new one', () => {
    const labels = [
      { name: 'Bug', group: 'Type', color: '#f00', external: 'linear:l-bug' },
    ];
    expect(withLabelColor(labels, 'type/bug', '#0f0')[0]?.color).toBe('#0f0');
    // The input is left alone.
    expect(labels[0]?.color).toBe('#f00');
    expect(withLabelColor(labels, 'infra', '#00f')).toEqual([
      ...labels,
      { name: 'infra', color: '#00f', group: null, external: null },
    ]);
  });

  it('drops a local entry whose color is cleared, keeping a linked one', () => {
    const labels = [
      { name: 'web', color: '#00f', external: null },
      { name: 'Bug', group: 'Type', color: '#f00', external: 'linear:l-bug' },
    ];
    const cleared = withLabelColor(
      withLabelColor(labels, 'web', null),
      'Type/Bug',
      null
    );
    expect(cleared).toEqual([
      { name: 'Bug', group: 'Type', color: null, external: 'linear:l-bug' },
    ]);
  });
});

describe('labels: in config.yml', () => {
  it('parses entries with defaults and round-trips them through a patch', () => {
    const dir = writeConfig(
      'labels:\n  - name: Bug\n    group: Type\n    color: "#eb5757"\n    external: linear:l-bug\n  - name: web\n'
    );
    expect(loadConfig(dir).labels).toEqual([
      {
        name: 'Bug',
        group: 'Type',
        color: '#eb5757',
        external: 'linear:l-bug',
      },
      { name: 'web', group: null, color: null, external: null },
    ]);
    const next = updateConfig(dir, {
      labels: [{ name: 'infra', color: '#0f0', group: null, external: null }],
    });
    expect(next.labels).toEqual([
      { name: 'infra', color: '#0f0', group: null, external: null },
    ]);
    expect(updateConfig(dir, { labels: null }).labels).toBeUndefined();
  });

  it('refuses a duplicate ref or a non-hex color', () => {
    expect(() =>
      loadConfig(writeConfig('labels:\n  - name: web\n  - name: WEB\n'))
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(writeConfig('labels:\n  - name: web\n    color: blue\n'))
    ).toThrow(/labels\[0\]/);
    const dir = writeConfig('');
    expect(() =>
      updateConfig(dir, {
        labels: [{ name: 'web', color: 'javascript:alert(1)' }],
      })
    ).toThrow(ConfigError);
  });
});
