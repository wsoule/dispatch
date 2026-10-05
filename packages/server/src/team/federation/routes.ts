import { HANDLE, printable } from '@dispatch/federation';
import { fingerprint } from '@dispatch/protocol/federation';
import { basename } from 'node:path';

import type { ApiContext } from '../../api.js';
import {
  errorResponse,
  jsonResponse,
  readJsonBodyOptional,
} from '../../api/http.js';
import type { AuthTier } from '../../tiers.js';
import { tierAllows } from '../../tiers.js';
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
  'mail-out:',
  'run-moved:',
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
    case 'invite':
      return after(roster.invite(need('handle')));
    case 'join':
      roster.join(need('code'));
      return after(null);
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
      return switchTransport(fedCtx, body, after);
    default:
      return errorResponse(404, 'not found');
  }
}

/** The first build that speaks to a relay (F4). */
const RELAY_MIN_BUILD = '0.37.0';

// Whether dotted version `a` is older than `b`; an unreadable one is old.
function olderThan(a: string, b: string): boolean {
  const pa = a.split(/[.+-]/).slice(0, 3).map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i];
    const y = pb[i] ?? 0;
    if (x === undefined || !Number.isFinite(x)) return true;
    if (x !== y) return x < y;
  }
  return false;
}

// A relay URL a machine may dial: wss, or ws on this machine only.
function relayUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'url is not a URL';
  }
  if (parsed.protocol === 'wss:') return null;
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol === 'ws:' && local) return null;
  return 'url must be wss:// (ws:// only on this machine)';
}

// POST /api/team/transport: an admin switches the team between git and a
// relay. The relay needs every admitted machine on an F4 build, the legacy
// window closed, and its disclosure confirmed first (F-D31).
async function switchTransport(
  fedCtx: FederationContext,
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
    const bad = url === '' ? 'url is required' : relayUrlProblem(url);
    if (bad !== null) throw new RosterError('invalid', bad);
    const builds = new Map(
      fed.db
        .query<{ replica: string; build: string }, []>(
          'SELECT replica, build FROM fed_replicas'
        )
        .all()
        .map((r) => [r.replica, r.build])
    );
    const old = [...view.members.keys()].filter((r) =>
      olderThan(builds.get(r) ?? fed.pinned(r)?.build ?? '', RELAY_MIN_BUILD)
    );
    if (old.length > 0)
      throw new RosterError(
        'conflict',
        `every machine needs Dispatch ${RELAY_MIN_BUILD} or later to use a relay; still older: ${old.map((r) => fedCtx.label(r)).join(', ')}`
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
    roster.setTransport('relay', url);
    return after({ ok: true, disclosure: RELAY_DISCLOSURE });
  }
  roster.setTransport('git');
  return after(null);
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
