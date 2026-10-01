import { fingerprint } from '@dispatch/protocol/federation';
import { basename } from 'node:path';

import type { ApiContext } from '../../api.js';
import {
  errorResponse,
  jsonResponse,
  readJsonBodyOptional,
} from '../../api/http.js';
import type { RosterService } from './roster.js';
import { RosterError } from './roster.js';
import type { FedStore } from './store.js';
import { OpTooLargeError } from './store.js';
import { assembleTeamKeys } from './teamKeys.js';

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
  /** How long a route waits for its pass; ROUTE_PASS_WAIT_MS unless a test sets it. */
  passWaitMs?: number;
}

/** A route waits this long for its pass, then answers with pending: true. */
const ROUTE_PASS_WAIT_MS = 20_000;

// Runs a pass and waits for it at most passWaitMs, so an unreachable remote
// never hangs a route; true when it finished. A pass that finishes later and
// fails is named as a problem, since nobody is waiting on its answer.
async function boundedPass(
  fedCtx: FederationContext,
  service: NonNullable<ApiContext['boardSync']>,
  what: string
): Promise<boolean> {
  let late = false;
  const run = service.syncNow().then(() => {
    const failed = service.status().lastError;
    if (late && failed !== null)
      fedCtx.fed.problem(
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
    }, fedCtx.passWaitMs ?? ROUTE_PASS_WAIT_MS);
  });
  const done = await Promise.race([run, wait]);
  clearTimeout(timer);
  return done;
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
]);

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
  if (method !== 'POST') return errorResponse(405, 'method not allowed');
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const tooBig = oversized(body);
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
    default:
      return errorResponse(404, 'not found');
  }
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
    replicas,
    health: status.transportHealth,
    problems: fed.problems(),
    remote: fedCtx.remote,
    now: fedCtx.now(),
  });
}
