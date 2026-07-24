import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'bun:test';

import {
  CLAUDE_INSTALL_HINT,
  isMissingCliError,
  openClaudeQuery,
  rewriteMissingCliError,
} from '../../src/orchestrator/claudeCli.js';

// The exact text the Agent SDK throws when it can't resolve its own bundled
// native CLI binary — see claudeCli.ts's doc comment for why this specific
// wording is what isMissingCliError/rewriteMissingCliError key off of.
const MISSING_CLI_MESSAGE =
  'Native CLI binary for darwin-arm64 not found. Reinstall ' +
  '@anthropic-ai/claude-agent-sdk without --omit=optional, or set ' +
  'options.pathToClaudeCodeExecutable.';

// An empty async generator — good enough for tests that only care whether
// openClaudeQuery's fallback chain reached a successful queryFn call, not
// about any particular message stream afterward.
async function* emptyMessages(): AsyncGenerator<never> {}

describe('isMissingCliError / rewriteMissingCliError', () => {
  it('recognizes the SDK missing-CLI message and rewrites it to the install hint', () => {
    expect(isMissingCliError(MISSING_CLI_MESSAGE)).toBe(true);
    expect(rewriteMissingCliError(MISSING_CLI_MESSAGE)).toBe(
      CLAUDE_INSTALL_HINT
    );
  });

  it('leaves an unrelated message untouched', () => {
    expect(isMissingCliError('some other startup failure')).toBe(false);
    expect(rewriteMissingCliError('some other startup failure')).toBe(
      'some other startup failure'
    );
  });
});

describe('openClaudeQuery CLI resolution chain', () => {
  it('falls back to a PATH `claude` when the bundled attempt reports a missing CLI, and succeeds', () => {
    const originalWhich = Bun.which;
    // Stub Bun.which so this test does not depend on whether the sandbox
    // running it happens to have a real `claude` on PATH.
    Bun.which = ((cmd: string) =>
      cmd === 'claude'
        ? '/fake/path/claude'
        : originalWhich(cmd)) as typeof Bun.which;
    try {
      const capturedOptions: (Options | undefined)[] = [];
      const fakeQueryFn = (args: { options?: Options }) => {
        capturedOptions.push(args.options);
        if (capturedOptions.length === 1) {
          throw new Error(MISSING_CLI_MESSAGE);
        }
        return emptyMessages() as unknown as Query;
      };

      const result = openClaudeQuery(fakeQueryFn as never, 'do the thing', {});

      expect(result).toBeDefined();
      expect(capturedOptions).toHaveLength(2);
      // The retry passed the PATH-resolved executable through explicitly.
      expect(capturedOptions[1]?.pathToClaudeCodeExecutable).toBe(
        '/fake/path/claude'
      );
    } finally {
      Bun.which = originalWhich;
    }
  });

  it('surfaces the install hint, not the raw SDK text, when the PATH fallback also fails', () => {
    const originalWhich = Bun.which;
    Bun.which = ((cmd: string) =>
      cmd === 'claude'
        ? '/fake/path/claude'
        : originalWhich(cmd)) as typeof Bun.which;
    try {
      const fakeQueryFn = () => {
        throw new Error(MISSING_CLI_MESSAGE);
      };

      expect(() =>
        openClaudeQuery(fakeQueryFn as never, 'do the thing', {})
      ).toThrow(CLAUDE_INSTALL_HINT);
    } finally {
      Bun.which = originalWhich;
    }
  });

  it('surfaces the install hint when no `claude` is found on PATH at all', () => {
    const originalWhich = Bun.which;
    Bun.which = (() => null) as typeof Bun.which;
    try {
      const fakeQueryFn = () => {
        throw new Error(MISSING_CLI_MESSAGE);
      };

      expect(() =>
        openClaudeQuery(fakeQueryFn as never, 'do the thing', {})
      ).toThrow(CLAUDE_INSTALL_HINT);
    } finally {
      Bun.which = originalWhich;
    }
  });

  it('passes a non-CLI startup error through unchanged, with no PATH probe', () => {
    const fakeQueryFn = () => {
      throw new Error('some other startup failure');
    };

    expect(() =>
      openClaudeQuery(fakeQueryFn as never, 'do the thing', {})
    ).toThrow('some other startup failure');
  });

  it('honors DISPATCH_CLAUDE_BIN as an explicit override before any fallback', () => {
    const prev = process.env.DISPATCH_CLAUDE_BIN;
    process.env.DISPATCH_CLAUDE_BIN = '/opt/custom/claude';
    try {
      let captured: Options | undefined;
      const fakeQueryFn = (args: { options?: Options }) => {
        captured = args.options;
        return emptyMessages() as unknown as Query;
      };

      openClaudeQuery(fakeQueryFn as never, 'do the thing', {});

      expect(captured?.pathToClaudeCodeExecutable).toBe('/opt/custom/claude');
    } finally {
      if (prev === undefined) delete process.env.DISPATCH_CLAUDE_BIN;
      else process.env.DISPATCH_CLAUDE_BIN = prev;
    }
  });
});
