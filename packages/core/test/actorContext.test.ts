import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ActorContext } from '../src/actorContext.js';
import { parseTeam } from '../src/team.js';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-actor-'));
  mkdirSync(join(root, '.dispatch'), { recursive: true });
  return root;
}

const gitOk = (args: string[]) =>
  args.includes('user.email') ? 'w@example.com' : 'Wyat Soule';

// Same DISPATCH_HOME redirection pattern as daemonfile.test.ts, so the
// known-handle file never lands in the real ~/.dispatch.
let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-actor-home-'));
  process.env.DISPATCH_HOME = fakeHome;
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('ActorContext.resolve', () => {
  it('registers an unknown developer and writes the roster', () => {
    const root = fixture();
    const ctx = ActorContext.resolve(root, gitOk);
    expect(ctx.humanRef).toBe('human:w');
    expect(readFileSync(join(root, '.dispatch', 'team.yml'), 'utf8')).toContain(
      'w@example.com'
    );
  });

  it('does not rewrite the roster when nothing changed', () => {
    const root = fixture();
    ActorContext.resolve(root, gitOk);
    const before = readFileSync(join(root, '.dispatch', 'team.yml'), 'utf8');
    ActorContext.resolve(root, gitOk);
    expect(readFileSync(join(root, '.dispatch', 'team.yml'), 'utf8')).toBe(
      before
    );
  });

  it('builds an operator-scoped agent ref', () => {
    const ctx = ActorContext.resolve(fixture(), gitOk);
    expect(ctx.agentRef('claude')).toBe('agent:w/claude');
  });

  it('falls back to a local identity when git has no user configured', () => {
    const root = fixture();
    const ctx = ActorContext.resolve(root, () => null);
    expect(ctx.humanRef).toBe('human:local');
    expect(ctx.member.email).toBe('local@localhost');
  });

  it('falls back when git returns an empty email', () => {
    const ctx = ActorContext.resolve(fixture(), (args) =>
      args.includes('user.email') ? '' : 'Wyat Soule'
    );
    expect(ctx.humanRef).toBe('human:local');
    expect(ctx.member.email).toBe('local@localhost');
  });

  it('falls back when git returns whitespace', () => {
    const ctx = ActorContext.resolve(fixture(), () => '   ');
    expect(ctx.humanRef).toBe('human:local');
    expect(ctx.member.displayName).toBe('Local');
  });

  it('keeps an existing member rather than adding a duplicate', () => {
    const root = fixture();
    writeFileSync(
      join(root, '.dispatch', 'team.yml'),
      'members:\n  - handle: w\n    email: w@example.com\n    displayName: Wyat Soule\n    emails: []\n'
    );
    const ctx = ActorContext.resolve(root, gitOk);
    expect(ctx.member.handle).toBe('w');
  });

  it('remembers its handle across a changed git email', () => {
    const root = fixture();
    const first = ActorContext.resolve(root, gitOk);
    expect(first.member.handle).toBe('w');

    const gitNewEmail = (args: string[]) =>
      args.includes('user.email') ? 'wyat@newcorp.com' : 'Wyat Soule';
    const second = ActorContext.resolve(root, gitNewEmail);
    // Same handle, updated email — the known-handle file is what makes this
    // an update rather than a second member.
    expect(second.member.handle).toBe('w');
    expect(second.member.email).toBe('wyat@newcorp.com');
  });

  it('registers as a new member when no known-handle file exists', () => {
    const root = fixture();
    // A fresh rootDir has no known-handle file yet, so this must derive
    // fresh from git rather than finding a stale record.
    const ctx = ActorContext.resolve(root, gitOk);
    expect(ctx.member.handle).toBe('w');
  });

  // Regression for the two compounding defects: (a) resolve() used to write
  // a known-handle file even when the roster it derived from was unreadable
  // (empty), and (b) upsertMember let a knownHandle match short-circuit
  // ahead of the email lookup even when that match belonged to someone
  // else. Together they let a corrupted known-handle file permanently
  // merge two people's roster entries. This three-boot sequence reproduces
  // it end to end and asserts the roster never merges.
  it('does not let a corrupted known-handle file merge two roster entries', () => {
    const root = fixture();
    const rosterWithOther =
      'members:\n  - handle: w\n    email: other@example.com\n    displayName: Other Person\n    emails: []\n';
    writeFileSync(join(root, '.dispatch', 'team.yml'), rosterWithOther);

    // Boot 1: Wyat's own git email also has local part "w" — collides with
    // Other Person's handle, so Wyat is registered as "w2".
    const gitWyat = (args: string[]) =>
      args.includes('user.email') ? 'w@wyatcorp.com' : 'Wyat Soule';
    const boot1 = ActorContext.resolve(root, gitWyat);
    expect(boot1.member.handle).toBe('w2');

    // Boot 2: team.yml develops a merge conflict before the next boot.
    const conflicted =
      'members:\n<<<<<<< HEAD\n  - handle: w\n=======\n  - handle: wyat\n>>>>>>> branch\n';
    writeFileSync(join(root, '.dispatch', 'team.yml'), conflicted);
    const boot2 = ActorContext.resolve(root, gitWyat);
    expect(boot2.rosterReadable).toBe(false);

    // The user repairs the conflict — team.yml restored with both members
    // intact, exactly as before the conflict.
    const rosterRepaired =
      'members:\n' +
      '  - handle: w\n    email: other@example.com\n    displayName: Other Person\n    emails: []\n' +
      '  - handle: w2\n    email: w@wyatcorp.com\n    displayName: Wyat Soule\n    emails: []\n';
    writeFileSync(join(root, '.dispatch', 'team.yml'), rosterRepaired);

    // Boot 3 must resolve back to Wyat's own entry, not take over Other
    // Person's.
    const boot3 = ActorContext.resolve(root, gitWyat);
    expect(boot3.member.handle).toBe('w2');
    expect(boot3.member.email).toBe('w@wyatcorp.com');

    const finalRoster = parseTeam(
      readFileSync(join(root, '.dispatch', 'team.yml'), 'utf8')
    );
    expect(finalRoster).toHaveLength(2);
    expect(finalRoster.find((m) => m.handle === 'w')?.email).toBe(
      'other@example.com'
    );
    expect(finalRoster.find((m) => m.handle === 'w2')?.email).toBe(
      'w@wyatcorp.com'
    );
  });

  // Isolates fix (a) from fix (b): here the very first boot a new developer
  // ever makes hits a conflicted team.yml, before any known-handle file
  // exists — so upsertMember's byEmail lookup is undefined not because a
  // legitimate email change is in progress, but because the roster it saw
  // was empty. Fix (b) alone cannot tell those two cases apart (both leave
  // byEmail undefined); only guarding the write in resolve() (fix a) keeps
  // this boot's guess out of the known-handle file at all.
  it('does not let a first boot against a conflicted roster poison the known-handle file', () => {
    const root = fixture();
    const rosterWithOther =
      'members:\n  - handle: w\n    email: other@example.com\n    displayName: Other Person\n    emails: []\n';
    const conflicted =
      'members:\n<<<<<<< HEAD\n  - handle: w\n=======\n  - handle: wyat\n>>>>>>> branch\n';
    // The roster is already conflicted before Wyat's daemon ever boots.
    writeFileSync(join(root, '.dispatch', 'team.yml'), conflicted);

    const gitWyat = (args: string[]) =>
      args.includes('user.email') ? 'w@wyatcorp.com' : 'Wyat Soule';
    const boot1 = ActorContext.resolve(root, gitWyat);
    expect(boot1.rosterReadable).toBe(false);

    // The conflict resolves to a roster that already has Other Person under
    // handle "w" — the same handle boot1 would have (wrongly) derived from
    // an empty roster, had it been allowed to persist that guess.
    writeFileSync(join(root, '.dispatch', 'team.yml'), rosterWithOther);
    const boot2 = ActorContext.resolve(root, gitWyat);

    expect(boot2.member.handle).not.toBe('w');
    expect(boot2.member.email).toBe('w@wyatcorp.com');
    const roster = parseTeam(
      readFileSync(join(root, '.dispatch', 'team.yml'), 'utf8')
    );
    expect(roster.find((m) => m.handle === 'w')?.email).toBe(
      'other@example.com'
    );
  });

  it('stands down without writing when the roster is conflicted', () => {
    const root = fixture();
    const conflicted =
      'members:\n<<<<<<< HEAD\n  - handle: w\n=======\n  - handle: wyat\n>>>>>>> branch\n';
    writeFileSync(join(root, '.dispatch', 'team.yml'), conflicted);

    const ctx = ActorContext.resolve(root, gitOk);

    expect(ctx.rosterReadable).toBe(false);
    expect(ctx.humanRef).toBe('human:w');
    expect(readFileSync(join(root, '.dispatch', 'team.yml'), 'utf8')).toBe(
      conflicted
    );
  });
});
