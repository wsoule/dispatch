import { describe, expect, it } from 'bun:test';

import {
  chooseMemoryMode,
  claudeMemorySettings,
  compareVersions,
  EXPORT_PROMPT_LINE,
  mergeFlagSettings,
  resolveManagedSettings,
  runPreflight,
} from '../../src/memory/claudeModes.js';

const base = {
  isClaude: true,
  runKind: 'execute' as const,
  hasOperator: true,
  personalAvailable: true,
  operatorIsOwner: true,
  ownerImport: 'complete' as const,
  claudeAutoMemory: 'export' as const,
  preflight: { ok: true as const, version: '2.1.207' },
  exportWritten: () => true,
};

describe('chooseMemoryMode', () => {
  it.each([
    ['not Claude', { isClaude: false }, 'prompt', true],
    ['a review run', { runKind: 'review' as const }, 'prompt', false],
    ['a verify run', { runKind: 'verify' as const }, 'prompt', false],
    ['no operator', { hasOperator: false }, 'prompt', true],
    [
      'a teammate whose personal store is down',
      { operatorIsOwner: false, ownerImport: null, personalAvailable: false },
      'prompt',
      true,
    ],
    [
      'the owner, store down, import state unreadable',
      { personalAvailable: false, ownerImport: null },
      'prompt',
      true,
    ],
    [
      'owner, import unconfirmed',
      { ownerImport: 'unconfirmed' as const },
      'native',
      true,
    ],
    [
      'owner, import failed, even with export off',
      { ownerImport: 'failed' as const, claudeAutoMemory: 'off' as const },
      'native',
      true,
    ],
    [
      'owner, import still running',
      { ownerImport: 'running' as const },
      'native',
      true,
    ],
    [
      'a teammate never goes native',
      { operatorIsOwner: false, ownerImport: null },
      'export',
      true,
    ],
    ['export off', { claudeAutoMemory: 'off' as const }, 'prompt', true],
    [
      'preflight failed',
      {
        preflight: {
          ok: false as const,
          reason: 'managed settings set autoMemoryDirectory',
        },
      },
      'prompt',
      true,
    ],
    ['export not writable', { exportWritten: () => false }, 'prompt', true],
    ['everything in place', {}, 'export', true],
  ])('%s', (_name, over, mode, index) => {
    const out = chooseMemoryMode({ ...base, ...over });
    expect<unknown[]>([out.mode, out.index]).toEqual([mode, index]);
  });

  it('never writes an export it does not use', () => {
    let wrote = 0;
    for (const over of [
      { claudeAutoMemory: 'off' as const },
      { personalAvailable: false },
      { hasOperator: false },
      { ownerImport: 'unconfirmed' as const },
    ]) {
      chooseMemoryMode({ ...base, ...over, exportWritten: () => ++wrote > 0 });
    }
    expect(wrote).toBe(0);
  });
});

describe('claudeMemorySettings', () => {
  it('export: points Claude at the directory, pins the env switch on, and allows reads and edits there', () => {
    expect(
      claudeMemorySettings('export', '/h/.dispatch/runs/k/claude-memory/r-1')
    ).toEqual({
      settings: {
        env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' },
        autoMemoryEnabled: true,
        autoMemoryDirectory: '/h/.dispatch/runs/k/claude-memory/r-1',
        autoDreamEnabled: false,
        permissions: {
          allow: [
            'Read(//h/.dispatch/runs/k/claude-memory/r-1/**)',
            'Edit(//h/.dispatch/runs/k/claude-memory/r-1/**)',
          ],
        },
      },
      additionalDirectories: ['/h/.dispatch/runs/k/claude-memory/r-1'],
    });
    expect(() => claudeMemorySettings('export', 'relative/dir')).toThrow(
      'absolute'
    );
  });

  it('prompt: switches auto memory off and pins it; native changes nothing', () => {
    expect(claudeMemorySettings('prompt').settings).toEqual({
      autoMemoryEnabled: false,
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    });
    expect(claudeMemorySettings('native')).toEqual({
      settings: null,
      additionalDirectories: [],
    });
  });

  it('merges beside the floor’s pin without dropping it', () => {
    const merged = mergeFlagSettings(
      { env: { CLAUDE_CODE_SIMPLE: '0' }, disableSkillShellExecution: true },
      claudeMemorySettings('prompt').settings
    );
    expect(merged).toEqual({
      env: { CLAUDE_CODE_SIMPLE: '0', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      disableSkillShellExecution: true,
      autoMemoryEnabled: false,
    });
    expect(mergeFlagSettings({ env: { A: '1' } }, null)).toEqual({
      env: { A: '1' },
    });
  });

  it('compares dotted versions numerically', () => {
    expect(compareVersions('2.1.210', '2.1.207')).toBeGreaterThan(0);
    expect(compareVersions('2.1.9', '2.1.10')).toBeLessThan(0);
    expect(compareVersions('2.1.207', '2.1.207')).toBe(0);
  });
});

describe('EXPORT_PROMPT_LINE', () => {
  it('names the index file and the tools that reach past it', () => {
    for (const word of [
      'MEMORY.md',
      'memory_search',
      'memory_read',
      'memory_save',
    ])
      expect(EXPORT_PROMPT_LINE).toContain(word);
  });
});

describe('resolveManagedSettings', () => {
  type Sources = Parameters<typeof resolveManagedSettings>[1];
  // A resolver that reports `sources` and keeps the options it was asked with.
  const resolver = (
    sources: Awaited<ReturnType<NonNullable<Sources>>>['sources']
  ) => {
    const asked: unknown[] = [];
    const resolve: NonNullable<Sources> = (opts) => {
      asked.push(opts);
      return Promise.resolve({ effective: {}, provenance: {}, sources });
    };
    return { asked, resolve };
  };

  it('merges only the managed layers, later ones winning, as the CLI resolves them in cwd', async () => {
    const { asked, resolve } = resolver([
      { source: 'user', settings: { autoMemoryDirectory: '/user' } },
      { source: 'managed', settings: { env: { A: '1' }, model: 'm1' } },
      { source: 'project', settings: { autoMemoryEnabled: false } },
      { source: 'managed', settings: { env: { B: '2' }, model: 'm2' } },
    ]);
    expect(await resolveManagedSettings('/repo', resolve)).toEqual({
      env: { A: '1', B: '2' },
      model: 'm2',
    });
    expect(asked).toEqual([
      { cwd: '/repo', settingSources: ['user', 'project', 'local'] },
    ]);
  });

  it('is null when no managed source sets anything', async () => {
    const { resolve } = resolver([
      { source: 'user', settings: { autoMemoryEnabled: false } },
    ]);
    expect(await resolveManagedSettings('/repo', resolve)).toBeNull();
  });
});

describe('runPreflight', () => {
  const ok = {
    env: {},
    probePassed: '2.1.207',
    cliVersion: () => Promise.resolve('2.1.210'),
    resolveManaged: () => Promise.resolve(null),
  };
  it('passes when the CLI is at least the probed version and nothing managed overrides it', async () => {
    expect(await runPreflight(ok)).toEqual({ ok: true, version: '2.1.210' });
  });
  it.each([
    ['no probe has passed', { probePassed: null }],
    ['an older CLI', { cliVersion: () => Promise.resolve('2.1.100') }],
    ['no CLI version at all', { cliVersion: () => Promise.resolve(null) }],
    [
      'the daemon’s env disables auto memory',
      { env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } },
    ],
    [
      'managed settings move the directory',
      {
        resolveManaged: () =>
          Promise.resolve({ autoMemoryDirectory: '/elsewhere' }),
      },
    ],
    [
      'managed settings turn it off',
      { resolveManaged: () => Promise.resolve({ autoMemoryEnabled: false }) },
    ],
    [
      'managed settings pin the env switch',
      {
        resolveManaged: () =>
          Promise.resolve({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } }),
      },
    ],
    [
      'resolveSettings throws (it is @alpha)',
      {
        resolveManaged: () => Promise.reject(new Error('alpha')),
      },
    ],
  ])('fails when %s', async (_name, over) => {
    expect((await runPreflight({ ...ok, ...over } as never)).ok).toBe(false);
  });
});
