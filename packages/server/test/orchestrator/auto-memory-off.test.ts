import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeAiTaskFilter } from '../../src/aiTaskFilter.js';
import { CommitMessageGenerator } from '../../src/git/commitMessage.js';
import { InboxClusterer } from '../../src/inboxClusterer.js';
import {
  openClaudeQuery,
  resolveClaudeCli,
  withAutoMemoryOff,
} from '../../src/orchestrator/claudeCli.js';
import { generateRepoDigest } from '../../src/orchestrator/repoDigest.js';

const MISSING_CLI_MESSAGE =
  'Native CLI binary for darwin-arm64 not found. Reinstall ' +
  '@anthropic-ai/claude-agent-sdk without --omit=optional, or set ' +
  'options.pathToClaudeCodeExecutable.';

// A query function that records its options and ends at once.
function capture(): { options: Options[]; fn: never } {
  const options: Options[] = [];
  const fn = ((args: { options?: Options }) => {
    options.push(args.options ?? {});
    return (async function* () {})() as unknown as Query;
  }) as never;
  return { options, fn };
}

function expectOff(options: Options): void {
  const settings = options.settings as {
    autoMemoryEnabled?: boolean;
    env?: Record<string, string>;
  };
  expect(settings.autoMemoryEnabled).toBe(false);
  expect(settings.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
}

describe('auto memory off by default', () => {
  it('keeps settings a caller already set, the floor’s env pin included', () => {
    const out = withAutoMemoryOff({
      settings: {
        env: { CLAUDE_CODE_SIMPLE: '0' },
        disableSkillShellExecution: true,
      },
    });
    expect(out.settings).toEqual({
      env: { CLAUDE_CODE_SIMPLE: '0', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      disableSkillShellExecution: true,
      autoMemoryEnabled: false,
    });
  });

  it('refuses a settings file path, which cannot carry the switch', () => {
    expect(() => withAutoMemoryOff({ settings: '/tmp/settings.json' })).toThrow(
      'settings file path'
    );
  });

  it('applies unless the caller manages memory itself', () => {
    const c = capture();
    openClaudeQuery(c.fn, 'x', {});
    openClaudeQuery(c.fn, 'y', {}, { memory: 'managed' });
    expectOff(c.options[0]);
    expect(c.options[1].settings).toBeUndefined();
  });

  it('stays off on the override and PATH-fallback attempts', () => {
    const prev = process.env.DISPATCH_CLAUDE_BIN;
    const originalWhich = Bun.which;
    try {
      process.env.DISPATCH_CLAUDE_BIN = '/opt/custom/claude';
      const override = capture();
      openClaudeQuery(override.fn, 'x', {});
      expectOff(override.options[0]);

      delete process.env.DISPATCH_CLAUDE_BIN;
      Bun.which = (() => '/fake/path/claude') as typeof Bun.which;
      const seen: Options[] = [];
      const failFirst = ((args: { options?: Options }) => {
        seen.push(args.options ?? {});
        if (seen.length === 1) throw new Error(MISSING_CLI_MESSAGE);
        return (async function* () {})() as unknown as Query;
      }) as never;
      openClaudeQuery(failFirst, 'x', {});
      expect(seen).toHaveLength(2);
      expectOff(seen[1]);
    } finally {
      Bun.which = originalWhich;
      if (prev === undefined) delete process.env.DISPATCH_CLAUDE_BIN;
      else process.env.DISPATCH_CLAUDE_BIN = prev;
    }
  });

  it('covers the repo digest, AI filter, inbox clusterer and commit-message sessions', async () => {
    const root = process.cwd();
    for (const run of [
      (fn: never) => generateRepoDigest(root, fn),
      (fn: never) =>
        new ClaudeAiTaskFilter(root, fn).toFilters('open bugs', {
          statuses: [],
          labels: [],
          milestones: [],
          epics: [],
          runStates: [],
        }),
      (fn: never) =>
        new InboxClusterer(root, fn).cluster(
          Array.from(
            { length: 6 },
            (_, i) => ({ id: `i${i}`, text: `note ${i}`, done: false }) as never
          )
        ),
      (fn: never) =>
        new CommitMessageGenerator(root, fn).generate('diff --git a/x b/x'),
    ]) {
      const c = capture();
      await run(c.fn).catch(() => {});
      expect(c.options).toHaveLength(1);
      expectOff(c.options[0]);
    }
  });
});

describe('resolveClaudeCli', () => {
  it('reads the override’s version once per path and mtime', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-cli-')));
    const counter = join(dir, 'calls');
    const exe = join(dir, 'claude');
    writeFileSync(
      exe,
      `#!/bin/sh\necho call >> '${counter}'\necho '2.1.211 (Claude Code)'\n`
    );
    chmodSync(exe, 0o755);
    const prev = process.env.DISPATCH_CLAUDE_BIN;
    try {
      process.env.DISPATCH_CLAUDE_BIN = exe;
      expect(await resolveClaudeCli()).toEqual({
        path: exe,
        version: '2.1.211',
      });
      expect(await resolveClaudeCli()).toEqual({
        path: exe,
        version: '2.1.211',
      });
      expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.DISPATCH_CLAUDE_BIN;
      else process.env.DISPATCH_CLAUDE_BIN = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
