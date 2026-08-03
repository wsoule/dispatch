import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigError,
  DEFAULT_CARTO,
  DEFAULT_FIX_LOOP,
  DEFAULT_LINEAR,
  DEFAULT_MODELS,
  loadConfig,
} from '../src/config.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-'));
});

// Writes `contents` as `.dispatch/config.yml` under a fresh temp root and
// returns that root, so a test can hand it straight to loadConfig.
function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-'));
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  writeFileSync(join(dir, '.dispatch/config.yml'), contents);
  return dir;
}

describe('loadConfig', () => {
  it('returns defaults when file missing', () => {
    expect(loadConfig(root)).toEqual({
      statuses: [
        'backlog',
        'todo',
        'in-progress',
        'in-review',
        'done',
        'cancelled',
      ],
      autoCommit: false,
      orchestrator: {
        permissionMode: 'auto',
        epicConcurrency: 3,
        verifyTimeoutSec: 600,
      },
      models: DEFAULT_MODELS,
      linear: DEFAULT_LINEAR,
      fixLoop: DEFAULT_FIX_LOOP,
      carto: DEFAULT_CARTO,
    });
  });
  it('merges file values over defaults', () => {
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(join(root, '.dispatch/config.yml'), 'autoCommit: true\n');
    const cfg = loadConfig(root);
    expect(cfg.autoCommit).toBe(true);
    expect(cfg.statuses).toHaveLength(6);
  });
  it('mutating a returned config does not poison later loads', () => {
    loadConfig(root).statuses.push('x');
    expect(loadConfig(root).statuses).toEqual([
      'backlog',
      'todo',
      'in-progress',
      'in-review',
      'done',
      'cancelled',
    ]);
  });
  it('throws a ConfigError on malformed YAML', () => {
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(
      join(root, '.dispatch/config.yml'),
      'autoCommit: true\n  bad: x'
    );
    expect(() => loadConfig(root)).toThrow(/invalid \.dispatch\/config\.yml/);
    let caught: unknown;
    try {
      loadConfig(root);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
  });
  it('throws when statuses is not an array of strings', () => {
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(
      join(root, '.dispatch/config.yml'),
      'statuses: not-an-array\n'
    );
    expect(() => loadConfig(root)).toThrow(/statuses must be/);
  });
  it('throws when autoCommit is not a boolean', () => {
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(join(root, '.dispatch/config.yml'), 'autoCommit: "yes"\n');
    expect(() => loadConfig(root)).toThrow(/autoCommit must be/);
  });
  it('parses verifyCommand when provided as a non-empty string', () => {
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(
      join(root, '.dispatch/config.yml'),
      'verifyCommand: bun test\n'
    );
    expect(loadConfig(root).verifyCommand).toBe('bun test');
  });
  it('leaves verifyCommand undefined when omitted', () => {
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(join(root, '.dispatch/config.yml'), 'autoCommit: true\n');
    expect(loadConfig(root).verifyCommand).toBeUndefined();
  });
  it('throws when verifyCommand is not a string', () => {
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(join(root, '.dispatch/config.yml'), 'verifyCommand: 5\n');
    expect(() => loadConfig(root)).toThrow(/verifyCommand must be/);
  });
  it('throws when verifyCommand is an empty string', () => {
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(join(root, '.dispatch/config.yml'), 'verifyCommand: ""\n');
    expect(() => loadConfig(root)).toThrow(/verifyCommand must be/);
  });

  describe('orchestrator block', () => {
    it('defaults to no turn cap, no budget cap, auto, epicConcurrency 3', () => {
      expect(loadConfig(root).orchestrator).toEqual({
        permissionMode: 'auto',
        epicConcurrency: 3,
        verifyTimeoutSec: 600,
      });
    });

    it('merges provided fields over defaults', () => {
      mkdirSync(join(root, '.dispatch'), { recursive: true });
      writeFileSync(
        join(root, '.dispatch/config.yml'),
        'orchestrator:\n  maxTurns: 25\n  maxBudgetUsd: 5\n  permissionMode: plan\n  epicConcurrency: 5\n'
      );
      expect(loadConfig(root).orchestrator).toEqual({
        maxTurns: 25,
        maxBudgetUsd: 5,
        permissionMode: 'plan',
        epicConcurrency: 5,
        verifyTimeoutSec: 600,
      });
    });

    it('leaves epicConcurrency at the default of 3 when omitted', () => {
      mkdirSync(join(root, '.dispatch'), { recursive: true });
      writeFileSync(
        join(root, '.dispatch/config.yml'),
        'orchestrator:\n  maxTurns: 25\n'
      );
      expect(loadConfig(root).orchestrator.epicConcurrency).toBe(3);
    });

    it('throws when epicConcurrency is not an integer >= 1', () => {
      mkdirSync(join(root, '.dispatch'), { recursive: true });
      writeFileSync(
        join(root, '.dispatch/config.yml'),
        'orchestrator:\n  epicConcurrency: 0\n'
      );
      expect(() => loadConfig(root)).toThrow(
        /orchestrator\.epicConcurrency must be an integer >= 1/
      );
    });

    it('throws when epicConcurrency is not an integer', () => {
      mkdirSync(join(root, '.dispatch'), { recursive: true });
      writeFileSync(
        join(root, '.dispatch/config.yml'),
        'orchestrator:\n  epicConcurrency: 1.5\n'
      );
      expect(() => loadConfig(root)).toThrow(
        /orchestrator\.epicConcurrency must be an integer >= 1/
      );
    });

    it('leaves maxBudgetUsd undefined (no cap) when omitted', () => {
      mkdirSync(join(root, '.dispatch'), { recursive: true });
      writeFileSync(
        join(root, '.dispatch/config.yml'),
        'orchestrator:\n  maxTurns: 25\n'
      );
      expect(loadConfig(root).orchestrator.maxBudgetUsd).toBeUndefined();
    });

    it('throws when orchestrator is not an object', () => {
      mkdirSync(join(root, '.dispatch'), { recursive: true });
      writeFileSync(
        join(root, '.dispatch/config.yml'),
        'orchestrator: not-an-object\n'
      );
      expect(() => loadConfig(root)).toThrow(/orchestrator must be an object/);
    });

    it('throws when maxTurns is not a positive number', () => {
      mkdirSync(join(root, '.dispatch'), { recursive: true });
      writeFileSync(
        join(root, '.dispatch/config.yml'),
        'orchestrator:\n  maxTurns: 0\n'
      );
      expect(() => loadConfig(root)).toThrow(
        /orchestrator\.maxTurns must be a positive number/
      );
    });

    // A zero or negative verify timeout would kill every verify instantly,
    // failing every merge-queue entry — louder to reject it at load than to let
    // the queue mysteriously refuse everything.
    it('throws when verifyTimeoutSec is not a positive number', () => {
      mkdirSync(join(root, '.dispatch'), { recursive: true });
      writeFileSync(
        join(root, '.dispatch/config.yml'),
        'orchestrator:\n  verifyTimeoutSec: 0\n'
      );
      expect(() => loadConfig(root)).toThrow(
        /orchestrator\.verifyTimeoutSec must be a positive number/
      );
    });

    it('reads a provided verifyTimeoutSec over the default', () => {
      mkdirSync(join(root, '.dispatch'), { recursive: true });
      writeFileSync(
        join(root, '.dispatch/config.yml'),
        'orchestrator:\n  verifyTimeoutSec: 45\n'
      );
      expect(loadConfig(root).orchestrator.verifyTimeoutSec).toBe(45);
    });

    it('throws when maxBudgetUsd is not a positive number', () => {
      mkdirSync(join(root, '.dispatch'), { recursive: true });
      writeFileSync(
        join(root, '.dispatch/config.yml'),
        'orchestrator:\n  maxBudgetUsd: -1\n'
      );
      expect(() => loadConfig(root)).toThrow(
        /orchestrator\.maxBudgetUsd must be a positive number/
      );
    });

    it('throws when permissionMode is not a known SDK permission mode', () => {
      mkdirSync(join(root, '.dispatch'), { recursive: true });
      writeFileSync(
        join(root, '.dispatch/config.yml'),
        'orchestrator:\n  permissionMode: yolo\n'
      );
      expect(() => loadConfig(root)).toThrow(
        /orchestrator\.permissionMode must be one of/
      );
    });
  });
});

describe('the carto block', () => {
  it('defaults to on when absent', () => {
    const root = writeConfig('statuses: [todo, done]\n');
    expect(loadConfig(root).carto.enabled).toBe('on');
  });

  it('accepts detect and off', () => {
    expect(
      loadConfig(writeConfig('carto:\n  enabled: detect\n')).carto.enabled
    ).toBe('detect');
    expect(
      loadConfig(writeConfig('carto:\n  enabled: off\n')).carto.enabled
    ).toBe('off');
  });

  it('accepts bare on/off unquoted (yaml core schema keeps these as strings)', () => {
    expect(
      loadConfig(writeConfig('carto:\n  enabled: on\n')).carto.enabled
    ).toBe('on');
    expect(
      loadConfig(writeConfig('carto:\n  enabled: off\n')).carto.enabled
    ).toBe('off');
  });

  it('accepts quoted on/off spellings', () => {
    expect(
      loadConfig(writeConfig("carto:\n  enabled: 'off'\n")).carto.enabled
    ).toBe('off');
    expect(
      loadConfig(writeConfig("carto:\n  enabled: 'on'\n")).carto.enabled
    ).toBe('on');
  });

  // `enabled: true`/`enabled: false` (unquoted) ARE real YAML booleans under
  // this package's default (non-1.1) schema, unlike bare on/off above, so the
  // parser must normalize them to the 'on'/'off' string modes.
  it('normalizes real YAML booleans (bare true/false) to on/off', () => {
    expect(
      loadConfig(writeConfig('carto:\n  enabled: true\n')).carto.enabled
    ).toBe('on');
    expect(
      loadConfig(writeConfig('carto:\n  enabled: false\n')).carto.enabled
    ).toBe('off');
  });

  it('rejects an unknown mode with a ConfigError', () => {
    expect(() => loadConfig(writeConfig('carto:\n  enabled: maybe\n'))).toThrow(
      ConfigError
    );
  });
});
