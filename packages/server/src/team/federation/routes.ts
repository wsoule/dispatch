import { upsertMember } from '@dispatch-foo/core';
import { HANDLE, printable } from '@dispatch-foo/federation';
import { fingerprint } from '@dispatch-foo/protocol/federation';
import type { LogEntry } from '@dispatch-foo/protocol/federation';
import { basename } from 'node:path';

import type { ApiContext } from '../../api.js';
import {
  errorResponse,
  jsonResponse,
  readJsonBodyOptional,
} from '../../api/http.js';
import type { AuthTier } from '../../tiers.js';
import { tierAllows } from '../../tiers.js';
import { readRoster } from '../routes.js';
import { capsOf } from './caps.js';
import {
  checkString,
  defaultRelayUrl,
  normalRelay,
  teamLinkUrl,
  teamStatus,
} from './onboarding.js';
import type { TeamStatus } from './onboarding.js';
import {
  founderChain,
  registerAtRelay,
  RelayRegistrationError,
} from './relay.js';
import type { RosterService } from './roster.js';
import { RosterError } from './roster.js';
import type { FedStore } from './store.js';
import { OpTooLargeError } from './store.js';
import {
  assembleTeamKeys,
  redactCredentials,
  RELAY_DISCLOSURE,
  withoutCredentials,
} from './teamKeys.js';

/** What api.ts's context carries once federation is wired (index.ts). */
export interface FederationContext {
  roster: RosterService;
  fed: FedStore;
  /** This machine's Dispatch handle and short hostname. */
  handle: string;
  device: string;
  /** The clock board sync reads. */
  now: () => Date;
  /** The code remote the branch rides when sync.repo is unset, else null. */
  remote: string | null;
  /** "<handle>" or the replica id. */
  label(replica: string): string;
  /** "<handle>'s <device>" of an admitted observer, or null. */
  observer(): string | null;
  /** Binds a contested run to one claimant (an admin's), when messaging
   *  federates; absent before then. */
  resolveRun?: (run: string, replica: string) => void;
  /** Where a task's live run is, when messaging federates. */
  presenceOf?: (task: string) => {
    presence: { replica: string; handle: string; device: string } | null;
    waitingOn: string | null;
  };
  /** Tests only: a ws:// relay on this machine may be switched to. */
  allowLoopbackRelay?: boolean;
  /** How long a route waits for its pass; ROUTE_PASS_WAIT_MS unless a test sets it. */
  passWaitMs?: number;
}

/** A route waits this long for its pass, then answers with pending: true. */
const ROUTE_PASS_WAIT_MS = 20_000;

// Runs a pass and waits for it at most passWaitMs, so an unreachable remote
// never hangs a route; true when it finished. A pass that finishes later and
// fails is named as a problem, since nobody is waiting on its answer.
async function boundedPass(
  fedCtx: FederationContext | null,
  service: NonNullable<ApiContext['boardSync']>,
  what: string
): Promise<boolean> {
  let late = false;
  const run = service.syncNow().then(() => {
    const failed = service.status().lastError;
    if (late && failed !== null)
      fedCtx?.fed.problem(
        'team:route',
        `the sync after ${what} failed: ${failed}; the change is made here and goes out on a later sync`
      );
    return true;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      late = true;
      resolve(false);
    }, fedCtx?.passWaitMs ?? ROUTE_PASS_WAIT_MS);
  });
  const done = await Promise.race([run, wait]);
  clearTimeout(timer);
  return done;
}

/** Board sync's status as `tier` may see it: below operator, without
 *  credentials in the remote; below decide, also without the transport's
 *  health or the team's problems (F-D29). */
export function statusFor(
  status: object,
  tier: AuthTier
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...status };
  if (tierAllows(tier, 'operator')) return out;
  // Credentials in the remote are the operator's alone (G).
  if (typeof out.remote === 'string')
    out.remote = withoutCredentials(out.remote);
  if (typeof out.lastError === 'string')
    out.lastError = redactCredentials(out.lastError);
  const health = out.transportHealth as { lastError?: unknown } | undefined;
  if (typeof health?.lastError === 'string')
    out.transportHealth = {
      ...health,
      lastError: redactCredentials(health.lastError),
    };
  if (tierAllows(tier, 'decide')) return out;
  delete out.transportHealth;
  delete out.federationProblems;
  return out;
}

/** POST /api/board-sync/now: a pass, waited for at most passWaitMs, then the
 *  status for the caller's tier, `running` while the pass still runs (its
 *  `pending` stays the count of changes not yet pushed). */
export async function boardSyncNow(
  ctx: ApiContext,
  service: NonNullable<ApiContext['boardSync']>
): Promise<Record<string, unknown>> {
  const done = await boundedPass(
    ctx.federation,
    service,
    'the sync you asked for'
  );
  const view = statusFor(service.status(), ctx.caller?.tier ?? 'request');
  return done ? view : { ...view, running: true };
}

// The roster actions under /api/team, beside the teammate-token routes.
const ACTIONS = new Set([
  'start',
  'status',
  'leave',
  'keys',
  'found',
  'trust',
  'invite',
  'join',
  'recover',
  'recovery-key',
  'license',
  'close-legacy',
  'dismiss',
  'abandon-invite',
  'problems',
  'runs',
  'presence',
  'transport',
]);

// Notes a person may acknowledge: a race, a cut that cannot be checked, a
// merge reset, a route's late failure, a message note and a run conflict. A halt, a key claim or a pause
// stays until what caused it is gone.
const ACKNOWLEDGEABLE = [
  'team:race:',
  'team:cut:',
  'transport:merge',
  'team:route',
  'observer:',
  'transport:read:',
  'transport:bloat:',
  'transport:rewrite:',
  // FW-R31(3): a message note and a run conflict can be acknowledged.
  'message:',
  'run-conflict:',
  // A teammate's refused agent or channel op is a one-off note.
  'agent:',
  'channel:',
  // FW-R32(6): one rolling note per publisher, and a message that could not go.
  'malformed:',
  'mail-drop:',
  'link-op:',
  'mail-out:',
  'run-moved:',
  // A reused, expired or shared invite a machine tried.
  'invite:',
];

const STATUS: Record<RosterError['code'], number> = {
  forbidden: 403,
  conflict: 409,
  seat_limit: 402,
  invalid: 400,
};

export function isFederationRoute(segments: readonly string[]): boolean {
  return segments[0] === 'team' && ACTIONS.has(segments[1] ?? '');
}

type Body = Record<string, unknown>;

// Caps on what a route signs: a name, reason or handle, and a hosts list; an
// invite code carries a relay URL, so it gets more room.
const MAX_INPUT_CHARS = 256;
const MAX_CODE_CHARS = 4096;
const MAX_LIST_ITEMS = 64;

// A handle or hosts entry that is not a handle (M1), named, or null.
function offGrammar(body: Body): string | null {
  const handles = [
    ...(body.handle === undefined ? [] : [body.handle]),
    ...(Array.isArray(body.hosts) ? body.hosts : []),
  ];
  const bad = handles.find((h) => typeof h !== 'string' || !HANDLE.test(h));
  return bad === undefined
    ? null
    : `${JSON.stringify(printable(String(bad), 64))} is not a handle: lowercase letters, digits, dot, dash and underscore`;
}

// The first input over its cap, named, or null.
function oversized(body: Body): string | null {
  for (const [key, value] of Object.entries(body)) {
    const cap = key === 'code' ? MAX_CODE_CHARS : MAX_INPUT_CHARS;
    if (typeof value === 'string' && value.length > cap)
      return `${key} is longer than ${cap} characters`;
    if (Array.isArray(value)) {
      if (value.length > MAX_LIST_ITEMS)
        return `${key} has more than ${MAX_LIST_ITEMS} entries`;
      if (
        value.some((v) => typeof v === 'string' && v.length > MAX_INPUT_CHARS)
      )
        return `an entry in ${key} is longer than ${MAX_INPUT_CHARS} characters`;
    }
  }
  return null;
}

// The /api/team federation routes (spec "Daemon routes, CLI and MCP"): reads
// at the decide tier and roster changes at the operator tier (api.ts).
export async function handleFederationRoute(
  req: Request,
  ctx: ApiContext,
  segments: readonly string[],
  method: string
): Promise<Response> {
  const fedCtx = ctx.federation;
  const service = ctx.boardSync;
  if (method === 'GET' && segments.length === 2 && segments[1] === 'status')
    return jsonResponse(
      fedCtx === null || service === null
        ? SHARING_OFF
        : statusOf(fedCtx, service)
    );
  if (fedCtx === null || service === null)
    return errorResponse(409, 'board sync is not on');
  if (method === 'GET' && segments.length === 2 && segments[1] === 'keys')
    return jsonResponse(teamKeys(fedCtx, service));
  if (method === 'GET' && segments.length === 2 && segments[1] === 'presence') {
    const task = new URL(req.url).searchParams.get('task') ?? '';
    return jsonResponse(
      fedCtx.presenceOf?.(task) ?? { presence: null, waitingOn: null }
    );
  }
  if (method !== 'POST') return errorResponse(405, 'method not allowed');
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const tooBig = oversized(body) ?? offGrammar(body);
  if (tooBig !== null)
    return jsonResponse({ error: tooBig, code: 'invalid' }, 400);
  try {
    const answer = await act(ctx, fedCtx, service, segments, body);
    return answer instanceof Response
      ? answer
      : jsonResponse(answer ?? { ok: true });
  } catch (err) {
    if (err instanceof RosterError)
      return jsonResponse(
        { error: err.message, code: err.code },
        STATUS[err.code]
      );
    if (err instanceof OpTooLargeError)
      return jsonResponse({ error: err.message, code: 'too_large' }, 413);
    throw err;
  }
}

// One roster action, a pass after it so the op goes out; a removal runs a
// pass first, so its cut is taken right after a pull (spec:1169-1170).
async function act(
  ctx: ApiContext,
  fedCtx: FederationContext,
  service: NonNullable<ApiContext['boardSync']>,
  segments: readonly string[],
  body: Body
): Promise<Response | Record<string, unknown> | null> {
  const { roster } = fedCtx;
  const str = (key: string): string | null => {
    const value = body[key];
    return typeof value === 'string' ? value : null;
  };
  const need = (key: string): string => {
    const value = str(key);
    if (value === null || value === '')
      throw new RosterError('invalid', `${key} is required`);
    return value;
  };
  const what = `${segments.slice(1).join(' ')}`;
  const after = async (
    value: Record<string, unknown> | null
  ): Promise<Record<string, unknown> | null> =>
    (await boundedPass(fedCtx, service, what))
      ? value
      : { ...(value ?? { ok: true }), pending: true };
  if (segments.length === 4 && segments[1] === 'keys') {
    const replica = segments[2] ?? '';
    return keyAction(fedCtx, service, replica, segments[3] ?? '', body);
  }
  if (
    segments.length === 3 &&
    segments[1] === 'problems' &&
    segments[2] === 'ack'
  ) {
    const subject = need('subject');
    if (!ACKNOWLEDGEABLE.some((p) => subject.startsWith(p)))
      throw new RosterError(
        'invalid',
        `${subject} is not a note to acknowledge; it goes when its cause does`
      );
    if (
      subject.startsWith('team:cut:') &&
      !tierAllows(ctx.caller?.tier ?? 'request', 'operator')
    )
      throw new RosterError(
        'forbidden',
        'acknowledging a revocation that cannot be checked needs the operator tier'
      );
    fedCtx.fed.ackProblem(subject);
    return { ok: true };
  }
  if (
    segments.length === 4 &&
    segments[1] === 'runs' &&
    segments[3] === 'resolve'
  ) {
    if (fedCtx.resolveRun === undefined)
      return errorResponse(409, 'team messaging is not on');
    fedCtx.resolveRun(segments[2] ?? '', need('replica'));
    return after({ ok: true });
  }
  if (segments.length !== 2) return errorResponse(404, 'not found');
  switch (segments[1]) {
    case 'found': {
      // Founding needs a pull that succeeds (spec:943-944).
      if (!(await boundedPass(fedCtx, service, 'the pull before founding')))
        return jsonResponse(
          {
            error:
              'the pull before founding is still running; try again shortly',
            code: 'conflict',
            pending: true,
          },
          409
        );
      const pulled = service.status().lastError;
      if (pulled !== null)
        return jsonResponse(
          { error: `a pull must succeed first: ${pulled}`, code: 'conflict' },
          409
        );
      const { recoveryCode } = roster.found(
        str('name') ?? basename(ctx.rootDir)
      );
      return after({
        teamId: roster.teamId(),
        recoveryCode,
        fingerprint: fingerprint(
          fedCtx.fed.keys.signPub,
          fedCtx.fed.keys.sealPub
        ),
      });
    }
    case 'trust':
      roster.trust(need('fingerprint'));
      return after(null);
    case 'start':
      return startTeam(ctx, fedCtx, service, body, after);
    case 'invite':
      return after(invite(ctx, fedCtx, service, body));
    case 'join':
      return after(join(fedCtx, service, need('code')));
    case 'leave':
      return after(leave(fedCtx));
    case 'recover':
      roster.recover(need('code'));
      return after(null);
    case 'recovery-key':
      return after(roster.replaceRecoveryKey());
    case 'license':
      roster.shareLicense();
      return after(null);
    case 'close-legacy':
      roster.closeLegacy();
      return after(null);
    case 'dismiss': {
      const seq = body.seq;
      if (!Number.isSafeInteger(seq))
        throw new RosterError('invalid', 'seq is required');
      roster.dismiss(need('replica'), seq as number, need('hash'));
      return after(null);
    }
    case 'abandon-invite':
      roster.abandonInvite();
      return after(null);
    case 'transport':
      return switchTransport(fedCtx, service, body, after);
    default:
      return errorResponse(404, 'not found');
  }
}

// A relay URL a machine may dial: wss, or, in tests, ws on this machine.
function relayUrlProblem(url: string, loopback: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'url is not a URL';
  }
  if (parsed.protocol === 'wss:') return null;
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (loopback && parsed.protocol === 'ws:' && local) return null;
  return 'url must be wss://';
}

// POST /api/team/transport: an admin switches the team between git and a
// relay. The relay needs every admitted machine to speak it (FW-R39), the legacy
// window closed, its disclosure confirmed first (F-D31), and the team
// registered at the relay before the `transport` op is signed. The optional
// `registrationToken` goes only into that registration request.
async function switchTransport(
  fedCtx: FederationContext,
  service: NonNullable<ApiContext['boardSync']>,
  body: Body,
  after: (
    value: Record<string, unknown> | null
  ) => Promise<Record<string, unknown> | null>
): Promise<Response | Record<string, unknown> | null> {
  const { roster, fed } = fedCtx;
  const kind = body.kind;
  if (kind !== 'git' && kind !== 'relay')
    throw new RosterError('invalid', 'kind must be git or relay');
  const view = roster.view();
  if (view === null)
    throw new RosterError('conflict', 'this machine is in no team');
  if (kind === 'relay') {
    const url = typeof body.url === 'string' ? body.url : '';
    const bad =
      url === ''
        ? 'url is required'
        : relayUrlProblem(url, fedCtx.allowLoopbackRelay === true);
    if (bad !== null) throw new RosterError('invalid', bad);
    // FW-R39: every admitted machine must announce that it speaks the relay.
    // Invitees waiting to be admitted count too: they join over the relay.
    const lacking = [...view.members.keys(), ...view.invitedBy.keys()].filter(
      (r) => !capsOf(fed, r).includes('relay')
    );
    if (lacking.length > 0)
      throw new RosterError(
        'conflict',
        `every machine needs a Dispatch build that speaks the relay; not yet: ${lacking.map((r) => fedCtx.label(r)).join(', ')}`
      );
    if (view.legacy.closed === null)
      throw new RosterError(
        'conflict',
        'close the legacy window first: older builds read only the git branch'
      );
    if (body.confirmed !== true)
      return jsonResponse(
        {
          error: 'confirm what the relay can read first',
          code: 'confirm_required',
          disclosure: RELAY_DISCLOSURE,
        },
        409
      );
    const token = body.registrationToken;
    if (token !== undefined && (typeof token !== 'string' || token === ''))
      throw new RosterError(
        'invalid',
        'registrationToken must be a non-empty string'
      );
    roster.requireAdmin('switch the team transport');
    const refused = await registerTeam(fedCtx, service, url, token);
    if (refused !== null)
      return jsonResponse(
        { error: refused, code: 'relay_registration_failed' },
        502
      );
    roster.setTransport('relay', url);
    return after({ ok: true, disclosure: RELAY_DISCLOSURE });
  }
  roster.setTransport('git');
  return after(null);
}

// Registers the team at the relay from the founder's chain: this machine's
// own log on the founder, else what the current transport holds of the
// founder's log. Answers why it could not, or null once the relay holds it.
async function registerTeam(
  fedCtx: FederationContext,
  service: NonNullable<ApiContext['boardSync']>,
  url: string,
  token: string | undefined
): Promise<string | null> {
  const { fed, roster } = fedCtx;
  const founder = fed.meta('founder');
  const foundSeq = Number(fed.meta('founder_seq'));
  if (founder === null || !Number.isSafeInteger(foundSeq))
    return 'this machine holds no founding to register the team with';
  let log: LogEntry[];
  try {
    log =
      founder === fed.replica ? fed.ownLog() : await service.scan([founder]);
  } catch (err) {
    return `could not register the team at the relay: this machine could not read ${fedCtx.label(founder)}'s log (${(err as Error).message.slice(0, 200)})`;
  }
  const chain = founderChain(log, founder, foundSeq);
  if (chain === null)
    return `could not register the team at the relay: this machine does not hold ${fedCtx.label(founder)}'s key and found ops yet; pull, then try again`;
  try {
    const teamId = await registerAtRelay(url, chain, {
      ...(token === undefined ? {} : { token }),
    });
    if (teamId !== roster.teamId())
      return `could not register the team at the relay: it registered team ${teamId}, not this team`;
  } catch (err) {
    if (err instanceof RelayRegistrationError) return err.message;
    throw err;
  }
  return null;
}

async function keyAction(
  fedCtx: FederationContext,
  service: NonNullable<ApiContext['boardSync']>,
  replica: string,
  action: string,
  body: Body
): Promise<Response | Record<string, unknown> | null> {
  const { roster } = fedCtx;
  // A removal's cut is the target's last op seen after a pull; offline, the
  // last one applied, which the revocation race covers (Task 10b).
  const pullFirst = async (): Promise<Record<string, unknown> | null> => {
    if (!(await boundedPass(fedCtx, service, `the pull before ${action}`)))
      return {
        warning: `this machine could not pull first: the pull is still running; ops it has not seen yet from ${fedCtx.label(replica)} stay applied wherever they already landed`,
        pending: true,
      };
    const failed = service.status().lastError;
    return failed === null
      ? null
      : {
          warning: `this machine could not pull first: ${failed}; ops it has not seen yet from ${fedCtx.label(replica)} stay applied wherever they already landed`,
        };
  };
  let answer: Record<string, unknown> | null = null;
  // A retry of a change the roster already shows (the first answer may have
  // been `pending`) is answered as done rather than refused.
  if (alreadyDone(fedCtx, replica, action, body)) {
    if (!(await boundedPass(fedCtx, service, action)))
      return { ok: true, already: true, pending: true };
    return { ok: true, already: true };
  }
  switch (action) {
    case 'admit': {
      if (typeof body.fingerprint !== 'string')
        throw new RosterError('invalid', 'fingerprint is required');
      // FW-R28: junk claims stored first never keep out the real key; its
      // id's files are scanned for the fingerprint before any refusal.
      if (
        !fedCtx.fed
          .claims(replica)
          .some((c) => c.fingerprint === body.fingerprint)
      )
        await service.findKey(replica, body.fingerprint);
      const role = body.role === 'admin' ? 'admin' : 'member';
      const hosts = Array.isArray(body.hosts)
        ? body.hosts.filter((h): h is string => typeof h === 'string')
        : undefined;
      roster.admit(replica, {
        fingerprint: body.fingerprint,
        ...(typeof body.handle === 'string' ? { handle: body.handle } : {}),
        role,
        ...(hosts === undefined ? {} : { hosts }),
        ...(body.observer === true ? { observer: true } : {}),
      });
      break;
    }
    case 'revoke':
      answer = await pullFirst();
      roster.revoke(
        replica,
        typeof body.reason === 'string' ? body.reason : 'revoked'
      );
      break;
    case 'role':
      if (body.role !== 'admin' && body.role !== 'member')
        throw new RosterError('invalid', 'role is admin or member');
      if (body.role === 'member') answer = await pullFirst();
      roster.setRole(replica, body.role);
      break;
    case 'hosts':
      if (
        !Array.isArray(body.hosts) ||
        !body.hosts.every((h) => typeof h === 'string')
      )
        throw new RosterError('invalid', 'hosts is a list of handles');
      answer = await pullFirst();
      roster.setHosts(replica, body.hosts);
      break;
    default:
      return errorResponse(404, 'not found');
  }
  if (!(await boundedPass(fedCtx, service, action)))
    return { ...(answer ?? { ok: true }), pending: true };
  return answer;
}

// Whether the roster already shows what an admit, revoke or role asks for.
function alreadyDone(
  fedCtx: FederationContext,
  replica: string,
  action: string,
  body: Body
): boolean {
  const view = fedCtx.roster.view();
  if (view === null) return false;
  const member = view.members.get(replica);
  switch (action) {
    case 'admit': {
      const pin = fedCtx.fed.pinned(replica);
      return (
        member !== undefined &&
        pin !== null &&
        fingerprint(pin.signPub, pin.sealPub) === body.fingerprint &&
        member.role === (body.role === 'admin' ? 'admin' : 'member')
      );
    }
    case 'revoke':
      return view.revoked.has(replica);
    case 'role':
      return member !== undefined && member.role === body.role;
    default:
      return false;
  }
}

function teamKeys(
  fedCtx: FederationContext,
  service: NonNullable<ApiContext['boardSync']>
): ReturnType<typeof assembleTeamKeys> {
  const { fed, roster } = fedCtx;
  const replicas = fed.db
    .query<{ replica: string; last_hlc: string; skew_ms: number }, []>(
      'SELECT replica, last_hlc, skew_ms FROM fed_replicas'
    )
    .all()
    .map((r) => ({
      replica: r.replica,
      lastHlc: r.last_hlc,
      skewMs: r.skew_ms,
    }));
  const status = service.status();
  return assembleTeamKeys({
    machine: {
      replica: fed.replica,
      handle: fedCtx.handle,
      device: fedCtx.device,
      fingerprint: fingerprint(fed.keys.signPub, fed.keys.sealPub),
    },
    view: roster.view(),
    foundings: roster.founded() ? [] : roster.foundingsSeen(),
    pins: fed.pins(),
    waiting: fedCtx.roster.waitingClaims(),
    replicas,
    health: status.transportHealth,
    problems: fed.problems(),
    remote: fedCtx.remote,
    now: fedCtx.now(),
  });
}

/** The status while board sync is off: no team can be here yet. */
const SHARING_OFF: TeamStatus = {
  state: 'off',
  line: 'Sharing is off for this project, so it is in no team',
  team: null,
  role: null,
  seats: null,
  sync: null,
  teammates: [],
  check: null,
  problems: [
    {
      message:
        'Board sync is off here. Turn it on in Settings → Board sync (or set `sync.enabled: true` in .dispatch/config.yml), then restart Dispatch for this project.',
      fix: null,
    },
  ],
};

// GET /api/team/status: the team in one line, and its problems in plain
// words with the command that fixes each.
function statusOf(
  fedCtx: FederationContext,
  service: NonNullable<ApiContext['boardSync']>
): TeamStatus {
  const { fed, roster } = fedCtx;
  const status = service.status();
  const keys = teamKeys(fedCtx, service);
  return teamStatus(
    {
      machine: {
        replica: fed.replica,
        handle: fedCtx.handle,
        fingerprint: keys.machine.fingerprint,
      },
      view: roster.view(),
      pins: fed.pins(),
      joining: roster.joining(),
      foundings: keys.foundings,
      waiting: keys.waiting,
      health: status.transportHealth,
      lastSyncAt: status.lastSyncAt,
      lastError:
        status.lastError === null ? null : redactCredentials(status.lastError),
      paused: status.paused,
      problems: fed.problems(),
      olderBuilds: keys.legacy.olderBuilds,
      now: fedCtx.now(),
    },
    withoutCredentials(status.remote)
  );
}

// POST /api/team/start: founds the team, closes the legacy window when no
// older build syncs here, and moves it to the relay (the hosted one unless
// `relayUrl` or DISPATCH_RELAY_URL names another), registering it there
// first. `git: true` keeps it on the git branch; an unreachable relay leaves
// it there too, with a notice saying so. The relay's disclosure must be
// confirmed first, as for any switch (F-D31).
async function startTeam(
  ctx: ApiContext,
  fedCtx: FederationContext,
  service: NonNullable<ApiContext['boardSync']>,
  body: Body,
  after: (
    value: Record<string, unknown> | null
  ) => Promise<Record<string, unknown> | null>
): Promise<Response | Record<string, unknown> | null> {
  const { roster, fed } = fedCtx;
  const view = roster.view();
  if (view !== null && view.members.has(fed.replica))
    throw new RosterError(
      'conflict',
      `This machine is already in team ${view.name}.`
    );
  const toRelay = body.git !== true;
  const given =
    typeof body.relayUrl === 'string' && body.relayUrl !== ''
      ? body.relayUrl
      : defaultRelayUrl();
  // Shown and dialed in one normal form; a URL that has none is refused below.
  const url = normalRelay(given) ?? given;
  const token = body.registrationToken;
  if (token !== undefined && (typeof token !== 'string' || token === ''))
    throw new RosterError(
      'invalid',
      'registrationToken must be a non-empty string'
    );
  if (toRelay) {
    const bad = relayUrlProblem(url, fedCtx.allowLoopbackRelay === true);
    if (bad !== null) throw new RosterError('invalid', `relayUrl: ${bad}`);
    if (body.confirmed !== true)
      return jsonResponse(
        {
          error: 'confirm what the relay can read first',
          code: 'confirm_required',
          disclosure: RELAY_DISCLOSURE,
          relayUrl: url,
        },
        409
      );
  }
  // Founding needs a pull that succeeds (spec:943-944).
  if (!(await boundedPass(fedCtx, service, 'the pull before starting')))
    return jsonResponse(
      {
        error: 'the pull before starting is still running; try again shortly',
        code: 'conflict',
        pending: true,
      },
      409
    );
  const pulled = service.status().lastError;
  if (pulled !== null)
    return jsonResponse(
      {
        error: `Dispatch could not reach the sync remote, so it cannot check no team is here yet: ${redactCredentials(pulled)}`,
        code: 'conflict',
      },
      409
    );
  if (roster.foundingSeen() && !roster.founded())
    throw new RosterError(
      'conflict',
      'A team was already started on this branch. Ask its founder for an invite link and run `dispatch team join <link>`.'
    );
  const name =
    typeof body.name === 'string' && body.name.trim() !== ''
      ? body.name.trim()
      : basename(ctx.rootDir);
  const { recoveryCode, legacyClosed } = roster.start(name);
  let transport: { kind: 'git' | 'relay'; url?: string } = { kind: 'git' };
  let notice: string | null = null;
  if (toRelay) {
    const later = `dispatch team advanced transport relay ${url} --yes`;
    if (!legacyClosed)
      notice = `Older Dispatch builds already sync this board, so the team syncs over git until they update. Then run \`dispatch team advanced close-legacy\` and \`${later}\`.`;
    else {
      const refused = await registerTeam(
        fedCtx,
        service,
        url,
        typeof token === 'string' ? token : undefined
      );
      if (refused === null) {
        roster.setTransport('relay', url);
        transport = { kind: 'relay', url };
      } else
        notice = `${refused}. The team syncs over git for now; switch later with \`${later}\`.`;
    }
  }
  return after({
    teamId: roster.teamId(),
    name,
    recoveryCode,
    fingerprint: fingerprint(fed.keys.signPub, fed.keys.sealPub),
    transport,
    notice,
  });
}

// POST /api/team/invite with `{ handle }` or `{ email }`: an invite for
// one machine, as a single link that carries everything it needs to join.
function invite(
  ctx: ApiContext,
  fedCtx: FederationContext,
  service: NonNullable<ApiContext['boardSync']>,
  body: Body
): Record<string, unknown> {
  const { roster, fed } = fedCtx;
  const handle = inviteeHandle(ctx, body);
  const view = roster.view();
  const status = service.status();
  const issued = roster.invite(
    handle,
    view === null
      ? undefined
      : {
          name: view.name,
          by: fedCtx.handle,
          fp: fingerprint(fed.keys.signPub, fed.keys.sealPub),
          via:
            view.transport.kind === 'relay' && view.transport.url !== undefined
              ? { kind: 'relay', url: view.transport.url }
              : { kind: 'git' },
          remote: withoutCredentials(status.remote),
        }
  );
  return {
    ...issued,
    handle,
    ...(issued.link === undefined ? {} : { url: teamLinkUrl(issued.link) }),
  };
}

// The handle an invite is for: as given, or the one team.yml gives (or
// would give) an email, the same rule the joiner's own daemon follows.
function inviteeHandle(ctx: ApiContext, body: Body): string {
  if (typeof body.handle === 'string' && body.handle !== '') return body.handle;
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (email === '')
    throw new RosterError('invalid', 'handle or email is required');
  if (!email.includes('@') || email.length > MAX_INPUT_CHARS)
    throw new RosterError('invalid', `${printable(email, 64)} is not an email`);
  const roster = readRoster(ctx.rootDir);
  if (!roster.ok)
    throw new RosterError(
      'conflict',
      `team.yml cannot be read (${roster.error}); invite by handle instead`
    );
  const known = roster.members.find(
    (m) => m.email === email || m.emails.includes(email)
  );
  if (known !== undefined) return known.handle;
  return upsertMember(roster.members, email, email.slice(0, email.indexOf('@')))
    .member.handle;
}

// POST /api/team/join: what the joiner sees right away, the team, who
// invited it and the optional check, and whether this project syncs where
// the team does.
function join(
  fedCtx: FederationContext,
  service: NonNullable<ApiContext['boardSync']>,
  code: string
): Record<string, unknown> {
  const { teamId, link } = fedCtx.roster.join(code);
  if (link === null) return { ok: true, team: { id: teamId, name: null } };
  const here = withoutCredentials(service.status().remote);
  const warning =
    link.remote !== null && sameRemote(link.remote, here) === false
      ? `This team syncs through ${link.remote}, but this project syncs through ${here}. Point Settings → Board sync at ${link.remote} (sync.repo), then restart Dispatch.`
      : undefined;
  return {
    ok: true,
    team: { id: teamId, name: link.name },
    by: link.by,
    via: link.via,
    check: checkString(
      teamId,
      link.fp,
      fingerprint(fedCtx.fed.keys.signPub, fedCtx.fed.keys.sealPub)
    ),
    ...(warning === undefined ? {} : { warning }),
  };
}

// Whether two git remotes name one repository, read loosely: scheme, login,
// a trailing .git and scp-style colons do not matter. Null when either is
// not a remote the comparison can read.
function sameRemote(a: string, b: string): boolean | null {
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

// POST /api/team/leave: lets go of an invite this machine is waiting on. A
// machine in the team cannot sign its own removal; the answer names who can.
function leave(fedCtx: FederationContext): Record<string, unknown> {
  const { roster, fed } = fedCtx;
  if (roster.joining() !== null) {
    roster.abandonInvite();
    return { ok: true, left: 'invite' };
  }
  const view = roster.view();
  if (view === null || !view.members.has(fed.replica))
    throw new RosterError('conflict', 'This machine is not in a team.');
  const admins = [...view.members.values()]
    .filter((m) => m.role === 'admin' && m.replica !== fed.replica)
    .map((m) => m.handle);
  throw new RosterError(
    'conflict',
    admins.length === 0
      ? `This machine is the team's only admin, so nobody else can remove it. Make someone else an admin first: dispatch team advanced role <machine> admin`
      : `A machine cannot remove itself. Ask ${[...new Set(admins)].join(' or ')} to run: dispatch team advanced revoke ${fed.replica}`
  );
}
