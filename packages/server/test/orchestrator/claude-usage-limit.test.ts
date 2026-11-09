import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'bun:test';

import {
  resetTimeIso,
  usageLimitFromResult,
  withAccount,
} from '../../src/orchestrator/executors/claude.js';

// The Claude executor's half of account failover: telling a usage-limit stop
// from every other failure, and signing a run in as a stored account.

function result(terminalReason: string): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    terminal_reason: terminalReason,
  } as unknown as SDKResultMessage;
}

describe('usageLimitFromResult', () => {
  it('reads blocking_limit as a usage limit', () => {
    expect(
      usageLimitFromResult(result('blocking_limit'), undefined, undefined)
    ).toEqual({});
  });

  it('reads a rate_limit API error before an api_error stop as one', () => {
    expect(
      usageLimitFromResult(
        result('api_error'),
        { kind: 'rate_limit', text: "You've hit your session limit" },
        undefined
      )
    ).toEqual({});
  });

  it('carries the reset time of a rejected rate_limit_event', () => {
    expect(
      usageLimitFromResult(result('api_error'), undefined, {
        resetsAt: '2026-10-20T15:40:00.000Z',
      })
    ).toEqual({ resetsAt: '2026-10-20T15:40:00.000Z' });
  });

  it('ignores other stops', () => {
    for (const reason of ['rapid_refill_breaker', 'max_turns', 'api_error']) {
      expect(
        usageLimitFromResult(result(reason), undefined, undefined)
      ).toBeUndefined();
    }
    expect(
      usageLimitFromResult(
        result('api_error'),
        { kind: 'billing_error', text: '' },
        undefined
      )
    ).toBeUndefined();
  });
});

describe('resetTimeIso', () => {
  it('takes epoch seconds and milliseconds', () => {
    expect(resetTimeIso(1_792_543_200)).toBe('2026-10-21T00:40:00.000Z');
    expect(resetTimeIso(1_792_543_200_000)).toBe('2026-10-21T00:40:00.000Z');
    expect(resetTimeIso(undefined)).toBeUndefined();
    expect(resetTimeIso(0)).toBeUndefined();
  });
});

describe('withAccount', () => {
  const env = {
    PATH: '/bin',
    ANTHROPIC_API_KEY: 'sk',
    ANTHROPIC_AUTH_TOKEN: 'x',
  };

  it('leaves the env alone for the default login', () => {
    expect(withAccount(env, undefined)).toBe(env);
    expect(withAccount(env, { label: 'default' })).toBe(env);
  });

  it("signs in with the account's token ahead of any key", () => {
    expect(withAccount(env, { label: 'work', token: 'oat-1' })).toEqual({
      PATH: '/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'oat-1',
    });
  });
});
