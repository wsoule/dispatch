import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGitSync } from '../../../orchestrator/helpers.js';
import { daemons } from '../helpers/daemon.js';
import type { TeammateDaemon } from '../helpers/daemon.js';

export interface Member {
  name: string;
  handle: TeammateDaemon;
  clock: { ms: number };
}

export interface Cluster {
  members: Member[];
  remote: string;
  /** Another daemon on the same remote, starting on the cluster's time. */
  add(name: string, opts?: { gitName?: string }): Promise<Member>;
  stop(): Promise<void>;
}

const BASE_MS = Date.parse('2026-09-26T10:00:00.000Z');

// Real daemons over one bare remote, each on an injectable clock. Everything
// lives in realpathSync temp dirs; nothing spawnSyncs the in-process server.
export async function cluster(
  names: string[],
  opts: {
    skewMs?: Record<string, number>;
    gitNames?: Record<string, string>;
    /** Extra .dispatch/config.yml lines per member. */
    config?: Record<string, string>;
    /** Members that start with board sync off (team start/join turn it on). */
    syncOff?: string[];
  } = {}
): Promise<Cluster> {
  const env = daemons();
  env.setup();
  const members: Member[] = [];
  const add = async (
    name: string,
    more: { gitName?: string } = {}
  ): Promise<Member> => {
    // A late joiner starts on the cluster's current time, not the base.
    const now =
      members.length === 0
        ? BASE_MS
        : Math.max(...members.map((m) => m.clock.ms));
    const clock = { ms: now + (opts.skewMs?.[name] ?? 0) };
    const gitName = more.gitName ?? opts.gitNames?.[name];
    const config = opts.config?.[name];
    const handle = await env.teammate(name, {
      federationNow: () => clock.ms,
      federationDebounceMs: 0,
      ...(gitName === undefined ? {} : { gitName }),
      ...(config === undefined ? {} : { config }),
      ...(opts.syncOff?.includes(name) === true ? { syncOff: true } : {}),
    });
    const member = { name, handle, clock };
    members.push(member);
    return member;
  };
  for (const name of names) await add(name);
  return { members, remote: env.remote(), add, stop: env.cleanup };
}

type Counts = { applied?: number; pending?: number };

// Passes on every member until two rounds in a row apply nothing anywhere
// and leave every outbox empty (spec "Converge").
export async function quiesce(
  members: Member[],
  maxRounds = 12,
  /** A wait between rounds that moved something, so a transport in its
   *  reconnect backoff (the relay's starts at a second) gets its turn. */
  pauseMs = 0
): Promise<void> {
  let quiet = 0;
  for (let round = 0; round < maxRounds && quiet < 2; round++) {
    if (round > 0 && quiet === 0 && pauseMs > 0) await Bun.sleep(pauseMs);
    let moved = 0;
    for (const m of members) {
      const before = (await m.handle.api('/api/board-sync')).body as Counts;
      const after = (await m.handle.sync()).body as Counts;
      moved +=
        (after.applied ?? 0) - (before.applied ?? 0) + (after.pending ?? 0);
    }
    quiet = moved === 0 ? quiet + 1 : 0;
  }
  if (quiet < 2) throw new Error(`no quiescence after ${maxRounds} rounds`);
}

/** Moves every member's clock on by `ms`. */
export function advance(members: Member[], ms: number): void {
  for (const m of members) m.clock.ms += ms;
}

// Clones the bare remote into a scratch dir, lets `edit` change files, and
// pushes: a teammate with push access editing the branch by hand.
export function editRemote(
  remote: string,
  edit: (dir: string) => void,
  opts: { force?: boolean; resetTo?: string } = {}
): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fed-edit-')));
  try {
    runGitSync(dir, ['clone', '-q', '-b', 'dispatch-sync', remote, '.']);
    if (opts.resetTo !== undefined)
      runGitSync(dir, ['reset', '-q', '--hard', opts.resetTo]);
    edit(dir);
    runGitSync(dir, ['add', '-A']);
    // --allow-empty: a force-push that only drops history has nothing to add.
    runGitSync(dir, [
      '-c',
      'user.name=mallory',
      '-c',
      'user.email=m@example.invalid',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'edit',
    ]);
    runGitSync(dir, [
      'push',
      '-q',
      ...(opts.force === true ? ['--force'] : []),
      'origin',
      'HEAD:dispatch-sync',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The member's federation problems, as `GET /api/team/keys` lists them. */
export async function problemsOf(
  m: Member
): Promise<{ subject: string; message: string }[]> {
  return (await m.handle.keys()).problems;
}

/** The member's fed_audit kinds, read-only. */
export function auditKindsOf(m: Member): string[] {
  return m.handle
    .stateDb<{ kind: string }>('SELECT kind FROM fed_audit ORDER BY id')
    .map((r) => r.kind);
}
