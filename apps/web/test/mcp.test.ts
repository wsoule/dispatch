import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TeamService } from '../src/server.js';
import { startTeamService } from '../src/server.js';

// claude.ai's path: register, sign in, consent, PKCE code, token, then MCP
// over streamable HTTP. Two people's hosted sessions message each other.

let service: TeamService;
let dataDir: string;
let base: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mcp-team-'));
  service = startTeamService({
    port: 0,
    hostname: '127.0.0.1',
    dataDir,
    origin: 'http://placeholder',
    githubClientId: null,
    githubClientSecret: null,
    devLogin: true,
    teamSecret: null,
  });
  base = `http://127.0.0.1:${service.port}`;
});
afterAll(async () => {
  await service.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function cookieFor(login: string): Promise<string> {
  const res = await fetch(`${base}/auth/dev?login=${login}`, {
    redirect: 'manual',
  });
  const set = res.headers.get('set-cookie') ?? '';
  return set.slice(0, set.indexOf(';'));
}

async function connect(
  login: string,
  teamId: string
): Promise<{ client: Client; token: string }> {
  const reg = (await (
    await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: [REDIRECT],
      }),
    })
  ).json()) as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const cookie = await cookieFor(login);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
  });
  const consent = await fetch(`${base}/oauth/authorize?${params.toString()}`, {
    headers: { cookie },
  });
  expect(await consent.text()).toContain('Connect Claude to Dispatch?');
  const allowed = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...Object.fromEntries(params),
      team: teamId,
      decision: 'allow',
    }).toString(),
  });
  const back = new URL(allowed.headers.get('location') ?? '');
  expect(back.searchParams.get('state')).toBe('xyz');
  const code = back.searchParams.get('code') ?? '';

  const badVerifier = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: reg.client_id,
      redirect_uri: REDIRECT,
      code_verifier: 'wrong',
    }).toString(),
  });
  expect(badVerifier.status).toBe(400);

  // The first redemption spent the code even though it failed: start over.
  const again = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...Object.fromEntries(params),
      team: teamId,
      decision: 'allow',
    }).toString(),
  });
  const code2 =
    new URL(again.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const tokens = (await (
    await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code2,
        client_id: reg.client_id,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }).toString(),
    })
  ).json()) as { access_token: string };

  const client = new Client({ name: 'claude.ai', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      },
    })
  );
  return { client, token: tokens.access_token };
}

function body(result: unknown): Record<string, unknown> {
  const content = (result as { content: { text: string }[] }).content;
  return JSON.parse(content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('hosted MCP endpoint', () => {
  it('asks an unsigned client to authenticate, pointing at its metadata', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      '/.well-known/oauth-protected-resource'
    );
    const meta = (await (
      await fetch(`${base}/.well-known/oauth-authorization-server`)
    ).json()) as {
      code_challenge_methods_supported: string[];
    };
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('refuses a redirect URI that is neither https nor loopback', async () => {
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'x',
        redirect_uris: ['http://evil.example/cb'],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('lets two people’s claude.ai sessions message each other', async () => {
    const userOf = async (login: string) =>
      service.db.webSessionUser(
        decodeURIComponent((await cookieFor(login)).split('=')[1] ?? '')
      )!;
    const ada = await userOf('ada');
    const team = service.db.createTeam('Core', ada.id);
    const bobUser = await userOf('bob');
    service.db.acceptInvite(
      service.db.createInvite(team.id, ada.id),
      bobUser.id
    );
    const a = await connect('ada', team.id);
    const b = await connect('bob', team.id);

    const adaMe = body(
      await a.client.callTool({ name: 'whoami', arguments: {} })
    );
    const bobMe = body(
      await b.client.callTool({ name: 'whoami', arguments: {} })
    );
    expect(String(adaMe.address)).toMatch(
      /^agent:ada\/claude\.web-[0-9a-f]{6}$/
    );

    const listed = body(
      await b.client.callTool({ name: 'agent_list', arguments: {} })
    );
    expect(JSON.stringify(listed)).toContain(String(adaMe.address));

    const sent = body(
      await b.client.callTool({
        name: 'msg_send',
        arguments: { to: [adaMe.address], kind: 'message', body: 'ship it?' },
      })
    );
    const next = (await a.client.callTool({
      name: 'agent_list',
      arguments: {},
    })) as { content: { text: string }[] };
    expect(next.content.at(-1)?.text).toBe(
      `[dispatch] 1 unread (from ${String(bobMe.address)}). Call inbox_read.`
    );
    const inbox = body(
      await a.client.callTool({ name: 'inbox_read', arguments: {} })
    );
    expect(JSON.stringify(inbox)).toContain('ship it?');
    await a.client.callTool({
      name: 'msg_reply',
      arguments: {
        messageId: (sent.message as { id: string }).id,
        body: 'shipping',
      },
    });
    const bobInbox = body(
      await b.client.callTool({ name: 'inbox_read', arguments: {} })
    );
    expect(JSON.stringify(bobInbox)).toContain('shipping');
  });
});
