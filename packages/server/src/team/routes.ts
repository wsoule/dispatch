import type { DroppedEntry, TeamMember } from '@dispatch/core';
import {
  describeDroppedEntry,
  DISPATCH_DIR,
  parseTeamReport,
  serializeTeam,
  TeamParseError,
  upsertMember,
} from '@dispatch/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ApiContext } from '../api.js';
import { errorResponse, jsonResponse, readJsonBody } from '../api/http.js';
import type { AuthTier } from '../tiers.js';
import { AUTH_TIERS, isAuthTier, tierAllows } from '../tiers.js';
import type { LicenseState } from './license.js';
import { SeatLimitError } from './teammates.js';

// Issuing credentials to teammates: the step that turns one person's daemon
// into one a team can share, and the license that says how many teammates
// that may be. Licensed under the Elastic License 2.0 (./LICENSE).
// Every route here is decide-tier (see
// ELEVATED_ROUTES) — handing out a credential is an adjudication, and an
// agent holding the on-disk agent token must not be able to mint itself a
// second identity.
//
// On top of that, nobody hands out more than they hold: a decide-tier lead can
// invite reviewers but cannot mint an operator token, which would be a shell on
// the host by another name. The same cap applies to revoking, so a lead cannot
// lock the operator's own teammate-issued operator tokens out either.

// How long an invite lasts when the inviter does not say. Long enough that a
// teammate on a project is not re-invited every sprint; short enough that a
// token handed to a contractor and forgotten stops working on its own.
const DEFAULT_EXPIRY_DAYS = 90;
// A decade: anything longer is "never" said the hard way.
const MAX_EXPIRY_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

/** When an invite's token should stop working: the default when absent, a
 *  number of days, or never (`null`). */
function expiryFrom(
  value: unknown,
  now: Date
): { ok: true; expiresAt: Date | null } | { ok: false; error: string } {
  if (value === undefined) {
    return {
      ok: true,
      expiresAt: new Date(now.getTime() + DEFAULT_EXPIRY_DAYS * DAY_MS),
    };
  }
  if (value === null) return { ok: true, expiresAt: null };
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_EXPIRY_DAYS
  ) {
    return {
      ok: false,
      error: `expiresInDays must be a whole number from 1 to ${MAX_EXPIRY_DAYS}, or null for never`,
    };
  }
  return { ok: true, expiresAt: new Date(now.getTime() + value * DAY_MS) };
}

const INVALID_TIER = `invalid tier: expected one of ${AUTH_TIERS.map((t) => `'${t}'`).join(', ')}`;

/** Refuses a tier the caller does not hold themselves, or null to proceed.
 *  The caller is always set here — handleApi resolved it before routing to a
 *  decide-tier route — so a missing one is treated as holding nothing. */
function exceedsCaller(ctx: ApiContext, tier: AuthTier): Response | null {
  const held = ctx.caller?.tier ?? 'request';
  if (tierAllows(held, tier)) return null;
  return errorResponse(
    403,
    `you hold the ${held} tier and cannot grant or revoke ${tier}; ask whoever runs this daemon`
  );
}

function teamFile(rootDir: string): string {
  return join(rootDir, DISPATCH_DIR, 'team.yml');
}

/** The roster as it stands, with the entries it skipped, or a reason it
 *  cannot be read. A conflicted team.yml is reported, never treated as empty —
 *  writing over it would wipe the team, the same rule ActorContext follows. */
function readRoster(
  rootDir: string
):
  | { ok: true; members: TeamMember[]; dropped: DroppedEntry[] }
  | { ok: false; error: string } {
  const file = teamFile(rootDir);
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
  try {
    return { ok: true, ...parseTeamReport(raw) };
  } catch (err) {
    if (!(err instanceof TeamParseError)) throw err;
    return { ok: false, error: err.message };
  }
}

// GET /api/team/tokens — who holds credentials, never the credentials. The
// operator's built-in pair comes first, from the daemon's own registry.
export function listTeamTokens(ctx: ApiContext): Response {
  return jsonResponse(ctx.tokens.registry.list());
}

/**
 * POST /api/team/tokens — issue a teammate a credential.
 *
 * Body is either `{ handle }` for someone already on the roster, or
 * `{ email, displayName? }` to add them first — the same upsert a teammate's
 * own daemon performs on its first boot, so a person invited here and a person
 * who joined by cloning land as the same roster entry. `tier` defaults to
 * `request`: someone new to a project can drive it before they can adjudicate
 * in it, and granting `decide` is a separate, explicit act.
 *
 * The token is in the response body and nowhere else. It is not logged, not
 * persisted (only its hash is), and cannot be read back — lose it and issue a
 * new one, which revokes the old.
 */
export async function issueTeamToken(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    handle?: unknown;
    email?: unknown;
    displayName?: unknown;
    tier?: unknown;
    expiresInDays?: unknown;
  };

  const tier = body.tier ?? 'request';
  if (!isAuthTier(tier)) return errorResponse(400, INVALID_TIER);
  const refused = exceedsCaller(ctx, tier);
  if (refused !== null) return refused;
  const expiry = expiryFrom(body.expiresInDays, new Date());
  if (!expiry.ok) return errorResponse(400, expiry.error);

  const roster = readRoster(ctx.rootDir);
  if (!roster.ok) {
    return errorResponse(
      409,
      `team.yml cannot be read (${roster.error}); resolve it before issuing tokens`
    );
  }

  let handle: string;
  if (typeof body.email === 'string' && body.email.trim() !== '') {
    const email = body.email.trim();
    if (!email.includes('@')) {
      return errorResponse(400, 'invalid email');
    }
    const displayName =
      typeof body.displayName === 'string' && body.displayName.trim() !== ''
        ? body.displayName.trim()
        : email.slice(0, email.indexOf('@'));
    const result = upsertMember(roster.members, email, displayName);
    if (result.changed) {
      // Rewriting a roster with skipped entries would delete those teammates.
      if (roster.dropped.length > 0) {
        const named = roster.dropped.map(describeDroppedEntry).join('; ');
        return errorResponse(
          409,
          `team.yml has entries this daemon skipped (${named}); fix them before adding anyone, or rewriting the roster would delete them`
        );
      }
      mkdirSync(join(ctx.rootDir, DISPATCH_DIR), { recursive: true });
      writeFileSync(teamFile(ctx.rootDir), serializeTeam(result.members));
    }
    handle = result.member.handle;
  } else if (typeof body.handle === 'string') {
    const wanted = body.handle;
    if (!roster.members.some((m) => m.handle === wanted)) {
      return errorResponse(
        404,
        `no roster member "${wanted}": pass their email instead to add them`
      );
    }
    handle = wanted;
  } else {
    return errorResponse(400, 'expected { handle } or { email }');
  }

  // Issuing replaces what they held, so replacing an operator token is as
  // privileged as revoking one.
  const current = ctx.team.teammates.issuedTier(handle);
  if (current !== null) {
    const replacing = exceedsCaller(ctx, current);
    if (replacing !== null) return replacing;
  }
  let token: string;
  try {
    token = ctx.team.teammates.issue(handle, tier, {
      expiresAt: expiry.expiresAt,
    });
  } catch (err) {
    if (!(err instanceof SeatLimitError)) throw err;
    // 402: the request is fine, and a seat is what it takes.
    return jsonResponse(
      { error: err.message, code: 'seat_limit', seats: err.seats },
      402
    );
  }
  return jsonResponse(
    {
      handle,
      tier,
      token,
      expiresAt: expiry.expiresAt?.toISOString() ?? null,
    },
    201
  );
}

// DELETE /api/team/tokens/:handle — revoke whatever that teammate holds. 404
// rather than a silent 200 when there was nothing to revoke, so a typo in a
// handle is visible instead of reading as success.
export function revokeTeamToken(ctx: ApiContext, handle: string): Response {
  const current = ctx.team.teammates.issuedTier(handle);
  if (current === null) {
    return errorResponse(404, `no issued token for "${handle}"`);
  }
  const refused = exceedsCaller(ctx, current);
  if (refused !== null) return refused;
  ctx.team.teammates.revoke(handle);
  return jsonResponse({ ok: true, tier: current });
}

/** What Settings → License shows: the plan, and who it covers. Never the
 *  key itself, which is the licensee's to keep. */
function licenseView(ctx: ApiContext, state: LicenseState) {
  return {
    kind: state.kind,
    seats: state.seats,
    used: ctx.team.teammates.peopleWithAccess(),
    org: 'license' in state ? state.license.org : null,
    expiresAt: 'license' in state ? state.license.expiresAt : null,
    reason: state.kind === 'invalid' ? state.reason : null,
  };
}

// GET /api/license
export function getLicense(ctx: ApiContext): Response {
  return jsonResponse(licenseView(ctx, ctx.team.license.state()));
}

// PUT /api/license — install a key. One that does not verify is refused with
// why, and the key already installed stays.
export async function installLicense(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const { key } = parsed.value as { key?: unknown };
  if (typeof key !== 'string' || key.trim() === '') {
    return errorResponse(400, 'expected { key }');
  }
  const next = ctx.team.license.install(key);
  if (next.kind === 'expired') {
    return errorResponse(
      400,
      `that key for ${next.license.org} expired on ${next.license.expiresAt?.slice(0, 10)}`
    );
  }
  if (next.kind !== 'licensed') {
    return errorResponse(
      400,
      `that is not a license key this build accepts: ${next.kind === 'invalid' ? next.reason : 'unreadable'}`
    );
  }
  return jsonResponse(licenseView(ctx, next));
}
