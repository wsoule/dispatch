// An in-memory Linear OAuth server for the sign-in tests: registered apps
// (client id, exact redirect URIs, optional secret), people in workspaces,
// the authorize step, the token endpoint (PKCE S256 check, single-use codes,
// rotating refresh tokens with an optional replay grace) and both revoke
// forms. Its GraphQL endpoint answers `Identity` and `Viewer` for whichever
// credential a request carries: a bare API key or a `Bearer` OAuth token.
// It is a `fetch` for unit tests and `serve()` (127.0.0.1) for listener
// tests and the browser smoke. Nothing here reaches the network.
import { createHash, randomBytes } from 'node:crypto';

export interface FakeOAuthUser {
  id: string;
  name: string;
  displayName: string;
  email: string;
  guest?: boolean;
  admin?: boolean;
}

export interface FakeOAuthOrg {
  id: string;
  name: string;
  urlKey: string;
}

interface CodeGrant {
  clientId: string;
  redirectUri: string;
  challenge: string;
  userId: string;
  orgId: string;
  used: boolean;
}

interface Grant {
  clientId: string;
  userId: string;
  orgId: string;
  access: string;
  refresh: string;
  scope: string[];
  alive: boolean;
  /** The pair a refresh replaced this one with, for the replay grace. */
  next: Grant | null;
  rotatedAt: number | null;
}

/** One request the fake answered: the endpoint and what came with it. */
export interface FakeOAuthCall {
  endpoint: 'authorize' | 'token' | 'revoke' | 'graphql';
  form: Record<string, string>;
  authorization: string | null;
  operation?: string;
}

/** What `authorize` does with the next consent: approve as a person, deny,
 *  or approve in another workspace. */
export type FakeConsent =
  | { approve: string; orgId?: string }
  | { deny: true }
  | { error: string };

const random = () => randomBytes(18).toString('base64url');

/** An in-memory Linear OAuth server. */
export class LinearOAuthFake {
  readonly orgs = new Map<string, FakeOAuthOrg>();
  readonly users = new Map<string, { user: FakeOAuthUser; orgId: string }>();
  /** Raw `lin_api_` keys -> the person they act as. */
  readonly apiKeys = new Map<string, string>();
  readonly calls: FakeOAuthCall[] = [];
  /** How the next authorize answers. */
  consent: FakeConsent = { approve: 'u-ada' };
  /** How long an old refresh token still answers with the pair it already
   *  got (Linear's lost-response replay); 0 refuses it at once. */
  replayGraceMs = 0;
  /** The first revoke form (token + hint) answers this status instead. */
  revokeFirstForm: 200 | 400 | 401 = 200;
  /** The next token-endpoint call fails this way instead of answering. */
  failNextToken: 'network' | 500 | 'invalid_grant' | null = null;
  /** The next token-endpoint call answers exactly this instead. */
  answerNextToken: { status: number; body: unknown } | null = null;
  /** Refresh answers leave `scope` out, as Linear sometimes does. */
  omitScopeOnRefresh = false;
  /** Scope a grant is issued with (Linear may grant less than asked). */
  grantScope: string | null = null;
  /** Holds every token-endpoint answer until it resolves, for races. */
  tokenGate: Promise<void> | null = null;
  private readonly apps = new Map<
    string,
    { redirectUris: string[]; secret: string | null }
  >();
  private readonly codes = new Map<string, CodeGrant>();
  private readonly byAccess = new Map<string, Grant>();
  private readonly byRefresh = new Map<string, Grant>();
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor() {
    this.addOrg({ id: 'org-1', name: 'Acme', urlKey: 'acme' });
    this.addOrg({ id: 'org-2', name: 'Other Co', urlKey: 'other' });
    this.addUser(
      {
        id: 'u-ada',
        name: 'Ada Lovelace',
        displayName: 'ada',
        email: 'ada@example.com',
      },
      'org-1'
    );
    this.addUser(
      {
        id: 'u-key',
        name: 'Key Holder',
        displayName: 'key',
        email: 'key@example.com',
      },
      'org-1'
    );
    this.addUser(
      {
        id: 'u-ada-other',
        name: 'Ada Lovelace',
        displayName: 'ada',
        email: 'ada@other.example',
      },
      'org-2'
    );
    this.apiKeys.set('lin_api_project_key', 'u-key');
  }

  addOrg(org: FakeOAuthOrg): void {
    this.orgs.set(org.id, org);
  }

  addUser(user: FakeOAuthUser, orgId: string): void {
    this.users.set(user.id, { user, orgId });
  }

  registerApp(
    clientId: string,
    redirectUris: string[],
    secret: string | null = null
  ): void {
    this.apps.set(clientId, { redirectUris, secret });
  }

  /** Grants that are still alive. */
  liveGrants(): number {
    return [...new Set(this.byRefresh.values())].filter((g) => g.alive).length;
  }

  /** Whether an access token still works. */
  accessAlive(access: string): boolean {
    return this.byAccess.get(access)?.alive === true;
  }

  /** Ends an access token without telling anyone (an expiry Linear enforces
   *  early); its refresh token keeps working. */
  killAccess(access: string): void {
    const grant = this.byAccess.get(access);
    if (grant !== undefined) this.byAccess.delete(access);
  }

  /** Ends a whole grant, as revoking it in Linear's settings would. */
  revokeAll(): void {
    for (const g of this.byRefresh.values()) g.alive = false;
  }

  /** Calls to one endpoint, in order. */
  callsTo(endpoint: FakeOAuthCall['endpoint']): FakeOAuthCall[] {
    return this.calls.filter((c) => c.endpoint === endpoint);
  }

  /**
   * The consent step: checks the app and redirect URI exactly as Linear does
   * and answers the URL Linear would redirect the browser to (the callback
   * with `code` and `state`, or an `error`). Null when Linear would show an
   * error page instead of redirecting.
   */
  authorize(authorizeUrl: string): string | null {
    const url = new URL(authorizeUrl);
    const q = url.searchParams;
    this.calls.push({
      endpoint: 'authorize',
      form: Object.fromEntries(q),
      authorization: null,
    });
    const clientId = q.get('client_id') ?? '';
    const redirectUri = q.get('redirect_uri') ?? '';
    const app = this.apps.get(clientId);
    if (app === undefined || !app.redirectUris.includes(redirectUri))
      return null;
    if (
      q.get('response_type') !== 'code' ||
      q.get('code_challenge_method') !== 'S256' ||
      (q.get('code_challenge') ?? '') === ''
    )
      return null;
    const back = new URL(redirectUri);
    const state = q.get('state');
    if (state !== null) back.searchParams.set('state', state);
    const consent = this.consent;
    if ('deny' in consent) {
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set(
        'error_description',
        '<script>alert(1)</script> denied'
      );
      return back.toString();
    }
    if ('error' in consent) {
      back.searchParams.set('error', consent.error);
      return back.toString();
    }
    const person = this.users.get(consent.approve);
    if (person === undefined) return null;
    const code = `code_${random()}`;
    this.codes.set(code, {
      clientId,
      redirectUri,
      challenge: q.get('code_challenge') ?? '',
      userId: consent.approve,
      orgId: consent.orgId ?? person.orgId,
      used: false,
    });
    back.searchParams.set('code', code);
    return back.toString();
  }

  private issue(
    clientId: string,
    userId: string,
    orgId: string,
    scope: string[]
  ): Grant {
    const grant: Grant = {
      clientId,
      userId,
      orgId,
      access: `lin_oauth_access_${random()}`,
      refresh: `lin_oauth_refresh_${random()}`,
      scope,
      alive: true,
      next: null,
      rotatedAt: null,
    };
    this.byAccess.set(grant.access, grant);
    this.byRefresh.set(grant.refresh, grant);
    return grant;
  }

  private tokenBody(grant: Grant): Record<string, unknown> {
    return {
      access_token: grant.access,
      token_type: 'Bearer',
      expires_in: 86_399,
      scope: grant.scope.join(' '),
      refresh_token: grant.refresh,
    };
  }

  // Checks the client half of a token-endpoint form.
  private clientOk(form: Record<string, string>): boolean {
    const app = this.apps.get(form.client_id ?? '');
    if (app === undefined) return false;
    return (
      app.secret === null ||
      form.client_secret === undefined ||
      form.client_secret === app.secret
    );
  }

  private token(form: Record<string, string>): {
    status: number;
    body: unknown;
  } {
    const answer = this.answerNextToken;
    this.answerNextToken = null;
    if (answer !== null) return answer;
    const failure = this.failNextToken;
    this.failNextToken = null;
    if (failure === 500) return { status: 500, body: 'upstream failure' };
    if (failure === 'invalid_grant')
      return { status: 400, body: { error: 'invalid_grant' } };
    if (!this.clientOk(form))
      return { status: 401, body: { error: 'invalid_client' } };
    if (form.grant_type === 'authorization_code') {
      const grant = this.codes.get(form.code ?? '');
      const expected =
        grant === undefined
          ? null
          : createHash('sha256')
              .update(form.code_verifier ?? '')
              .digest('base64url');
      if (
        grant === undefined ||
        grant.used ||
        grant.clientId !== form.client_id ||
        grant.redirectUri !== form.redirect_uri ||
        expected !== grant.challenge
      ) {
        if (grant !== undefined) grant.used = true;
        return {
          status: 400,
          body: {
            error: 'invalid_grant',
            error_description: `code ${form.code ?? ''} rejected`,
          },
        };
      }
      grant.used = true;
      const scope = (this.grantScope ?? 'read write').split(' ');
      return {
        status: 200,
        body: this.tokenBody(
          this.issue(grant.clientId, grant.userId, grant.orgId, scope)
        ),
      };
    }
    if (form.grant_type === 'refresh_token') {
      const grant = this.byRefresh.get(form.refresh_token ?? '');
      if (grant === undefined || grant.clientId !== form.client_id)
        return { status: 400, body: { error: 'invalid_grant' } };
      if (grant.next !== null) {
        const inGrace =
          grant.rotatedAt !== null &&
          Date.now() - grant.rotatedAt < this.replayGraceMs &&
          grant.next.alive;
        return inGrace
          ? { status: 200, body: this.tokenBody(grant.next) }
          : { status: 400, body: { error: 'invalid_grant' } };
      }
      if (!grant.alive)
        return { status: 400, body: { error: 'invalid_grant' } };
      const next = this.issue(
        grant.clientId,
        grant.userId,
        grant.orgId,
        grant.scope
      );
      grant.alive = false;
      grant.next = next;
      grant.rotatedAt = Date.now();
      this.byAccess.delete(grant.access);
      const body = this.tokenBody(next);
      if (this.omitScopeOnRefresh) delete body.scope;
      return { status: 200, body };
    }
    return { status: 400, body: { error: 'unsupported_grant_type' } };
  }

  private revoke(
    form: Record<string, string>,
    authorization: string | null
  ): number {
    if (authorization?.startsWith('Bearer ') === true) {
      const grant = this.byAccess.get(authorization.slice(7));
      if (grant === undefined) return 401;
      grant.alive = false;
      this.byAccess.delete(grant.access);
      return 200;
    }
    if (this.revokeFirstForm !== 200) return this.revokeFirstForm;
    if (!this.clientOk(form)) return 401;
    const grant =
      this.byRefresh.get(form.token ?? '') ??
      this.byAccess.get(form.token ?? '');
    if (grant !== undefined) {
      grant.alive = false;
      this.byAccess.delete(grant.access);
    }
    return 200;
  }

  /** The person and workspace a request's credential acts as, or null. */
  whoIs(
    authorization: string | null
  ): { user: FakeOAuthUser; org: FakeOAuthOrg } | null {
    if (authorization === null) return null;
    let userId: string | undefined;
    let orgId: string | undefined;
    if (authorization.startsWith('Bearer ')) {
      const grant = this.byAccess.get(authorization.slice(7));
      if (grant === undefined || !grant.alive) return null;
      userId = grant.userId;
      orgId = grant.orgId;
    } else {
      userId = this.apiKeys.get(authorization);
      orgId = userId === undefined ? undefined : this.users.get(userId)?.orgId;
    }
    const person = userId === undefined ? undefined : this.users.get(userId);
    const org = orgId === undefined ? undefined : this.orgs.get(orgId);
    return person === undefined || org === undefined
      ? null
      : { user: person.user, org };
  }

  private graphql(
    body: { query?: string },
    authorization: string | null
  ): { status: number; body: unknown } {
    const operation =
      /(?:query|mutation)\s+(\w+)/.exec(body.query ?? '')?.[1] ?? '';
    this.calls.push({
      endpoint: 'graphql',
      form: {},
      authorization,
      operation,
    });
    const who = this.whoIs(authorization);
    if (who === null)
      return {
        status: 401,
        body: {
          errors: [
            {
              message: 'Authentication required, not authenticated',
              extensions: { code: 'AUTHENTICATION_ERROR' },
            },
          ],
        },
      };
    const viewer = {
      id: who.user.id,
      name: who.user.name,
      displayName: who.user.displayName,
      email: who.user.email,
      avatarUrl: null,
      active: true,
      admin: who.user.admin === true,
      guest: who.user.guest === true,
    };
    if (operation === 'Identity')
      return { status: 200, body: { data: { viewer, organization: who.org } } };
    if (operation === 'Viewer')
      return { status: 200, body: { data: { viewer } } };
    return {
      status: 400,
      body: { errors: [{ message: `fake has no ${operation}` }] },
    };
  }

  /** Answers one request the way Linear's OAuth and GraphQL endpoints would. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const authorization = request.headers.get('authorization');
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.pathname === '/oauth/authorize' && request.method === 'GET') {
      const back = this.authorize(url.toString());
      return back === null
        ? new Response('no such app or redirect', { status: 400 })
        : new Response(null, { status: 302, headers: { location: back } });
    }
    if (url.pathname === '/graphql' && request.method === 'POST') {
      const answer = this.graphql(
        (await request.json()) as { query?: string },
        authorization
      );
      return json(answer.status, answer.body);
    }
    const form = Object.fromEntries(
      new URLSearchParams(await request.text())
    ) as Record<string, string>;
    if (url.pathname === '/oauth/token' && request.method === 'POST') {
      this.calls.push({ endpoint: 'token', form, authorization });
      if (this.failNextToken === 'network') {
        this.failNextToken = null;
        throw new TypeError('fetch failed');
      }
      if (this.tokenGate !== null) await this.tokenGate;
      const answer = this.token(form);
      return json(answer.status, answer.body);
    }
    if (url.pathname === '/oauth/revoke' && request.method === 'POST') {
      this.calls.push({ endpoint: 'revoke', form, authorization });
      const status = this.revoke(form, authorization);
      return new Response(status === 200 ? '' : '{"error":"invalid_client"}', {
        status,
      });
    }
    return new Response('not found', { status: 404 });
  }

  /** A `fetch` that answers from this fake; any other host throws. */
  readonly fetch = (async (input: unknown, init?: RequestInit) => {
    const request = new Request(String(input), init);
    return this.handle(request);
  }) as unknown as typeof fetch;

  /** Serves the fake on 127.0.0.1 (an OS-assigned port unless given). */
  serve(port = 0): { origin: string; port: number } {
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: async (request) => {
        try {
          return await this.handle(request);
        } catch {
          return new Response('fake failure', { status: 502 });
        }
      },
    });
    const bound = this.server.port ?? port;
    return { origin: `http://127.0.0.1:${bound}`, port: bound };
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = null;
  }
}
