import { printable } from '@dispatch-foo/federation';
import type { PinnedKey, RosterView } from '@dispatch-foo/federation';
import {
  b64u,
  canonicalize,
  crockford32,
  fromB64u,
  sha256Hex,
} from '@dispatch-foo/protocol/federation';

import { RosterError } from './errors.js';
import type { TransportHealth } from './transport.js';

// Team setup in two actions a person (spec: team-easy): one link carries
// everything a joiner needs, and one status line says how the team is doing.

/** The hosted relay a new team syncs through unless told otherwise. */
export const DEFAULT_RELAY_URL = 'wss://relay.dispatch.foo';

/** The relay `team start` registers at: DISPATCH_RELAY_URL, else the hosted one. */
export function defaultRelayUrl(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.DISPATCH_RELAY_URL?.trim();
  return set === undefined || set === '' ? DEFAULT_RELAY_URL : set;
}

const LINK_PREFIX = 'dispatch-team:';
/** The web form of a link: the payload rides the fragment, never a request. */
export const LINK_URL_BASE = 'https://dispatch.foo/join#';
const SEED_BYTES = 32;
const SUM_CHARS = 16;

/** Where a team's machines exchange their logs. */
export type TeamVia = { kind: 'relay'; url: string } | { kind: 'git' };

/** Everything `dispatch team join` needs, in one string. */
export interface TeamLink {
  /** The team id: the first 32 hex characters of its found op's hash. */
  team: string;
  name: string;
  /** Who invited, and their machine's fingerprint for the optional check. */
  by: string;
  fp: string;
  /** The handle the invite is for; the joiner's must match. */
  handle: string;
  /** The invite key's seed: the one-time secret whose signature admits. */
  seed: Buffer;
  expires: string;
  via: TeamVia;
  /** The git remote the sync branch rides, without credentials, or null. */
  remote: string | null;
}

// The link's fields as they go on the wire, in JCS order, without the sum.
function wireFields(link: TeamLink): Record<string, unknown> {
  return {
    v: 1,
    team: link.team,
    name: link.name,
    by: link.by,
    fp: link.fp,
    handle: link.handle,
    secret: crockford32(link.seed),
    expires: link.expires,
    via: link.via,
    remote: link.remote,
  };
}

/** `dispatch-team:<base64url(JCS)>`, with a checksum that catches a link
 *  damaged in copying. */
export function encodeTeamLink(link: TeamLink): string {
  const fields = wireFields(link);
  const sum = sha256Hex(canonicalize(fields)).slice(0, SUM_CHARS);
  return `${LINK_PREFIX}${b64u(Buffer.from(canonicalize({ ...fields, sum }), 'utf8'))}`;
}

/** The same link as a URL, for a chat client that only makes URLs clickable. */
export function teamLinkUrl(link: string): string {
  return `${LINK_URL_BASE}${link.slice(LINK_PREFIX.length)}`;
}

const DAMAGED = 'This invite link is damaged; copy the whole link again.';

/** A link in either form, or throws RosterError('invalid') in plain words. */
export function decodeTeamLink(text: string): TeamLink {
  const trimmed = text.trim();
  let payload: string;
  if (trimmed.startsWith(LINK_PREFIX))
    payload = trimmed.slice(LINK_PREFIX.length);
  else if (trimmed.startsWith(LINK_URL_BASE))
    payload = trimmed.slice(LINK_URL_BASE.length);
  else
    throw new RosterError(
      'invalid',
      'That is not a Dispatch team invite link; it starts with "dispatch-team:".'
    );
  let raw: unknown;
  try {
    raw = JSON.parse(fromB64u(payload).toString('utf8'));
  } catch {
    throw new RosterError('invalid', DAMAGED);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new RosterError('invalid', DAMAGED);
  const { sum, ...fields } = raw as Record<string, unknown>;
  if (
    typeof sum !== 'string' ||
    sha256Hex(canonicalize(fields)).slice(0, SUM_CHARS) !== sum
  )
    throw new RosterError('invalid', DAMAGED);
  if (fields.v !== 1)
    throw new RosterError(
      'invalid',
      'This invite link is from a newer Dispatch; update Dispatch to join.'
    );
  const str = (key: string): string => {
    const v = fields[key];
    if (typeof v !== 'string') throw new RosterError('invalid', DAMAGED);
    return v;
  };
  const team = str('team');
  const seed = fromCrockford(str('secret'));
  const expires = str('expires');
  if (
    !/^[0-9a-f]{32}$/.test(team) ||
    seed === null ||
    Number.isNaN(Date.parse(expires))
  )
    throw new RosterError('invalid', DAMAGED);
  const via = fields.via as { kind?: unknown; url?: unknown } | undefined;
  const remote = fields.remote;
  return {
    team,
    name: printable(str('name'), 128),
    by: printable(str('by'), 64),
    fp: printable(str('fp'), 64),
    handle: str('handle'),
    seed,
    expires,
    via:
      via?.kind === 'relay' && typeof via.url === 'string'
        ? { kind: 'relay', url: via.url }
        : { kind: 'git' },
    remote: typeof remote === 'string' ? remote : null,
  };
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// The 32-byte seed crockford32 wrote, or null.
function fromCrockford(text: string): Buffer | null {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) return null;
    buffer = ((buffer << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const seed = Buffer.from(out);
  if (seed.length !== SEED_BYTES || crockford32(seed) !== text) return null;
  return seed;
}

/**
 * The optional check both machines can read aloud, like a pairing code: six
 * digits from the team and the two fingerprints, the same on either side.
 * Matching it confirms nobody swapped a key; skipping it is safe enough for
 * most teams, since the invite secret is what admits.
 */
export function checkString(teamId: string, a: string, b: string): string {
  const [x, y] = [a, b].sort();
  const digest = sha256Hex(`dispatch-team-check-v1\n${teamId}\n${x}\n${y}`);
  const n = Number.parseInt(digest.slice(0, 8), 16) % 1_000_000;
  const digits = String(n).padStart(6, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

// ---- status ----

/** A problem in plain words, with the one command that fixes it, if any. */
export interface StatusProblem {
  message: string;
  fix: string | null;
}

/** What `GET /api/team/status` answers and `dispatch team status` prints. */
export interface TeamStatus {
  state: 'off' | 'none' | 'joining' | 'member';
  /** One line: "Team 'acme' · 3 of 3 seats · syncing via relay.dispatch.foo · last sync 4s ago". */
  line: string;
  team: { id: string; name: string } | null;
  role: 'admin' | 'member' | 'observer' | null;
  seats: { used: number; total: number } | null;
  sync: {
    kind: 'git' | 'relay';
    where: string | null;
    lastSyncAt: string | null;
  } | null;
  /** Everyone on the team, with the check this machine shares with each. */
  teammates: {
    handle: string;
    device: string;
    role: 'admin' | 'member' | 'observer';
    you: boolean;
    check: string | null;
  }[];
  /** While joining: the check to compare with whoever invited this machine. */
  check: string | null;
  problems: StatusProblem[];
}

export interface TeamStatusInput {
  machine: { replica: string; handle: string; fingerprint: string };
  view: RosterView | null;
  pins: PinnedKey[];
  /** The invite this machine joined with, while it waits to be let in. */
  joining: {
    teamId: string;
    name: string | null;
    by: string | null;
    fp: string | null;
  } | null;
  /** Foundings seen on the branch while none is followed. */
  foundings: { replica: string; fingerprint: string }[];
  waiting: {
    replica: string;
    handle: string;
    device: string;
    fingerprint: string;
    invitedBy: string | null;
  }[];
  health: TransportHealth;
  lastSyncAt: string | null;
  lastError: string | null;
  paused: string | null;
  problems: { subject: string; message: string }[];
  olderBuilds: string[];
  now: Date;
}

// Notes `dispatch team advanced ack` takes; mirrors routes.ts's list.
const ACKABLE = [
  'team:race:',
  'team:cut:',
  'transport:merge',
  'team:route',
  'observer:',
  'transport:read:',
  'transport:bloat:',
  'transport:rewrite:',
  'message:',
  'run-conflict:',
  'agent:',
  'channel:',
  'malformed:',
  'mail-drop:',
  'link-op:',
  'mail-out:',
  'run-moved:',
  'invite:',
];

/** Where a transport syncs, short: the relay's host, or the remote's tail. */
export function whereOf(
  health: TransportHealth,
  remote: string | null
): string {
  if (health.kind === 'relay' && health.url !== undefined) {
    try {
      return new URL(health.url).host;
    } catch {
      return health.url;
    }
  }
  if (remote === null) return 'git';
  const tail = remote
    .replace(/\.git$/, '')
    .replace(/^.*[:/]([^:/]+\/[^:/]+)$/, '$1');
  return `git (${tail})`;
}

/** "4s ago", "3 min ago", "2 h ago", or the date. */
export function ago(iso: string | null, now: Date): string | null {
  if (iso === null) return null;
  const ms = Math.max(0, now.getTime() - Date.parse(iso));
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return iso.slice(0, 10);
}

/** The team in one line and plain-worded problems, each with its fix. */
export function teamStatus(
  input: TeamStatusInput,
  remote: string | null
): TeamStatus {
  const { view, machine, now } = input;
  const where = whereOf(input.health, remote);
  const sync = {
    kind: input.health.kind,
    where,
    lastSyncAt: input.lastSyncAt,
  };
  const synced = ago(input.lastSyncAt, now);
  const problems: StatusProblem[] = [];
  if (input.lastError !== null)
    problems.push({
      message: `Can't reach ${where}: ${input.lastError.slice(0, 200)}. Changes made here wait and go out on the next sync.`,
      fix: 'dispatch sync now',
    });
  if (input.paused !== null)
    problems.push({ message: input.paused, fix: 'dispatch license' });
  const me = view?.members.get(machine.replica);
  if (view === null || me === undefined) {
    if (input.foundings.length > 1)
      problems.push({
        message:
          'More than one team was started on this branch. Pick the one whose founder you know.',
        fix: `dispatch team advanced trust ${input.foundings[0]?.fingerprint ?? '<fingerprint>'}`,
      });
    problems.push(...plainProblems(input.problems, false));
    if (input.joining !== null) {
      const name = input.joining.name ?? view?.name ?? 'the team';
      const by = input.joining.by ?? 'whoever invited you';
      return {
        state: 'joining',
        line: `Joining team '${name}' · waiting for ${by}'s Dispatch to let this machine in${synced === null ? '' : ` · last sync ${synced}`}`,
        team: { id: input.joining.teamId, name },
        role: null,
        seats: null,
        sync,
        teammates: [],
        check:
          input.joining.fp === null
            ? null
            : checkString(
                input.joining.teamId,
                input.joining.fp,
                machine.fingerprint
              ),
        problems,
      };
    }
    return {
      state: 'none',
      line: 'Not in a team yet · start one, or join with an invite link',
      team: null,
      role: null,
      seats: null,
      sync,
      teammates: [],
      check: null,
      problems,
    };
  }
  const pins = new Map(input.pins.map((p) => [p.replica, p]));
  const teammates = [...view.members.values()].map((m) => {
    const fp = pins.get(m.replica)?.fingerprint ?? null;
    const you = m.replica === machine.replica;
    return {
      handle: m.handle,
      device: printable(pins.get(m.replica)?.device ?? ''),
      role: m.observer ? ('observer' as const) : m.role,
      you,
      check:
        you || fp === null
          ? null
          : checkString(view.teamId, machine.fingerprint, fp),
    };
  });
  const isAdmin = me.role === 'admin';
  if (view.unknown != null)
    problems.push({
      message:
        "A teammate's newer Dispatch changed the team in a way this version can't read, so syncing here is paused. Update Dispatch on this machine.",
      fix: isAdmin
        ? `dispatch team advanced dismiss ${view.unknown.replica} ${view.unknown.seq} ${view.unknown.hash}`
        : null,
    });
  for (const w of input.waiting)
    if (w.invitedBy === null)
      problems.push({
        message: `${w.handle} on ${printable(w.device)} asked to join without an invite.${isAdmin ? ' Let them in only if you know this machine.' : ''}`,
        fix: isAdmin
          ? `dispatch team advanced admit ${w.replica} --fingerprint ${w.fingerprint}`
          : null,
      });
  if (view.legacy.closed === null && input.olderBuilds.length > 0)
    problems.push({
      message: `Older Dispatch builds still sync this board (${input.olderBuilds.join(', ')}). Once they update, stop syncing with older builds.`,
      fix: isAdmin ? 'dispatch team advanced close-legacy' : null,
    });
  problems.push(...plainProblems(input.problems, isAdmin));
  const seats = { used: view.people.length, total: view.seats };
  const parts = [
    `Team '${view.name}'`,
    `${seats.used} of ${seats.total} seats`,
    `syncing via ${where}`,
    synced === null ? 'not synced yet' : `last sync ${synced}`,
  ];
  return {
    state: 'member',
    line: parts.join(' · '),
    team: { id: view.teamId, name: view.name },
    role: me.observer ? 'observer' : me.role,
    seats,
    sync,
    teammates,
    check: null,
    problems,
  };
}

// The daemon's problem notes in plainer words, each with the command that
// clears it: an ack for a one-off note, the details view otherwise.
function plainProblems(
  notes: { subject: string; message: string }[],
  isAdmin: boolean
): StatusProblem[] {
  return notes.map((p) => {
    if (p.subject.startsWith('op:'))
      return {
        message: p.message,
        fix: isAdmin ? 'dispatch team advanced keys' : null,
      };
    if (ACKABLE.some((a) => p.subject.startsWith(a)))
      return {
        message: p.message,
        fix: `dispatch team advanced ack ${p.subject}`,
      };
    return { message: p.message, fix: 'dispatch team advanced keys' };
  });
}
