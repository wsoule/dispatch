import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { DEFAULT_MESSAGING } from '../src/configTypes.js';
import { consultPolicy, GATE_RUNGS } from '../src/policy.js';

function rootWith(yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), 'cfg-msg-'));
  mkdirSync(join(root, '.dispatch'), { recursive: true });
  writeFileSync(join(root, '.dispatch', 'config.yml'), yaml);
  return root;
}

describe('messaging config', () => {
  it('defaults when absent', () => {
    expect(loadConfig(rootWith('')).messaging).toEqual(DEFAULT_MESSAGING);
  });
  it('merges partial overrides', () => {
    expect(
      loadConfig(rootWith('messaging:\n  urgentPerHour: 3\n')).messaging
    ).toEqual({ ...DEFAULT_MESSAGING, urgentPerHour: 3 });
  });
  it('rejects non-positive values', () => {
    expect(() =>
      loadConfig(rootWith('messaging:\n  urgentPerHour: 0\n'))
    ).toThrow(/messaging.urgentPerHour/);
  });
});

describe('wake gate', () => {
  it('sits at rung 3', () => {
    expect(GATE_RUNGS.wake).toBe(3);
  });

  it('blocks below rung 3 and auto-decides at rung 3', () => {
    expect(consultPolicy({ rung: 2, gates: {} }, 'wake')).toEqual({
      mode: 'block',
    });
    const ruling = consultPolicy({ rung: 3, gates: {} }, 'wake');
    expect(ruling).toEqual({
      mode: 'auto',
      gate: 'wake',
      rung: 3,
      authorizedBy: 'rung',
    });
  });
});
