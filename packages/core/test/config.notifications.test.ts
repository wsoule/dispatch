import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigError,
  DEFAULT_NOTIFICATIONS,
  loadConfig,
  updateConfig,
} from '../src/config.js';

// Writes `contents` as `.dispatch/config.yml` under a fresh temp root and
// returns that root, so a test can hand it straight to loadConfig.
function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-notifications-'));
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  writeFileSync(join(dir, '.dispatch/config.yml'), contents);
  return dir;
}

function read(dir: string): string {
  return readFileSync(join(dir, '.dispatch', 'config.yml'), 'utf8');
}

describe('loadConfig notifications', () => {
  it('defaults every kind on with no webhook when the block is absent', () => {
    const cfg = loadConfig(writeConfig('autoCommit: false\n'));
    expect(cfg.notifications).toEqual(DEFAULT_NOTIFICATIONS);
    expect(cfg.notifications.webhook).toBeUndefined();
  });

  it('does not share the default kinds map between loads', () => {
    const a = loadConfig(writeConfig('autoCommit: false\n'));
    a.notifications.kinds.question = false;
    const b = loadConfig(writeConfig('autoCommit: false\n'));
    expect(b.notifications.kinds.question).toBe(true);
    expect(DEFAULT_NOTIFICATIONS.kinds.question).toBe(true);
  });

  it('merges kinds over the defaults so one toggle leaves the rest on', () => {
    const cfg = loadConfig(
      writeConfig('notifications:\n  kinds:\n    fix-loop-capped: false\n')
    );
    expect(cfg.notifications.kinds).toEqual({
      question: true,
      approval: true,
      'scope-request': true,
      'fix-loop-capped': false,
      'run-stalled': true,
    });
  });

  it('reads a webhook URL', () => {
    const cfg = loadConfig(
      writeConfig(
        'notifications:\n  webhook: https://hooks.example.com/services/T0/B0/x\n'
      )
    );
    expect(cfg.notifications.webhook).toBe(
      'https://hooks.example.com/services/T0/B0/x'
    );
  });

  it('treats webhook: null as no webhook', () => {
    const cfg = loadConfig(writeConfig('notifications:\n  webhook: null\n'));
    expect(cfg.notifications.webhook).toBeUndefined();
  });

  it('rejects a non-object block', () => {
    expect(() => loadConfig(writeConfig('notifications: true\n'))).toThrow(
      ConfigError
    );
    expect(() => loadConfig(writeConfig('notifications: []\n'))).toThrow(
      ConfigError
    );
  });

  it('rejects an unknown kind rather than ignoring the typo', () => {
    expect(() =>
      loadConfig(
        writeConfig('notifications:\n  kinds:\n    fix-loop-caped: false\n')
      )
    ).toThrow(/unknown kind "fix-loop-caped"/);
  });

  it('rejects a non-boolean toggle', () => {
    expect(() =>
      loadConfig(writeConfig('notifications:\n  kinds:\n    question: "no"\n'))
    ).toThrow(/notifications\.kinds\.question: must be a boolean/);
  });

  it('rejects a webhook that is not an http(s) URL', () => {
    for (const bad of ['not a url', 'ftp://x.example', 'file:///tmp/x', '']) {
      expect(() =>
        loadConfig(
          writeConfig(`notifications:\n  webhook: ${JSON.stringify(bad)}\n`)
        )
      ).toThrow(ConfigError);
    }
  });
});

describe('updateConfig notifications', () => {
  it('writes one toggle without disturbing the others on disk', () => {
    const dir = writeConfig(
      'notifications:\n  kinds:\n    run-stalled: false\n'
    );
    const cfg = updateConfig(dir, {
      notifications: { kinds: { 'fix-loop-capped': false } },
    });
    expect(cfg.notifications.kinds['fix-loop-capped']).toBe(false);
    expect(cfg.notifications.kinds['run-stalled']).toBe(false);
    expect(cfg.notifications.kinds.question).toBe(true);
    expect(read(dir)).toContain('run-stalled: false');
    expect(read(dir)).toContain('fix-loop-capped: false');
  });

  it('sets and clears the webhook', () => {
    const dir = writeConfig('autoCommit: false\n');
    expect(
      updateConfig(dir, {
        notifications: { webhook: '  https://hooks.example.com/a  ' },
      }).notifications.webhook
    ).toBe('https://hooks.example.com/a');
    expect(
      updateConfig(dir, { notifications: { webhook: null } }).notifications
        .webhook
    ).toBeUndefined();
    expect(read(dir)).not.toContain('webhook');
  });

  it('treats an empty string as clearing the webhook', () => {
    const dir = writeConfig(
      'notifications:\n  webhook: https://hooks.example.com/a\n'
    );
    expect(
      updateConfig(dir, { notifications: { webhook: '' } }).notifications
        .webhook
    ).toBeUndefined();
  });

  it('clearing an absent webhook does not create the block', () => {
    const dir = writeConfig('autoCommit: false\n');
    updateConfig(dir, { notifications: { webhook: null } });
    expect(read(dir)).not.toContain('notifications');
  });

  it('rejects a bad URL or kind before writing anything', () => {
    const dir = writeConfig('autoCommit: false\n');
    expect(() =>
      updateConfig(dir, { notifications: { webhook: 'nope' } })
    ).toThrow(ConfigError);
    expect(() =>
      updateConfig(dir, {
        notifications: {
          kinds: { bogus: true } as Record<string, boolean>,
        },
      })
    ).toThrow(ConfigError);
    expect(read(dir)).toBe('autoCommit: false\n');
  });
});
