import { printable } from '@dispatch/federation';
import type { PinnedKey, RosterView } from '@dispatch/federation';
import { hlcWallMs } from '@dispatch/protocol/federation';

import type { TransportHealth } from './transport.js';

/** An admitted replica silent this long blocks pruning (F-D39). */
export const PRUNE_BLOCKED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Past this, the sync branch is worth moving (spec "Git"). */
export const BRANCH_SIZE_WARN_BYTES = 1024 * 1024 * 1024;
// A clock this far from this machine's gets a warning.
const SKEW_WARN_MS = 60 * 1000;

/** What the relay can read, shown before any switch to it (F-D31). */
const RELAY_DISCLOSURE =
  'The relay can read everything that is not sealed: the board, team memory and team docs, the roster with the team’s license key, presence, and who messaged whom and when. It cannot read message contents.';

/** What `GET /api/team/keys` answers, at the decide tier. */
export interface TeamKeys {
  machine: {
    replica: string;
    handle: string;
    device: string;
    fingerprint: string;
  };
  team: {
    id: string;
    name: string;
    founder: { replica: string; handle: string; fingerprint: string };
  } | null;
  /** Two or more, awaiting trust. */
  foundings: { replica: string; fingerprint: string }[];
  roster: {
    replica: string;
    handle: string;
    device: string;
    build: string;
    role: 'member' | 'admin';
    rank: number | null;
    hosts: string[];
    observer: boolean;
    recovered: boolean;
    fingerprint: string;
    lastSeen: string | null;
    skewMs: number | null;
  }[];
  waiting: {
    replica: string;
    handle: string;
    device: string;
    fingerprint: string;
    invitedBy: string | null;
  }[];
  invites: { handle: string; expires: string; by: string }[];
  legacy: { until: string | null; closed: boolean; olderBuilds: string[] };
  /** The health object (F-D29); branch size is transport.sizeBytes. */
  transport: TransportHealth;
  license: {
    seats: number;
    org: string | null;
    sharedBy: string | null;
  } | null;
  pruningBlockers: {
    replica: string;
    handle: string;
    lastAck: string | null;
  }[];
  originWarning: string | null;
  relayDisclosure: string;
  warnings: string[];
  problems: { subject: string; message: string; at: string }[];
}

export interface TeamKeysInput {
  machine: TeamKeys['machine'];
  view: RosterView | null;
  foundings: TeamKeys['foundings'];
  pins: PinnedKey[];
  replicas: { replica: string; lastHlc: string; skewMs: number }[];
  health: TransportHealth;
  problems: TeamKeys['problems'];
  /** The code remote the branch rides, when sync.repo is unset; else null. */
  remote: string | null;
  now: Date;
}

// Everything Settings → Team and `dispatch team keys` show, assembled from the
// fold, the pins and the transport's health; pure, so each rule is testable.
export function assembleTeamKeys(input: TeamKeysInput): TeamKeys {
  const { view, now, health } = input;
  const pins = new Map(input.pins.map((p) => [p.replica, p]));
  const seen = new Map(input.replicas.map((r) => [r.replica, r]));
  const handleOf = (replica: string): string =>
    view?.members.get(replica)?.handle ?? pins.get(replica)?.handle ?? replica;
  const roster: TeamKeys['roster'] = [...(view?.members.values() ?? [])].map(
    (m) => {
      const pin = pins.get(m.replica);
      const last = seen.get(m.replica);
      const wall = last === undefined ? null : hlcWallMs(last.lastHlc);
      return {
        replica: m.replica,
        handle: m.handle,
        // Clean at claim time; printed through printable all the same (M1).
        device: printable(pin?.device ?? ''),
        build: printable(pin?.build ?? ''),
        role: m.role,
        rank: m.rank,
        hosts: [...m.hosts],
        observer: m.observer,
        recovered: m.recovered,
        fingerprint: pin?.fingerprint ?? '',
        lastSeen: wall === null ? null : new Date(wall).toISOString(),
        skewMs: last?.skewMs ?? null,
      };
    }
  );
  const waiting: TeamKeys['waiting'] = (view?.pending ?? []).flatMap((r) => {
    const pin = pins.get(r);
    if (pin === undefined) return [];
    return [
      {
        replica: r,
        handle: pin.handle,
        device: printable(pin.device),
        fingerprint: pin.fingerprint,
        invitedBy: view?.invitedBy.get(r) ?? null,
      },
    ];
  });
  const invites: TeamKeys['invites'] = [...(view?.invites.values() ?? [])]
    .filter((i) => Date.parse(i.expires) > now.getTime())
    .map((i) => ({ handle: i.handle, expires: i.expires, by: handleOf(i.by) }));
  const founder = view === null ? null : pins.get(view.founder);
  const license =
    view === null
      ? null
      : {
          seats: view.seats,
          org: 'license' in view.license ? view.license.license.org : null,
          sharedBy: view.licenseBy === null ? null : handleOf(view.licenseBy),
        };
  return {
    machine: input.machine,
    team:
      view === null
        ? null
        : {
            id: view.teamId,
            name: view.name,
            founder: {
              replica: view.founder,
              handle: handleOf(view.founder),
              fingerprint: founder?.fingerprint ?? '',
            },
          },
    foundings: input.foundings,
    roster,
    waiting,
    invites,
    legacy: {
      until:
        view === null ? null : new Date(view.legacy.deadlineMs).toISOString(),
      closed: view?.legacy.closed !== null && view !== null,
      olderBuilds: (view?.legacy.attested ?? [])
        .map((a) => a.replica)
        .filter((r) => !pins.has(r)),
    },
    transport: { ...health, lastError: redactNullable(health.lastError) },
    license,
    pruningBlockers: pruningBlockers(input, roster, handleOf),
    originWarning:
      input.remote === null
        ? null
        : originWarning(withoutCredentials(input.remote)),
    relayDisclosure: RELAY_DISCLOSURE,
    warnings: warnings(input, roster),
    problems: input.problems,
  };
}

// Admitted replicas silent past PRUNE_BLOCKED_AFTER_MS keep every sealed op
// on the branch; none on the relay, whose own retention caps it.
function pruningBlockers(
  input: TeamKeysInput,
  roster: TeamKeys['roster'],
  handleOf: (replica: string) => string
): TeamKeys['pruningBlockers'] {
  if (input.health.kind === 'relay') return [];
  const cutoff = input.now.getTime() - PRUNE_BLOCKED_AFTER_MS;
  return roster
    .filter((m) => m.replica !== input.machine.replica)
    .flatMap((m) => {
      const lastAck = input.health.acks[m.replica] ?? null;
      const since =
        lastAck === null
          ? (hlcWallMs(input.view?.members.get(m.replica)?.since.hlc ?? '') ??
            0)
          : Date.parse(lastAck);
      return since < cutoff
        ? [{ replica: m.replica, handle: handleOf(m.replica), lastAck }]
        : [];
    });
}

function originWarning(remote: string): string {
  return `Everyone with access to ${remote} can read the whole board, team memory and team docs, the team's license key, which machines are on the team, which runs are live and whom they are waiting on, and who messaged whom and when. Message contents are sealed. Set \`sync.repo\` to a private repository to keep that private. A key stolen later decrypts this machine's past messages from any copy of the branch.`;
}

function warnings(input: TeamKeysInput, roster: TeamKeys['roster']): string[] {
  const out: string[] = [];
  if (input.view !== null) {
    const admins = [
      ...new Set(roster.filter((m) => m.role === 'admin').map((m) => m.handle)),
    ];
    if (admins.length < 2)
      out.push(
        `Only ${admins[0] ?? 'nobody'} can admit, revoke or change the team. Make a second person an admin, or keep the recovery code safe.`
      );
  }
  for (const m of roster.filter((r) => r.observer))
    out.push(
      `${m.handle} (${m.device}) is an observer: it reads team messages that leave a machine.`
    );
  for (const m of roster)
    if (m.skewMs !== null && Math.abs(m.skewMs) > SKEW_WARN_MS)
      out.push(
        `${m.handle}'s ${m.device} clock is ${Math.round(Math.abs(m.skewMs) / 60_000)} minutes off.`
      );
  if ((input.health.sizeBytes ?? 0) > BRANCH_SIZE_WARN_BYTES)
    out.push(
      'The sync branch is over 1 GiB. Switch to the relay, or start a fresh sync.repo.'
    );
  return out;
}

/** A URL remote without its userinfo, query or fragment; an scp-style remote
 *  (git@host:path) names a login, not a secret, and stays. */
export function withoutCredentials(remote: string): string {
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return remote;
  }
  if (url.protocol === 'file:') return remote;
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Text (a git error, say) with any `scheme://user:secret@` userinfo cut. */
export function redactCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1');
}

function redactNullable(text: string | null): string | null {
  return text === null ? null : redactCredentials(text);
}
