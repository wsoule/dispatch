// "Sign in with Linear": the flow that starts on the daemon's API and ends
// on a short-lived loopback listener Linear redirects the browser to.
//
// Linear matches the redirect URI exactly, port included, while every
// daemon's own port is chosen by the OS per project, so the callback is a
// fixed port (`linear.oauthCallbackPort`, default 47823) on 127.0.0.1 that
// the daemon opens only while a sign-in waits. It is bound before the
// consent URL is handed out, so a process squatting on the port blocks the
// sign-in instead of receiving a code, and a code without the PKCE verifier
// held in this process's memory is useless anyway.
//
// The pending flow (state, verifier, expected workspace) is never written
// anywhere and never returned. The callback page carries no script, link or
// external resource, and never the code, the state, or Linear's own text.
import { publicLinearAccount } from '@dispatch-foo/core';
import type { LinearConfig, PublicLinearAccount } from '@dispatch-foo/core';
import { createHash, timingSafeEqual } from 'node:crypto';

import type { LinearAccounts } from './accounts.js';
import type {
  LinearAuth,
  LinearClient,
  LinearFailure,
  LinearIdentity,
  LinearResult,
} from './client.js';
import type { OAuthEndpoints } from './oauth.js';
import {
  buildAuthorizeUrl,
  createOAuthState,
  createPkcePair,
  exchangeCode,
  OAuthError,
} from './oauth.js';

/** The callback port when config names none. */
const DEFAULT_CALLBACK_PORT = 47823;

/** Dispatch's own public Linear OAuth app, used when neither the env var
 *  nor the project config names one, so every project can sign in with no
 *  setup. Not a secret: sign-in is PKCE. Its registered callback is
 *  http://127.0.0.1:47823/linear/callback. */
export const BUILT_IN_LINEAR_CLIENT_ID: string | null =
  '796cca6c4836cceedddb5200c7bfd9a9';

/** How long a started sign-in waits for Linear's redirect. */
const SIGN_IN_TTL_MS = 10 * 60_000;

const CALLBACK_PATH = '/linear/callback';

/** Where sign-in's settings come from, read on every start and view. */
export interface LinearSignInConfig {
  clientId: string | null;
  clientIdSource: 'env' | 'config' | 'builtin' | null;
  port: number;
  /** The exact URL to register in Linear; not a secret. */
  redirectUri: string;
}

// A non-blank, trimmed value, or null; an empty string counts as unset.
function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
}

/** The client ID (DISPATCH_LINEAR_CLIENT_ID, then linear.oauthClientId, then
 *  Dispatch's built-in app), the callback port and the redirect URI derived
 *  from it. The built-in app always uses the default port, the only callback
 *  registered for it. The client secret is not here: the daemon reads it
 *  once at boot and removes it from its environment (daemonMain.ts), so no
 *  child process inherits it. */
export function resolveLinearSignInConfig(
  linear: Pick<LinearConfig, 'oauthClientId' | 'oauthCallbackPort'> | null,
  env: Record<string, string | undefined> = process.env,
  builtIn: string | null = BUILT_IN_LINEAR_CLIENT_ID
): LinearSignInConfig {
  const fromEnv = nonBlank(env.DISPATCH_LINEAR_CLIENT_ID);
  const fromConfig = nonBlank(linear?.oauthClientId);
  const fromBuiltIn = nonBlank(builtIn);
  const own = fromEnv ?? fromConfig;
  const clientId = own ?? fromBuiltIn;
  const clientIdSource =
    fromEnv !== null
      ? 'env'
      : fromConfig !== null
        ? 'config'
        : fromBuiltIn !== null
          ? 'builtin'
          : null;
  const port =
    clientIdSource === 'builtin'
      ? DEFAULT_CALLBACK_PORT
      : (linear?.oauthCallbackPort ?? DEFAULT_CALLBACK_PORT);
  return {
    clientId,
    clientIdSource,
    port,
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
  };
}

export type LinearSignInProblemCode =
  | 'denied'
  | 'wrong-workspace'
  | 'expired'
  | 'ended'
  | 'failed';

/** What GET /api/linear/account answers; never a token. */
export interface LinearAccountView {
  /** True only for the owner's own credential, configured and connected. */
  canSignIn: boolean;
  unavailable:
    | 'teammate'
    | 'attached'
    | 'not-configured'
    | 'not-connected'
    | null;
  /** The exact URL to register in Linear; not a secret. */
  callbackUrl: string;
  clientIdSource: 'env' | 'config' | 'builtin' | null;
  /** Owner only; false for everyone else. */
  pending: boolean;
  /** The signed-in person for this project's workspace; owner only. Shown
   *  whatever the setup says, so a sign-in can always be ended. */
  account: PublicLinearAccount | null;
  /** Every sign-in stored on this computer, when this project's Linear
   *  workspace cannot be told now (no connection, or Linear could not say
   *  and this daemon never learned it); empty otherwise. Owner only; each
   *  can be signed out of by its workspace id, with no Linear lookup. */
  stored: PublicLinearAccount[];
  /** The project connection's Linear user and workspace; owner only. */
  connection: {
    /** The Linear user the project's API key acts as, to tell the person
     *  when tasks assigned to them still map to someone else. */
    userId: string;
    userName: string;
    workspace: { id: string; name: string; urlKey: string };
  } | null;
  problem: { code: LinearSignInProblemCode; message: string } | null;
}

/** Who asks for the view: the daemon's owner on their app token, the shared
 *  agent token (the CLI, agents, a window attached without the app token),
 *  or anyone else (a teammate). */
export type LinearSignInViewer = 'owner' | 'agent' | 'teammate';

/** A start's refusal, for the route to answer. */
export interface SignInRefusal {
  status: number;
  error: string;
  code: string;
}

export interface LinearSignInDeps {
  /** The project's config's `linear:` block, or null when it cannot be read. */
  linearConfig: () => Pick<
    LinearConfig,
    'oauthClientId' | 'oauthCallbackPort'
  > | null;
  accounts: LinearAccounts;
  /** The project connection's identity (cached by the engine), or null when
   *  no API key resolves. */
  connection: () => Promise<LinearResult<LinearIdentity> | null>;
  /** The connection's identity as this daemon last learned it, for when
   *  Linear cannot say now; null when it never did. */
  lastConnection: () => LinearIdentity | null;
  /** A client acting with `auth`, for the new token's identity check. */
  personClient: (auth: LinearAuth) => LinearClient;
  endpoints?: OAuthEndpoints;
  fetchImpl?: typeof fetch;
  now?: () => number;
  env?: Record<string, string | undefined>;
  /** Replaces BUILT_IN_LINEAR_CLIENT_ID; null turns the built-in app off. */
  builtInClientId?: string | null;
  /** DISPATCH_LINEAR_CLIENT_SECRET as the daemon read it once at boot;
   *  never stored or shown. */
  clientSecret?: string;
  /** How long a flow waits; SIGN_IN_TTL_MS outside tests. */
  ttlMs?: number;
  /** Hears every change the app should refetch for (`config.changed`). */
  onChange?: () => void;
}

interface PendingFlow {
  state: string;
  stateDigest: Buffer;
  verifier: string;
  clientId: string;
  clientSecret: string | undefined;
  redirectUri: string;
  port: number;
  expected: LinearIdentity['organization'];
  server: ReturnType<typeof Bun.serve>;
  timer: ReturnType<typeof setTimeout>;
  /** Set once a code with the right state arrived: the flow is single use. */
  used: boolean;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest();

// HTML-escapes a name for the callback page.
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// The callback page: plain text in a fixed frame, no script, link or
// external load, and headers that keep it out of caches and referrers.
function page(status: number, title: string, message: string): Response {
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:15vh auto;max-width:32rem;padding:0 1rem}</style>
</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>
`;
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
    },
  });
}

// A fixed reason for a failed exchange or identity check, never Linear's text.
function failedReason(err: unknown): string {
  if (err instanceof OAuthError) {
    if (err.code === 'network_error') return 'Linear did not answer';
    if (err.code === 'invalid_grant') return 'Linear refused the sign-in code';
    if (err.code === 'invalid_client')
      return 'Linear does not know this client ID';
    if (err.code === 'invalid_response')
      return "Linear's answer could not be used";
    return 'Linear refused the sign-in';
  }
  if (err instanceof Error && err.name === 'CredentialsUnreadableError')
    return 'the credentials file cannot be read';
  return 'something went wrong';
}

/** One daemon's sign-in: at most one pending flow, and its last outcome. */
export class LinearSignIn {
  private flow: PendingFlow | null = null;
  private problem: { code: LinearSignInProblemCode; message: string } | null =
    null;

  constructor(private readonly deps: LinearSignInDeps) {}

  private config(): LinearSignInConfig {
    return resolveLinearSignInConfig(
      this.deps.linearConfig(),
      this.deps.env,
      this.deps.builtInClientId === undefined
        ? BUILT_IN_LINEAR_CLIENT_ID
        : this.deps.builtInClientId
    );
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Whether a sign-in is waiting for Linear's redirect. */
  get pending(): boolean {
    return this.flow !== null;
  }

  /**
   * Starts a sign-in: checks setup and the project connection, binds the
   * callback listener, and answers the consent URL. A pending flow on this
   * daemon is cancelled first.
   */
  async start(
    opts: { anotherWorkspace?: boolean } = {}
  ): Promise<
    | { ok: true; authorizeUrl: string }
    | { ok: false; refusal: SignInRefusal }
    | { ok: false; failure: LinearFailure }
  > {
    const config = this.config();
    if (config.clientId === null)
      return {
        ok: false,
        refusal: {
          status: 409,
          code: 'linear_sign_in_not_configured',
          error:
            'Sign in with Linear is not set up: register an OAuth application in Linear and set linear.oauthClientId (or DISPATCH_LINEAR_CLIENT_ID).',
        },
      };
    const connection = await this.deps.connection();
    if (connection === null)
      return {
        ok: false,
        refusal: {
          status: 409,
          code: 'linear_not_connected',
          error:
            'Connect this project to Linear with an API key before signing in.',
        },
      };
    if (!connection.ok) return { ok: false, failure: connection };
    this.cancel();
    this.problem = null;
    const pkce = createPkcePair();
    const state = createOAuthState();
    let server: ReturnType<typeof Bun.serve>;
    try {
      server = Bun.serve({
        hostname: '127.0.0.1',
        port: config.port,
        // Never Bun's error page, which could quote a request back.
        development: false,
        fetch: (request) => this.callback(request),
      });
    } catch {
      return {
        ok: false,
        refusal: {
          status: 409,
          code: 'linear_callback_port_busy',
          error: `Port ${config.port} is in use, so Dispatch cannot hear back from Linear. Finish or cancel the other sign-in, or change the callback port in setup (and in Linear).`,
        },
      };
    }
    const flow: PendingFlow = {
      state,
      stateDigest: sha256(state),
      verifier: pkce.verifier,
      clientId: config.clientId,
      clientSecret: nonBlank(this.deps.clientSecret) ?? undefined,
      redirectUri: config.redirectUri,
      port: config.port,
      expected: connection.data.organization,
      server,
      timer: setTimeout(() => {
        if (this.flow === flow)
          this.end(flow, {
            code: 'expired',
            message: 'Sign-in timed out. Start again when you are ready.',
          });
      }, this.deps.ttlMs ?? SIGN_IN_TTL_MS),
      used: false,
    };
    // The listener keeps the process up while it waits; the timer need not.
    flow.timer.unref?.();
    this.flow = flow;
    return {
      ok: true,
      authorizeUrl: buildAuthorizeUrl({
        ...(this.deps.endpoints === undefined
          ? {}
          : { endpoints: this.deps.endpoints }),
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        state,
        challenge: pkce.challenge,
        anotherWorkspace: opts.anotherWorkspace === true,
      }),
    };
  }

  /** Cancels a pending sign-in, closing its listener; shows no problem. */
  cancel(): void {
    const flow = this.flow;
    if (flow !== null) this.end(flow, null);
  }

  /** Stops everything this sign-in holds, for the daemon's shutdown. */
  stop(): void {
    const flow = this.flow;
    if (flow !== null) this.end(flow, null, true);
  }

  // Ends a flow: its timer and listener go, and `problem` is what the app
  // shows until the next attempt (null: nothing to show). The listener stops
  // taking requests at once and finishes the one it is answering, unless
  // `force` (shutdown) cuts it short.
  private end(
    flow: PendingFlow,
    problem: { code: LinearSignInProblemCode; message: string } | null,
    force = false
  ): void {
    if (this.flow === flow) this.flow = null;
    clearTimeout(flow.timer);
    void flow.server.stop(force);
    if (problem !== null) this.problem = problem;
    this.deps.onChange?.();
  }

  // One request to the callback listener. Linear's redirect is a top-level
  // navigation, so a request a browser marks as anything else (a page's
  // fetch or image load aimed at the port) is turned away. A wrong state
  // never ends the flow: a page could otherwise cancel a sign-in blind, and
  // the 10-minute expiry already bounds how long it waits.
  private async callback(request: Request): Promise<Response> {
    const flow = this.flow;
    const url = new URL(request.url);
    const mode = request.headers.get('sec-fetch-mode');
    if (
      flow === null ||
      request.method !== 'GET' ||
      url.pathname !== CALLBACK_PATH ||
      request.headers.get('host') !== `127.0.0.1:${flow.port}` ||
      (mode !== null && mode !== 'navigate')
    )
      return page(404, 'Not found', 'There is nothing here.');
    const state = url.searchParams.get('state') ?? '';
    if (!timingSafeEqual(sha256(state), flow.stateDigest)) {
      return page(
        400,
        'Not this sign-in',
        'This sign-in link is not the one Dispatch is waiting for. Start again from Dispatch.'
      );
    }
    if (flow.used)
      return page(
        409,
        'Already used',
        'This sign-in link was already used. Go back to Dispatch.'
      );
    const error = url.searchParams.get('error');
    if (error !== null) {
      if (error === 'access_denied') {
        this.end(flow, {
          code: 'denied',
          message: 'Sign-in was cancelled in Linear. Nothing changed.',
        });
        return page(
          200,
          'Sign-in cancelled',
          'Sign-in was cancelled. You can close this tab.'
        );
      }
      this.end(flow, {
        code: 'failed',
        message:
          'Could not finish signing in: Linear refused the sign-in. Try again.',
      });
      return page(
        400,
        'Sign-in failed',
        'Linear did not sign you in. Go back to Dispatch and try again.'
      );
    }
    const code = url.searchParams.get('code');
    if (code === null || code === '')
      return page(
        400,
        'Not this sign-in',
        'This link carries no sign-in code.'
      );
    flow.used = true;
    return this.finish(flow, code);
  }

  // Exchanges the code, checks the token's workspace, and stores it: the
  // callback page reports the outcome while the browser waits.
  private async finish(flow: PendingFlow, code: string): Promise<Response> {
    const callOptions = {
      ...(this.deps.endpoints === undefined
        ? {}
        : { endpoints: this.deps.endpoints }),
      ...(this.deps.fetchImpl === undefined
        ? {}
        : { fetchImpl: this.deps.fetchImpl }),
      now: () => this.now(),
    };
    const failed = (reason: string) => {
      this.end(flow, {
        code: 'failed',
        message: `Could not finish signing in: ${reason}. Try again.`,
      });
      return page(
        502,
        'Sign-in failed',
        `Dispatch could not finish signing you in: ${reason}. Go back to Dispatch and try again.`
      );
    };
    let tokens;
    try {
      tokens = await exchangeCode(
        {
          code,
          verifier: flow.verifier,
          clientId: flow.clientId,
          redirectUri: flow.redirectUri,
          ...(flow.clientSecret === undefined
            ? {}
            : { clientSecret: flow.clientSecret }),
        },
        callOptions
      );
    } catch (err) {
      return failed(failedReason(err));
    }
    const grant = {
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      clientId: flow.clientId,
    };
    const fixed: LinearAuth = {
      header: () =>
        Promise.resolve({ ok: true, value: `Bearer ${tokens.accessToken}` }),
      secrets: () => [tokens.accessToken, tokens.refreshToken],
      renew: () => Promise.resolve(false),
    };
    const identity = await this.deps.personClient(fixed).identity();
    // Cancelled (or replaced by a new start) while Linear answered: the
    // person no longer wants this grant, so it must not outlive the flow.
    if (this.flow !== flow) {
      await this.deps.accounts.revoke(grant);
      return page(
        409,
        'Sign-in cancelled',
        'This sign-in was cancelled in Dispatch. Nothing changed.'
      );
    }
    if (!identity.ok) {
      await this.deps.accounts.revoke(grant);
      return failed('Linear did not say who signed in');
    }
    const { viewer, organization } = identity.data;
    if (organization.id !== flow.expected.id) {
      await this.deps.accounts.revoke(grant);
      const message = `You signed in to ${organization.name}, but this project syncs with ${flow.expected.name}. Switch Linear to ${flow.expected.name} in your browser, then sign in again.`;
      this.end(flow, { code: 'wrong-workspace', message });
      return page(409, 'Wrong Linear workspace', message);
    }
    const now = new Date(this.now()).toISOString();
    try {
      await this.deps.accounts.save({
        version: 1,
        clientId: flow.clientId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope,
        user: {
          id: viewer.id,
          name: viewer.name,
          displayName: viewer.displayName,
          email: viewer.email,
          guest: viewer.guest,
          admin: viewer.admin,
        },
        organization,
        signedInAt: now,
        refreshedAt: null,
      });
    } catch (err) {
      await this.deps.accounts.revoke(grant);
      return failed(failedReason(err));
    }
    this.end(flow, null);
    this.problem = null;
    return page(
      200,
      'Signed in to Linear',
      `Signed in to Linear as ${viewer.name}. You can close this tab and go back to Dispatch.`
    );
  }

  /**
   * The account view for one caller. Only the owner sees who is signed in,
   * the connection's user and any problem; nobody sees a token. Teammates
   * cause no Linear call, and neither does a project with no sign-in set up
   * while nothing is stored on this computer. A stored sign-in is shown, with
   * its way out, whatever the setup says.
   */
  async view(viewer: LinearSignInViewer): Promise<LinearAccountView> {
    const config = this.config();
    const base: LinearAccountView = {
      canSignIn: false,
      unavailable: null,
      callbackUrl: config.redirectUri,
      clientIdSource: config.clientIdSource,
      pending: false,
      account: null,
      stored: [],
      connection: null,
      problem: null,
    };
    if (viewer !== 'owner')
      return {
        ...base,
        unavailable: viewer === 'agent' ? 'attached' : 'teammate',
      };
    const { accounts } = this.deps;
    const owner = { ...base, pending: this.pending, problem: this.problem };
    if (config.clientId === null && !accounts.any())
      return { ...owner, unavailable: 'not-configured' };
    const connection = await this.deps.connection();
    const unavailable =
      connection === null
        ? 'not-connected'
        : config.clientId === null
          ? 'not-configured'
          : null;
    const known = this.workspaceOf(connection);
    if (known === null)
      return {
        ...owner,
        unavailable,
        canSignIn: unavailable === null,
        stored: accounts.list().map(publicLinearAccount),
      };
    const { organization } = known;
    const record = accounts.read(organization.id);
    const ended = record === null ? accounts.endedFor(organization.id) : null;
    return {
      ...owner,
      unavailable,
      canSignIn: unavailable === null,
      account: record === null ? null : publicLinearAccount(record),
      connection: {
        userId: known.viewer.id,
        userName: known.viewer.name,
        workspace: { ...organization },
      },
      problem:
        this.problem ??
        (ended === null ? null : { code: 'ended', message: ended }),
    };
  }

  // The project connection's identity: as Linear says now, else as this
  // daemon last learned it while the key still resolves; null when no key
  // resolves or nothing was ever learned.
  private workspaceOf(
    connection: LinearResult<LinearIdentity> | null
  ): LinearIdentity | null {
    if (connection === null) return null;
    return connection.ok ? connection.data : this.deps.lastConnection();
  }

  /**
   * Signs out: deletes the stored sign-in, then revokes it at Linear. With
   * `workspaceId` (what the app sends, naming the account it shows), no
   * Linear lookup comes first, so a rotated project key or an unreachable
   * Linear never strands the token on disk. Without it, the project
   * connection's workspace, as Linear says or as last learned.
   */
  async signOut(
    workspaceId?: string
  ): Promise<
    | { ok: true; revoked: boolean }
    | { ok: false; refusal: SignInRefusal }
    | { ok: false; failure: LinearFailure }
  > {
    let orgId = workspaceId ?? null;
    if (orgId === null) {
      const connection = await this.deps.connection();
      if (connection === null)
        return {
          ok: false,
          refusal: {
            status: 409,
            code: 'linear_not_connected',
            error:
              'This project has no Linear connection; name the workspace to sign out of.',
          },
        };
      if (connection.ok) orgId = connection.data.organization.id;
      else {
        const last = this.deps.lastConnection();
        if (last === null) return { ok: false, failure: connection };
        orgId = last.organization.id;
      }
    }
    this.problem = null;
    const out = await this.deps.accounts.signOut(orgId);
    // Nothing stored means no grant is left to end.
    return { ok: true, revoked: out.signedOut ? out.revoked : true };
  }
}
