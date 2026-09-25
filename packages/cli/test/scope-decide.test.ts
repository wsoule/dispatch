import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonFilePath } from '../src/commands/daemon.js';
import type { CliContext } from '../src/context.js';
import { CliError } from '../src/context.js';
import { makeProgram } from '../src/program.js';

const AGENT_TOKEN = 'agent-token-from-the-daemon-file';
const APP_TOKEN = 'app-token-only-a-human-has';

// An open scope gate a run raised: the message `scope show`/`decide` act on.
const SCOPE_GATE = {
  id: 'm-scope1',
  thread: 'm-scope1',
  replyTo: null,
  from: 'run:r-1',
  to: ['human:wyat'],
  kind: 'question',
  body: 'May I edit packages/core/src/browser.ts?',
  refs: [],
  urgent: false,
  blocking: true,
  choices: ['grant', 'deny'],
  wake: 'none',
  createdAt: '2026-09-25T10:00:00Z',
  data: {
    type: 'scope',
    paths: ['packages/core/src/browser.ts'],
    reason: 'needed for the fix',
  },
};

let root: string;
let fakeHome: string;
let lines: string[];
let ctx: CliContext;
let server: ReturnType<typeof Bun.serve>;
// Every request the fake daemon saw, so a test can assert both what was sent
// and — for the never-decide-without-an-app-token guard — what was not.
let received: { path: string; auth: string | null }[];
// The gate's answer once a reply lands, so `show` can read it back.
let answer: Record<string, unknown> | null;
const originalDispatchHome = process.env.DISPATCH_HOME;
const originalAppToken = process.env.DISPATCH_APP_TOKEN;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

// A fake dispatchd that enforces the real tier split: every messaging route
// refuses the agent token and needs a human's app token.
function startFakeDaemon(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get('authorization');
      received.push({ path: url.pathname, auth });
      if (url.pathname === '/api/health') return Response.json({ ok: true });
      if (auth !== `Bearer ${APP_TOKEN}`) {
        return Response.json(
          { error: 'needs the app token', code: 'auth_insufficient_tier' },
          { status: 403 }
        );
      }
      if (url.pathname === `/api/messages/${SCOPE_GATE.id}`) {
        return Response.json(SCOPE_GATE);
      }
      if (url.pathname === `/api/messages/${SCOPE_GATE.id}/answer`) {
        return Response.json({ answer });
      }
      if (
        url.pathname === `/api/messages/${SCOPE_GATE.id}/reply` &&
        req.method === 'POST'
      ) {
        const body = (await req.json()) as { body: string; choice: string };
        answer = {
          ...SCOPE_GATE,
          id: 'm-answer',
          replyTo: SCOPE_GATE.id,
          from: 'human:wyat',
          to: ['run:r-1'],
          kind: 'answer',
          blocking: false,
          body: body.body,
          choice: body.choice,
        };
        return Response.json(
          { message: answer, deliveries: [], downgraded: false },
          { status: 201 }
        );
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-scope-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-scope-'));
  process.env.DISPATCH_HOME = fakeHome;
  delete process.env.DISPATCH_APP_TOKEN;
  lines = [];
  received = [];
  answer = null;
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

describe('dispatch scope decide', () => {
  it('refuses to run without an app token, and points at dispatch serve', async () => {
    await expect(run('scope', 'decide', 'm-scope1')).rejects.toThrow(CliError);
    await expect(run('scope', 'decide', 'm-scope1')).rejects.toThrow(
      /dispatch serve/
    );
  });

  it('never falls back to the agent token sitting in the daemon file', async () => {
    await expect(run('scope', 'decide', 'm-scope1')).rejects.toThrow(CliError);
    // The point is not just the throw: no request must reach the daemon at
    // all, since a decide attempt carrying the agent token would be the very
    // silent fallback the tier split exists to prevent.
    expect(received).toEqual([]);
  });

  it('grants with a --token app token', async () => {
    await run('scope', 'decide', 'm-scope1', '--token', APP_TOKEN);
    const reply = received.find((r) => r.path.endsWith('/reply'));
    expect(reply?.auth).toBe(`Bearer ${APP_TOKEN}`);
    expect(answer).toMatchObject({
      choice: 'grant',
      body: 'granted at the CLI',
    });
    expect(lines).toContain('m-scope1 granted (packages/core/src/browser.ts)');
  });

  it('denies with DISPATCH_APP_TOKEN, recording the reason given', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('scope', 'decide', 'm-scope1', '--deny', '--reason', 'no');
    const reply = received.find((r) => r.path.endsWith('/reply'));
    expect(reply?.auth).toBe(`Bearer ${APP_TOKEN}`);
    expect(answer).toMatchObject({ choice: 'deny', body: 'no' });
    expect(lines).toContain('m-scope1 denied (packages/core/src/browser.ts)');
  });

  it('surfaces the daemon 403 when the token supplied is only agent-tier', async () => {
    await expect(
      run('scope', 'decide', 'm-scope1', '--token', AGENT_TOKEN)
    ).rejects.toThrow(/needs the app token/);
  });
});

describe('dispatch scope show', () => {
  it('reads an open scope gate with the app token', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('scope', 'show', 'm-scope1');
    const read = received.find((r) => r.path === '/api/messages/m-scope1');
    expect(read?.auth).toBe(`Bearer ${APP_TOKEN}`);
    expect(lines).toEqual([
      'm-scope1  run=r-1  pending',
      'paths: packages/core/src/browser.ts',
      'reason: needed for the fix',
    ]);
  });

  it('shows the decision once the gate is answered', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('scope', 'decide', 'm-scope1', '--deny');
    lines = [];
    await run('scope', 'show', 'm-scope1');
    expect(lines).toContain('m-scope1  run=r-1  denied');
    expect(lines).toContain('decision: denied at the CLI');
  });

  it('needs the app token, and never reads with the agent token', async () => {
    await expect(run('scope', 'show', 'm-scope1')).rejects.toThrow(
      /DISPATCH_APP_TOKEN/
    );
    expect(received).toEqual([]);
  });
});
