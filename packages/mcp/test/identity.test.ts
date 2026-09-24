import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { daemonFilePath } from '../src/daemon.js';
import { agentName, messagingCredential } from '../src/identity.js';

// A minimal stand-in for dispatchd's registration route — just enough to
// drive messagingCredential's self-registration path deterministically.
class FakeDaemon {
  registerStatus = 201;
  registerBody: unknown = {
    address: 'agent:wyat/claude-code.some-host',
    token: 'freshly-minted-token',
    status: 'pending',
  };
  registerCalls: { name: string; client: string }[] = [];
  private server: ReturnType<typeof Bun.serve> | undefined;

  start(): number {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/api/health') return Response.json({ ok: true });
        if (url.pathname === '/api/agents/register' && req.method === 'POST') {
          const body = (await req.json()) as { name: string; client: string };
          this.registerCalls.push(body);
          return Response.json(this.registerBody, {
            status: this.registerStatus,
          });
        }
        return Response.json({ error: 'not found' }, { status: 404 });
      },
    });
    return this.server.port ?? 0;
  }

  stop(): void {
    void this.server?.stop(true);
  }
}

let fakeHome: string;
let root: string;
let daemon: FakeDaemon | undefined;
const originalEnv = {
  DISPATCH_HOME: process.env.DISPATCH_HOME,
  DISPATCH_RUN_TOKEN: process.env.DISPATCH_RUN_TOKEN,
  DISPATCH_RUN_ID: process.env.DISPATCH_RUN_ID,
  DISPATCH_AGENT_NAME: process.env.DISPATCH_AGENT_NAME,
};

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-mcp-identity-home-'));
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-identity-root-'));
  process.env.DISPATCH_HOME = fakeHome;
  delete process.env.DISPATCH_RUN_TOKEN;
  delete process.env.DISPATCH_RUN_ID;
  delete process.env.DISPATCH_AGENT_NAME;
});

afterEach(() => {
  daemon?.stop();
  daemon = undefined;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function writeFakeDaemonFile(port: number): void {
  const path = daemonFilePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      port,
      pid: process.pid,
      rootDir: root,
      startedAt: new Date().toISOString(),
      agentToken: 'shared-agent-token',
    })
  );
}

function tokenFilePath(name: string): string {
  return join(fakeHome, '.dispatch', 'agents', `${name}.token`);
}

describe('agentName', () => {
  it('joins the client name and short hostname, normalized like the server does', () => {
    expect(agentName({}, 'Claude Code', 'Wyats-MacBook-Pro.local')).toBe(
      'claude-code.wyats-macbook-pro'
    );
  });

  it('DISPATCH_AGENT_NAME overrides the computed name', () => {
    expect(
      agentName(
        { DISPATCH_AGENT_NAME: 'My Custom Bot' },
        'Claude Code',
        'Wyats-MacBook-Pro.local'
      )
    ).toBe('my-custom-bot');
  });

  it('falls back to "agent" when no client name is known', () => {
    expect(agentName({}, undefined, 'host.local')).toBe('agent.host');
  });
});

describe('messagingCredential (run context)', () => {
  it('uses DISPATCH_RUN_TOKEN and derives the run address from DISPATCH_RUN_ID', async () => {
    process.env.DISPATCH_RUN_TOKEN = 'rt-abc123';
    process.env.DISPATCH_RUN_ID = 'r-self1';
    const result = await messagingCredential(root, 'Claude Code');
    expect(result).toEqual({
      token: 'rt-abc123',
      kind: 'run',
      address: 'run:r-self1',
    });
  });
});

describe('messagingCredential (cached agent token)', () => {
  it('reads an already-registered agent token straight from disk, no daemon needed', async () => {
    const name = agentName(process.env, 'Claude Code', hostname());
    const path = tokenFilePath(name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'cached-token-value\n');

    const result = await messagingCredential(root, 'Claude Code');
    expect(result).toEqual({
      token: 'cached-token-value',
      kind: 'agent',
      address: null,
    });
  });
});

describe('messagingCredential (self-registration)', () => {
  it('reports a clear error when no daemon is reachable to register with', async () => {
    const result = await messagingCredential(root, 'Claude Code');
    expect(result).toEqual({
      error: expect.stringContaining('dispatchd not running'),
    });
  });

  it('registers a fresh agent identity and writes its token to disk at 0600', async () => {
    daemon = new FakeDaemon();
    writeFakeDaemonFile(daemon.start());

    const result = await messagingCredential(root, 'Claude Code');
    expect(result).toEqual({
      token: 'freshly-minted-token',
      kind: 'agent',
      address: null,
    });

    const name = agentName(process.env, 'Claude Code', hostname());
    expect(daemon.registerCalls).toEqual([{ name, client: 'Claude Code' }]);

    const path = tokenFilePath(name);
    expect(readFileSync(path, 'utf8')).toBe('freshly-minted-token');
    // 0600 — owner read/write only, since this is a bearer credential.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('surfaces the guidance text verbatim on a 409 (already registered)', async () => {
    daemon = new FakeDaemon();
    daemon.registerStatus = 409;
    daemon.registerBody = {
      error: 'agent:wyat/claude-code.some-host is already registered (pending)',
    };
    writeFakeDaemonFile(daemon.start());

    const result = await messagingCredential(root, 'Claude Code');
    const name = agentName(process.env, 'Claude Code', hostname());
    expect(result).toEqual({
      error: `an agent named ${name} is already registered; revoke it in Dispatch → Settings → Agents to re-register`,
    });
  });
});
