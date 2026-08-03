import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ActorContext } from '../src/actorContext.js';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-actor-'));
  mkdirSync(join(root, '.dispatch'), { recursive: true });
  return root;
}

// A fresh temp dir per call, standing in for `~/.dispatch` so no test ever
// touches the developer's real home directory.
function userHome(): string {
  return mkdtempSync(join(tmpdir(), 'dispatch-actor-home-'));
}

const gitOk = (args: string[]) =>
  args.includes('user.email') ? 'w@example.com' : 'Wyat Soule';

describe('ActorContext.resolve', () => {
  it('registers an unknown developer and writes the roster', () => {
    const root = fixture();
    const ctx = ActorContext.resolve(root, gitOk, userHome());
    expect(ctx.humanRef).toBe('human:w');
    expect(readFileSync(join(root, '.dispatch', 'team.yml'), 'utf8')).toContain(
      'w@example.com'
    );
  });

  it('does not rewrite the roster when nothing changed', () => {
    const root = fixture();
    const home = userHome();
    ActorContext.resolve(root, gitOk, home);
    const before = readFileSync(join(root, '.dispatch', 'team.yml'), 'utf8');
    ActorContext.resolve(root, gitOk, home);
    expect(readFileSync(join(root, '.dispatch', 'team.yml'), 'utf8')).toBe(
      before
    );
  });

  it('builds an operator-scoped agent ref', () => {
    const ctx = ActorContext.resolve(fixture(), gitOk, userHome());
    expect(ctx.agentRef('claude')).toBe('agent:w/claude');
  });

  it('falls back to a local identity when git has no user configured', () => {
    const root = fixture();
    const ctx = ActorContext.resolve(root, () => null, userHome());
    expect(ctx.humanRef).toBe('human:local');
    expect(ctx.member.email).toBe('local@localhost');
  });

  it('keeps an existing member rather than adding a duplicate', () => {
    const root = fixture();
    writeFileSync(
      join(root, '.dispatch', 'team.yml'),
      'members:\n  - handle: w\n    email: w@example.com\n    displayName: Wyat Soule\n    emails: []\n'
    );
    const ctx = ActorContext.resolve(root, gitOk, userHome());
    expect(ctx.member.handle).toBe('w');
  });

  it('remembers its handle across a changed git email', () => {
    const root = fixture();
    const home = userHome();
    const first = ActorContext.resolve(root, gitOk, home);
    expect(first.member.handle).toBe('w');

    const gitNewEmail = (args: string[]) =>
      args.includes('user.email') ? 'wyat@newcorp.com' : 'Wyat Soule';
    const second = ActorContext.resolve(root, gitNewEmail, home);
    // Same handle, updated email — the known-handle file is what makes this
    // an update rather than a second member.
    expect(second.member.handle).toBe('w');
    expect(second.member.email).toBe('wyat@newcorp.com');
  });

  it('registers as a new member when no known-handle file exists', () => {
    const root = fixture();
    // Two different rootDirs never share a known-handle file, so the second
    // resolve here has nothing recorded and must derive fresh from git.
    const ctx = ActorContext.resolve(root, gitOk, userHome());
    expect(ctx.member.handle).toBe('w');
  });

  it('stands down without writing when the roster is conflicted', () => {
    const root = fixture();
    const conflicted =
      'members:\n<<<<<<< HEAD\n  - handle: w\n=======\n  - handle: wyat\n>>>>>>> branch\n';
    writeFileSync(join(root, '.dispatch', 'team.yml'), conflicted);

    const ctx = ActorContext.resolve(root, gitOk, userHome());

    expect(ctx.rosterReadable).toBe(false);
    expect(ctx.humanRef).toBe('human:w');
    expect(readFileSync(join(root, '.dispatch', 'team.yml'), 'utf8')).toBe(
      conflicted
    );
  });
});
