import { MessagingError } from '@dispatch-foo/protocol';
import type { Message, Sender } from '@dispatch-foo/protocol';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

import { handleOf, OAuthDb } from './db.js';
import type { Grant, TeamDb } from './db.js';
import type { TeamHub, TeamHubs } from './hub.js';
import type { TeamLinear } from './linear.js';
import { linearOp } from './linear.js';
import { consentPage, messagePage, PAGE_CSP, signInPage } from './pages.js';
import { webUserOf } from './web.js';

// The hosted MCP endpoint (/mcp) and the OAuth 2.1 server in front of it, so
// a client with no local process (claude.ai on the web and phone, or any
// remote-MCP client) joins the team by signing in: RFC 9728 resource
// metadata, RFC 8414 server metadata, RFC 7591 registration, PKCE (S256)
// codes and rotating refresh tokens. Its sessions live on the team hub, so
// teammates' agents on their own machines reach them like any other.

export interface McpDeps {
  db: TeamDb;
  hubs: TeamHubs;
  origin: string;
  linear: TeamLinear;
}

const UNREAD_STATES = ['held', 'notified', 'pushed'] as const;

function json(
  status: number,
  body: unknown,
  extra: Record<string, string> = {}
): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      ...extra,
    },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': PAGE_CSP,
    },
  });
}

// A redirect URI a public client may register: https, or loopback http.
function allowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash !== '') return false;
    if (u.protocol === 'https:') return true;
    return (
      u.protocol === 'http:' &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

async function fields(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const body = (await req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return Object.fromEntries(
      Object.entries(body).filter(
        (e): e is [string, string] => typeof e[1] === 'string'
      )
    );
  }
  return Object.fromEntries(new URLSearchParams(await req.text()));
}

function sessionSuffix(grantId: string): string {
  return createHash('sha256').update(grantId).digest('hex').slice(0, 6);
}

// The agent a grant speaks as on its team hub: a client identity for the
// app (e.g. agent:ada/claude) and this grant's session under it.
function sessionOf(hub: TeamHub, grant: Grant, clientName: string): string {
  const login = grant.user.login;
  // Hosted names carry ".web", apart from any agent a machine registers.
  const derived = handleOf(clientName).slice(0, 26);
  const client = derived === '' ? 'agent' : derived;
  const parent = `agent:${login}/${client}.web`;
  const session = `agent:${login}/${client}.web-${sessionSuffix(grant.id)}`;
  const now = new Date().toISOString();
  let changed = false;
  for (const [address, isSession] of [
    [parent, false],
    [session, true],
  ] as const) {
    const row = hub.store.getAgent(address);
    // Never speak as an agent this endpoint did not make (a machine's).
    if (row !== null && !row.tokenHash.startsWith('hosted:'))
      throw new Error(`${address} belongs to one of your machines`);
    if (row === null) {
      hub.store.putAgent({
        address,
        displayName: address.slice(address.indexOf('/') + 1),
        client: clientName.slice(0, 100),
        tokenHash: `hosted:${randomBytes(12).toString('hex')}`,
        status: 'approved',
        muted: false,
        approvedBy: `human:${login}`,
        createdAt: now,
        ...(isSession
          ? {
              parent,
              meta: { kind: 'session', client: clientName.slice(0, 100) },
            }
          : {}),
        lastSeen: now,
      });
      changed = true;
    } else hub.store.touchAgent(address, now);
  }
  if (changed) hub.rosterChanged();
  return session;
}

function text(value: unknown, footer: string | null = null) {
  const content = [{ type: 'text' as const, text: JSON.stringify(value) }];
  if (footer !== null) content.push({ type: 'text' as const, text: footer });
  return { content };
}

function failure(err: unknown) {
  const message =
    err instanceof MessagingError || err instanceof Error
      ? err.message
      : String(err);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

// The tools a hosted session has: the same names as the local MCP's.
function buildServer(
  hub: TeamHub,
  address: string,
  linear: TeamLinear,
  teamId: string
): McpServer {
  const server = new McpServer({ name: 'dispatch', version: '0.1.0' });
  const sender: Sender = { address, canDecide: false };
  const unread = () => hub.engine.inbox(address, [...UNREAD_STATES]);
  const footer = (): string | null => {
    const items = unread();
    if (items.length === 0) return null;
    const from = [...new Set(items.map((i) => i.message.from))].slice(0, 3);
    return `[dispatch] ${items.length} unread (from ${from.join(', ')}). Call inbox_read.`;
  };

  server.registerTool(
    'whoami',
    {
      description:
        'Your Dispatch address (teammates reach you there) and how much unread mail you have.',
    },
    () => text({ address, kind: 'session', unread: unread().length })
  );
  server.registerTool(
    'agent_list',
    {
      description:
        "Every agent session on your team, live first: teammates' Claude Code, Codex, Cursor and other agents, and yours.",
    },
    () =>
      text(
        {
          agents: hub
            .sessions()
            .map((s) => (s.address === address ? { ...s, you: true } : s)),
        },
        footer()
      )
  );
  server.registerTool(
    'msg_send',
    {
      description:
        'Send a message to agent:<handle>/<name> addresses from agent_list. kind is message, question or notice.',
      inputSchema: {
        to: z.array(z.string()).min(1),
        kind: z.enum(['message', 'question', 'notice']),
        body: z.string(),
      },
    },
    async ({ to, kind, body }) => {
      try {
        const result = await hub.engine.send({ to, kind, body }, sender);
        return text(
          { message: { id: result.message.id, thread: result.message.thread } },
          footer()
        );
      } catch (err) {
        return failure(err);
      }
    }
  );
  server.registerTool(
    'msg_reply',
    {
      description: 'Reply to a message by its id, in its thread.',
      inputSchema: {
        messageId: z.string(),
        body: z.string(),
        choice: z.string().optional(),
      },
    },
    async ({ messageId, body, choice }) => {
      try {
        const result = await hub.engine.reply(
          messageId,
          { body, ...(choice === undefined ? {} : { choice }) },
          sender
        );
        return text(
          { message: { id: result.message.id, thread: result.message.thread } },
          footer()
        );
      } catch (err) {
        return failure(err);
      }
    }
  );
  server.registerTool(
    'inbox_read',
    {
      description:
        'Read your unread messages, newest first, and mark them read.',
    },
    () => {
      const items = unread().toReversed().slice(0, 50);
      for (const item of items) hub.engine.markRead(item.delivery.id);
      return text({
        items: items.map((i) => ({
          id: i.message.id,
          thread: i.message.thread,
          from: i.message.from,
          kind: i.message.kind,
          body: i.message.body,
          at: i.message.createdAt,
        })),
      });
    }
  );
  server.registerTool(
    'thread_read',
    {
      description: 'Read a whole conversation by its thread id.',
      inputSchema: { threadId: z.string() },
    },
    ({ threadId }) => {
      if (!hub.engine.canReadThread(threadId, sender))
        return failure(new Error(`no message ${threadId}`));
      const { messages } = hub.engine.thread(threadId);
      return text(
        {
          messages: messages.map((m: Message) => ({
            id: m.id,
            from: m.from,
            kind: m.kind,
            body: m.body,
            at: m.createdAt,
          })),
        },
        footer()
      );
    }
  );
  const linearTool = (
    name: string,
    op: string,
    description: string,
    shape: z.ZodRawShape
  ) =>
    server.registerTool(
      name,
      { description, inputSchema: shape },
      async (args: Record<string, unknown>) => {
        try {
          return text(
            await linearOp(linear, teamId, address, op, args),
            footer()
          );
        } catch (err) {
          return failure(err);
        }
      }
    );
  linearTool('linear_search', 'search', "Search your team's Linear issues.", {
    query: z.string(),
  });
  linearTool(
    'linear_issue',
    'issue',
    'Read a Linear issue by identifier (e.g. ENG-123): description, state, comments.',
    { id: z.string() }
  );
  linearTool(
    'linear_comment',
    'comment',
    'Comment on a Linear issue; the comment names you as its author.',
    { id: z.string(), body: z.string() }
  );
  linearTool(
    'linear_state',
    'state',
    'Move a Linear issue to a workflow state by name (e.g. "In Progress").',
    { id: z.string(), state: z.string() }
  );
  linearTool(
    'linear_watch',
    'watch',
    'Get a notice whenever a Linear issue changes or gets a comment (stop: true to stop).',
    {
      id: z.string(),
      stop: z.boolean().optional(),
    }
  );
  server.registerTool(
    'session_label',
    {
      description:
        'Say what this session is working on, so teammates can tell it apart.',
      inputSchema: { label: z.string().min(1).max(200) },
    },
    ({ label }) => {
      const row = hub.store.getAgent(address);
      if (row !== null) {
        hub.store.putAgent({ ...row, meta: { ...row.meta, label } });
        hub.rosterChanged();
      }
      return text({ address, label });
    }
  );
  return server;
}

export function mcpHandler(
  deps: McpDeps
): (req: Request) => Promise<Response | null> {
  const { db, hubs, origin } = deps;
  const oauth = new OAuthDb(db);
  const resource = `${origin}/mcp`;
  const resourceMetadata = `${origin}/.well-known/oauth-protected-resource`;

  return async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (
      method === 'OPTIONS' &&
      (path.startsWith('/oauth/') ||
        path.startsWith('/.well-known/') ||
        path === '/mcp')
    )
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-allow-headers':
            'authorization, content-type, mcp-protocol-version, mcp-session-id',
        },
      });

    if (
      path === '/.well-known/oauth-protected-resource' ||
      path === '/.well-known/oauth-protected-resource/mcp'
    )
      return json(200, {
        resource,
        authorization_servers: [origin],
        bearer_methods_supported: ['header'],
      });
    if (path === '/.well-known/oauth-authorization-server')
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });

    if (path === '/oauth/register' && method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as {
        client_name?: unknown;
        redirect_uris?: unknown;
      };
      const uris = Array.isArray(body.redirect_uris)
        ? body.redirect_uris.filter((u): u is string => typeof u === 'string')
        : [];
      if (uris.length === 0 || uris.length > 10 || !uris.every(allowedRedirect))
        return json(400, {
          error: 'invalid_redirect_uri',
          error_description: 'https (or loopback http) redirect URIs only',
        });
      const client = oauth.registerClient(
        typeof body.client_name === 'string' ? body.client_name : 'MCP client',
        uris
      );
      return json(201, {
        client_id: client.id,
        client_name: client.name,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    }

    if (path === '/oauth/authorize') {
      const params =
        method === 'POST'
          ? await fields(req)
          : Object.fromEntries(url.searchParams);
      const client = oauth.client(params.client_id ?? '');
      const redirectUri = params.redirect_uri ?? '';
      // Nothing redirects anywhere until the client and its URI check out.
      if (client === null || !client.redirectUris.includes(redirectUri))
        return html(
          messagePage(
            null,
            'Unknown app',
            'This connection request names an app or return address Dispatch does not know.'
          ),
          400
        );
      const back = (query: Record<string, string>): Response => {
        const target = new URL(redirectUri);
        for (const [k, v] of Object.entries(query))
          target.searchParams.set(k, v);
        if (params.state !== undefined)
          target.searchParams.set('state', params.state);
        target.searchParams.set('iss', origin);
        return new Response(null, {
          status: 303,
          headers: { location: target.toString() },
        });
      };
      // With open registration a redirect URI proves nothing, so nothing goes
      // back to one until a signed-in person has chosen Allow or Deny.
      if (
        params.response_type !== 'code' ||
        params.code_challenge_method !== 'S256' ||
        (params.code_challenge ?? '') === ''
      )
        return html(
          messagePage(
            null,
            'Bad request',
            'This app asked to connect without PKCE (S256); Dispatch only supports that.'
          ),
          400
        );
      const user = webUserOf(db, req);
      if (user === null) return html(signInPage(`${path}${url.search}`, false));
      if (method === 'GET')
        return html(
          consentPage({
            user,
            client: client.name,
            redirectHost: new URL(redirectUri).host,
            teams: db.teamsOf(user.id),
            hidden: {
              client_id: client.id,
              redirect_uri: redirectUri,
              response_type: 'code',
              code_challenge: params.code_challenge ?? '',
              code_challenge_method: 'S256',
              ...(params.state === undefined ? {} : { state: params.state }),
            },
          })
        );
      const from = req.headers.get('origin');
      if (from !== null && from !== origin)
        return html(
          messagePage(user, 'Refused', 'That form came from another site.'),
          403
        );
      if (params.decision !== 'allow') return back({ error: 'access_denied' });
      const teamId = params.team ?? '';
      if (db.role(teamId, user.id) === null)
        return back({ error: 'access_denied' });
      return back({
        code: oauth.issueCode({
          clientId: client.id,
          userId: user.id,
          teamId,
          redirectUri,
          challenge: params.code_challenge ?? '',
        }),
      });
    }

    if (path === '/oauth/token' && method === 'POST') {
      const f = await fields(req);
      const tokens =
        f.grant_type === 'authorization_code'
          ? oauth.redeemCode({
              code: f.code ?? '',
              clientId: f.client_id ?? '',
              redirectUri: f.redirect_uri ?? '',
              verifier: f.code_verifier ?? '',
            })
          : f.grant_type === 'refresh_token'
            ? oauth.refresh(f.refresh_token ?? '', f.client_id ?? '')
            : undefined;
      if (tokens === undefined)
        return json(400, { error: 'unsupported_grant_type' });
      if (tokens === null) return json(400, { error: 'invalid_grant' });
      return json(200, {
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
      });
    }

    if (path === '/mcp') {
      const header = req.headers.get('authorization') ?? '';
      const grant = header.startsWith('Bearer ')
        ? oauth.grant(header.slice(7))
        : null;
      if (grant === null)
        return json(
          401,
          { error: 'invalid_token' },
          {
            'www-authenticate': `Bearer resource_metadata="${resourceMetadata}"`,
          }
        );
      const hub = hubs.of(grant.teamId);
      let address: string;
      try {
        address = sessionOf(
          hub,
          grant,
          oauth.client(grant.clientId)?.name ?? 'agent'
        );
      } catch (err) {
        return json(409, { error: (err as Error).message });
      }
      const server = buildServer(hub, address, deps.linear, grant.teamId);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      const res = await transport.handleRequest(req);
      const headers = new Headers(res.headers);
      headers.set('access-control-allow-origin', '*');
      return new Response(res.body, { status: res.status, headers });
    }
    return null;
  };
}
