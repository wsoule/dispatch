import { hubDir, readHubFile } from '@dispatch-foo/core';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import type { TeamFile } from './hub/team.js';
import {
  readTeamFile,
  removeTeamFile,
  teamServer,
  writeTeamFile,
} from './hub/team.js';
import { openBrowser, safeToOpen } from './setup.js';

// Signing this machine in to a team (RFC 8628 device flow against the team
// service): the person approves a short code in their browser, and the
// machine hub restarts as a member of that team.

export interface DeviceLogin {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  /** Resolves once the person approves (or denies, or the code expires). */
  done: Promise<{ ok: true; team: TeamFile } | { ok: false; error: string }>;
}

const DEFAULT_INTERVAL_SEC = 3;

// The device code a sign-in is waiting on, kept in ~/.dispatch/hub so a new
// process (an MCP server restarted with its client, a second terminal) picks
// up the code the person may already be confirming instead of replacing it.
interface PendingCode {
  server: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  /** Epoch ms after which the code is no good. */
  expires_at: number;
  interval?: number;
}

function pendingPath(): string {
  return join(hubDir(), 'login-pending.json');
}

/** The unexpired pending code for `server`, if a sign-in left one. */
export function readPendingCode(server: string): PendingCode | null {
  if (!existsSync(pendingPath())) return null;
  try {
    const p = JSON.parse(readFileSync(pendingPath(), 'utf8')) as PendingCode;
    return p.server === server &&
      typeof p.device_code === 'string' &&
      p.expires_at > Date.now() + 5000
      ? p
      : null;
  } catch {
    return null;
  }
}

function writePendingCode(p: PendingCode): void {
  mkdirSync(hubDir(), { recursive: true, mode: 0o700 });
  const temp = `${pendingPath()}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(p), { mode: 0o600 });
  renameSync(temp, pendingPath());
}

function clearPendingCode(deviceCode: string): void {
  try {
    const p = JSON.parse(readFileSync(pendingPath(), 'utf8')) as PendingCode;
    if (p.device_code !== deviceCode) return;
  } catch {
    // Unreadable: nothing to keep.
  }
  rmSync(pendingPath(), { force: true });
}

/** Starts a sign-in, or resumes the one still pending from another process;
 *  `done` settles when it finishes. */
export async function startDeviceLogin(
  server: string = teamServer(),
  client = `dispatch-mcp on ${hostname().split('.')[0] ?? 'this machine'}`,
  invite?: string
): Promise<DeviceLogin | { error: string }> {
  let started: PendingCode | null =
    invite === undefined ? readPendingCode(server) : null;
  if (started === null) {
    let answer: Omit<PendingCode, 'server' | 'expires_at'> & {
      expires_in: number;
    };
    try {
      const res = await fetch(`${server}/api/device/code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client,
          ...(invite === undefined ? {} : { invite }),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { error: `${server} answered ${res.status}` };
      answer = (await res.json()) as typeof answer;
    } catch (err) {
      return { error: `cannot reach ${server}: ${(err as Error).message}` };
    }
    started = {
      server,
      device_code: answer.device_code,
      user_code: answer.user_code,
      verification_uri: answer.verification_uri,
      verification_uri_complete: answer.verification_uri_complete,
      expires_at: Date.now() + answer.expires_in * 1000,
      ...(answer.interval === undefined ? {} : { interval: answer.interval }),
    };
    writePendingCode(started);
  }
  const code = started;
  const interval = (code.interval ?? DEFAULT_INTERVAL_SEC) * 1000;
  const deadline = code.expires_at;
  const finish = <T>(result: T): T => {
    clearPendingCode(code.device_code);
    return result;
  };
  const done = (async (): Promise<
    { ok: true; team: TeamFile } | { ok: false; error: string }
  > => {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      // Another process polling the same code may have finished first.
      const joined = readTeamFile();
      if (joined !== null && joined.server === server)
        return finish({ ok: true, team: joined });
      let body: {
        error?: string;
        token?: string;
        handle?: string;
        device?: string;
        team?: { id: string; name: string };
      };
      try {
        const res = await fetch(`${server}/api/device/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ device_code: code.device_code }),
          signal: AbortSignal.timeout(15_000),
        });
        body = (await res.json()) as typeof body;
      } catch {
        continue;
      }
      if (body.error === 'authorization_pending') continue;
      if (body.error !== undefined) {
        // The other process may have taken the token and finished.
        const joined = readTeamFile();
        if (joined !== null && joined.server === server)
          return finish({ ok: true, team: joined });
        return finish({
          ok: false,
          error:
            body.error === 'access_denied'
              ? 'the sign-in was denied'
              : 'the code expired; start again',
        });
      }
      if (
        body.token === undefined ||
        body.handle === undefined ||
        body.device === undefined ||
        body.team === undefined
      )
        return finish({
          ok: false,
          error: 'the team service sent an incomplete answer',
        });
      const team: TeamFile = {
        server,
        token: body.token,
        handle: body.handle,
        team: body.team,
        device: body.device,
      };
      joinTeam(team);
      return finish({ ok: true as const, team });
    }
    return finish({ ok: false, error: 'the code expired; start again' });
  })();
  return {
    userCode: code.user_code,
    verificationUri: code.verification_uri,
    verificationUriComplete: code.verification_uri_complete,
    done,
  };
}

// Saves the sign-in and restarts the machine hub as a team member.
function joinTeam(team: TeamFile): void {
  writeTeamFile(team);
  restartHub();
}

/** Forgets the team sign-in and restarts the machine hub off the team. */
export function logout(): boolean {
  const had = readTeamFile() !== null;
  removeTeamFile();
  restartHub();
  return had;
}

// The hub's agents re-register (under the new handle) on their next call,
// against a fresh hub that reads the sign-in anew.
function restartHub(): void {
  rmSync(join(hubDir(), '..', 'agents', 'hub'), {
    recursive: true,
    force: true,
  });
  const running = readHubFile();
  if (running !== null) {
    try {
      process.kill(running.pid, 'SIGTERM');
    } catch {
      // Already gone; the next MCP call starts a fresh hub.
    }
  }
}

/** Signs this machine in from a terminal: opens the browser at the code,
 *  waits, and says how it went. Already signed in, it says so and stops. */
export async function interactiveLogin(
  say: (line: string) => void
): Promise<boolean> {
  const current = readTeamFile();
  if (current !== null) {
    say(`Signed in to ${current.team.name} as ${current.handle}.`);
    return true;
  }
  const started = await startDeviceLogin();
  if ('error' in started) {
    say(`Could not start signing in: ${started.error}`);
    return false;
  }
  const opened =
    safeToOpen(started.verificationUriComplete, teamServer()) &&
    openBrowser(started.verificationUriComplete);
  say(
    `${opened ? 'Your browser opened' : `Open ${started.verificationUriComplete}`}: confirm the code ${started.userCode} there.`
  );
  const result = await started.done;
  if (!result.ok) {
    say(`Not signed in: ${result.error}`);
    return false;
  }
  say(
    `Signed in to ${result.team.team.name} as ${result.team.handle}. Your agents can reach your teammates' agents now.`
  );
  return true;
}
