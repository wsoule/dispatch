import { describe, expect, test } from 'bun:test';

import type { CredentialSource, TokenLookup } from '../src/identity.js';
import { sha256, TokenRegistry } from '../src/identity.js';

// The daemon's own two credentials, and the seam every other credential comes
// through. Teammates' tokens themselves are team/ (test/team/teammates.test.ts).

const BUILT_IN = { agentToken: 'agent-aaa', appToken: 'app-bbb' };

describe('TokenRegistry', () => {
  test('the built-in pair keeps its tiers and names the operator', () => {
    const reg = new TokenRegistry(BUILT_IN, 'wyat');
    // The app token sits at the top of the ladder — it only ever reaches the
    // person at this machine — and the agent token stays at the bottom.
    expect(reg.resolve('app-bbb')).toEqual({
      handle: 'wyat',
      ref: 'human:wyat',
      tier: 'operator',
    });
    // Flagged as the agent token: whoever presents it may be a run's agent.
    expect(reg.resolve('agent-aaa')).toEqual({
      handle: 'wyat',
      ref: 'human:wyat',
      tier: 'request',
      agentToken: true,
    });
  });

  test('with no one else to ask, anything else resolves to nobody', () => {
    const reg = new TokenRegistry(BUILT_IN, 'wyat');
    expect(reg.resolve('nope')).toBeNull();
    expect(reg.resolve(null)).toBeNull();
    // A prefix of a real token must not pass.
    expect(reg.resolve('app-')).toBeNull();
    expect(reg.resolve('')).toBeNull();
    expect(reg.list().map((t) => t.builtIn)).toEqual([true, true]);
  });

  test('any other token is asked of the credential source, verdict and all', () => {
    // A source that knows one token and refuses it — the shape a teammate
    // past the license's seats takes.
    const refused: TokenLookup = {
      kind: 'refused',
      handle: 'ada',
      reason: 'no seat for ada',
    };
    const asked: Buffer[] = [];
    const source: CredentialSource = {
      lookup: (digest) => {
        asked.push(digest);
        return digest.equals(sha256('ada-token'))
          ? refused
          : { kind: 'unknown' };
      },
      list: () => [],
    };
    const reg = new TokenRegistry(BUILT_IN, 'wyat', source);

    expect(reg.lookup('ada-token')).toEqual(refused);
    // Refused is not valid: nothing downstream may treat it as a caller.
    expect(reg.resolve('ada-token')).toBeNull();
    // The built-in pair never reaches the source, and never loses to it.
    expect(reg.resolve('app-bbb')?.tier).toBe('operator');
    expect(asked.map((d) => d.equals(sha256('app-bbb')))).not.toContain(true);
  });

  test("a teammate token naming the operator's handle matches no one", () => {
    const source: CredentialSource = {
      lookup: () => ({
        kind: 'valid',
        identity: { handle: 'wyat', ref: 'human:wyat', tier: 'decide' },
      }),
      list: () => [],
    };
    const reg = new TokenRegistry(BUILT_IN, 'wyat', source);
    expect(reg.lookup('stolen')).toEqual({ kind: 'unknown' });
    expect(reg.resolve('app-bbb')?.tier).toBe('operator');
  });
});
