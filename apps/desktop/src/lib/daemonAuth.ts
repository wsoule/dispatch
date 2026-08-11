import type { RunMeta } from '@dispatch/client';

import { isTerminalRunState } from './runState';

/**
 * What the backend hands back for a daemon this window talks to.
 *
 * `appToken` is present only when this app spawned the daemon and read the
 * token off its stdout. It is never on disk anywhere — that is the point of the
 * split: a request-tier `agentToken` sits in `~/.dispatch/daemons/<key>.json`
 * where any agent running as the user can read it, so decisions are gated on a
 * credential that only ever lives in this process's memory.
 */
export interface DaemonConnection {
  port: number;
  appToken: string | null;
  agentToken: string | null;
  /** Full API base URL override; when set, port is ignored. Set by the web demo. */
  baseUrl?: string | null;
}

/** The HTTP base for this daemon: the web demo's injected proxy URL, or the
 * desktop's loopback-port form. */
export function daemonBaseUrl(connection: DaemonConnection): string {
  return connection.baseUrl != null && connection.baseUrl !== ''
    ? connection.baseUrl
    : `http://127.0.0.1:${connection.port}`;
}

/** The credential to present, and whether it reaches decide tier. */
export interface DaemonAuth {
  /** Passed to `createApiClient`; `undefined` when we hold nothing at all. */
  token: string | undefined;
  /** True only with an app token — the daemon 403s decide routes otherwise. */
  canDecide: boolean;
}

/** Shown wherever a decide-tier action is unavailable. */
export const RESTART_FOR_APPROVALS = 'Restart daemon to enable approvals';

/**
 * Why approvals are off, in one sentence: this window attached to a daemon it
 * did not start, so it never saw the app token that daemon printed once at
 * startup.
 */
export const ATTACHED_DAEMON_EXPLANATION =
  "This window didn't start the daemon, so it can't approve scope requests. Use the app token the daemon printed at startup.";

/**
 * Picks the credential to send. The app token grants request tier as well as
 * decide tier, so when we have it there is never a reason to send the agent
 * token instead.
 */
export function resolveDaemonAuth(
  connection: DaemonConnection | undefined
): DaemonAuth {
  if (connection === undefined) return { token: undefined, canDecide: false };
  if (connection.appToken !== null && connection.appToken !== '') {
    return { token: connection.appToken, canDecide: true };
  }
  const agentToken = connection.agentToken;
  return {
    token: agentToken !== null && agentToken !== '' ? agentToken : undefined,
    canDecide: false,
  };
}

/**
 * Backstop for the decide-tier call sites: refuses locally rather than sending a
 * request the daemon can only answer with a 403, so the surface reports the
 * actionable sentence instead of an auth error.
 */
export function assertCanDecide(auth: DaemonAuth): void {
  if (!auth.canDecide) throw new Error(ATTACHED_DAEMON_EXPLANATION);
}

/**
 * True for the daemon's "valid token, wrong tier" rejection. Keys on the stable
 * `code` field rather than the message text, which is prose and will drift.
 * Reads `code` off the error or a nested body so it works with whatever shape
 * the client layer surfaces.
 */
export function isInsufficientTier(error: unknown): boolean {
  return errorCode(error) === 'auth_insufficient_tier';
}

/** True when the daemon rejected the credential outright rather than its tier. */
export function isMissingOrInvalidToken(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'auth_missing_token' || code === 'auth_invalid_token';
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const body = (error as { body?: unknown }).body;
  if (typeof body === 'object' && body !== null) {
    const nested = (body as { code?: unknown }).code;
    if (typeof nested === 'string') return nested;
  }
  return null;
}

/** Whether restarting the daemon is safe right now, and if not, why not. */
export interface RestartReadiness {
  safe: boolean;
  blockedReason: string | null;
}

/**
 * Restarting kills the daemon process, and agent runs execute inside it — a
 * restart with work in flight ends those runs. So the affordance is only
 * offered when every run this project knows about has already come to rest.
 */
export function daemonRestartReadiness(runs: RunMeta[]): RestartReadiness {
  const live = runs.filter((run) => !isTerminalRunState(run.state));
  if (live.length === 0) return { safe: true, blockedReason: null };
  const noun = live.length === 1 ? 'run is' : 'runs are';
  return {
    safe: false,
    blockedReason: `${live.length} ${noun} still in flight. Restarting dispatchd would end ${live.length === 1 ? 'it' : 'them'}. Wait for ${live.length === 1 ? 'it' : 'them'} to finish, or cancel first.`,
  };
}

/** Everything a decide-tier surface needs to render itself honestly. */
export interface DecideAvailability {
  enabled: boolean;
  /** Present exactly when `enabled` is false. */
  notice: string | null;
  explanation: string | null;
  restart: RestartReadiness | null;
}

export function decideAvailability(
  auth: DaemonAuth,
  runs: RunMeta[]
): DecideAvailability {
  if (auth.canDecide) {
    return { enabled: true, notice: null, explanation: null, restart: null };
  }
  return {
    enabled: false,
    notice: RESTART_FOR_APPROVALS,
    explanation: ATTACHED_DAEMON_EXPLANATION,
    restart: daemonRestartReadiness(runs),
  };
}
