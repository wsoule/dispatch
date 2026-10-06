import { HANDLE } from '@dispatch-foo/federation';
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
const DEFAULT_RELAY_URL = 'wss://relay.dispatch.foo';

/** The relay `team start` registers at: DISPATCH_RELAY_URL, else the hosted one. */
export function defaultRelayUrl(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.DISPATCH_RELAY_URL?.trim();
  return set === undefined || set === '' ? DEFAULT_RELAY_URL : set;
}

const LINK_PREFIX = 'dispatch-team:';
/** A machine fingerprint: six groups of four Crockford characters. */
const FINGERPRINT = /^[0-9A-Z]{4}(?:-[0-9A-Z]{4}){5}$/;
const MAX_NAME_CHARS = 64;
const MAX_REMOTE_CHARS = 256;
const MAX_TEXT_CHARS = 300;
/** A sync branch a link may name: a plain ref name, never an option. */
const SYNC_BRANCH = /^(?!-)[A-Za-z0-9._/-]{1,100}$/;

// ANSI CSI and OSC sequences, whole, so no fragment of one reaches a terminal.
// Built from code points, so the source holds no raw escape characters.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ANSI = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?|${ESC}[@-Z\\\\-_]`,
  'g'
);
// Controls, format characters (bidi overrides, zero-widths) and line or
// paragraph separators: nothing that moves the cursor or reorders text.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Text from elsewhere (an invite link, a relay's answer, a peer's op) made
 * safe to print to a terminal, a status line or the desktop: escape
 * sequences and every control, format and separator character removed,
 * runs of space collapsed, and capped at `max` characters.
 */
export function plainText(value: string, max = MAX_TEXT_CHARS): string {
  const clean = value
    .replace(ANSI, '')
    .replace(UNPRINTABLE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= max) return clean;
  // Never cut a surrogate pair in half.
  return `${clean.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

/** A relay URL as it is shown and dialed: wss:// (ws:// only on this
 *  machine), no credentials, query or fragment, no trailing slash; null
 *  when it is not one. */
export function normalRelay(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'wss:' && !(parsed.protocol === 'ws:' && local))
    return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  parsed.search = '';
  parsed.hash = '';
  return parsed.href.replace(/\/+$/, '');
}
/** The web form of a link: the payload rides the fragment, never a request. */
const LINK_URL_BASE = 'https://dispatch.foo/join#';
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
  /** The sync branch on it; absent from links made before it was carried. */
  branch?: string;
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
    ...(link.branch === undefined ? {} : { branch: link.branch }),
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
  // Every field is checked against its grammar, or cleaned where it is free
  // text: the link is a stranger's input until its secret is proven.
  const team = str('team');
  const seed = fromCrockford(str('secret'));
  const expiresMs = Date.parse(str('expires'));
  const handle = str('handle');
  const by = str('by');
  const fp = str('fp');
  const name = plainText(str('name'), MAX_NAME_CHARS);
  if (
    !/^[0-9a-f]{32}$/.test(team) ||
    seed === null ||
    Number.isNaN(expiresMs) ||
    !HANDLE.test(handle) ||
    !HANDLE.test(by) ||
    !FINGERPRINT.test(fp) ||
    name === ''
  )
    throw new RosterError('invalid', DAMAGED);
  const via = fields.via as { kind?: unknown; url?: unknown } | undefined;
  let relay: string | null = null;
  if (via?.kind === 'relay') {
    relay = typeof via.url === 'string' ? normalRelay(via.url) : null;
    if (relay === null) throw new RosterError('invalid', DAMAGED);
  } else if (via?.kind !== 'git') throw new RosterError('invalid', DAMAGED);
  const remote = fields.remote;
  if (remote !== null && typeof remote !== 'string')
    throw new RosterError('invalid', DAMAGED);
  const cleanRemote =
    remote === null ? null : plainText(remote, MAX_REMOTE_CHARS);
  const branch = fields.branch;
  if (
    branch !== undefined &&
    (typeof branch !== 'string' || !SYNC_BRANCH.test(branch))
  )
    throw new RosterError('invalid', DAMAGED);
  return {
    team,
    name,
    by,
    fp,
    handle,
    seed,
    expires: new Date(expiresMs).toISOString(),
    via: relay === null ? { kind: 'git' } : { kind: 'relay', url: relay },
    remote: cleanRemote === '' ? null : cleanRemote,
    ...(branch === undefined ? {} : { branch }),
  };
}

// Whether two git remotes name one repository, read loosely: scheme, login,
// a trailing .git and scp-style colons do not matter. Null when either is
// not a remote the comparison can read.
export function sameRemote(a: string, b: string): boolean | null {
  const norm = (r: string): string =>
    r
      .trim()
      .toLowerCase()
      .replace(/^[a-z+]+:\/\//, '')
      .replace(/^[^@/]+@/, '')
      .replace(/:(?!\d)/, '/')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');
  if (a.trim() === '' || b.trim() === '') return null;
  return norm(a) === norm(b);
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
interface StatusProblem {
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
  /** The one founding this machine follows without having asked to join
   *  it (a provisional pin, nothing announced), or null. */
  followedOnly?: { name: string; fingerprint: string } | null;
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
const ACKNOWLEDGEABLE = [
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
      return plainText(health.url, 80);
    }
  }
  if (remote === null) return 'git';
  const tail = plainText(remote, MAX_REMOTE_CHARS)
    .replace(/\.git$/, '')
    .replace(/^.*[:/]([^:/]+\/[^:/]+)$/, '$1');
  return `git (${tail})`;
}

/** "4s ago", "3 min ago", "2 h ago", or the date. */
function ago(iso: string | null, now: Date): string | null {
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
      message: `Can't reach ${where}: ${plainText(input.lastError, 200)}. Changes made here wait and go out on the next sync.`,
      fix: 'dispatch sync now',
    });
  if (input.paused !== null)
    problems.push({
      message: plainText(input.paused),
      fix: 'dispatch license',
    });
  const me = view?.members.get(machine.replica);
  if (view === null || me === undefined) {
    if (input.foundings.length > 1)
      problems.push({
        message:
          'More than one team was started on this branch. Pick the one whose founder you know.',
        fix: `dispatch team advanced trust ${input.foundings[0]?.fingerprint ?? '<fingerprint>'}`,
      });
    const followed = input.followedOnly ?? null;
    if (input.joining === null && followed !== null)
      problems.push({
        message: `This branch has team '${plainText(followed.name, MAX_NAME_CHARS)}' on it, and this machine has not asked to join. Ask its founder for an invite link; only if you know this team, follow it as it is.`,
        fix: `dispatch team advanced trust ${followed.fingerprint}`,
      });
    problems.push(...plainProblems(input.problems, false));
    if (input.joining !== null) {
      const name = plainText(
        input.joining.name ?? view?.name ?? 'the team',
        MAX_NAME_CHARS
      );
      const by = plainText(input.joining.by ?? 'whoever invited you', 64);
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
      device: plainText(pins.get(m.replica)?.device ?? '', 64),
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
        message: `${w.handle} on ${plainText(w.device, 64)} asked to join without an invite.${isAdmin ? ' Let them in only if you know this machine.' : ''}`,
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
  const name = plainText(view.name, MAX_NAME_CHARS);
  const parts = [
    `Team '${name}'`,
    `${seats.used} of ${seats.total} seats`,
    `syncing via ${where}`,
    synced === null ? 'not synced yet' : `last sync ${synced}`,
  ];
  return {
    state: 'member',
    line: parts.join(' · '),
    team: { id: view.teamId, name },
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
        message: plainText(p.message),
        fix: isAdmin ? 'dispatch team advanced keys' : null,
      };
    if (ACKNOWLEDGEABLE.some((a) => p.subject.startsWith(a)))
      return {
        message: plainText(p.message),
        fix: `dispatch team advanced ack ${plainText(p.subject, 120)}`,
      };
    return {
      message: plainText(p.message),
      fix: 'dispatch team advanced keys',
    };
  });
}
