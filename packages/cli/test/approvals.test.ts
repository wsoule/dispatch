import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonFilePath } from '../src/commands/daemon.js';
import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

const AGENT_TOKEN = 'agent-token-from-the-daemon-file';
const APP_TOKEN = 'app-token-only-a-human-has';

function gate(id: string, choices: string[], data: unknown, body: string) {
  return {
    id,
    thread: id,
    replyTo: null,
    from: 'agent:dispatch',
    to: ['human:wyat'],
    kind: 'question',
    body,
    refs: [],
    urgent: false,
    blocking: true,
    choices,
    wake: 'none',
    createdAt: '2026-10-06T10:00:00Z',
    data,
  };
}

const TOOL_GATE = gate(
  'm-tool',
  ['approve', 'approve-session', 'deny'],
  {
    type: 'tool-approval',
    requestId: 'req-1',
    runId: 'r-1',
    tool: 'run_shell',
    input: {},
  },
  'Checkout wants to run run_shell'
);
const AGENT_GATE = gate(
  'm-agent',
  ['approve', 'deny'],
  {
    type: 'agent-registration',
    agent: 'agent:wyat/claude-code',
    client: 'claude-code',
    requestedBy: 'human:wyat',
    key: 'k',
  },
  'New agent agent:wyat/claude-code wants to join this project'
);
const SCOPE_GATE = gate(
  'm-scope',
  ['grant', 'deny'],
  { type: 'scope', paths: ['src/a.ts'], reason: 'needs it' },
  'May I edit src/a.ts?'
);
const PLAIN_QUESTION = gate('m-ask', [], undefined, 'Which colour?');

const ROSTER = [
  {
    address: 'agent:wyat/claude-code',
    displayName: 'claude-code',
    client: 'claude-code',
    status: 'approved',
    muted: false,
    approvedBy: 'human:wyat',
    createdAt: '2026-10-06T10:00:00Z',
    remote: null,
  },
  {
    address: 'agent:sam/codex',
    displayName: 'codex',
    client: 'codex',
    status: 'approved',
    muted: false,
    approvedBy: 'human:sam',
    createdAt: '2026-10-06T10:00:00Z',
    remote: 'sam',
  },
  {
    address: 'agent:wyat/old',
    displayName: 'old',
    client: 'codex',
    status: 'revoked',
    muted: false,
    approvedBy: null,
    createdAt: '2026-10-06T10:00:00Z',
    remote: null,
  },
];

let root: string;
let fakeHome: string;
let lines: string[];
let ctx: CliContext;
let server: ReturnType<typeof Bun.serve>;
let replies: { id: string; body: unknown }[];
let rosterAuth: string | null;
const originalDispatchHome = process.env.DISPATCH_HOME;
const originalAppToken = process.env.DISPATCH_APP_TOKEN;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

function startFakeDaemon(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get('authorization');
      if (url.pathname === '/api/health') return Response.json({ ok: true });
      if (url.pathname === '/api/agents/roster') {
        rosterAuth = auth;
        return Response.json({ agents: ROSTER });
      }
      if (auth !== `Bearer ${APP_TOKEN}`) {
        return Response.json(
          { error: 'use a human token', code: 'auth_insufficient_tier' },
          { status: 403 }
        );
      }
      if (url.pathname === '/api/decisions/open') {
        return Response.json({
          items: [TOOL_GATE, AGENT_GATE, SCOPE_GATE, PLAIN_QUESTION],
        });
      }
      const reply = /^\/api\/messages\/([^/]+)\/reply$/.exec(url.pathname);
      if (reply !== null && req.method === 'POST') {
        replies.push({ id: reply[1], body: await req.json() });
        return Response.json(
          {
            message: { ...TOOL_GATE, id: 'm-ans', kind: 'answer' },
            deliveries: [],
            downgraded: false,
          },
          { status: 201 }
        );
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-approvals-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-approvals-'));
  process.env.DISPATCH_HOME = fakeHome;
  delete process.env.DISPATCH_APP_TOKEN;
  lines = [];
  replies = [];
  rosterAuth = null;
  ctx = { cwd: root, log: (l) => lines.push(l) };
  await run('init');
  lines = [];
  server = startFakeDaemon();
  mkdirSync(join(fakeHome, '.dispatch', 'daemons'), { recursive: true });
  writeFileSync(
    daemonFilePath(root),
    JSON.stringify({
      port: server.port,
      pid: process.pid,
      rootDir: root,
      startedAt: new Date().toISOString(),
      agentToken: AGENT_TOKEN,
    })
  );
});

afterEach(() => {
  void server.stop(true);
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  if (originalAppToken === undefined) delete process.env.DISPATCH_APP_TOKEN;
  else process.env.DISPATCH_APP_TOKEN = originalAppToken;
});

describe('dispatch approvals', () => {
  it('lists every open Needs you item with its kind', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('approvals');
    const out = lines.join('\n');
    expect(out).toContain('m-tool');
    expect(out).toContain('tool-approval');
    expect(out).toContain('run_shell on run r-1');
    expect(out).toContain('agent-registration');
    expect(out).toContain('agent:wyat/claude-code');
    expect(out).toContain('scope');
    expect(out).toContain('dispatch approvals approve <id>');
  });

  it('refuses without the app token, naming DISPATCH_APP_TOKEN', async () => {
    await expect(run('approvals', 'list')).rejects.toThrow(
      /DISPATCH_APP_TOKEN/
    );
  });

  it('approves each gate with its own word for yes', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('approvals', 'approve', 'm-agent');
    await run('approvals', 'approve', 'm-scope');
    await run('approvals', 'approve', 'm-tool', '--session');
    expect(replies).toEqual([
      { id: 'm-agent', body: { body: '', choice: 'approve' } },
      { id: 'm-scope', body: { body: '', choice: 'grant' } },
      { id: 'm-tool', body: { body: '', choice: 'approve-session' } },
    ]);
    expect(lines).toContain('m-scope grant (scope)');
  });

  it('finds an item by pending agent address or tool request id', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('approvals', 'approve', 'agent:wyat/claude-code');
    await run('approvals', 'deny', 'req-1', '--reason', 'not now');
    expect(replies).toEqual([
      { id: 'm-agent', body: { body: '', choice: 'approve' } },
      { id: 'm-tool', body: { body: 'not now', choice: 'deny' } },
    ]);
  });

  it('refuses what it cannot decide, sending nothing', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await expect(run('approvals', 'approve', 'm-gone')).rejects.toThrow(
      'm-gone is not awaiting a decision; pending: m-tool, m-agent, m-scope, m-ask'
    );
    await expect(run('approvals', 'approve', 'm-ask')).rejects.toThrow(
      'free-text question'
    );
    await expect(
      run('approvals', 'approve', 'm-scope', '--session')
    ).rejects.toThrow('--session applies only to tool approvals');
    expect(replies).toEqual([]);
  });
});

describe('dispatch team agents', () => {
  it("lists this machine's and teammates' agents on the daemon file token", async () => {
    await run('team', 'agents');
    const out = lines.join('\n');
    expect(rosterAuth).toBe(`Bearer ${AGENT_TOKEN}`);
    expect(out).toContain('agent:wyat/claude-code');
    expect(out).toContain('this machine');
    expect(out).toContain('agent:sam/codex');
    expect(out).toMatch(/agent:sam\/codex\s+approved\s+sam/);
    expect(out).not.toContain('agent:wyat/old');
    expect(out).toContain('task:<id> or run:<id>');
  });

  it('--all --json includes revoked agents', async () => {
    await run('team', 'agents', '--all', '--json');
    const parsed = JSON.parse(lines.join('\n')) as { address: string }[];
    expect(parsed.map((a) => a.address)).toEqual([
      'agent:sam/codex',
      'agent:wyat/claude-code',
      'agent:wyat/old',
    ]);
  });
});
