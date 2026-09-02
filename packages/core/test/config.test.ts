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
  DEFAULT_RECEIPTS,
  DEFAULT_REPO_DIGEST,
  loadConfig,
  queueWeights,
} from '../src/config.js';
import { DEFAULT_QUEUE_WEIGHTS } from '../src/scoring.js';

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
        'draft',
        'ready',
        'working',
        'review',
        'landing',
        'landed',
        'dropped',
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
      repoDigest: DEFAULT_REPO_DIGEST,
      receipts: DEFAULT_RECEIPTS,
      queue: { weights: DEFAULT_QUEUE_WEIGHTS },
    });
  });
  it('merges file values over defaults', () => {
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(join(root, '.dispatch/config.yml'), 'autoCommit: true\n');
    const cfg = loadConfig(root);
    expect(cfg.autoCommit).toBe(true);
    expect(cfg.statuses).toHaveLength(7);
  });
  it('mutating a returned config does not poison later loads', () => {
    loadConfig(root).statuses.push('x');
    expect(loadConfig(root).statuses).toEqual([
      'draft',
      'ready',
      'working',
      'review',
      'landing',
      'landed',
      'dropped',
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

  // Bare `true`/`false` are real YAML booleans, unlike bare on/off above, so
  // the parser must normalize them to the 'on'/'off' string modes.
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

  it('throws when carto is not a mapping', () => {
    expect(() => loadConfig(writeConfig('carto: nope\n'))).toThrow(
      /invalid \.dispatch\/config\.yml: carto must be a mapping/
    );
  });
});

describe('repoDigest config', () => {
  it('defaults to enabled with a six-hour cooldown when the block is absent', () => {
    expect(loadConfig(writeConfig('statuses: [todo]\n')).repoDigest).toEqual({
      enabled: true,
      cooldownHours: 6,
    });
  });

  it('reads an explicit block', () => {
    const dir = writeConfig(
      'repoDigest:\n  enabled: false\n  cooldownHours: 24\n'
    );
    expect(loadConfig(dir).repoDigest).toEqual({
      enabled: false,
      cooldownHours: 24,
    });
  });

  it('fills each field independently from the defaults', () => {
    const dir = writeConfig('repoDigest:\n  cooldownHours: 1\n');
    expect(loadConfig(dir).repoDigest).toEqual({
      enabled: true,
      cooldownHours: 1,
    });
  });

  it('rejects a non-positive cooldown', () => {
    const dir = writeConfig('repoDigest:\n  cooldownHours: 0\n');
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(
      /repoDigest\.cooldownHours must be a positive number/
    );
  });

  it('rejects a non-boolean enabled', () => {
    const dir = writeConfig('repoDigest:\n  enabled: "yes"\n');
    expect(() => loadConfig(dir)).toThrow(
      /repoDigest\.enabled must be a boolean/
    );
  });

  it('rejects a non-object block', () => {
    expect(() => loadConfig(writeConfig('repoDigest: 5\n'))).toThrow(
      /repoDigest must be an object/
    );
  });
});

describe('receipts config', () => {
  it('defaults to enabled with no directory override', () => {
    expect(loadConfig(writeConfig('statuses: [todo]\n')).receipts).toEqual({
      enabled: true,
      dir: undefined,
    });
  });

  it('reads enabled and dir from the file', () => {
    const dir = writeConfig('receipts:\n  enabled: false\n  dir: ../audit\n');
    expect(loadConfig(dir).receipts).toEqual({
      enabled: false,
      dir: '../audit',
    });
  });

  it('rejects a non-boolean enabled', () => {
    expect(() =>
      loadConfig(writeConfig('receipts:\n  enabled: "yes"\n'))
    ).toThrow(/receipts\.enabled must be a boolean/);
  });

  // Empty rather than absent: falling back to the default location would write
  // the audit trail somewhere the author did not ask for and would not look.
  it('rejects an empty dir instead of falling back to the default', () => {
    expect(() => loadConfig(writeConfig('receipts:\n  dir: "   "\n'))).toThrow(
      /receipts\.dir must be a non-empty string/
    );
  });

  it('rejects a non-string dir', () => {
    expect(() => loadConfig(writeConfig('receipts:\n  dir: 5\n'))).toThrow(
      /receipts\.dir must be a non-empty string/
    );
  });

  it('rejects a non-object block', () => {
    expect(() => loadConfig(writeConfig('receipts: 5\n'))).toThrow(
      /receipts must be an object/
    );
  });

  it('mutating a returned block does not poison later loads', () => {
    loadConfig(root).repoDigest.cooldownHours = 999;
    expect(loadConfig(root).repoDigest.cooldownHours).toBe(6);
  });
});

// The queue's weights are the one part of the scoring function a project tunes.
// A bad value must be refused loudly — a NaN weight would make every task's
// score NaN — but the refusal is carried on the config rather than thrown, so
// one mistyped weight does not 422 every config-reading endpoint in the daemon.
describe('queue.weights', () => {
  it('layers a partial weights block over the defaults', () => {
    const dir = writeConfig('queue:\n  weights:\n    urgency: 4\n');
    expect(queueWeights(loadConfig(dir))).toEqual({
      ok: true,
      weights: { ...DEFAULT_QUEUE_WEIGHTS, urgency: 4 },
    });
  });

  it('accepts zero as "turn this factor off"', () => {
    const dir = writeConfig('queue:\n  weights:\n    age: 0\n');
    const result = queueWeights(loadConfig(dir));
    expect(result.ok && result.weights.age).toBe(0);
  });

  it('falls back to defaults when the block is absent or empty', () => {
    for (const contents of ['autoCommit: true\n', 'queue: {}\n']) {
      expect(queueWeights(loadConfig(writeConfig(contents)))).toEqual({
        ok: true,
        weights: DEFAULT_QUEUE_WEIGHTS,
      });
    }
  });

  // Every rejection below is reported through queueWeights rather than thrown
  // from loadConfig: the file still loads, so runs/tasks/settings keep working
  // while the queue itself refuses to rank against a config it cannot read.
  describe('rejections are loud but contained', () => {
    const bad: [string, string, RegExp][] = [
      [
        'a negative weight, which would invert the factor',
        'queue:\n  weights:\n    age: -1\n',
        /queue\.weights\.age/,
      ],
      [
        'a non-numeric weight',
        'queue:\n  weights:\n    urgency: high\n',
        /queue\.weights\.urgency/,
      ],
      [
        'an unknown factor inside weights',
        'queue:\n  weights:\n    urgncy: 2\n',
        /unknown queue\.weights factor "urgncy"/,
      ],
      // The typo one level up used to parse as an empty block and hand back
      // defaults, which is the quietest possible way to ignore a setting.
      [
        'a typo beside weights',
        'queue:\n  wieghts:\n    urgency: 2\n',
        /unknown queue key "wieghts"/,
      ],
      ['a non-object queue block', 'queue: 3\n', /queue must be an object/],
      [
        'a non-object weights block',
        'queue:\n  weights: []\n',
        /queue\.weights must be an object/,
      ],
    ];

    for (const [label, contents, expected] of bad) {
      it(`reports ${label} without failing the whole load`, () => {
        const dir = writeConfig(contents);
        // loadConfig itself must not throw, or every endpoint 422s.
        const config = loadConfig(dir);
        expect(config.autoCommit).toBe(false);

        const result = queueWeights(config);
        expect(result.ok).toBe(false);
        expect(result.ok ? '' : result.error).toMatch(expected);
      });
    }
  });

  it('still exposes renderable weights alongside the error', () => {
    const config = loadConfig(writeConfig('queue:\n  weights:\n    age: -1\n'));
    expect(config.queue?.weights).toEqual(DEFAULT_QUEUE_WEIGHTS);
    expect(config.queue?.error).toBeDefined();
  });

  // DEFAULT_QUEUE_WEIGHTS is a frozen module constant every fallback reads, so
  // handing it out by reference would either throw under the caller (frozen)
  // or, unfrozen, let one mutation corrupt every later ranking process-wide.
  // A config with no `queue` block at all is the path that hits the fallback —
  // one built by hand rather than by loadConfig, which always copies.
  it('never hands out the shared defaults object', () => {
    const handBuilt = loadConfig(root);
    delete handBuilt.queue;

    const first = queueWeights(handBuilt);
    expect(first.ok && first.weights).not.toBe(DEFAULT_QUEUE_WEIGHTS);
    // Must be safe to mutate: a caller normalizing weights should not blow up
    // on the frozen constant.
    if (first.ok) first.weights.urgency = 99;

    const second = queueWeights(handBuilt);
    expect(second.ok && second.weights.urgency).toBe(1);
    expect(DEFAULT_QUEUE_WEIGHTS.urgency).toBe(1);
  });

  it('mutating a loaded config does not poison later loads', () => {
    const dir = writeConfig('queue:\n  weights:\n    urgency: 4\n');
    const loaded = loadConfig(dir);
    if (loaded.queue !== undefined) loaded.queue.weights.urgency = 99;
    const reloaded = queueWeights(loadConfig(dir));
    expect(reloaded.ok && reloaded.weights.urgency).toBe(4);
  });
});
