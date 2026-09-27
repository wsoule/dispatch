import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { DEFAULT_A2A } from '../src/configTypes.js';

function rootWith(yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), 'cfg-a2a-'));
  mkdirSync(join(root, '.dispatch'), { recursive: true });
  writeFileSync(join(root, '.dispatch', 'config.yml'), yaml);
  return root;
}

describe('a2a config', () => {
  it('defaults when absent, with no warnings', () => {
    const config = loadConfig(rootWith(''));
    expect(config.a2a).toEqual(DEFAULT_A2A);
    expect(config.a2aWarnings).toEqual([]);
  });

  it('defaults when there is no config file at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'cfg-a2a-none-'));
    expect(loadConfig(root).a2a).toEqual(DEFAULT_A2A);
  });

  it('merges valid keys', () => {
    const config = loadConfig(
      rootWith(
        'a2a:\n  name: Acme API\n  skills: [ask]\n  blockingWaitSec: 600\n  sendsPerHour: 5\n'
      )
    );
    expect(config.a2a).toEqual({
      ...DEFAULT_A2A,
      name: 'Acme API',
      skills: ['ask'],
      blockingWaitSec: 600,
      sendsPerHour: 5,
    });
    expect(config.a2aWarnings).toEqual([]);
  });

  it('accepts a wait shorter than the 60 s default; 600 is the cap', () => {
    const config = loadConfig(rootWith('a2a:\n  blockingWaitSec: 1\n'));
    expect(config.a2a?.blockingWaitSec).toBe(1);
    expect(config.a2aWarnings).toEqual([]);
  });

  it('falls back key by key with a warning and never throws', () => {
    const config = loadConfig(
      rootWith(
        'a2a:\n  blockingWaitSec: 601\n  requestsPerMinute: -1\n  skills: [ask, teleport]\n  name: 7\n  listen: true\n'
      )
    );
    expect(config.a2a).toEqual(DEFAULT_A2A);
    const keys = config.a2aWarnings?.map((w) => w.split(' ')[0]).sort();
    expect(keys).toEqual([
      'a2a.blockingWaitSec',
      'a2a.listen',
      'a2a.name',
      'a2a.requestsPerMinute',
      'a2a.skills',
    ]);
  });

  it('falls back entirely for a block that is not a mapping', () => {
    const config = loadConfig(rootWith('a2a: [1, 2]\n'));
    expect(config.a2a).toEqual(DEFAULT_A2A);
    expect(config.a2aWarnings).toEqual([
      'a2a must be a mapping; using the defaults',
    ]);
  });

  it('still returns the rest of the config when a2a is broken', () => {
    const config = loadConfig(
      rootWith('a2a: yes\nmessaging:\n  urgentPerHour: 3\n')
    );
    expect(config.messaging.urgentPerHour).toBe(3);
  });

  it('has no key that could open a listener', () => {
    expect(
      Object.keys(DEFAULT_A2A).filter((k) =>
        /enabled|host|port|listen|tls|url/i.test(k)
      )
    ).toEqual([]);
  });
});
