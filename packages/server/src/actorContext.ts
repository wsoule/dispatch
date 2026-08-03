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

// Same override/fallback rule as daemonfile.ts's `daemonHome()` and
// orchestrator/paths.ts's `dispatchHome()` — no injectable param, just this.
function userStateHome(): string {
  const home = process.env.DISPATCH_HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

// `~/.dispatch/actor/<hash of rootDir>.json`, keyed exactly like linear/state.ts.
function knownHandlePath(rootDir: string): string {
  const key = createHash('sha256').update(rootDir).digest('hex').slice(0, 12);
  return join(userStateHome(), '.dispatch', 'actor', `${key}.json`);
}

// Missing or corrupt just means "no known handle yet" — resolve() then
// registers fresh from git.
function readKnownHandle(rootDir: string): string | undefined {
  const path = knownHandlePath(rootDir);
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

function writeKnownHandle(rootDir: string, handle: string): void {
  const path = knownHandlePath(rootDir);
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
    // False when `.dispatch/team.yml` was unparseable (e.g. merge
    // conflict markers) — the caller should surface the degraded state.
    readonly rosterReadable: boolean
  ) {}

  static resolve(rootDir: string, runGit: GitReader): ActorContext {
    const email = runGit(['config', 'user.email'])?.trim() ?? FALLBACK_EMAIL;
    const name = runGit(['config', 'user.name'])?.trim() ?? FALLBACK_NAME;
    const dir = join(rootDir, DISPATCH_DIR);
    const file = join(dir, 'team.yml');
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';

    // A conflicted roster must be reported, never treated as empty — that
    // would re-register the local member alone and wipe out the team.
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
    const knownHandle = readKnownHandle(rootDir);
    const result = upsertMember(existingMembers, email, name, knownHandle);
    if (rosterReadable && result.changed) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, serializeTeam(result.members));
    }
    writeKnownHandle(rootDir, result.member.handle);
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
