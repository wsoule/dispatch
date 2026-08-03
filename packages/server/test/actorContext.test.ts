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
