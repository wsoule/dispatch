import { describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TokenRegistry } from '../../src/identity.js';
import type { PersistedToken, TokenStore } from '../../src/team/teammates.js';
import {
  fileTokenStore,
  SeatLimitError,
  TeammateTokens,
} from '../../src/team/teammates.js';

// A store the test can inspect, standing in for the file.
function memoryStore(initial: PersistedToken[] = []) {
  let saved = initial;
  const store: TokenStore = {
    load: () => saved,
    save: (tokens) => {
      saved = tokens;
    },
  };
  return { store, saved: () => saved };
}

const BUILT_IN = { agentToken: 'agent-aaa', appToken: 'app-bbb' };

/**
 * The daemon's registry with teammates' tokens behind it, as index.ts wires
 * them — plus the team's own issue/revoke, so each test reads as one object
 * the way the daemon's routes see it. `seats` defaults to unlimited: the tests
 * that are about the seat limit say how many.
 */
function registry(
  store?: TokenStore,
  clock?: () => Date,
  seats?: () => number
) {
  const teammates = new TeammateTokens({
    store,
    clock,
    seats,
    operatorHandle: 'wyat',
  });
  const reg = new TokenRegistry(BUILT_IN, 'wyat', teammates);
  return Object.assign(reg, {
    issue: teammates.issue.bind(teammates),
    revoke: teammates.revoke.bind(teammates),
    issuedTier: teammates.issuedTier.bind(teammates),
    peopleWithAccess: teammates.peopleWithAccess.bind(teammates),
  });
}

describe('TokenRegistry', () => {
  test('the built-in pair keeps its tiers and now names the operator', () => {
    const reg = registry();

    // The app token sits at the top of the ladder — it only ever reaches the
    // person at this machine — and the agent token stays at the bottom.
    expect(reg.resolve('app-bbb')).toEqual({
      handle: 'wyat',
      ref: 'human:wyat',
      tier: 'operator',
      appToken: true,
    });
    expect(reg.resolve('agent-aaa')).toEqual({
      handle: 'wyat',
      ref: 'human:wyat',
      tier: 'request',
      agentToken: true,
    });
  });

  test('an unknown or absent credential resolves to nobody', () => {
    const reg = registry();

    expect(reg.resolve('nope')).toBeNull();
    expect(reg.resolve(null)).toBeNull();
    // A prefix of a real token must not pass.
    expect(reg.resolve('app-')).toBeNull();
    expect(reg.resolve('')).toBeNull();
  });

  test('an issued token tells one teammate from another', () => {
    const reg = registry();

    const ada = reg.issue('ada', 'request');
    const grace = reg.issue('grace', 'request');

    // The whole point: two humans on one daemon are no longer the same caller.
    expect(reg.resolve(ada)?.handle).toBe('ada');
    expect(reg.resolve(grace)?.handle).toBe('grace');
    expect(ada).not.toBe(grace);
  });

  test('an issued token carries the tier it was issued for', () => {
    const reg = registry();

    const requester = reg.issue('ada', 'request');
    const decider = reg.issue('grace', 'decide');
    const operator = reg.issue('linus', 'operator');

    expect(reg.resolve(requester)?.tier).toBe('request');
    expect(reg.resolve(decider)?.tier).toBe('decide');
    expect(reg.resolve(operator)?.tier).toBe('operator');
  });

  test('one token per person: a new tier replaces the old token', () => {
    const reg = registry();
    const asRequester = reg.issue('ada', 'request');

    const asDecider = reg.issue('ada', 'decide');

    // Promoting someone must not leave their old token live at the old tier,
    // where a later `revoke ada` would be expected to have killed it.
    expect(reg.resolve(asRequester)).toBeNull();
    expect(reg.resolve(asDecider)?.tier).toBe('decide');
    expect(reg.issuedTier('ada')).toBe('decide');
    expect(reg.list().filter((e) => !e.builtIn)).toHaveLength(1);
  });

  test('re-issuing replaces the old credential rather than adding one', () => {
    const reg = registry();
    const first = reg.issue('ada', 'request');

    const second = reg.issue('ada', 'request');

    // A teammate whose laptop was lost is re-credentialed; the old token must
    // stop working the moment the new one exists.
    expect(reg.resolve(first)).toBeNull();
    expect(reg.resolve(second)?.handle).toBe('ada');
    expect(reg.list().filter((e) => e.handle === 'ada')).toHaveLength(1);
  });

  test('revoking stops a credential working', () => {
    const reg = registry();
    const ada = reg.issue('ada', 'request');

    expect(reg.revoke('ada')).toBe(true);
    expect(reg.resolve(ada)).toBeNull();
    expect(reg.issuedTier('ada')).toBeNull();
    // Revoking again is false, not an error.
    expect(reg.revoke('ada')).toBe(false);
  });

  test('the built-in pair cannot be revoked', () => {
    const reg = registry();

    // Dropping them would lock the operator out of the daemon running on
    // their own machine, with no way back short of a restart.
    expect(reg.revoke('wyat')).toBe(false);
    expect(reg.resolve('app-bbb')?.tier).toBe('operator');
    expect(reg.issuedTier('wyat')).toBeNull();
  });

  test('listing holders never discloses the credentials', () => {
    const reg = registry();
    const ada = reg.issue('ada', 'request');

    const listed = reg.list();

    expect(listed).toContainEqual(
      expect.objectContaining({
        handle: 'ada',
        tier: 'request',
        builtIn: false,
      })
    );
    // A list endpoint built on this must not be able to hand out tokens.
    expect(JSON.stringify(listed)).not.toContain(ada);
  });

  test('issued tokens survive a restart, as hashes only', () => {
    const { store, saved } = memoryStore();
    const first = registry(store);
    const ada = first.issue('ada', 'request');

    // Nothing on disk can be walked back to the token.
    expect(JSON.stringify(saved())).not.toContain(ada);
    expect(saved()[0].hash).toMatch(/^[0-9a-f]{64}$/);

    // A new daemon over the same store still knows Ada.
    const second = new TokenRegistry(
      { agentToken: 'agent-new', appToken: 'app-new' },
      'wyat',
      new TeammateTokens({ store })
    );
    expect(second.resolve(ada)?.handle).toBe('ada');
  });

  test('the built-in pair is never written to the store', () => {
    const { store, saved } = memoryStore();
    const reg = registry(store);
    reg.issue('ada', 'request');

    // The app token is never persisted anywhere by design; a hash of it on
    // disk would be the first place it ever was.
    expect(saved().every((t) => t.handle === 'ada')).toBe(true);
  });

  test('revoking persists too, so a restart does not resurrect a token', () => {
    const { store } = memoryStore();
    const first = registry(store);
    const ada = first.issue('ada', 'request');
    first.revoke('ada');

    const second = registry(store);
    expect(second.resolve(ada)).toBeNull();
  });
  test('a file from before one-token-per-person is revoked whole', () => {
    // Written by a daemon that keyed tokens on handle and tier together, so
    // Ada could hold one of each.
    const { store } = memoryStore([
      { handle: 'ada', tier: 'request', hash: 'a'.repeat(64), issuedAt: 'x' },
      { handle: 'ada', tier: 'decide', hash: 'b'.repeat(64), issuedAt: 'x' },
    ]);
    const reg = registry(store);

    expect(reg.revoke('ada')).toBe(true);
    expect(reg.list().filter((e) => e.handle === 'ada')).toHaveLength(0);
  });
});

describe('expiry and last use', () => {
  // A clock the test moves by hand.
  function clockAt(iso: string) {
    let now = new Date(iso);
    return {
      clock: () => now,
      advance: (ms: number) => {
        now = new Date(now.getTime() + ms);
      },
    };
  }
  const MINUTE = 60 * 1000;

  test('an expired token stops working, and says it expired rather than vanishing', () => {
    const t = clockAt('2026-01-01T00:00:00Z');
    const reg = registry(undefined, t.clock);
    const ada = reg.issue('ada', 'request', {
      expiresAt: new Date('2026-01-02T00:00:00Z'),
    });
    expect(reg.resolve(ada)?.handle).toBe('ada');

    t.advance(24 * 60 * MINUTE);

    expect(reg.resolve(ada)).toBeNull();
    expect(reg.lookup(ada)).toEqual({
      kind: 'expired',
      handle: 'ada',
      expiredAt: '2026-01-02T00:00:00.000Z',
    });
    expect(reg.list().find((e) => e.handle === 'ada')?.expired).toBe(true);
  });

  test('no expiry means it never runs out', () => {
    const t = clockAt('2026-01-01T00:00:00Z');
    const reg = registry(undefined, t.clock);
    const ada = reg.issue('ada', 'request');
    t.advance(10 * 365 * 24 * 60 * MINUTE);
    expect(reg.resolve(ada)?.handle).toBe('ada');
  });

  test('last use is recorded, but written to disk at most every fifteen minutes', () => {
    const t = clockAt('2026-01-01T00:00:00Z');
    let saves = 0;
    const store: TokenStore = {
      load: () => [],
      save: () => {
        saves += 1;
      },
    };
    const reg = registry(store, t.clock);
    const ada = reg.issue('ada', 'request');
    const afterIssue = saves;

    // The first use is written through; a burst after it is not.
    reg.resolve(ada);
    for (let i = 0; i < 50; i++) {
      t.advance(1000);
      reg.resolve(ada);
    }
    expect(saves).toBe(afterIssue + 1);
    // …but memory is always current, which is what `list` reports.
    expect(reg.list().find((e) => e.handle === 'ada')?.lastUsedAt).toBe(
      '2026-01-01T00:00:50.000Z'
    );

    t.advance(15 * MINUTE);
    reg.resolve(ada);
    expect(saves).toBe(afterIssue + 2);
  });

  test('the built-in pair never records use, so it never writes', () => {
    let saves = 0;
    const store: TokenStore = { load: () => [], save: () => void saves++ };
    const reg = registry(store);
    reg.resolve('app-bbb');
    reg.resolve('agent-aaa');
    expect(saves).toBe(0);
  });

  test('a malformed expiry in the file drops the token instead of reading as never', () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'dispatch-tokens-')),
      'team-tokens.json'
    );
    writeFileSync(
      path,
      JSON.stringify([
        {
          handle: 'ada',
          tier: 'operator',
          hash: 'a'.repeat(64),
          issuedAt: 'x',
          expiresAt: 'soon',
        },
        {
          handle: 'grace',
          tier: 'request',
          hash: 'b'.repeat(64),
          issuedAt: 'x',
          expiresAt: 12,
        },
        {
          handle: 'linus',
          tier: 'request',
          hash: 'c'.repeat(64),
          issuedAt: 'x',
          expiresAt: null,
        },
        {
          handle: 'mary',
          tier: 'request',
          hash: 'd'.repeat(64),
          issuedAt: 'x',
        },
      ])
    );
    expect(
      fileTokenStore(path)
        .load()
        .map((t) => t.handle)
    ).toEqual(['linus', 'mary']);
  });
});

describe('fileTokenStore', () => {
  test('round-trips through a 0600 file', () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'dispatch-tokens-')),
      'team-tokens.json'
    );
    const store = fileTokenStore(path);
    const reg = registry(store);
    const ada = reg.issue('ada', 'decide');

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).not.toContain(ada);
    expect(registry(fileTokenStore(path)).resolve(ada)?.tier).toBe('decide');
  });

  test('a missing file loads as empty rather than failing boot', () => {
    expect(
      fileTokenStore(join(tmpdir(), 'no-such-dir-8f1a', 'x.json')).load()
    ).toEqual([]);
  });

  test('a corrupt file loads as empty rather than failing boot', () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'dispatch-tokens-')),
      'team-tokens.json'
    );
    writeFileSync(path, '{ not json');
    expect(fileTokenStore(path).load()).toEqual([]);
  });

  test('moves an unreadable file aside with a problem, and never saves over it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-tokens-'));
    const path = join(dir, 'team-tokens.json');
    writeFileSync(path, '{ not json');
    const store = fileTokenStore(path);
    expect(store.load()).toEqual([]);
    const aside = readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]), 'utf8')).toBe('{ not json');
    expect(store.problems?.()).toEqual([expect.stringContaining(aside[0])]);
    expect(new TeammateTokens({ store }).problems()).toHaveLength(1);
    // A file damaged after load is moved aside too, not overwritten.
    writeFileSync(path, '[{ broken');
    store.save([]);
    expect(
      readdirSync(dir).filter((f) => f.includes('.corrupt-'))
    ).toHaveLength(2);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([]);
  });

  test('saves through a temp file and rename, leaving no temp behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-tokens-'));
    const path = join(dir, 'team-tokens.json');
    const store = fileTokenStore(path);
    store.save([]);
    // A crash before the rename leaves the old file whole: simulate by a
    // stray temp file, which the next save replaces.
    writeFileSync(`${path}.tmp-stale`, 'half');
    store.save([]);
    expect(readdirSync(dir).filter((f) => !f.includes('stale'))).toEqual([
      'team-tokens.json',
    ]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('drops entries that are not well-formed hashes', () => {
    const path = join(
      mkdtempSync(join(tmpdir(), 'dispatch-tokens-')),
      'team-tokens.json'
    );
    // A hand-edited file that put a raw token where the hash goes must not
    // turn into a credential that matches its own sha256.
    writeFileSync(
      path,
      JSON.stringify([
        {
          handle: 'ada',
          tier: 'request',
          hash: 'raw-token-oops',
          issuedAt: '',
        },
        { handle: 'eve', tier: 'admin', hash: 'a'.repeat(64), issuedAt: '' },
      ])
    );
    expect(fileTokenStore(path).load()).toEqual([]);
  });
});

describe('seats', () => {
  // A clock that moves only when told, so "earliest invited" is exact.
  function steppingClock() {
    let now = Date.parse('2026-09-23T10:00:00Z');
    return {
      clock: () => new Date(now),
      step: () => {
        now += 60_000;
      },
    };
  }

  test('three people fit for free: the operator and two teammates', () => {
    const t = steppingClock();
    const reg = registry(undefined, t.clock, () => 3);
    reg.issue('ada', 'request');
    t.step();
    reg.issue('grace', 'request');
    expect(reg.peopleWithAccess()).toBe(3);

    // A fourth person is refused, with the reason and the seat count.
    expect(() => reg.issue('linus', 'request')).toThrow(SeatLimitError);
    try {
      reg.issue('linus', 'request');
    } catch (err) {
      expect((err as SeatLimitError).seats).toBe(3);
    }
    expect(reg.issuedTier('linus')).toBeNull();
  });

  test('re-inviting someone already here never needs a seat', () => {
    const reg = registry(undefined, undefined, () => 3);
    reg.issue('ada', 'request');
    reg.issue('grace', 'request');
    // A new tier, or a lost laptop: same person, same seat.
    const again = reg.issue('ada', 'decide');
    expect(reg.resolve(again)?.tier).toBe('decide');
  });

  test('revoking someone frees their seat', () => {
    const reg = registry(undefined, undefined, () => 3);
    reg.issue('ada', 'request');
    reg.issue('grace', 'request');
    reg.revoke('ada');
    expect(() => reg.issue('linus', 'request')).not.toThrow();
  });

  test('an expired token holds no seat', () => {
    const t = steppingClock();
    const reg = registry(undefined, t.clock, () => 3);
    reg.issue('ada', 'request', {
      expiresAt: new Date(t.clock().getTime() + 1),
    });
    reg.issue('grace', 'request');
    t.step();
    expect(() => reg.issue('linus', 'request')).not.toThrow();
  });

  test('fewer seats than holders: the earliest invited keep working, the rest are told why', () => {
    // How a license lapsing, or a token file edited by hand, looks from here.
    const t = steppingClock();
    let seats = 10;
    const reg = registry(undefined, t.clock, () => seats);
    const tokens: Record<string, string> = {};
    for (const who of ['ada', 'grace', 'linus', 'barbara']) {
      tokens[who] = reg.issue(who, 'request');
      t.step();
    }

    seats = 3;
    expect(reg.resolve(tokens.ada)?.handle).toBe('ada');
    expect(reg.resolve(tokens.grace)?.handle).toBe('grace');
    for (const who of ['linus', 'barbara']) {
      const found = reg.lookup(tokens[who]);
      expect(found.kind).toBe('refused');
      expect(found.kind === 'refused' && found.reason).toContain('3 people');
    }

    // A key with more seats brings them straight back, no restart.
    seats = 5;
    expect(reg.resolve(tokens.barbara)?.handle).toBe('barbara');
  });

  test('a token file with more holders than seats cannot widen the plan', () => {
    const t = steppingClock();
    const { store } = memoryStore();
    const writer = registry(store, t.clock);
    const tokens = ['a1', 'a2', 'a3', 'a4', 'a5'].map((who) => {
      const token = writer.issue(who, 'request');
      t.step();
      return token;
    });

    const reader = registry(store, t.clock, () => 3);
    expect(tokens.map((tok) => reader.lookup(tok).kind)).toEqual([
      'valid',
      'valid',
      'refused',
      'refused',
      'refused',
    ]);
  });

  test("a pre-fix token for the operator's handle is unusable and takes no seat", () => {
    const t = steppingClock();
    const { store } = memoryStore();
    const writer = new TeammateTokens({ store, clock: t.clock });
    // Issued before the operator's handle was refused, and first in line.
    const stale = writer.issue('wyat', 'decide');
    t.step();

    const reg = registry(store, t.clock, () => 2);
    expect(reg.lookup(stale).kind).toBe('unknown');
    expect(reg.peopleWithAccess()).toBe(1);
    expect(reg.list().find((h) => !h.builtIn)).toMatchObject({
      handle: 'wyat',
      unusable: true,
    });
    const ada = reg.issue('ada', 'request');
    expect(reg.resolve(ada)?.handle).toBe('ada');
    expect(reg.peopleWithAccess()).toBe(2);
    expect(reg.list().find((h) => h.handle === 'ada')?.unusable).toBe(false);
  });
});
