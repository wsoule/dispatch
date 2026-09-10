import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigError,
  loadConfig,
  projectPolicy,
  updateConfig,
} from '../src/config.js';
import { DEFAULT_POLICY, FLOOR_CHECKS } from '../src/policy.js';

function root(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-policy-'));
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  if (contents !== undefined) {
    writeFileSync(join(dir, '.dispatch', 'config.yml'), contents);
  }
  return dir;
}

function read(dir: string): string {
  return readFileSync(join(dir, '.dispatch', 'config.yml'), 'utf8');
}

describe('policy config', () => {
  it('defaults to the strictest rung when the block is absent', () => {
    expect(loadConfig(root('autoCommit: true\n')).policy).toEqual(
      DEFAULT_POLICY
    );
    // Same default when no config file exists at all.
    const empty = mkdtempSync(join(tmpdir(), 'dispatch-policy-'));
    expect(loadConfig(empty).policy).toEqual(DEFAULT_POLICY);
  });

  it('a block on disk sets the rung and gate pins', () => {
    const dir = root('policy:\n  rung: 3\n  gates:\n    merge: auto\n');
    expect(loadConfig(dir).policy).toEqual({
      rung: 3,
      gates: { merge: 'auto' },
    });
  });

  it('gates alone keep the default rung', () => {
    const dir = root('policy:\n  gates:\n    scope: block\n');
    expect(loadConfig(dir).policy).toEqual({
      rung: DEFAULT_POLICY.rung,
      gates: { scope: 'block' },
    });
  });

  it('rejects a rung off the ladder', () => {
    for (const bad of ['0', '5', '2.5', "'two'"]) {
      expect(() => loadConfig(root(`policy:\n  rung: ${bad}\n`))).toThrow(
        ConfigError
      );
    }
  });

  it('rejects an unknown gate key and an unknown mode', () => {
    expect(() =>
      loadConfig(root('policy:\n  gates:\n    review: auto\n'))
    ).toThrow(/unknown policy gate: review/);
    expect(() =>
      loadConfig(root('policy:\n  gates:\n    merge: always\n'))
    ).toThrow(/policy\.gates\.merge/);
  });

  it('rejects a non-object block rather than ignoring it', () => {
    expect(() => loadConfig(root('policy: 3\n'))).toThrow(ConfigError);
  });
});

describe('projectPolicy', () => {
  it('fills in the default for hand-built configs and returns a fresh copy', () => {
    const config = loadConfig(root('autoCommit: true\n'));
    delete config.policy;
    const first = projectPolicy(config);
    expect(first).toEqual(DEFAULT_POLICY);
    first.gates.merge = 'auto';
    expect(projectPolicy(config).gates.merge).toBeUndefined();
  });
});

describe('updateConfig policy patch', () => {
  it('writes the rung and validates it before it reaches disk', () => {
    const dir = root('autoCommit: true\n');
    expect(updateConfig(dir, { policy: { rung: 2 } }).policy?.rung).toBe(2);
    expect(read(dir)).toContain('rung: 2');
    expect(() => updateConfig(dir, { policy: { rung: 9 } })).toThrow(
      ConfigError
    );
    // The failed write left the file loadable with the previous rung.
    expect(loadConfig(dir).policy?.rung).toBe(2);
  });

  it('writes pins key-by-key and null clears one back to the rung', () => {
    const dir = root('policy:\n  rung: 4\n  gates:\n    scope: block\n');
    const patched = updateConfig(dir, {
      policy: { gates: { merge: 'block' } },
    });
    expect(patched.policy).toEqual({
      rung: 4,
      gates: { scope: 'block', merge: 'block' },
    });
    const cleared = updateConfig(dir, { policy: { gates: { scope: null } } });
    expect(cleared.policy).toEqual({ rung: 4, gates: { merge: 'block' } });
  });

  it('rejects an unknown gate or mode without touching the file', () => {
    const dir = root('autoCommit: true\n');
    const before = read(dir);
    expect(() =>
      updateConfig(dir, {
        policy: { gates: { review: 'auto' } as never },
      })
    ).toThrow(/invalid policy gate/);
    expect(() =>
      updateConfig(dir, {
        policy: { gates: { merge: 'always' } as never },
      })
    ).toThrow(/invalid policy\.gates\.merge/);
    expect(read(dir)).toBe(before);
  });
});

describe('the irreversibility floor at the config seam', () => {
  it('refuses a floor check under policy.gates on load, in either mode', () => {
    for (const check of FLOOR_CHECKS) {
      for (const mode of ['auto', 'block']) {
        const dir = root(
          `policy:\n  rung: 4\n  gates:\n    ${check}: ${mode}\n`
        );
        expect(() => loadConfig(dir)).toThrow(/irreversibility floor/);
      }
    }
  });

  it('refuses a floor check from updateConfig without touching the file', () => {
    const dir = root('policy:\n  rung: 4\n');
    const before = read(dir);
    for (const check of FLOOR_CHECKS) {
      expect(() =>
        updateConfig(dir, {
          policy: { gates: { [check]: 'auto' } as never },
        })
      ).toThrow(/irreversibility floor/);
    }
    expect(read(dir)).toBe(before);
    expect(loadConfig(dir).policy).toEqual({ rung: 4, gates: {} });
  });
});
