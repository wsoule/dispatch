import { MemoryError } from '@dispatch/memory';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IDENTITY_PATTERN,
  MemoryIdentities,
} from '../../src/memory/identities.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function open(now = () => new Date('2026-09-25T10:00:00.000Z')) {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ids-')));
  return new MemoryIdentities({
    path: join(dir, 'memory', 'identities.db'),
    now,
  });
}
const P1 = 'aaaaaaaaaaaa';
const P2 = 'bbbbbbbbbbbb';
const P3 = 'cccccccccccc';

function identityOf(
  ids: MemoryIdentities,
  projectKey: string,
  handle: string,
  rosterEmail: string | null
): string {
  const r = ids.resolve({ projectKey, handle, isOwner: false, rosterEmail });
  if (!r.ok) throw new Error(`unexpected ${r.reason}`);
  return r.identity;
}

function codeError(fn: () => unknown): MemoryError {
  try {
    fn();
  } catch (err) {
    if (err instanceof MemoryError) return err;
    throw err;
  }
  throw new Error('expected a MemoryError');
}

describe('MemoryIdentities', () => {
  // A placeholder or missing roster email named no one, so a real one later is the same person.
  it.each([['local@localhost'], [null]])(
    'keeps a handle bound under %p when its roster email becomes real',
    (before) => {
      const ids = open();
      const first = identityOf(ids, P1, 'ada', before);
      expect(identityOf(ids, P1, 'ada', 'ada@example.com')).toBe(first);
      expect(
        ids.startLink({
          projectKey: P1,
          handle: 'ada',
          rosterEmail: 'ada@example.com',
        }).code
      ).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      // Now bound to the real email, a different one is a different person.
      expect(
        ids.resolve({
          projectKey: P1,
          handle: 'ada',
          isOwner: false,
          rosterEmail: 'eve@example.com',
        }).ok
      ).toBe(false);
    }
  );

  it('moves a placeholder-bound handle’s entries when it completes a link', () => {
    const ids = open();
    const target = identityOf(ids, P2, 'ada', 'ada@example.com');
    const { code } = ids.startLink({
      projectKey: P2,
      handle: 'ada',
      rosterEmail: 'ada@example.com',
    });
    const old = identityOf(ids, P1, 'ada', 'local@localhost');
    expect(
      ids.completeLink({
        code,
        projectKey: P1,
        handle: 'ada',
        rosterEmail: 'ada@example.com',
      })
    ).toEqual({ identity: target, previous: old });
  });

  it('binds every owner alias to self, whatever the handle', () => {
    const ids = open();
    expect(
      ids.resolve({
        projectKey: P1,
        handle: 'wyat',
        isOwner: true,
        rosterEmail: 'w@x.com',
      })
    ).toEqual({ ok: true, identity: 'self' });
    expect(
      ids.resolve({
        projectKey: P2,
        handle: 'wyat2',
        isOwner: true,
        rosterEmail: 'w@y.com',
      })
    ).toEqual({ ok: true, identity: 'self' });
    expect(statSync(join(dir, 'memory')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'memory', 'identities.db')).mode & 0o777).toBe(
      0o600
    );
    expect(ids.identities()).toEqual(['self']);
    expect(ids.aliasesOf('self')).toEqual([
      { projectKey: P1, handle: 'wyat' },
      { projectKey: P2, handle: 'wyat2' },
    ]);
  });

  it('gives two people with one handle in two projects different identities', () => {
    const ids = open();
    const a = ids.resolve({
      projectKey: P1,
      handle: 'alex',
      isOwner: false,
      rosterEmail: 'alex@a.com',
    });
    const b = ids.resolve({
      projectKey: P2,
      handle: 'alex',
      isOwner: false,
      rosterEmail: 'alex@b.com',
    });
    expect(a.ok && b.ok && a.identity !== b.identity).toBe(true);
    expect((a as { identity: string }).identity).toMatch(IDENTITY_PATTERN);
    expect(identityOf(ids, P1, 'alex', 'alex@a.com')).toBe(
      (a as { identity: string }).identity
    );
  });

  it('keeps one person with different handles separate until linked', () => {
    const ids = open();
    const first = identityOf(ids, P1, 'ada', 'ada@x.com');
    const second = identityOf(ids, P2, 'ada.l', 'ada@x.com');
    expect(first).not.toBe(second);
    const { code, expiresAt } = ids.startLink({
      projectKey: P1,
      handle: 'ada',
      rosterEmail: 'ada@x.com',
    });
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(expiresAt).toBe('2026-09-25T10:10:00.000Z');
    expect(
      ids.completeLink({
        code,
        projectKey: P2,
        handle: 'ada.l',
        rosterEmail: 'ada@x.com',
      })
    ).toEqual({ identity: first, previous: second });
    expect(
      ids.resolve({
        projectKey: P2,
        handle: 'ada.l',
        isOwner: false,
        rosterEmail: 'ada@x.com',
      })
    ).toEqual({ ok: true, identity: first });
    expect(ids.aliasesOf(second)).toEqual([]);
    expect(() =>
      ids.completeLink({
        code,
        projectKey: P2,
        handle: 'ada.l',
        rosterEmail: 'ada@x.com',
      })
    ).toThrow(/code/);
  });

  it('refuses an expired link code', () => {
    let t = new Date('2026-09-25T10:00:00.000Z');
    const ids = open(() => t);
    ids.resolve({
      projectKey: P1,
      handle: 'ada',
      isOwner: false,
      rosterEmail: 'ada@x.com',
    });
    const { code } = ids.startLink({
      projectKey: P1,
      handle: 'ada',
      rosterEmail: 'ada@x.com',
    });
    t = new Date('2026-09-25T10:10:01.000Z');
    expect(() =>
      ids.completeLink({
        code,
        projectKey: P2,
        handle: 'ada',
        rosterEmail: 'ada@x.com',
      })
    ).toThrow(/expired|code/);
  });

  it('flags a handle reused by someone else, and starts fresh on request', () => {
    const ids = open();
    const old = identityOf(ids, P1, 'sam', 'sam@old.com');
    expect(
      ids.resolve({
        projectKey: P1,
        handle: 'sam',
        isOwner: false,
        rosterEmail: 'sam@new.com',
      })
    ).toEqual({
      ok: false,
      reason: 'reused-handle',
      boundEmail: 'sam@old.com',
      currentEmail: 'sam@new.com',
    });
    const fresh = ids.startFresh({
      projectKey: P1,
      handle: 'sam',
      rosterEmail: 'sam@new.com',
    });
    expect(fresh).not.toBe(old);
    expect(fresh).toMatch(IDENTITY_PATTERN);
    expect(
      ids.resolve({
        projectKey: P1,
        handle: 'sam',
        isOwner: false,
        rosterEmail: 'sam@new.com',
      })
    ).toEqual({ ok: true, identity: fresh });
  });

  it('accepts a code typed in lower case without its dash, and stores only its hash', () => {
    const ids = open();
    identityOf(ids, P1, 'ada', 'ada@x.com');
    const { code } = ids.startLink({
      projectKey: P1,
      handle: 'ada',
      rosterEmail: 'ada@x.com',
    });
    for (const file of ['identities.db', 'identities.db-wal']) {
      const path = join(dir, 'memory', file);
      if (existsSync(path))
        expect(readFileSync(path).includes(code.replace('-', ''))).toBe(false);
    }
    expect(
      ids.completeLink({
        code: code.replace('-', '').toLowerCase(),
        projectKey: P2,
        handle: 'ada',
        rosterEmail: 'ada@x.com',
      }).identity
    ).toBe(identityOf(ids, P1, 'ada', 'ada@x.com'));
    expect(
      codeError(() =>
        ids.completeLink({
          code: 'not a code',
          projectKey: P2,
          handle: 'ada',
          rosterEmail: 'ada@x.com',
        })
      ).field
    ).toBe('code');
  });

  it('never lets a teammate reach the owner store', () => {
    const ids = open();
    ids.resolve({
      projectKey: P1,
      handle: 'wyat',
      isOwner: true,
      rosterEmail: 'w@x.com',
    });
    expect(
      ids.resolve({
        projectKey: P1,
        handle: 'wyat',
        isOwner: false,
        rosterEmail: 'w@x.com',
      })
    ).toEqual({
      ok: false,
      reason: 'reused-handle',
      boundEmail: 'w@x.com',
      currentEmail: 'w@x.com',
    });
    expect(
      codeError(() =>
        ids.startLink({
          projectKey: P1,
          handle: 'wyat',
          rosterEmail: 'w@x.com',
        })
      ).code
    ).toBe('invalid');
  });

  // The owner's alias always resolves back to self, so a link would only
  // burn the teammate's code.
  it('refuses to link the owner’s alias, and keeps the code', () => {
    const ids = open();
    ids.resolve({
      projectKey: P1,
      handle: 'wyat',
      isOwner: true,
      rosterEmail: 'w@x.com',
    });
    identityOf(ids, P2, 'ada', 'a@x.com');
    const { code } = ids.startLink({
      projectKey: P2,
      handle: 'ada',
      rosterEmail: 'a@x.com',
    });
    const link = (handle: string, rosterEmail: string) =>
      ids.completeLink({ code, projectKey: P1, handle, rosterEmail });
    expect(codeError(() => link('wyat', 'w@x.com')).code).toBe('invalid');
    expect(link('ada', 'a@x.com').identity).toMatch(IDENTITY_PATTERN);
  });

  it('will not start a link from a handle someone else now holds', () => {
    const ids = open();
    identityOf(ids, P1, 'sam', 'sam@old.com');
    const err = codeError(() =>
      ids.startLink({
        projectKey: P1,
        handle: 'sam',
        rosterEmail: 'sam@new.com',
      })
    );
    expect(err.code).toBe('conflict');
    expect(
      codeError(() =>
        ids.startLink({ projectKey: P1, handle: 'nobody', rosterEmail: null })
      ).code
    ).toBe('not-found');
  });

  it('never hands a reused handle the previous holder store to move', () => {
    const ids = open();
    const oldSam = identityOf(ids, P2, 'sam', 'sam@old.com');
    const newSam = identityOf(ids, P1, 'sam', 'sam@new.com');
    const { code } = ids.startLink({
      projectKey: P1,
      handle: 'sam',
      rosterEmail: 'sam@new.com',
    });
    expect(
      ids.completeLink({
        code,
        projectKey: P2,
        handle: 'sam',
        rosterEmail: 'sam@new.com',
      })
    ).toEqual({ identity: newSam, previous: null });
    expect(ids.aliasesOf(oldSam)).toEqual([]);
    expect(identityOf(ids, P2, 'sam', 'sam@new.com')).toBe(newSam);
  });

  it('reports no previous identity when the alias was new or already linked', () => {
    const ids = open();
    const ada = identityOf(ids, P1, 'ada', 'ada@x.com');
    const link = () =>
      ids.startLink({ projectKey: P1, handle: 'ada', rosterEmail: 'ada@x.com' })
        .code;
    expect(
      ids.completeLink({
        code: link(),
        projectKey: P3,
        handle: 'ada',
        rosterEmail: 'ada@x.com',
      })
    ).toEqual({ identity: ada, previous: null });
    expect(
      ids.completeLink({
        code: link(),
        projectKey: P3,
        handle: 'ada',
        rosterEmail: 'ada@x.com',
      })
    ).toEqual({ identity: ada, previous: null });
    expect(ids.aliasesOf(ada)).toEqual([
      { projectKey: P1, handle: 'ada' },
      { projectKey: P3, handle: 'ada' },
    ]);
  });

  it('reopens an existing file with its bindings intact', () => {
    const ids = open();
    const ada = identityOf(ids, P1, 'ada', 'ada@x.com');
    ids.close();
    const again = new MemoryIdentities({
      path: join(dir, 'memory', 'identities.db'),
    });
    expect(identityOf(again, P1, 'ada', 'ada@x.com')).toBe(ada);
    again.close();
  });

  it("keeps an owner approval per project, at the agent's own token", () => {
    const ids = open();
    ids.recordOwnerApproval({
      projectKey: P1,
      agent: 'agent:test/a',
      tokenHash: 'h1',
      approvedBy: 'human:test',
    });
    expect(ids.ownerApproved(P1, 'agent:test/a', 'h1')).toBe(true);
    expect(ids.ownerApproved(P1, 'agent:test/a', 'h2')).toBe(false);
    expect(ids.ownerApproved(P2, 'agent:test/a', 'h1')).toBe(false);
    ids.dropOwnerApproval(P1, 'agent:test/a');
    expect(ids.ownerApproved(P1, 'agent:test/a', 'h1')).toBe(false);
    ids.close();
  });
});
