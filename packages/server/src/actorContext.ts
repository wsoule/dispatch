import {
  DISPATCH_DIR,
  formatActorRef,
  parseTeam,
  serializeTeam,
  TeamParseError,
  upsertMember,
} from '@dispatch/core';
import type { TeamMember } from '@dispatch/core';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Reads one git config value; returns null when git or the key is unavailable. */
export type GitReader = (args: string[]) => string | null;

const FALLBACK_EMAIL = 'local@localhost';
const FALLBACK_NAME = 'Local';

// Same `DISPATCH_HOME` override and fallback rule as daemonfile.ts's
// `daemonHome()` and orchestrator/paths.ts's `dispatchHome()`, so the known-
// handle file lands in the same redirected home the rest of the daemon's
// user-level state uses under the test suite's DISPATCH_HOME.
function defaultUserStateHome(): string {
  const home = process.env.DISPATCH_HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

// `~/.dispatch/actor/<hash of rootDir>.json`, keyed exactly like
// linear/state.ts's per-project state — user-level, never under the
// project's own `.dispatch/`, which is committed and shared with the team.
function knownHandlePath(rootDir: string, userStateHome: string): string {
  const key = createHash('sha256').update(rootDir).digest('hex').slice(0, 12);
  return join(userStateHome, '.dispatch', 'actor', `${key}.json`);
}

// A missing or corrupt file just means "no known handle yet" — resolve()
// falls back to registering fresh from git in that case.
function readKnownHandle(
  rootDir: string,
  userStateHome: string
): string | undefined {
  const path = knownHandlePath(rootDir, userStateHome);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as
      | { handle?: unknown }
      | undefined;
    return typeof parsed?.handle === 'string' ? parsed.handle : undefined;
  } catch {
    return undefined;
  }
}

function writeKnownHandle(
  rootDir: string,
  userStateHome: string,
  handle: string
): void {
  const path = knownHandlePath(rootDir, userStateHome);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ handle })}\n`);
}

/**
 * The identity this daemon acts as. Derived from git config and recorded in
 * `.dispatch/team.yml` on first sight, so joining a team needs no invite step.
 */
export class ActorContext {
  private constructor(
    readonly member: TeamMember,
    readonly humanRef: string,
    // False when `.dispatch/team.yml` held merge-conflict markers or other
    // malformed YAML — the caller should surface this rather than silently
    // acting on a made-up empty roster.
    readonly rosterReadable: boolean
  ) {}

  static resolve(
    rootDir: string,
    runGit: GitReader,
    userStateHome: string = defaultUserStateHome()
  ): ActorContext {
    const email = runGit(['config', 'user.email'])?.trim() ?? FALLBACK_EMAIL;
    const name = runGit(['config', 'user.name'])?.trim() ?? FALLBACK_NAME;
    const dir = join(rootDir, DISPATCH_DIR);
    const file = join(dir, 'team.yml');
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';

    // A conflicted team.yml must be reported, never treated as empty — doing
    // so would re-register the local member alone and wipe out every
    // teammate's entry on the next write.
    let existingMembers: TeamMember[] = [];
    let rosterReadable = true;
    try {
      existingMembers = parseTeam(existing);
    } catch (err) {
      if (!(err instanceof TeamParseError)) throw err;
      rosterReadable = false;
    }

    // The handle we registered under last time. It is the only thing that
    // survives a changed git email — the roster cannot infer identity itself.
    const knownHandle = readKnownHandle(rootDir, userStateHome);
    const result = upsertMember(existingMembers, email, name, knownHandle);
    if (rosterReadable && result.changed) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, serializeTeam(result.members));
    }
    writeKnownHandle(rootDir, userStateHome, result.member.handle);
    return new ActorContext(
      result.member,
      formatActorRef({
        kind: 'human',
        handle: result.member.handle,
        operator: null,
      }),
      rosterReadable
    );
  }

  /** The ref for an agent this developer operates, e.g. `agent:wyat/claude`. */
  agentRef(executorId: string): string {
    return formatActorRef({
      kind: 'agent',
      handle: executorId,
      operator: this.member.handle,
    });
  }
}
