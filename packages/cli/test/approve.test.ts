import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonFilePath } from '../src/commands/daemon.js';
import type { CliContext } from '../src/context.js';
import { makeProgram } from '../src/program.js';

const AGENT_TOKEN = 'agent-token-from-the-daemon-file';
const APP_TOKEN = 'app-token-only-a-human-has';

const GATE = {
  id: 'm-gate01',
  thread: 'm-gate01',
  replyTo: null,
  from: 'agent:dispatch',
  to: ['human:wyat'],
  kind: 'question',
  body: 'Checkout wants to run run_shell',
  refs: [],
  urgent: false,
  blocking: true,
  choices: ['approve', 'approve-session', 'deny'],
  wake: 'none',
  createdAt: '2026-09-25T10:00:00Z',
  data: {
    type: 'tool-approval',
    requestId: 'fake-approval-1',
    runId: 'r-1',
    tool: 'run_shell',
    input: {},
  },
};

// A second call the same run parked after the first, with its own gate.
const GATE_2 = {
  ...GATE,
  id: 'm-gate02',
  thread: 'm-gate02',
  body: 'Checkout wants to run write_file',
  createdAt: '2026-09-25T10:00:05Z',
  data: { ...GATE.data, requestId: 'fake-approval-2', tool: 'write_file' },
};

function runMeta(id: string, taskId: string, state: string) {
  return {
    id,
    taskId,
    taskTitle: 'Checkout',
    executor: 'fake',
    state,
    branch: `dispatch/${taskId}`,
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-09-25T10:00:00Z',
    updatedAt: '2026-09-25T10:00:00Z',
  };
}

const RUNS = [
  runMeta('r-1', 't-1', 'awaiting-approval'),
  runMeta('r-3', 't-3', 'finished'),
  runMeta('r-5', 't-5', 'finished'),
];
const WOKEN_RUN = runMeta('r-4', 't-3', 'running');

let root: string;
let fakeHome: string;
let lines: string[];
let ctx: CliContext;
let server: ReturnType<typeof Bun.serve>;
let replies: { id: string; body: unknown; auth: string | null }[];
let sends: { body: unknown; auth: string | null }[];
let decisionReads: number;
// The gates GET /api/decisions/open lists, oldest first.
let openGates: (typeof GATE)[];
// Whether a wake of t-3 started a run, for `message --resume`.
let woke: boolean;
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
      // Run reads take either token, as on the real daemon.
      const runRead = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
      if (runRead !== null) {
        const meta = RUNS.find((r) => r.id === runRead[1]);
        return meta === undefined
          ? Response.json({ error: 'run not found' }, { status: 404 })
          : Response.json({ meta, entries: [], evidence: [], mutations: [] });
      }
      if (url.pathname === '/api/runs') {
        return Response.json(woke ? [...RUNS, WOKEN_RUN] : RUNS);
      }
      // The real daemon refuses the shared agent token on every messaging route.
      if (auth !== `Bearer ${APP_TOKEN}`) {
        return Response.json(
          { error: 'use a human token', code: 'auth_insufficient_tier' },
          { status: 403 }
        );
      }
      if (url.pathname === '/api/decisions/open') {
        decisionReads++;
        return Response.json({ items: openGates });
      }
      if (url.pathname === '/api/messages' && req.method === 'POST') {
        const body = (await req.json()) as { to: string[]; wake?: string };
        sends.push({ body, auth });
        if (body.to.includes('run:r-9')) {
          return Response.json(
            { error: 'run r-9 is not live', code: 'invalid' },
            { status: 400 }
          );
        }
        if (body.to.includes('task:t-3') && body.wake === 'request') {
          woke = true;
        }
        return Response.json(
          { message: GATE, deliveries: [], downgraded: false },
          { status: 201 }
        );
      }
      const reply = /^\/api\/messages\/([^/]+)\/reply$/.exec(url.pathname);
      if (reply !== null && req.method === 'POST') {
        replies.push({ id: reply[1], body: await req.json(), auth });
        return Response.json(
          {
            message: { ...GATE, id: 'm-ans', kind: 'answer' },
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
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-approve-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-approve-'));
  process.env.DISPATCH_HOME = fakeHome;
  delete process.env.DISPATCH_APP_TOKEN;
  lines = [];
  replies = [];
  sends = [];
  decisionReads = 0;
  openGates = [GATE];
  woke = false;
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

describe('dispatch approve', () => {
  it('finds the run gate and answers it with the app token', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('approve', 'r-1');
    expect(replies).toEqual([
      {
        id: 'm-gate01',
        body: { body: '', choice: 'approve' },
        auth: `Bearer ${APP_TOKEN}`,
      },
    ]);
    expect(lines).toContain('r-1 approved (fake-approval-1)');
  });

  it('--session and --deny --reason map to the gate choices', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('approve', 'r-1', '--session');
    await run('approve', 'r-1', '--deny', '--reason', 'not on main');
    expect(replies.map((r) => r.body)).toEqual([
      { body: '', choice: 'approve-session' },
      { body: 'not on main', choice: 'deny' },
    ]);
    expect(lines).toContain('r-1 denied (fake-approval-1)');
  });

  it('without an app token it refuses before sending anything, naming DISPATCH_APP_TOKEN', async () => {
    await expect(run('approve', 'r-1')).rejects.toThrow(/DISPATCH_APP_TOKEN/);
    expect(replies).toEqual([]);
  });

  it('a run with no open gate is an error, not a silent no-op', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await expect(run('approve', 'r-2')).rejects.toThrow(
      'r-2 is not awaiting an approval'
    );
  });

  it('a request id that is not the open one is an error', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await expect(run('approve', 'r-1', 'fake-approval-9')).rejects.toThrow(
      'r-1 is not awaiting an approval'
    );
    expect(replies).toEqual([]);
  });

  // Each parked call has its own gate, and the daemon answers any of them.
  it('answers exactly the named call when a run parked several', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    openGates = [GATE, GATE_2];
    await run('approve', 'r-1', 'fake-approval-2');
    expect(replies.map((r) => r.id)).toEqual(['m-gate02']);
    expect(lines).toContain('r-1 approved (fake-approval-2)');
  });

  it('with several parked calls and no request id, names them and answers none', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    openGates = [GATE, GATE_2];
    await expect(run('approve', 'r-1')).rejects.toThrow(
      'r-1 is parked on 2 calls: fake-approval-1 (run_shell), fake-approval-2 (write_file)'
    );
    expect(replies).toEqual([]);
  });

  it('--reason without --deny is refused rather than dropped', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await expect(
      run('approve', 'r-1', '--reason', 'looks fine')
    ).rejects.toThrow('--reason goes with --deny');
    expect(replies).toEqual([]);
  });
});

describe('dispatch run show', () => {
  const answerWith =
    'answer with: dispatch approve r-1 [--deny] (needs the app token: --token or DISPATCH_APP_TOKEN)';

  it('names the parked tool and request id when an app token can read the gates', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('run', 'show', 'r-1');
    expect(lines).toContain(
      `awaiting approval: run_shell (fake-approval-1) — ${answerWith}`
    );
  });

  it('lists every parked call, since each is answered by its own request id', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    openGates = [GATE, GATE_2];
    await run('run', 'show', 'r-1');
    const at = lines.indexOf(
      'awaiting approval on 2 calls — answer each with: dispatch approve r-1 <requestId> [--deny] (needs the app token: --token or DISPATCH_APP_TOKEN)'
    );
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines.slice(at + 1, at + 3)).toEqual([
      '  run_shell (fake-approval-1)',
      '  write_file (fake-approval-2)',
    ]);
  });

  it('without an app token it still says how to answer, without the gate details', async () => {
    await run('run', 'show', 'r-1');
    expect(lines).toContain(`awaiting approval — ${answerWith}`);
    expect(decisionReads).toBe(0);
  });

  it('a gate the token cannot read falls back to the plain line and says why', async () => {
    await run('run', 'show', 'r-1', '--token', AGENT_TOKEN);
    expect(lines).toContain(`awaiting approval — ${answerWith}`);
    expect(lines).toContain(
      '  could not read its gates with that token: use a human token'
    );
  });

  it('prints nothing about approvals for a run that is not parked', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('run', 'show', 'r-3');
    expect(lines.some((l) => l.includes('awaiting approval'))).toBe(false);
    expect(decisionReads).toBe(0);
  });
});

describe('dispatch message', () => {
  it('sends to the run address with the app token', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('message', 'r-1', 'use', 'the', 'v2', 'endpoint');
    expect(sends).toEqual([
      {
        body: { to: ['run:r-1'], kind: 'message', body: 'use the v2 endpoint' },
        auth: `Bearer ${APP_TOKEN}`,
      },
    ]);
    expect(lines).toContain('sent message to r-1');
  });

  it('without an app token it refuses before sending anything', async () => {
    await expect(run('message', 'r-1', 'hi')).rejects.toThrow(
      /DISPATCH_APP_TOKEN/
    );
    expect(sends).toEqual([]);
  });

  it("surfaces the daemon's error for a run that is not live", async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await expect(run('message', 'r-9', 'hi')).rejects.toThrow(
      'run r-9 is not live'
    );
  });

  it('--resume wakes the run task and names the run that picked it up', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await run('message', 'r-3', 'rename', 'it', '--resume');
    expect(sends.map((s) => s.body)).toEqual([
      {
        to: ['task:t-3'],
        kind: 'message',
        body: 'rename it',
        wake: 'request',
      },
    ]);
    expect(lines).toContain('requested changes on r-3 — new run r-4');
  });

  it('--resume with no run woken says the message is waiting', async () => {
    process.env.DISPATCH_APP_TOKEN = APP_TOKEN;
    await expect(run('message', 'r-5', 'again', '--resume')).rejects.toThrow(
      't-5 did not wake; your message is waiting for its next run'
    );
  });
});
